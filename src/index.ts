/**
 * dsh-agentic-pet — the pet-surface bundle's runtime glue plugin plus
 * the bundle patch (`cordis.patch.yml`, declared by the `dsh.bundle.patch`
 * manifest field). The plugin owns the pet-surface glue: it resolves the built
 * pet renderer dist (workspace knowledge of this bundle, never user config)
 * and registers the `/pet` prefix route over the web composition, serving the
 * desktop pet's page through Connection's browser authentication — the same
 * token/cookie chain the Web GUI uses, so the desktop pet attaches to dsh as
 * an authenticated client (`interactions=answer`) rather than a file-bridge
 * observer. The route registers in the raw `handler` form and adapts to Fetch
 * at the edge, because resource-typed routes postdate the installed 0.2.1-rc.3
 * desktop webserver; Connection's authorizeIndex has the same version split
 * and is branched on a webserver capability probe. The dist location follows
 * the `@deepseek-ai/dsh-web-frontend` precedent: anchored on the app package
 * manifest, never configured.
 * @module dsh-agentic-pet
 */

import { execFileSync, spawn } from 'node:child_process'
import type { ChildProcess } from 'node:child_process'
import { createHash } from 'node:crypto'
import { appendFileSync, existsSync, readFileSync, statSync, unlinkSync, writeFileSync } from 'node:fs'
import { mkdir, readFile, unlink, writeFile } from 'node:fs/promises'
import type { IncomingMessage, ServerResponse } from 'node:http'
import { homedir } from 'node:os'
import { createRequire } from 'node:module'
import { dirname, extname, join, normalize, resolve, sep } from 'node:path'
import { fileURLToPath } from 'node:url'
import type { Context } from '@deepseek-ai/cordis'
import type {} from '@deepseek-ai/dsh-client-connection'
import type {} from '@deepseek-ai/dsh-host-webserver'
import { installPetDriver } from './driver.ts'
import { installLockStale, isProcessAlive, parseInstallLock } from './electron-lock.ts'
import { writeElectronRuntimeStatus, type ElectronRuntimeStatus } from './electron-runtime-status.ts'
import { installSettingsPage } from './settings-page.ts'
import { installPetService, petHome } from './service.ts'

/** Stable Cordis plugin name. */
export const name = 'pet-surface'

/**
 * Services required before the `/pet` route can register. `sessionController`
 * is a SIBLING plugin row's service (the api-session-controller row in the
 * same composition): a command-style ctx.get from this row's fiber never sees
 * it (the petTools/petService precedent), while static inject is resolved by
 * the Loader ACROSS rows and waits for that row to mount — the webServer
 * precedent. Every profile mounting this bundle mounts the web-app rows too,
 * so the dependency is always satisfiable.
 */
export const inject = ['webServer', 'connection', 'sessionController', 'workspaceController']

/** The URL path prefix the pet renderer is served under. No trailing slash. */
export const PET_PATH_PREFIX = '/whale598'
// ↑ 前缀含专属标识（whale598）：'/pet' 太通用，易与其他插件的路由注册撞车。

/**
 * Locator file naming this runtime's authenticated root for the pet carrier.
 * The desktop shell keeps its authenticated URL in process memory only, so a
 * bundle inside that runtime is the only component positioned to publish it.
 * The carrier prefers the env override, then this file's freshest live
 * publisher, then falls back to spawning its own profile.
 */
export function petLocatorPath(): string {
  // whale598/ 命名空间（与注册表/数据仓库一致）；载体 readLocatorUrl 双路读取
  return join(process.env.DSH_HOME ?? join(homedir(), '.dsh'), 'whale598', 'pet-surface-url.json')
}

const HTML_MIME = 'text/html; charset=utf-8'

const MIME: Record<string, string> = {
  '.html': HTML_MIME,
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.png': 'image/png',
  '.svg': 'image/svg+xml',
  '.webp': 'image/webp',
  '.ico': 'image/x-icon',
  '.json': 'application/json',
  '.map': 'application/json',
  '.webmanifest': 'application/manifest+json',
  '.woff2': 'font/woff2',
}

const STATIC_MISS_CODES: ReadonlySet<string | undefined> = new Set([
  'ENOENT',
  'EISDIR',
  'ENOTDIR',
])

/**
 * Dist location is workspace knowledge of this bundle: anchored on the pet app
 * package manifest, not configured. Existence is a request-time concern — the
 * route reads files per request, so a composition whose pet page is never
 * visited boots without the dist being built.
 */
