/**
 * dsh-pet Electron main process. Owns the pet window (transparent,
 * always-on-top, click-through outside the pet body), the pet-profile child
 * process (spawned through Electron's own binary in Node mode, mirroring
 * apps/desktop-host), and the pet-asset protocol that streams the pet's
 * animation media from a local directory without vendoring it into the
 * repository.
 *
 * Window drag is manual: the renderer captures the pointer over the pet body
 * and reports screen coordinates; the main process follows with setBounds
 * whose size is pinned to the canonical WINDOW_SIZE and whose position
 * recomputes from the gesture anchor, so neither the DWM re-measure ratchet
 * nor a per-call nudge can accumulate (DSH-PET.md §5 error chain #11-12).
 */

import { app, BrowserWindow, ipcMain, Menu, protocol, screen, session } from 'electron'
import { spawn, type ChildProcess } from 'node:child_process'
import { randomUUID } from 'node:crypto'
import { existsSync, mkdirSync, readFileSync } from 'node:fs'
import { readFile, rm, writeFile } from 'node:fs/promises'
import type { ServerResponse } from 'node:http'
import { createServer } from 'node:http'
import { homedir } from 'node:os'
import { dirname, join, normalize, resolve, sep } from 'node:path'
import { fileURLToPath } from 'node:url'
import { createRequire } from 'node:module'

const HERE = dirname(fileURLToPath(import.meta.url))
const PET_PROFILE_NAME = 'pet'
const ASSET_SCHEME = 'pet-asset'
/** Bounded wait for the profile child's graceful shutdown before it is left to the OS. */
const SHUTDOWN_TIMEOUT_MS = 10_000

/** The dsh home this carrier shares with the driver (manifest, settings). */
const DSH_HOME = process.env.DSH_HOME ?? join(homedir(), '.dsh')

/**
 * The window's one canonical size: creation and every drag setBounds pin it.
 * A position-only setPosition re-sends whatever size DWM last re-measured the
 * transparent frameless window to, which ratchets +1px per call; an explicit
 * size can at worst oscillate, never accumulate.
 */
const WINDOW_SIZE = { width: 460, height: 560 } as const

process.env.ELECTRON_DISABLE_SECURITY_WARNINGS = 'true'
// ── boot logger (diagnostic injection, remove after incident) ──────────────
import { appendFileSync as __afs } from 'node:fs'
const __bootLog = (line: string): void => {
  try { __afs('C:/Users/beyondguo/.dsh/carrier-boot.log', `${new Date().toISOString()} ${line}\n`) } catch { /* ignore */ }
}
__bootLog(`BOOT pid=${process.pid} argv=${JSON.stringify(process.argv.slice(1))} runAsNode=${process.env.ELECTRON_RUN_AS_NODE ?? 'unset'} nodeOptions=${process.env.NODE_OPTIONS ?? 'unset'} dshPetUrl=${process.env.DSH_PET_URL ? 'set' : 'unset'} cwd=${process.cwd()}`)
process.on('uncaughtException', (e) => { __bootLog(`UNCAUGHT ${e.stack ?? String(e)}`) })
process.on('unhandledRejection', (e) => { __bootLog(`REJECTION ${String(e)}`) })
// ── boot logger end ─────────────────────────────────────────────────────────


// Route main-process crashes to the log instead of the dialog: an uncaught
// exception in an IPC handler or poller otherwise dies as a modal error box
// with the stack truncated, leaving nothing to diagnose from.
process.on('uncaughtException', (error) => {
  console.error(`[pet] uncaughtException: ${error.stack ?? String(error)}`)
})
process.on('unhandledRejection', (reason) => {
  console.error(`[pet] unhandledRejection: ${String(reason)}`)
})

// CDP diagnostics (page state reads, synthetic input), requested by the
// DSH_PET_CDP env or the settings page's debug switch (read synchronously —
// this runs pre-ready; the switch only takes hold on the next launch).
let cdpRequested = process.env.DSH_PET_CDP === '1'
try {
  const settings = JSON.parse(readFileSync(join(DSH_HOME, 'pet-settings.json'), 'utf8')) as {
    debug?: { cdp?: unknown }
  }
  if (settings.debug?.cdp === true) cdpRequested = true
} catch {
  // Absent or unreadable settings: env is the only request channel.
}
if (cdpRequested) {
  app.commandLine.appendSwitch('remote-debugging-port', '9222')
}