function resolveDistIndex(): string {
  const require = createRequire(import.meta.url)
  try {
    // Source/暂装 layout: the renderer package's dist (canonical, freshly
    // built by every deploy).
    return join(dirname(require.resolve('@deepseek-ai/dsh-pet/package.json')), 'dist-renderer', 'index.html')
  } catch {
    // Installed-from-registry layout: @deepseek-ai/dsh-pet is not a
    // dependency of the published package — the tgz ships the same dist
    // inside carrier/ (files: carrier/**), one directory up from lib/.
    const shipped = join(dirname(fileURLToPath(import.meta.url)), '..', 'carrier', 'dist-renderer', 'index.html')
    if (existsSync(shipped)) return shipped
    throw new Error('pet-app: the pet renderer dist is not resolvable from this composition (neither @deepseek-ai/dsh-pet nor the shipped carrier dist)')
  }
}

/** A Response body that is `bytes` itself, without the copy a buffer body gets. */
function bytesBody(bytes: Uint8Array): ReadableStream<Uint8Array> {
  return new ReadableStream<Uint8Array>({
    start(controller) {
      controller.enqueue(bytes)
      controller.close()
    },
  })
}

/**
 * Answer one GET or HEAD `/pet` request. The URL path is the full server
 * pathname (`/pet` prefix included); it must be exactly the prefix or stay
 * under it. The index entry (`/whale598`, `/whale598/`, `/whale598/index.html`) passes
 * Connection's browser authentication; every other file is public with a weak
 * ETag and `cache-control: no-cache`, answering a matching `If-None-Match`
 * with 304. Traversal outside the dist root is 403, missing paths are 404, a
 * malformed percent-escape rejects (the adapter answers 400 over HTTP), and
 * non-GET/HEAD is 405. The index serves raw, deliberately NOT through
 * webServer.renderIndex: the web boot injections (opaque boot background,
 * module-system bootstrap) are Web-GUI concerns that would paint the
 * transparent pet window opaque.
 */
export async function servePetStatic(
  request: Request, distRoot: string, distIndex: string,
  authorizeIndex: () => Response | undefined,
): Promise<Response> {
  const pathname = decodeURIComponent(new URL(request.url).pathname)
  // Prefix guard: anything not under PET_PATH_PREFIX is an ordinary miss.
  // (The webserver only routes the prefix here, but servePetStatic is also
  // unit-driven — and a path SHORTER than the prefix would degenerate the
  // slice below into serving the index to a foreign path.)
  if (!(pathname === PET_PATH_PREFIX || pathname.startsWith(`${PET_PATH_PREFIX}/`))) {
    return new Response(null, { status: 404 })
  }
  const relative = pathname === PET_PATH_PREFIX || pathname === `${PET_PATH_PREFIX}/`
    ? '/'
    : pathname.slice(PET_PATH_PREFIX.length)
  const target = resolve(normalize(join(distRoot, relative)))
  // Traversal rejection: the target must be distRoot itself (`/`) or stay
  // under it. `sep`, not '/': resolve() emits backslash paths on Windows,
  // where a '/' suffix would reject every legitimate subpath as traversal.
  if (target !== distRoot && !target.startsWith(distRoot + sep)) return new Response(null, { status: 403 })
  let body: string | Uint8Array<ArrayBuffer>
  let headers: Record<string, string>
  try {
    if (target === distRoot || target === distIndex) {
      const refusal = authorizeIndex()
      if (refusal !== undefined) return refusal
      body = await readFile(distIndex, 'utf8')
      headers = { 'content-type': HTML_MIME }
    } else {
      body = await readFile(target)
      // Weak: gzip changes the transferred bytes.
      const cache = { 'cache-control': 'no-cache', etag: `W/"${createHash('sha1').update(body).digest('base64url')}"` }
      if (request.headers.get('if-none-match') === cache.etag) return new Response(null, { status: 304, headers: cache })
      headers = { 'content-type': MIME[extname(target)] ?? 'application/octet-stream', ...cache }
    }
  } catch (error) {
    // Only absent or non-file targets are 404; other filesystem failures reach
    // the adapter, which answers 400 over HTTP.
    if (!STATIC_MISS_CODES.has((error as NodeJS.ErrnoException).code)) throw error
    return new Response(null, { status: 404 })
  }
  if (request.method === 'HEAD') return new Response(null, { status: 200, headers })
  return new Response(typeof body === 'string' ? body : bytesBody(body), { status: 200, headers })
}