// Registered before app ready, per Electron protocol registration rules. The
// scheme carries the pet's media under its path; media elements load it
// no-cors, so no CORS privilege is required.
protocol.registerSchemesAsPrivileged([
  // corsEnabled + an ACAO header on every response: the WebGL stage uploads
  // the video frames as textures, and a cross-origin media element without a
  // CORS-clean response taints the context (texImage2D SecurityError).
  { scheme: ASSET_SCHEME, privileges: { supportFetchAPI: true, stream: true, corsEnabled: true } },
])

if (!app.requestSingleInstanceLock()) {
  app.quit()
} else {
  app.on('second-instance', () => {
    const window = BrowserWindow.getAllWindows()[0]
    window?.show()
  })
  void main()
}

/** The local directory the pet's animation media is read from. */
function resolveAssetsRoot(): string {
  const configured = process.env.DSH_PET_ASSETS_DIR
  if (configured !== undefined && configured !== '') return resolve(configured)
  // Packaged layout: the carrier ships beside an assets directory (a junction
  // or copy staged next to lib/).
  const besideCarrier = resolve(HERE, '..', 'assets', 'characters')
  if (existsSync(besideCarrier)) return besideCarrier
  // npm assets package: dsh-agentic-pet-assets ships assets/characters as
  // plain files — the media channel for plugin installs from the registry
  // (the 50MB media deliberately stays out of the pet-app package itself).
  try {
    const require = createRequire(import.meta.url)
    const pkg = require.resolve('dsh-agentic-pet-assets/package.json')
    const packaged = resolve(dirname(pkg), 'assets', 'characters')
    if (existsSync(packaged)) return packaged
  } catch {
    // assets package not installed: fall through
  }
  // Source-checkout fallback: the media lives in the bundle's carrier tree
  // (gitignored, staged locally). lib/ → apps/pet → apps → deepseek-harness,
  // then into packages/bundle/pet-app/carrier.
  return resolve(HERE, '..', '..', '..', 'packages', 'bundle', 'pet-app', 'carrier', 'assets', 'characters')
}

function registerAssetProtocol(): void {
  const assetsRoot = resolveAssetsRoot()
  protocol.handle(ASSET_SCHEME, (request) => {
    const url = new URL(request.url)
    const relative = decodeURIComponent(url.pathname)
    const target = resolve(normalize(join(assetsRoot, relative)))
    if (target !== assetsRoot && !target.startsWith(assetsRoot + sep)) {
      return new Response(null, { status: 403 })
    }
    return netFetchFile(target)
  })
}

async function netFetchFile(target: string): Promise<Response> {
  try {
    const bytes = await readFile(target)
    return new Response(bytes, {
      headers: {
        'content-type': mimeOf(target),
        'access-control-allow-origin': '*',
      },
    })
  } catch {
    return new Response(null, { status: 404 })
  }
}

function mimeOf(target: string): string {
  switch (target.split('.').pop()?.toLowerCase()) {
    case 'webm': return 'video/webm'
    case 'gif': return 'image/gif'
    case 'png': return 'image/png'
    case 'json': return 'application/json'
    default: return 'application/octet-stream'
  }
}

interface HostChildHandle {
  child: ChildProcess
  url: Promise<string>
  shutdown: () => Promise<void>
}

/**
 * Spawn the pet profile child (Electron binary in Node mode running the
 * profile runner) and resolve its authenticated URL. The child owns the
 * Cordis tree; the carrier only supervises it.
 */