/** Connection's authorizeIndex across the resource-API version split. */
type AuthorizeIndex = ((
  request: Request,
  adapter: {
    writeHead(status: number, headers: Record<string, string>): unknown
    end(text?: string): unknown
  },
) => boolean)
  & ((req: IncomingMessage, res: ServerResponse) => boolean)

/** The environment minus Electron's Node-mode flag, so a spawned GUI child is a GUI child. */
function stripRunAsNode(env: NodeJS.ProcessEnv): NodeJS.ProcessEnv {
  const clean = { ...env }
  delete clean.ELECTRON_RUN_AS_NODE
  return clean
}

/** One raw webserver handler request's absolute URL. */
function absoluteUrl(req: IncomingMessage): string {
  return `http://${req.headers.host ?? '127.0.0.1'}${req.url ?? '/'}`
}

/** Normalize a node header value (string | string[] | undefined) for Fetch. */
function headerValue(value: string | string[] | undefined): string | undefined {
  return Array.isArray(value) ? value.join(', ') : value
}

/**
 * Register the `/pet` prefix route with a raw handler serving the pet renderer
 * dist, and publish the locator. The handler form predates resource-typed
 * routes, so one code path serves both the installed 0.2.1-rc.3 desktop
 * webserver and current builds; authorizeIndex branches on whether the
 * webserver carries the resource API (`readResource` arrived with it).
 * @param ctx - plugin context carrying the webServer and connection services.
 */