function spawnHostChild(): HostChildHandle {
  const hostChild = join(HERE, 'host-child.js')
  if (!existsSync(hostChild)) {
    throw new Error('pet: this carrier build has no self-spawn support (host-child.js absent); it expects DSH_PET_URL from a spawning runtime')
  }
  const child = spawn(process.execPath, [hostChild], {
    env: { ...process.env, ELECTRON_RUN_AS_NODE: '1' },
    stdio: ['ignore', 'pipe', 'pipe', 'ipc'],
  })
  let stderr = ''
  child.stderr?.setEncoding('utf8')
  child.stderr?.on('data', (chunk: string) => { stderr += chunk })
  // Forward the profile's console (the readiness URL line is the carrier
  // user's entry point to the Web GUI) instead of letting it sit in the pipe.
  child.stdout?.setEncoding('utf8')
  child.stdout?.on('data', (chunk: string) => { process.stdout.write(chunk) })
  child.stderr?.on('data', (chunk: string) => { process.stderr.write(chunk) })
  const url = new Promise<string>((resolveUrl, rejectUrl) => {
    const timer = setTimeout(() => {
      rejectUrl(new Error(`pet host: the profile child did not report ready within 120s\n${stderr.slice(-2000)}`))
    }, 120_000)
    child.on('message', (message: unknown) => {
      if ((message as { type?: string } | null)?.type !== 'ready') return
      clearTimeout(timer)
      resolveUrl(String((message as { url: string }).url))
    })
    child.on('exit', (code) => {
      clearTimeout(timer)
      rejectUrl(new Error(`pet host: the profile child exited with code ${String(code)} before ready\n${stderr.slice(-2000)}`))
    })
  })
  return {
    child,
    url,
    shutdown: () => new Promise<void>((resolveShutdown) => {
      if (child.exitCode !== null || child.signalCode !== null) {
        resolveShutdown()
        return
      }
      const timer = setTimeout(() => {
        child.kill()
        resolveShutdown()
      }, SHUTDOWN_TIMEOUT_MS)
      child.on('message', (message: unknown) => {
        if ((message as { type?: string } | null)?.type !== 'shutdown-complete') return
        clearTimeout(timer)
        resolveShutdown()
      })
      child.send({ type: 'shutdown' })
    }),
  }
}

/**
 * The pet-surface locator: pet-app bundles inside a running runtime publish
 * their authenticated root here (the desktop shell keeps its URL in process
 * memory only). A published URL wins over spawning a dedicated profile, so the
 * pet follows whichever live runtime serves /pet/ — the user's desktop when it
 * runs, otherwise the last publisher still alive.
 */
async function readLocatorUrl(): Promise<string | undefined> {
  const path = join(process.env.DSH_HOME ?? join(homedir(), '.dsh'), 'pet-surface-url.json')
  try {
    const record = JSON.parse(await readFile(path, 'utf8')) as { url?: unknown; pid?: unknown }
    if (typeof record.url !== 'string' || record.url === '') return undefined
    if (typeof record.pid === 'number') {
      try { process.kill(record.pid, 0) } catch { return undefined } // publisher gone
    }
    return record.url
  } catch {
    return undefined // absent or unreadable: no live publisher
  }
}

/**
 * The pet surface URL for an authenticated web root: path `/pet/` with the
 * token **dropped** — authorizeIndex mints the root cookie from the token and
 * rejects any token-carrying request on a subpath, so the pet page itself is
 * entered cookie-only after the root mint.
 */
function petSurfaceUrl(authenticated: string): string {
  const parsed = new URL(authenticated)
  parsed.pathname = '/pet/'
  parsed.search = ''
  parsed.hash = ''
  return parsed.toString()
}

/** The remembered window position, validated against the current displays so
 * a stale save (monitor unplugged, resolution change) cannot spawn the pet
 * off-screen. The WHOLE window rectangle must fit inside some work area —
 * a corner check admits positions whose body hangs past the edge, which is
 * how x=2125 (DIP work area 1707 wide) passed and the pet vanished. When no
 * display fits it, clamp fully into the primary work area. Undefined =
 * default placement. */
function readSavedPosition(): { x: number; y: number } | undefined {
  try {
    const parsed = JSON.parse(readFileSync(join(DSH_HOME, 'pet-window.json'), 'utf8')) as { x?: unknown; y?: unknown }
    const x = typeof parsed.x === 'number' ? Math.round(parsed.x) : Number.NaN
    const y = typeof parsed.y === 'number' ? Math.round(parsed.y) : Number.NaN
    if (!Number.isFinite(x) || !Number.isFinite(y)) return undefined
    const fits = (area: Electron.Rectangle): boolean =>
      x >= area.x && y >= area.y
      && x + WINDOW_SIZE.width <= area.x + area.width
      && y + WINDOW_SIZE.height <= area.y + area.height
    if (screen.getAllDisplays().some(display => fits(display.workArea))) return { x, y }
    const primary = screen.getPrimaryDisplay().workArea
    return {
      x: Math.min(primary.x + primary.width - WINDOW_SIZE.width, Math.max(primary.x, x)),
      y: Math.min(primary.y + primary.height - WINDOW_SIZE.height, Math.max(primary.y, y)),
    }
  } catch {
    return undefined
  }
}

function createPetWindow(): BrowserWindow {
  const saved = readSavedPosition()
  const window = new BrowserWindow({
    ...(saved === undefined ? {} : { x: saved.x, y: saved.y }),
    width: WINDOW_SIZE.width,
    height: WINDOW_SIZE.height,
    transparent: true,
    frame: false,
    hasShadow: false,
    alwaysOnTop: true,
    skipTaskbar: true,
    resizable: false,
    backgroundColor: '#00000000',
    webPreferences: {
      preload: join(HERE, 'preload.js'),
      // ESM preloads require the sandbox off; contextIsolation stays on.
      sandbox: false,
      contextIsolation: true,
      nodeIntegration: false,
      webSecurity: true,
    },
  })
  window.setAlwaysOnTop(true, 'screen-saver')
  // Mouse events start forwarded: the main-process poller toggles ignore off
  // while the cursor is over the pet body or a bubble, so the desktop
  // underneath stays clickable everywhere else.
  window.setIgnoreMouseEvents(true, { forward: true })
  return window
}

async function main(): Promise<void> {
  // protocol.handle touches the default session: registration must follow
  // app ready (registerSchemesAsPrivileged above is the only pre-ready call).
  await app.whenReady()
  // The runtime re-attaches to a fresh random port every boot, but cookies
  // ignore ports and pile up on the shared 127.0.0.1 domain — hundreds of
  // mints later the Cookie header outgrows the server's 16KB limit and every
  // page request is rejected (observed: 431 accumulated cookies). The boot's
  // token URL re-mints everything the page needs, so persistence is worthless.
  await session.defaultSession.clearStorageData({ storages: ['cookies'] })
  registerAssetProtocol()
  console.log(`[pet] assets root: ${resolveAssetsRoot()}`)

  let handle: HostChildHandle | undefined
  const attachUrl = process.env.DSH_PET_URL ?? await readLocatorUrl()
  let authenticated: string
  try {
    if (attachUrl !== undefined && attachUrl !== '') {
      console.log(`[pet] attaching to a published pet surface: ${new URL(attachUrl).origin}`)
      authenticated = attachUrl
    } else {
      // The self-spawn branch alone needs the profile machinery; the packaged
      // carrier always arrives with DSH_PET_URL from its spawning runtime and
      // carries none of these dependencies.
      const [{ initProfile }, { dshHomePath }, { PROFILE_TEMPLATES }] = await Promise.all([
        import('@deepseek-ai/dsh-app-boot'),
        import('@deepseek-ai/dsh-home-paths'),
        import('@deepseek-ai/dsh-official-bundles'),
      ])
      const template = PROFILE_TEMPLATES[PET_PROFILE_NAME]
      if (template === undefined) throw new Error('pet: no shipped profile template named "pet"')
      initProfile(dshHomePath('profiles', PET_PROFILE_NAME), template.bundles)
      handle = spawnHostChild()
      authenticated = await handle.url
    }
  } catch (error) {
    new BrowserWindow({ width: 520, height: 320 }).loadURL(
      'data:text/html;charset=utf-8,' + encodeURIComponent(
        `<pre style="font-family:monospace;white-space:pre-wrap">dsh pet 载体启动失败：\n\n${String(error instanceof Error ? error.message : error)}` +
        `\n\n素材目录（可配置 DSH_PET_ASSETS_DIR）：${resolveAssetsRoot()}</pre>`,
      ),
    )
    return
  }

  const window = createPetWindow()
  window.on('resize', () => {
    console.log(`[pet] resized: ${JSON.stringify(window.getBounds())}`)
  })
  window.on('moved', () => {
    console.log(`[pet] moved: ${JSON.stringify(window.getBounds())}`)
  })
  const primary = screen.getPrimaryDisplay()
  console.log(`[pet] window bounds: ${JSON.stringify(window.getBounds())} scaleFactor=${primary.scaleFactor} workarea=${JSON.stringify(primary.workArea)}`)
  // Forward the renderer console: the pet page's own diagnostics (connection,
  // shader, video failures) never reach a terminal otherwise.
  window.webContents.on('console-message', (_event, _level, message, line, source) => {
    console.log(`[pet-renderer] ${source}:${line} ${message}`)
  })
  window.webContents.on('did-fail-load', (_event, code, description, url) => {
    console.log(`[pet-renderer] did-fail-load ${code} ${description} ${url}`)
  })
  // Right-click anywhere on the window (pet body or bubble — the click-through
  // poller lets those through) opens the close menu: the MVP has no taskbar
  // entry or tray, so this is the only self-service exit.
  window.webContents.on('context-menu', () => {
    Menu.buildFromTemplate([
      { label: '退出 dsh pet', click: () => { window.close() } },
    ]).popup({ window })
  })
  // Connection's token exchange is root-path-only (authorizeIndex admits
  // `/?token=…`, never a subpath): load the authenticated root once to mint
  // the browser cookie, then enter /pet/ with it. The root load starts the
  // Web GUI; the second navigation aborts it, so the web app is at most a
  // flash.
  await window.loadURL(authenticated).catch(() => { /* the cookie is minted by the 303 */ })
  await window.loadURL(petSurfaceUrl(authenticated)).catch((error) => {
    console.error('[pet] the pet surface failed to load:', String(error))
  })

  // Click-through is decided by the MAIN process: setIgnoreMouseEvents(forward)
  // does not deliver forwarded moves on this Electron/Windows combination, so
  // the renderer never sees the cursor. The main process knows the window
  // bounds and the pet/bubble rects (they mirror the renderer CSS), polls the
  // cursor, and toggles ignore accordingly — no renderer participation.
  // The pet/bubble rects mirror the renderer CSS (pet: 340x200 bottom-center,
  // 12px margin; bubble: 400x300 above it), computed against the CURRENT
  // window size every poll — a fixed rect desyncs the moment the window
  // changes size for any reason.
  const PET_SIZE = { width: 340, height: 200 }
  const BUBBLE_SIZE = { width: 400, height: 300 }
  let bubbleVisible = false
  // The observable trace of one-shot actions (/action): consumers poll these
  // instead of override, which the renderer may set and clear within a tick.
  let lastAction: string | undefined
  let lastActionAt: number | undefined
  // The completion half of that trace, reported by the renderer when the
  // one-shot clip actually ends (onended/onerror) — this is what makes
  // pet_do(wait:true) waitable.
  let lastActionDone: {
    action: string
    durationMs: number | null
    at: number
    requestedBy: 'tool' | 'user'
    requestId?: string
  } | null = null
  // Tool-initiated /action requests awaiting their completion report: the
  // renderer echoes the requestId when the clip ends, so lastActionDone can
  // carry the REQUESTED action name (not the clip file) and the actor.
  const pendingActionRequests = new Map<string, { requested: string; at: number }>()
  let lastIgnore: boolean | undefined
  const updateClickThrough = (): void => {
    try {
      const bounds = window.getBounds()
      const cursor = screen.getCursorScreenPoint()
      const localX = cursor.x - bounds.x
      const localY = cursor.y - bounds.y
      const centeredX = (width: number): number => (bounds.width - width) / 2
      const petRect = { x: centeredX(PET_SIZE.width), y: bounds.height - 12 - PET_SIZE.height, ...PET_SIZE }
      const bubbleRect = { x: centeredX(BUBBLE_SIZE.width), y: bounds.height - 224 - BUBBLE_SIZE.height, ...BUBBLE_SIZE }
      const inRect = (rect: { x: number; y: number; width: number; height: number }): boolean =>
        localX >= rect.x && localX <= rect.x + rect.width
          && localY >= rect.y && localY <= rect.y + rect.height
      const overInteractive = inRect(petRect) || (bubbleVisible && inRect(bubbleRect))
      if (lastIgnore !== overInteractive) {
        console.log(`[pet] ignore -> ${String(!overInteractive)} cursorDIP=${cursor.x},${cursor.y} bounds=${JSON.stringify(bounds)}`)
        lastIgnore = overInteractive
      }
      window.setIgnoreMouseEvents(!overInteractive)
    } catch (error) {
      console.error(`[pet] click-through poll failed: ${String(error)}`)
    }
  }
  ipcMain.on('pet:bubble-visibility', (event, visible: unknown) => {
    try {
      if (event.sender !== window.webContents) return
      bubbleVisible = visible === true
    } catch (error) {
      console.error('[pet] bubble-visibility failed:', String(error))
    }
  })
  setInterval(updateClickThrough, 120)

  // ── manual drag ───────────────────────────────────────────────────────────
  // The believed origin: initialized once after creation and updated only by
  // our own setBounds — never re-read from getBounds(), which reports whatever
  // DWM last re-measured and would import the ratchet drift into the math.
  let windowOrigin = { x: window.getBounds().x, y: window.getBounds().y }
  let dragAnchor: {
    pointerX: number
    pointerY: number
    originX: number
    originY: number
  } | undefined
  ipcMain.on('pet:drag-start', (event, screenX: unknown, screenY: unknown) => {
    try {
      if (event.sender !== window.webContents) return
      if (typeof screenX !== 'number' || typeof screenY !== 'number'
        || !Number.isFinite(screenX) || !Number.isFinite(screenY)) return
      dragAnchor = { pointerX: screenX, pointerY: screenY, originX: windowOrigin.x, originY: windowOrigin.y }
    } catch (error) {
      console.error('[pet] drag-start failed:', String(error), 'args:', JSON.stringify([screenX, screenY]))
    }
  })
  ipcMain.on('pet:drag-move', (event, screenX: unknown, screenY: unknown) => {
    try {
      const anchor = dragAnchor
      if (event.sender !== window.webContents || anchor === undefined) return
      if (typeof screenX !== 'number' || typeof screenY !== 'number'
        || !Number.isFinite(screenX) || !Number.isFinite(screenY)) {
        console.error(`[pet] drag-move rejected args: ${JSON.stringify([screenX, screenY])}`)
        return
      }
      const next = {
        x: Math.round(anchor.originX + (screenX - anchor.pointerX)),
        y: Math.round(anchor.originY + (screenY - anchor.pointerY)),
        width: WINDOW_SIZE.width,
        height: WINDOW_SIZE.height,
      }
      if (next.x === windowOrigin.x && next.y === windowOrigin.y) return
      windowOrigin = { x: next.x, y: next.y }
      window.setBounds(next)
    } catch (error) {
      console.error('[pet] drag-move failed:', String(error), 'args:', JSON.stringify([screenX, screenY]))
    }
  })
  ipcMain.on('pet:drag-end', (event) => {
    try {
      if (event.sender !== window.webContents) return
      dragAnchor = undefined
      // Remember where the user parked the pet; restored on the next launch
      // and clearable from the settings page.
      void writeFile(join(DSH_HOME, 'pet-window.json'), `${JSON.stringify(windowOrigin)}\n`, 'utf8')
        .catch((error: unknown) => { console.error('[pet] could not save the window position:', String(error)) })
    } catch (error) {
      console.error('[pet] drag-end failed:', String(error))
    }
  })

  // ── control interface ─────────────────────────────────────────────────────
  // The driver's four operations (§6 of DSH-PET.md) as local HTTP, hosted by
  // the main process (renderers cannot listen); the renderer consumes them
  // over IPC. v1 is loopback without auth — the callers are this machine's
  // runtime driver and petctl.
  const pendingInteractions = new Map<string, ServerResponse>()
  // The renderer's latest self-report; the /status mirror serves it beside the
  // main process's own facts.
  let statusSnapshot: Record<string, unknown> = { state: 'idle' }
  const touchEvents: Array<{ seq: number; type: 'touch'; part: string; at: number }> = []
  let touchSeq = 0
  ipcMain.on('pet:touch', (event, touch: { part?: unknown }) => {
    try {
      if (event.sender !== window.webContents) return
      const part = touch?.part === 'head' || touch?.part === 'body' ? touch.part : 'unknown'
      touchSeq += 1
      touchEvents.push({ seq: touchSeq, type: 'touch', part, at: Date.now() })
      if (touchEvents.length > 200) touchEvents.splice(0, touchEvents.length - 200)
      console.log(`[pet] touch #${String(touchSeq)} (${part})`)
    } catch (error) {
      console.error('[pet] touch failed:', String(error))
    }
  })
  ipcMain.on('pet:status-report', (event, snapshot: Record<string, unknown>) => {
    try {
      if (event.sender !== window.webContents) return
      statusSnapshot = snapshot
    } catch (error) {
      console.error('[pet] status-report failed:', String(error))
    }
  })
  ipcMain.on('pet:action-done', (event, done: { action?: unknown; durationMs?: unknown; requestId?: unknown }) => {
    try {
      if (event.sender !== window.webContents) return
      if (typeof done?.action !== 'string') return
      const requestId = typeof done.requestId === 'string' ? done.requestId : undefined
      const pending = requestId !== undefined ? pendingActionRequests.get(requestId) : undefined
      if (pending !== undefined && requestId !== undefined) pendingActionRequests.delete(requestId)
      lastActionDone = {
        // Tool-initiated actions are reported under the REQUESTED name; a
        // user-initiated reaction only has its clip file.
        action: pending !== undefined ? pending.requested : done.action,
        durationMs: typeof done.durationMs === 'number' && Number.isFinite(done.durationMs)
          ? done.durationMs
          : null,
        at: Date.now(),
        requestedBy: pending !== undefined ? 'tool' : 'user',
        ...(requestId !== undefined ? { requestId } : {}),
      }
    } catch (error) {
      console.error('[pet] action-done failed:', String(error))
    }
  })
  ipcMain.on('pet:interaction-answer', (event, message: { id?: unknown; answer?: unknown }) => {
    try {
      if (event.sender !== window.webContents) return
      if (typeof message?.id !== 'string' || !pendingInteractions.has(message.id)) return
      const response = pendingInteractions.get(message.id)
      pendingInteractions.delete(message.id)
      response?.end(` ${JSON.stringify({ ok: true, answer: message.answer ?? null })}`)
    } catch (error) {
      console.error('[pet] interaction-answer failed:', String(error))
    }
  })
  const control = createServer((req, res) => {
    const url = new URL(req.url ?? '/', 'http://127.0.0.1')
    const send = (status: number, body: unknown): void => {
      res.writeHead(status, { 'content-type': 'application/json', 'cache-control': 'no-store' })
      res.end(JSON.stringify(body))
    }
    if (req.method === 'GET' && url.pathname === '/events') {
      // The poll端点 for driver-side consumption: everything the user did to
      // the pet since `since`, plus the newest seq (a smaller newest than the
      // caller's last means the pet restarted; re-pull from 0).
      const since = Number(url.searchParams.get('since') ?? '0')
      send(200, { events: touchEvents.filter(e => e.seq > since), latest: touchSeq })
      return
    }
    if (req.method === 'GET' && url.pathname === '/capabilities') {
      send(200, {
        states: ['idle', 'thinking', 'working', 'error'],
        actions: ['celebrate'],
        interactions: ['approval', 'question'],
        events: ['touch'],
        endpoints: ['capabilities', 'status', 'state', 'action', 'say', 'interaction', 'events'],
      })
      return
    }
    if (url.pathname === '/status') {
      // The mirror: what the pet currently is doing, where it stands. `bubble`
      // is the delivery receipt for /say; lastAction/lastActionAt are the
      // observable trace of /action (override is not a reliable witness).
      // Both are ALWAYS present (null before the first /action) — a
      // conditionally-absent field is a JSON.stringify footgun: `undefined`
      // vanishes from the payload and consumers writing === null misjudge.
      const bounds = window.getBounds()
      send(200, {
        ...statusSnapshot,
        bubble: bubbleVisible,
        lastAction: lastAction ?? null,
        lastActionAt: lastActionAt ?? null,
        lastActionDone: lastActionDone ?? null,
        interaction: pendingInteractions.size > 0,
        window: { x: bounds.x, y: bounds.y, width: bounds.width, height: bounds.height },
        visible: window.isVisible(),
        pid: process.pid,
      })
      return
    }
    if (req.method !== 'POST') {
      send(405, { error: 'POST only' })
      return
    }
    let raw = ''
    req.setEncoding('utf8')
    req.on('data', (chunk: string) => { raw += chunk })
    req.on('end', () => {
      let body: Record<string, unknown>
      try {
        body = JSON.parse(raw) as Record<string, unknown>
      } catch {
        send(400, { error: 'invalid json' })
        return
      }
      if (url.pathname === '/state') {
        console.log(`[pet] control /state ${JSON.stringify(body)}`)
        window.webContents.send('pet:set-state', body)
        send(200, { ok: true })
        return
      }
      if (url.pathname === '/say') {
        // Fire-and-forget: the driver says something through the pet; the
        // bubble self-dismisses and never blocks a turn.
        const text = typeof body.text === 'string' ? body.text.slice(0, 200) : ''
        window.webContents.send('pet:say', { text })
        send(200, { ok: true })
        return
      }
      if (url.pathname === '/action') {
        // Record the request observably: one-shot playback is fire-and-forget
        // and the renderer's override is not a reliable witness (it may
        // set/clear within one tick) — consumers poll lastAction/lastActionAt
        // instead of guessing from override. The requestId threads through
        // the renderer's completion report, so lastActionDone names the
        // REQUESTED action and pet_do(wait) can match precisely.
        const requested = typeof body.action === 'string' ? body.action : 'unknown'
        const requestId = randomUUID()
        lastAction = requested
        lastActionAt = Date.now()
        pendingActionRequests.set(requestId, { requested, at: lastActionAt })
        window.webContents.send('pet:action', { ...body, requestId })
        send(200, { ok: true, action: requested, requestId })
        return
      }
      if (url.pathname === '/interaction') {
        // Long-poll: the response IS the user's choice. A driver that gives
        // up aborts the connection; the close handler withdraws the bubble.
        const id = randomUUID()
        res.writeHead(200, { 'content-type': 'application/json', 'cache-control': 'no-store' })
        pendingInteractions.set(id, res)
        // Leading whitespace is valid JSON framing: keepalive spaces stop an
        // idle-body timeout on the driver's fetch without touching the answer.
        const keepalive = setInterval(() => { res.write(' ') }, 60_000)
        res.on('close', () => {
          clearInterval(keepalive)
          if (pendingInteractions.delete(id)) {
            window.webContents.send('pet:interaction-cancel', { id })
          }
        })
        window.webContents.send('pet:interaction', { id, ...body })
        return
      }
      send(404, { error: 'unknown endpoint' })
    })
  })
  control.listen(Number(process.env.DSH_PET_HTTP_PORT ?? 0), '127.0.0.1', () => {
    const address = control.address()
    const port = typeof address === 'object' && address !== null ? address.port : 0
    console.log(`[pet] control interface on 127.0.0.1:${String(port)}`)
    // Registry publish: one file per pet under pet-http.d/ — no shared name,
    // no last-writer-wins race (the incident class that produced repeated
    // swap blindness). The legacy single file keeps being written during the
    // transition so pre-registry readers still see this carrier.
    const manifest = `${JSON.stringify({ port, pid: process.pid, since: Date.now(), pet: 'electron' })}\n`
    const registryDir = join(DSH_HOME, 'pet-http.d')
    try {
      mkdirSync(registryDir, { recursive: true })
    } catch (error: unknown) {
      console.error('[pet] could not create the pet registry:', String(error))
    }
    const writeManifest = (): void => {
      void writeFile(join(registryDir, 'electron.json'), manifest, 'utf8')
        .catch((error: unknown) => { console.error('[pet] could not write the registry entry:', String(error)) })
      void writeFile(join(DSH_HOME, 'pet-http-electron.json'), manifest, 'utf8')
        .catch(() => { /* legacy mirror: pre-registry readers only */ })
    }
    writeManifest()
    // Re-assert on a cadence so a stale publisher cannot shadow a live pet.
    setInterval(writeManifest, 10_000)
  })

  // Runtime watchdog: a driver-spawned pet outlives nothing. Dispose-time
  // kill only runs on the runtime's graceful shutdown; a terminated runtime
  // leaves a detached pet orphaned on the desktop. Poll the spawning
  // runtime's pid and exit with it.
  const runtimePid = Number(process.env.DSH_PET_RUNTIME_PID)
  if (Number.isInteger(runtimePid) && runtimePid > 0) {
    setInterval(() => {
      try {
        process.kill(runtimePid, 0)
      } catch {
        console.log('[pet] the spawning runtime is gone; exiting')
        app.quit()
      }
    }, 10_000)
  }

  window.on('closed', () => {
    // The window is the carrier's whole surface: closing it tears the profile down.
    void handle?.shutdown()
  })
  app.on('before-quit', (event) => {
    // Withdraw our registry entry (and the legacy mirror) so consumers never
    // find a dead port in pet-http.d/ — stale entries were the "旧端点残留"
    // incident class. Best effort: a killed carrier leaves the file, and the
    // readers' pid+probe validation is the backstop.
    for (const file of ['pet-http.d/electron.json', 'pet-http-electron.json']) {
      void rm(join(DSH_HOME, file), { force: true }).catch(() => { /* best effort */ })
    }
    if (handle === undefined) return
    event.preventDefault()
    const closing = handle.shutdown()
    handle = undefined
    void closing.then(() => app.quit())
  })
}

app.on('window-all-closed', () => {
  app.quit()
})