export function apply(ctx: Context): void {
  const distIndex = resolveDistIndex()
  const distRoot = dirname(distIndex)
  const authorizeIndex = ctx.connection as unknown as { authorizeIndex: AuthorizeIndex }
  const supportsResourceApi = typeof (ctx.webServer as { readResource?: unknown }).readResource === 'function'
  const authorizeToResponse = (req: IncomingMessage): Response | undefined => {
    if (supportsResourceApi) {
      // Current Connection writes its refusal through a Fetch adapter. The
      // synthetic Request carries the audience (Host) and the admission
      // cookie: audience mismatches reject an otherwise valid cookie.
      let status = 401
      let headers: Record<string, string> = {}
      let body: string | undefined
      const requestHeaders: Record<string, string> = {}
      const host = headerValue(req.headers.host)
      if (host !== undefined) requestHeaders.host = host
      const cookie = headerValue(req.headers.cookie)
      if (cookie !== undefined) requestHeaders.cookie = cookie
      const admitted = authorizeIndex.authorizeIndex(
        new Request(absoluteUrl(req), { headers: requestHeaders }),
        {
          writeHead(nextStatus, nextHeaders) {
            status = nextStatus
            headers = nextHeaders
          },
          end(text) { body = text },
        },
      )
      return admitted ? undefined : new Response(body ?? '', { status, headers })
    }
    // Pre-resource Connection form: authorizeIndex answers a refusal by
    // writing the raw response itself; capture that write as a Response.
    let status = 401
    let headers: Record<string, string> = {}
    let body: string | undefined
    const capture = {
      writeHead(nextStatus: number, nextHeaders?: Record<string, string>): void {
        status = nextStatus
        headers = nextHeaders ?? {}
      },
      setHeader(name: string, value: unknown): void { headers[name] = String(value) },
      end(text?: string | Uint8Array): void { if (text !== undefined) body = String(text) },
    } as unknown as ServerResponse
    const admitted = authorizeIndex.authorizeIndex(req, capture)
    return admitted ? undefined : new Response(body ?? '', { status, headers })
  }
  ctx.effect(() => ctx.webServer.register({
    kind: 'prefix',
    path: PET_PATH_PREFIX,
    handler: async (req: IncomingMessage, res: ServerResponse): Promise<void> => {
      const ifNoneMatch = headerValue(req.headers['if-none-match'])
      const request = new Request(absoluteUrl(req), {
        method: req.method ?? 'GET',
        ...(ifNoneMatch === undefined ? {} : { headers: { 'if-none-match': ifNoneMatch } }),
      })
      const response = await servePetStatic(request, distRoot, distIndex, () => authorizeToResponse(req))
      res.writeHead(response.status, Object.fromEntries(response.headers.entries()))
      if (req.method === 'HEAD' || response.body === null) {
        res.end()
        return
      }
      res.end(Buffer.from(await response.arrayBuffer()))
    },
  } as Parameters<typeof ctx.webServer.register>[0]), 'pet-surface: /pet route')

  // Publish the locator after the tree settles (the webserver's port is part
  // of the boot the Loader still owns mid-activation), mirroring how web-app
  // times its URL line. A hand-built tree without a Loader is already whole.
  const authenticatedRoot = (): string | undefined => {
    if (ctx.get('webServer') === undefined || ctx.get('connection') === undefined) return undefined
    return ctx.connection.authenticatedUrl(`${ctx.webServer.protocol}//127.0.0.1:${String(ctx.webServer.port)}`)
  }
  const publishLocator = (url: string): void => {
    const record = `${JSON.stringify({ url, since: Date.now(), pid: process.pid })}\n`
    void mkdir(dirname(petLocatorPath()), { recursive: true })
      .then(() => writeFile(petLocatorPath(), record, 'utf8'))
      .catch((error: unknown) => {
        console.error(`pet-surface: could not write the locator file: ${error instanceof Error ? error.message : String(error)}`)
      })
  }
  /** Carrier spawn diagnostics; the packaged host's stderr is not visible. */
  const logCarrier = (line: string): void => {
    try {
      appendFileSync(join(dirname(petLocatorPath()), 'carrier-spawn.log'), `${new Date().toISOString()} ${line}\n`, 'utf8')
    } catch { /* diagnostics stay best-effort */ }
  }
  /**
   * The desktop profile directory is Low-integrity (inheritable), so an
   * electron.exe installed into it by pnpm inherits Low and Chromium crashes
   * on spawn (exit 0x80000003). The host itself runs at Medium, so raising
   * the label in place is enough; a later pnpm install that re-creates the
   * files is healed the same way on the next activation.
   */
  const ensureElectronUsable = (binary: string): string => {
    if (process.platform !== 'win32') return binary
    try {
      const acl = execFileSync('icacls', [binary], { encoding: 'utf8', windowsHide: true })
      if (!/Low Mandatory Level/i.test(acl)) return binary
      execFileSync('icacls', [dirname(binary), '/setintegritylevel', '(OI)(CI)M', '/T'], {
        windowsHide: true, stdio: 'ignore', timeout: 30_000,
      })
      logCarrier(`raised electron integrity to Medium: ${dirname(binary)}`)
    } catch (error) {
      logCarrier(`could not raise electron integrity: ${error instanceof Error ? error.message : String(error)}`)
    }
    return binary
  }
  /**
   * Locate the npm `electron` package WITHOUT loading it. Loading the module
   * (`require('electron')`) runs its lazy installer synchronously — a ~250 MB
   * download inside the host's event loop — so only the manifest is resolved
   * here; installing is a separate, background step.
   */
  const findNpmElectronPackage = (): string | undefined => {
    try {
      const require = createRequire(import.meta.url)
      const pkgDir = dirname(require.resolve('electron/package.json'))
      if (existsSync(join(pkgDir, 'package.json'))) return pkgDir
    } catch { /* no package.json export; fall back to the walk-up */ }
    try {
      let dir = dirname(fileURLToPath(import.meta.url))
      for (let i = 0; i < 8; i += 1) {
        const pkgDir = join(dir, 'node_modules', 'electron')
        if (existsSync(join(pkgDir, 'package.json'))) return pkgDir
        const parent = dirname(dir)
        if (parent === dir) break
        dir = parent
      }
    } catch { /* electron dependency not found on disk */ }
    return undefined
  }
  const npmElectronBinary = (pkgDir: string): string | undefined => {
    try {
      const exe = readFileSync(join(pkgDir, 'path.txt'), 'utf8').trim()
      const binary = join(pkgDir, 'dist', exe)
      return existsSync(binary) ? binary : undefined
    } catch { return undefined }
  }
  const installLockPath = (pkgDir: string): string => join(pkgDir, '.dsh-pet-install.lock')
  const acquireInstallLock = (pkgDir: string): boolean => {
    const lock = installLockPath(pkgDir)
    const write = (): void => { writeFileSync(lock, JSON.stringify({ pid: process.pid, at: Date.now() }), { flag: 'wx' }) }
    try {
      write()
      return true
    } catch { /* the lock already exists; inspect its owner */ }
    let raw: string | undefined
    let mtimeMs = 0
    try {
      raw = readFileSync(lock, 'utf8')
      mtimeMs = statSync(lock).mtimeMs
    } catch {
      // The lock vanished between the failed create and this read: try to own it.
      try { write(); return true } catch { return false }
    }
    const owner = raw === undefined ? undefined : parseInstallLock(raw)?.pid
    const ownerPid = typeof owner === 'number' ? owner : undefined
    if (!installLockStale(raw, mtimeMs, Date.now())) {
      logCarrier(ownerPid === undefined
        ? `electron install lock unreadable but fresh; waiting: ${lock}`
        : `electron install lock held by pid ${String(ownerPid)} (alive); waiting: ${lock}`)
      return false
    }
    const dead = ownerPid !== undefined && !isProcessAlive(ownerPid)
    logCarrier(`electron install lock stale (${ownerPid === undefined ? 'unreadable' : `pid ${String(ownerPid)} ${dead ? 'dead' : 'expired'}`}); taking over: ${lock}`)
    try { unlinkSync(lock) } catch { /* another activation removed it first */ }
    try {
      write()
      return true
    } catch {
      return false
    }
  }
  const releaseInstallLock = (pkgDir: string): void => {
    const lock = installLockPath(pkgDir)
    try {
      const owner = parseInstallLock(readFileSync(lock, 'utf8'))?.pid
      // A takeover after the absolute cap may have replaced our lock; never
      // delete the new owner's file on the way out.
      if (typeof owner === 'number' && owner !== process.pid) return
    } catch { /* unreadable or already gone: fall through to cleanup */ }
    try { unlinkSync(lock) } catch { /* already gone */ }
  }
  const NPMMIRROR_ELECTRON = 'https://npmmirror.com/mirrors/electron/'
  const INSTALL_TIMEOUT_MS = 20 * 60_000
  let activeInstallChild: ChildProcess | undefined

  const writeRuntimeStatus = (status: ElectronRuntimeStatus): void => {
    writeElectronRuntimeStatus(petHome(), status)
  }

  type ElectronInstallResult =
    | { kind: 'installed'; binary: string }
    | { kind: 'busy' }
    | { kind: 'failed'; error: string }
    | { kind: 'unavailable'; error: string }

  /**
   * Install the npm electron binary off the activation path. The package's
   * lazy installer is a large download; running it synchronously (which
   * `require('electron')` does) freezes the host, so it runs as a child with
   * progress in the spawn log. The lock is owner-liveness based: a host that
   * dies mid-download never blocks the next activation.
   */
  const installNpmElectron = async (pkgDir: string, attempt: number): Promise<ElectronInstallResult> => {
    const installer = join(pkgDir, 'install.js')
    if (!existsSync(installer)) {
      logCarrier(`electron binary missing and install.js not found: ${pkgDir}`)
      writeRuntimeStatus({ state: 'unavailable', updatedAt: Date.now(), error: `install.js not found in ${pkgDir}` })
      return { kind: 'unavailable', error: `install.js not found in ${pkgDir}` }
    }
    if (!acquireInstallLock(pkgDir)) {
      writeRuntimeStatus({ state: 'busy', updatedAt: Date.now() })
      return { kind: 'busy' }
    }
    const explicitMirror = (process.env.ELECTRON_MIRROR ?? process.env.npm_config_electron_mirror ?? '').trim()
    const mirror = explicitMirror !== ''
      ? explicitMirror
      : attempt % 2 === 0 ? NPMMIRROR_ELECTRON : undefined
    const source = explicitMirror !== '' ? 'explicit' : mirror === undefined ? 'github' : 'npmmirror'
    const startedAt = Date.now()
    writeRuntimeStatus({ state: 'downloading', updatedAt: startedAt, startedAt, attempt: attempt + 1, source })
    logCarrier(`electron binary missing; installing in background (attempt ${String(attempt + 1)}, source=${source}): ${pkgDir}`)
    return await new Promise<ElectronInstallResult>((resolveInstall) => {
      let settled = false
      let timeout: NodeJS.Timeout | undefined
      const finish = (result: ElectronInstallResult): void => {
        if (settled) return
        settled = true
        if (timeout !== undefined) clearTimeout(timeout)
        activeInstallChild = undefined
        releaseInstallLock(pkgDir)
        if (result.kind === 'installed') {
          writeRuntimeStatus({ state: 'ready', updatedAt: Date.now(), startedAt, finishedAt: Date.now(), attempt: attempt + 1, source })
        } else if (result.kind === 'failed') {
          writeRuntimeStatus({ state: 'failed', updatedAt: Date.now(), startedAt, attempt: attempt + 1, source, error: result.error })
        }
        resolveInstall(result)
      }
      let stderr = ''
      let stdout = ''
      let lastProgress = 0
      const env: NodeJS.ProcessEnv = { ...process.env, ELECTRON_RUN_AS_NODE: '1' }
      if (mirror === undefined) {
        delete env.ELECTRON_MIRROR
        delete env.npm_config_electron_mirror
      } else {
        env.ELECTRON_MIRROR = mirror
      }
      let child: ChildProcess
      try {
        child = spawn(process.execPath, [installer], {
          cwd: pkgDir,
          env,
          stdio: ['ignore', 'pipe', 'pipe'],
          windowsHide: true,
        })
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error)
        logCarrier(`electron install failed to start: ${message}`)
        finish({ kind: 'failed', error: message })
        return
      }
      activeInstallChild = child
      timeout = setTimeout(() => {
        logCarrier(`electron install timed out after ${String(INSTALL_TIMEOUT_MS / 60_000)} min (source=${source}); killing pid=${String(child.pid ?? 'unknown')}`)
        child.kill()
        finish({ kind: 'failed', error: `timed out after ${String(INSTALL_TIMEOUT_MS / 60_000)} min` })
      }, INSTALL_TIMEOUT_MS)
      child.stdout?.setEncoding('utf8')
      child.stdout?.on('data', (chunk: string) => {
        stdout = `${stdout}${chunk}`.slice(-2_000)
        const now = Date.now()
        if (now - lastProgress > 5_000) {
          lastProgress = now
          const line = stdout.split(/\r?\n/).map(part => part.trim()).filter(Boolean).pop()
          if (line !== undefined) logCarrier(`electron install: ${line}`)
        }
      })
      child.stderr?.setEncoding('utf8')
      child.stderr?.on('data', (chunk: string) => { stderr = `${stderr}${chunk}`.slice(-2_000) })
      child.on('error', (error: Error) => {
        logCarrier(`electron install failed to start: ${error.message}`)
        finish({ kind: 'failed', error: error.message })
      })
      child.on('exit', (code: number | null) => {
        if (code !== 0) {
          const detail = stderr.trim() || 'no stderr'
          logCarrier(`electron install failed (exit ${String(code)}, source=${source}): ${detail}`)
          finish({ kind: 'failed', error: `exit ${String(code)}: ${detail}` })
          return
        }
        const binary = npmElectronBinary(pkgDir)
        if (binary === undefined) {
          logCarrier(`electron install exited 0 but the binary is still missing: ${pkgDir}`)
          finish({ kind: 'failed', error: 'binary still missing after a successful install' })
          return
        }
        logCarrier(`electron installed: ${binary}`)
        finish({ kind: 'installed', binary: ensureElectronUsable(binary) })
      })
    })
  }
  /**
   * Auto-start the pet window. A bare Electron binary runs any app directory
   * (`electron.exe <dir>`), but a PACKAGED one (the installed desktop) loads
   * its own app and dies on its single-instance lock instead — so the
   * resolution order is an explicit env override, a binary staged beside this
   * package, then the `electron` npm dependency. The carrier's single-instance
   * lock collapses duplicates.
   */
  const resolveElectron = (): { binary?: string; npmPackageDir?: string } => {
    const override = process.env.DSH_PET_ELECTRON
    if (override !== undefined && override !== '') {
      if (existsSync(override)) return { binary: override }
      logCarrier(`DSH_PET_ELECTRON is set but missing, falling back: ${override}`)
    }
    const pkgRoot = resolve(join(dirname(fileURLToPath(import.meta.url)), '..'))
    const staged = join(pkgRoot, 'electron-bin',
      process.platform === 'win32' ? 'electron.exe'
        : process.platform === 'darwin' ? join('Electron.app', 'Contents', 'MacOS', 'Electron')
          : 'electron')
    if (existsSync(staged)) return { binary: staged }
    const npmPackageDir = findNpmElectronPackage()
    if (npmPackageDir !== undefined) {
      const binary = npmElectronBinary(npmPackageDir)
      if (binary !== undefined) return { binary: ensureElectronUsable(binary) }
      return { npmPackageDir }
    }
    logCarrier('no electron binary: no staged electron-bin, no npm electron dependency, and DSH_PET_ELECTRON is unset')
    return {}
  }
  const launchCarrier = (url: string, carrierDir: string, electronBinary: string): void => {
    // Escape hatch, never a default: some security suites refuse to let
    // Electron initialise its Chromium sandbox, and the carrier then dies
    // before a line of app code runs. Probing and quietly downgrading would put
    // every user on a sandbox-less renderer the moment a probe misfires, so the
    // plugin launches what the caller asked for; an operator who needs the
    // workaround sets DSH_PET_NO_SANDBOX=1 deliberately.
    const launchArgs = [carrierDir]
    if (process.env.DSH_PET_NO_SANDBOX === '1') launchArgs.push('--no-sandbox')
    // A packaged desktop host has no visible stderr, so the spawn decision and
    // whatever the child manages to say before dying go to a file next to the
    // locator.
    logCarrier(`spawn binary=${electronBinary} args=${JSON.stringify(launchArgs)} pid=${String(process.pid)}`)
    const child = ((): ReturnType<typeof spawn> | undefined => {
      try {
        return spawn(electronBinary, launchArgs, {
          // The host often runs inside its own Electron binary in Node mode
          // (ELECTRON_RUN_AS_NODE=1, e.g. the desktop's host child); inheriting
          // that flag would boot the carrier headless in Node mode too.
          env: {
            ...stripRunAsNode(process.env),
            DSH_PET_URL: url,
            // The carrier's liveness anchor: dispose-time kill never runs when
            // the runtime is terminated (only on graceful shutdown), and a
            // detached child escapes OS tree-kills — the carrier polls this pid
            // itself.
            DSH_PET_RUNTIME_PID: String(process.pid),
          },
          detached: true,
          stdio: ['ignore', 'pipe', 'pipe'],
        })
      } catch (error) {
        logCarrier(`spawn threw: ${error instanceof Error ? error.message : String(error)}`)
        return undefined
      }
    })()
    if (child === undefined) return
    logCarrier(`spawned pid=${String(child.pid ?? 'unknown')}`)
    let stderrTail = ''
    // Piped, not ignored: the carrier's diagnostics (control-interface calls,
    // load failures) are the only visibility into an auto-started pet.
    child.stdout?.setEncoding('utf8')
    child.stdout?.on('data', (chunk: string) => { process.stdout.write(`[pet-carrier] ${chunk}`) })
    child.stderr?.setEncoding('utf8')
    child.stderr?.on('data', (chunk: string) => {
      stderrTail = (stderrTail + chunk).slice(-2_000)
      process.stderr.write(`[pet-carrier] ${chunk}`)
    })
    child.on('error', (error) => { logCarrier(`child error: ${error.message}`) })
    child.on('exit', (code, signal) => {
      logCarrier(`child exit code=${String(code)} signal=${String(signal)} stderr=${JSON.stringify(stderrTail.slice(-700))}`)
    })
    child.unref()
    ctx.effect(() => () => { child.kill() }, 'pet-surface: carrier shutdown')
  }
  const RETRY_DELAYS_MS = [30_000, 60_000, 120_000, 300_000] as const
  let disposed = false
  let carrierLaunched = false
  let installInFlight = false
  let installAttempt = 0
  let retryTimer: NodeJS.Timeout | undefined

  const launchOnce = (url: string, carrierDir: string, binary: string): void => {
    if (disposed || carrierLaunched) return
    carrierLaunched = true
    if (retryTimer !== undefined) {
      clearTimeout(retryTimer)
      retryTimer = undefined
    }
    launchCarrier(url, carrierDir, binary)
  }

  const ensureCarrier = async (url: string, carrierDir: string, pkgDir: string): Promise<void> => {
    if (disposed || carrierLaunched) return
    // Re-resolve on every attempt: another runtime may have finished the install.
    const resolution = resolveElectron()
    if (resolution.binary !== undefined) {
      writeRuntimeStatus({ state: 'ready', updatedAt: Date.now() })
      launchOnce(url, carrierDir, resolution.binary)
      return
    }
    const nextPkgDir = resolution.npmPackageDir ?? pkgDir
    if (installInFlight) return
    installInFlight = true
    const attempt = installAttempt
    installAttempt += 1
    const result = await installNpmElectron(nextPkgDir, attempt).catch((error: unknown): ElectronInstallResult => ({
      kind: 'failed',
      error: error instanceof Error ? error.message : String(error),
    }))
    installInFlight = false
    if (disposed || carrierLaunched) return
    if (result.kind === 'installed') {
      launchOnce(url, carrierDir, result.binary)
      return
    }
    if (result.kind === 'unavailable') {
      logCarrier(`electron auto-install unavailable: ${result.error}`)
      return
    }
    const reason = result.kind === 'busy' ? 'blocked by another activation' : `failed (${result.error})`
    const delay = RETRY_DELAYS_MS[Math.min(installAttempt - 1, RETRY_DELAYS_MS.length - 1)]
    logCarrier(`electron install ${reason}; retrying in ${String(delay / 1_000)}s`)
    if (retryTimer !== undefined) clearTimeout(retryTimer)
    retryTimer = setTimeout(() => { void ensureCarrier(url, carrierDir, nextPkgDir) }, delay)
  }

  const spawnPetCarrier = (url: string): void => {
    const carrierDir = resolve(join(dirname(fileURLToPath(import.meta.url)), '..', 'carrier'))
    if (process.env.DSH_PET_NO_SPAWN === '1' || !existsSync(join(carrierDir, 'package.json'))) return
    const resolution = resolveElectron()
    if (resolution.binary !== undefined) {
      writeRuntimeStatus({ state: 'ready', updatedAt: Date.now() })
      launchOnce(url, carrierDir, resolution.binary)
      return
    }
    if (resolution.npmPackageDir === undefined) {
      logCarrier('no electron binary and no npm electron package; cannot auto-install')
      writeRuntimeStatus({ state: 'unavailable', updatedAt: Date.now(), error: 'electron package not installed' })
      return
    }
    void ensureCarrier(url, carrierDir, resolution.npmPackageDir)
  }
  const settledReady = (): void => {
    const url = authenticatedRoot()
    if (url === undefined) return
    publishLocator(url)
    // Multi-pet: the registry decides who is driven. The electron carrier
    // still auto-spawns (it IS this bundle's pet); the user's settings-page
    // close control and the pure pet's own supervision govern the rest. The
    // old activePet gate retired with the single-manifest design.
    spawnPetCarrier(url)
  }
  const settled = ctx.get('loader')?.await()
  if (settled === undefined) settledReady()
  else void settled.then(settledReady).catch(() => { /* boot owns the failure diagnostic */ })

  // The DSH-knowledge half (§7.2): converge this runtime's in-process events
  // into pet operations over the control interface. Installed regardless of
  // spawning — a manually launched pet is driven through the same manifest.
  // The pet capability seam first: discovery, liveness, and /status
  // normalization live behind it. The INSTANCE is passed to the imperative
  // consumers below — ctx.petService GETTER access from the same tick does
  // not wait for queued plugin fibers and threw "not found", failing the
  // whole apply (routes rolled back, locator withdrawn, carrier killed).
  // Future external plugins can still inject: ['petService'].
  // The dsh home (~/.dsh) is the one base every petdata/global helper joins
  // WHALE_DIR onto. NEVER derive it from the locator file's dirname — that
  // coupling silently rebased the whole driver when the locator moved under
  // whale598/ and doubled every path (whale598/whale598/).
  const home = petHome()
  const pet = installPetService(ctx, home)

  installPetDriver(ctx, home, pet)

  // The model-expression tools moved behind the pet preset (presets/pet.patch.yml
  // composes the ./tools entry) — sessions mounting other presets keep a clean
  // tool catalog. The host-side glue above stays unconditional.
  // The desktop sidebar settings page's host half (client half: ./client/).
  installSettingsPage(ctx, home, pet)
  // Stop the retry loop and our install child when this runtime unloads. If
  // the process dies before the exit handler runs, the lock's owner liveness
  // lets the next activation take over instead of waiting out a grace period.
  ctx.effect(() => () => {
    disposed = true
    if (retryTimer !== undefined) clearTimeout(retryTimer)
    activeInstallChild?.kill()
  }, 'pet-surface: electron install cleanup')
  // Withdraw on dispose while still our own entry, so a shut-down runtime does
  // not shadow a live publisher's file.
  ctx.effect(() => () => {
    void readFile(petLocatorPath(), 'utf8').then((raw: string) => {
      const record = JSON.parse(raw) as { pid?: unknown }
      if (record.pid === process.pid) return unlink(petLocatorPath())
      return undefined
    }).catch(() => { /* absent or unreadable: nothing to withdraw */ })
  }, 'pet-surface: locator withdrawal')
}
