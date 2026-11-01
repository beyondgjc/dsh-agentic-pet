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
import { app, BrowserWindow, ipcMain, Menu, protocol, screen, session } from 'electron';
import { spawn } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync } from 'node:fs';
import { readFile, readdir, rm, writeFile } from 'node:fs/promises';
import { createServer } from 'node:http';
import { homedir } from 'node:os';
import { dirname, join, normalize, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createRequire } from 'node:module';
import { createSayTts } from "./tts.js";
const HERE = dirname(fileURLToPath(import.meta.url));
const PET_PROFILE_NAME = 'pet';
const ASSET_SCHEME = 'pet-asset';
/** Bounded wait for the profile child's graceful shutdown before it is left to the OS. */
const SHUTDOWN_TIMEOUT_MS = 10_000;
/** The dsh home this carrier shares with the driver (manifest, settings). */
const DSH_HOME = process.env.DSH_HOME ?? join(homedir(), '.dsh');
/**
 * The character the pet page displays. Keep in sync with
 * src/renderer/main.ts (no shared module: the renderer is a separate vite
 * build; the catalog scan and the /action validation must cover the SAME
 * character the renderer can actually play).
 */
const CHARACTER = 'whale';
/**
 * Derive the action catalog from the media tree: categories are the
 * directories under characters/<id>/videos, clips are the .webm files inside
 * them (one nested level is flattened — events/balance). Scanning disk (not
 * a checked-in index) keeps an asset-package update from requiring a code
 * change. Failure degrades to an empty catalog — the pet then advertises
 * only the universal `celebrate` alias, i.e. yesterday's behavior.
 */
async function scanActionCatalog() {
    const videosRoot = join(resolveAssetsRoot(), CHARACTER, 'videos');
    const entries = [];
    const seen = new Set();
    const collect = async (dir, relativeDir) => {
        const items = await readdir(dir, { withFileTypes: true }).catch(() => null);
        if (items === null)
            return;
        for (const item of items) {
            if (item.isDirectory()) {
                await collect(join(dir, item.name), relativeDir === '' ? item.name : `${relativeDir}/${item.name}`);
                continue;
            }
            if (!item.name.toLowerCase().endsWith('.webm'))
                continue;
            const id = item.name.slice(0, -5);
            if (id === '' || seen.has(id))
                continue; // first wins; clip ids are unique in practice
            seen.add(id);
            entries.push({ id, dir: relativeDir, file: id });
        }
    };
    const categories = await readdir(videosRoot, { withFileTypes: true }).catch(() => null);
    if (categories === null)
        return entries; // no media: celebrate-only catalog
    for (const category of categories) {
        if (category.isDirectory())
            await collect(join(videosRoot, category.name), category.name);
    }
    return entries;
}
/**
 * The window's one canonical size: creation and every drag setBounds pin it.
 * A position-only setPosition re-sends whatever size DWM last re-measured the
 * transparent frameless window to, which ratchets +1px per call; an explicit
 * size can at worst oscillate, never accumulate.
 */
const WINDOW_SIZE = { width: 460, height: 560 };
/** A rect from a loose payload; null unless all four members are finite
 * numbers (defensive extraction — the /status, /world and persistence paths
 * share it). */
function rectOf(value) {
    if (typeof value !== 'object' || value === null)
        return null;
    const record = value;
    const num = (key) => typeof record[key] === 'number' && Number.isFinite(record[key]) ? record[key] : null;
    const x = num('x');
    const y = num('y');
    const width = num('width');
    const height = num('height');
    return x !== null && y !== null && width !== null && height !== null ? { x, y, width, height } : null;
}
/** Open-interval intersection: touching edges share no area. */
function rectsIntersect(a, b) {
    return a.x < b.x + b.width && b.x < a.x + a.width && a.y < b.y + b.height && b.y < a.y + a.height;
}
/** Clamp a scalar into [low, high]; a degenerate range (smaller world than
 * the window) collapses to its low edge so the rect still pins inside. */
function clampInto(value, low, high) {
    return high < low ? low : Math.min(Math.max(value, low), high);
}
process.env.ELECTRON_DISABLE_SECURITY_WARNINGS = 'true';
// ── boot logger (diagnostic injection, remove after incident) ──────────────
import { appendFileSync as __afs } from 'node:fs';
const __bootLog = (line) => {
    try {
        __afs('C:/Users/beyondguo/.dsh/whale598/carrier-boot.log', `${new Date().toISOString()} ${line}\n`);
    }
    catch { /* ignore */ }
};
__bootLog(`BOOT pid=${process.pid} argv=${JSON.stringify(process.argv.slice(1))} runAsNode=${process.env.ELECTRON_RUN_AS_NODE ?? 'unset'} nodeOptions=${process.env.NODE_OPTIONS ?? 'unset'} dshPetUrl=${process.env.DSH_PET_URL ? 'set' : 'unset'} cwd=${process.cwd()}`);
process.on('uncaughtException', (e) => { __bootLog(`UNCAUGHT ${e.stack ?? String(e)}`); });
process.on('unhandledRejection', (e) => { __bootLog(`REJECTION ${String(e)}`); });
// ── boot logger end ─────────────────────────────────────────────────────────
// Route main-process crashes to the log instead of the dialog: an uncaught
// exception in an IPC handler or poller otherwise dies as a modal error box
// with the stack truncated, leaving nothing to diagnose from.
process.on('uncaughtException', (error) => {
    console.error(`[pet] uncaughtException: ${error.stack ?? String(error)}`);
});
process.on('unhandledRejection', (reason) => {
    console.error(`[pet] unhandledRejection: ${String(reason)}`);
});
// CDP diagnostics (page state reads, synthetic input), requested by the
// DSH_PET_CDP env or the settings page's debug switch (read synchronously —
// this runs pre-ready; the switch only takes hold on the next launch).
let cdpRequested = process.env.DSH_PET_CDP === '1';
try {
    const settings = JSON.parse(readFileSync(join(DSH_HOME, 'pet-settings.json'), 'utf8'));
    if (settings.debug?.cdp === true)
        cdpRequested = true;
}
catch {
    // Absent or unreadable settings: env is the only request channel.
}
if (cdpRequested) {
    app.commandLine.appendSwitch('remote-debugging-port', '9222');
}
// Registered before app ready, per Electron protocol registration rules. The
// scheme carries the pet's media under its path; media elements load it
// no-cors, so no CORS privilege is required.
protocol.registerSchemesAsPrivileged([
    // corsEnabled + an ACAO header on every response: the WebGL stage uploads
    // the video frames as textures, and a cross-origin media element without a
    // CORS-clean response taints the context (texImage2D SecurityError).
    { scheme: ASSET_SCHEME, privileges: { supportFetchAPI: true, stream: true, corsEnabled: true } },
]);
if (!app.requestSingleInstanceLock()) {
    app.quit();
}
else {
    app.on('second-instance', () => {
        const window = BrowserWindow.getAllWindows()[0];
        window?.show();
    });
    void main();
}
/** The local directory the pet's animation media is read from. */
function resolveAssetsRoot() {
    const configured = process.env.DSH_PET_ASSETS_DIR;
    if (configured !== undefined && configured !== '')
        return resolve(configured);
    // Packaged layout: the carrier ships beside an assets directory (a junction
    // or copy staged next to lib/).
    const besideCarrier = resolve(HERE, '..', 'assets', 'characters');
    if (existsSync(besideCarrier))
        return besideCarrier;
    // npm assets package: dsh-agentic-pet-assets ships assets/characters as
    // plain files — the media channel for plugin installs from the registry
    // (the 50MB media deliberately stays out of the pet-app package itself).
    try {
        const require = createRequire(import.meta.url);
        const pkg = require.resolve('dsh-agentic-pet-assets/package.json');
        const packaged = resolve(dirname(pkg), 'assets', 'characters');
        if (existsSync(packaged))
            return packaged;
    }
    catch {
        // assets package not installed: fall through
    }
    // Source-checkout fallback: the media lives in the bundle's carrier tree
    // (gitignored, staged locally). lib/ → apps/pet → apps → deepseek-harness,
    // then into packages/bundle/pet-app/carrier.
    return resolve(HERE, '..', '..', '..', 'packages', 'bundle', 'pet-app', 'carrier', 'assets', 'characters');
}
function registerAssetProtocol() {
    const assetsRoot = resolveAssetsRoot();
    protocol.handle(ASSET_SCHEME, (request) => {
        const url = new URL(request.url);
        const relative = decodeURIComponent(url.pathname);
        const target = resolve(normalize(join(assetsRoot, relative)));
        if (target !== assetsRoot && !target.startsWith(assetsRoot + sep)) {
            return new Response(null, { status: 403 });
        }
        return netFetchFile(target);
    });
}
async function netFetchFile(target) {
    try {
        const bytes = await readFile(target);
        return new Response(bytes, {
            headers: {
                'content-type': mimeOf(target),
                'access-control-allow-origin': '*',
            },
        });
    }
    catch {
        return new Response(null, { status: 404 });
    }
}
function mimeOf(target) {
    switch (target.split('.').pop()?.toLowerCase()) {
        case 'webm': return 'video/webm';
        case 'gif': return 'image/gif';
        case 'png': return 'image/png';
        case 'json': return 'application/json';
        default: return 'application/octet-stream';
    }
}
/**
 * Spawn the pet profile child (Electron binary in Node mode running the
 * profile runner) and resolve its authenticated URL. The child owns the
 * Cordis tree; the carrier only supervises it.
 */
function spawnHostChild() {
    const hostChild = join(HERE, 'host-child.js');
    if (!existsSync(hostChild)) {
        throw new Error('pet: this carrier build has no self-spawn support (host-child.js absent); it expects DSH_PET_URL from a spawning runtime');
    }
    const child = spawn(process.execPath, [hostChild], {
        env: { ...process.env, ELECTRON_RUN_AS_NODE: '1' },
        stdio: ['ignore', 'pipe', 'pipe', 'ipc'],
    });
    let stderr = '';
    child.stderr?.setEncoding('utf8');
    child.stderr?.on('data', (chunk) => { stderr += chunk; });
    // Forward the profile's console (the readiness URL line is the carrier
    // user's entry point to the Web GUI) instead of letting it sit in the pipe.
    child.stdout?.setEncoding('utf8');
    child.stdout?.on('data', (chunk) => { process.stdout.write(chunk); });
    child.stderr?.on('data', (chunk) => { process.stderr.write(chunk); });
    const url = new Promise((resolveUrl, rejectUrl) => {
        const timer = setTimeout(() => {
            rejectUrl(new Error(`pet host: the profile child did not report ready within 120s\n${stderr.slice(-2000)}`));
        }, 120_000);
        child.on('message', (message) => {
            if (message?.type !== 'ready')
                return;
            clearTimeout(timer);
            resolveUrl(String(message.url));
        });
        child.on('exit', (code) => {
            clearTimeout(timer);
            rejectUrl(new Error(`pet host: the profile child exited with code ${String(code)} before ready\n${stderr.slice(-2000)}`));
        });
    });
    return {
        child,
        url,
        shutdown: () => new Promise((resolveShutdown) => {
            if (child.exitCode !== null || child.signalCode !== null) {
                resolveShutdown();
                return;
            }
            const timer = setTimeout(() => {
                child.kill();
                resolveShutdown();
            }, SHUTDOWN_TIMEOUT_MS);
            child.on('message', (message) => {
                if (message?.type !== 'shutdown-complete')
                    return;
                clearTimeout(timer);
                resolveShutdown();
            });
            child.send({ type: 'shutdown' });
        }),
    };
}
/**
 * The pet-surface locator: pet-app bundles inside a running runtime publish
 * their authenticated root here (the desktop shell keeps its URL in process
 * memory only). A published URL wins over spawning a dedicated profile, so the
 * pet follows whichever live runtime serves /whale598/ — the user's desktop when it
 * runs, otherwise the last publisher still alive.
 */
async function readLocatorUrl() {
    // whale598/ first (current publisher), then the legacy root copy — the
    // locator moved with the whale598 consolidation (publishLocator writes the
    // new path; old copies answer as fallback).
    const home = process.env.DSH_HOME ?? join(homedir(), '.dsh');
    for (const path of [join(home, 'whale598', 'pet-surface-url.json'), join(home, 'pet-surface-url.json')]) {
        try {
            const record = JSON.parse(await readFile(path, 'utf8'));
            if (typeof record.url !== 'string' || record.url === '')
                continue;
            if (typeof record.pid === 'number') {
                try {
                    process.kill(record.pid, 0);
                }
                catch {
                    return undefined;
                } // publisher gone
            }
            return record.url;
        }
        catch { /* try the next location */ }
    }
    return undefined;
}
/**
 * The pet surface URL for an authenticated web root: path `/whale598/` with the
 * token **dropped** — authorizeIndex mints the root cookie from the token and
 * rejects any token-carrying request on a subpath, so the pet page itself is
 * entered cookie-only after the root mint.
 */
function petSurfaceUrl(authenticated) {
    const parsed = new URL(authenticated);
    // MUST stay in lockstep with the plugin's PET_PATH_PREFIX (/whale598) —
    // separate builds, so the literal is duplicated here by design.
    parsed.pathname = '/whale598/';
    parsed.search = '';
    parsed.hash = '';
    return parsed.toString();
}
/** The remembered window position, validated against the current displays so
 * a stale save (monitor unplugged, resolution change) cannot spawn the pet
 * off-screen. The WHOLE window rectangle must fit inside some work area —
 * a corner check admits positions whose body hangs past the edge, which is
 * how x=2125 (DIP work area 1707 wide) passed and the pet vanished. When no
 * display fits it, clamp fully into the primary work area. Undefined =
 * default placement. */
function readSavedPosition() {
    try {
        const parsed = JSON.parse(readFileSync(join(DSH_HOME, 'pet-window.json'), 'utf8'));
        const x = typeof parsed.x === 'number' ? Math.round(parsed.x) : Number.NaN;
        const y = typeof parsed.y === 'number' ? Math.round(parsed.y) : Number.NaN;
        if (!Number.isFinite(x) || !Number.isFinite(y))
            return undefined;
        const fits = (area) => x >= area.x && y >= area.y
            && x + WINDOW_SIZE.width <= area.x + area.width
            && y + WINDOW_SIZE.height <= area.y + area.height;
        if (screen.getAllDisplays().some(display => fits(display.workArea)))
            return { x, y };
        const primary = screen.getPrimaryDisplay().workArea;
        return {
            x: Math.min(primary.x + primary.width - WINDOW_SIZE.width, Math.max(primary.x, x)),
            y: Math.min(primary.y + primary.height - WINDOW_SIZE.height, Math.max(primary.y, y)),
        };
    }
    catch {
        return undefined;
    }
}
/** The persisted roaming area (§6 /world): `pet-world.json` holds the
 * effective rect or an explicit null (unset). Anything unreadable or
 * mistyped degrades to unset — the default work-area clamping applies. */
function readSavedWorld() {
    try {
        return rectOf(JSON.parse(readFileSync(join(DSH_HOME, 'pet-world.json'), 'utf8')));
    }
    catch {
        return null;
    }
}
function createPetWindow() {
    const saved = readSavedPosition();
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
    });
    window.setAlwaysOnTop(true, 'screen-saver');
    // Mouse events start forwarded: the main-process poller toggles ignore off
    // while the cursor is over the pet body or a bubble, so the desktop
    // underneath stays clickable everywhere else.
    window.setIgnoreMouseEvents(true, { forward: true });
    return window;
}
async function main() {
    // protocol.handle touches the default session: registration must follow
    // app ready (registerSchemesAsPrivileged above is the only pre-ready call).
    await app.whenReady();
    // The runtime re-attaches to a fresh random port every boot, but cookies
    // ignore ports and pile up on the shared 127.0.0.1 domain — hundreds of
    // mints later the Cookie header outgrows the server's 16KB limit and every
    // page request is rejected (observed: 431 accumulated cookies). The boot's
    // token URL re-mints everything the page needs, so persistence is worthless.
    await session.defaultSession.clearStorageData({ storages: ['cookies'] });
    registerAssetProtocol();
    const actionCatalog = await scanActionCatalog();
    // The advertised menu: the universal celebrate alias first, then every
    // clip id the media tree holds.
    const actionIds = ['celebrate', ...actionCatalog.map(entry => entry.id)];
    console.log(`[pet] assets root: ${resolveAssetsRoot()} actions=${String(actionCatalog.length)}`);
    let handle;
    const attachUrl = process.env.DSH_PET_URL ?? await readLocatorUrl();
    let authenticated;
    try {
        if (attachUrl !== undefined && attachUrl !== '') {
            console.log(`[pet] attaching to a published pet surface: ${new URL(attachUrl).origin}`);
            authenticated = attachUrl;
        }
        else {
            // The self-spawn branch alone needs the profile machinery; the packaged
            // carrier always arrives with DSH_PET_URL from its spawning runtime and
            // carries none of these dependencies.
            const [{ initProfile }, { dshHomePath }, { PROFILE_TEMPLATES }] = await Promise.all([
                import('@deepseek-ai/dsh-app-boot'),
                import('@deepseek-ai/dsh-home-paths'),
                import('@deepseek-ai/dsh-official-bundles'),
            ]);
            const template = PROFILE_TEMPLATES[PET_PROFILE_NAME];
            if (template === undefined)
                throw new Error('pet: no shipped profile template named "pet"');
            initProfile(dshHomePath('profiles', PET_PROFILE_NAME), template.bundles);
            handle = spawnHostChild();
            authenticated = await handle.url;
        }
    }
    catch (error) {
        new BrowserWindow({ width: 520, height: 320 }).loadURL('data:text/html;charset=utf-8,' + encodeURIComponent(`<pre style="font-family:monospace;white-space:pre-wrap">dsh pet 载体启动失败：\n\n${String(error instanceof Error ? error.message : error)}` +
            `\n\n素材目录（可配置 DSH_PET_ASSETS_DIR）：${resolveAssetsRoot()}</pre>`));
        return;
    }
    const window = createPetWindow();
    // Say-side TTS: the /say pipeline's audio companion (see tts.ts). Created
    // once, fed by the control handler below; failures never touch the bubble.
    const sayTts = createSayTts({ home: DSH_HOME, window });
    window.on('resize', () => {
        console.log(`[pet] resized: ${JSON.stringify(window.getBounds())}`);
    });
    window.on('moved', () => {
        console.log(`[pet] moved: ${JSON.stringify(window.getBounds())}`);
    });
    const primary = screen.getPrimaryDisplay();
    console.log(`[pet] window bounds: ${JSON.stringify(window.getBounds())} scaleFactor=${primary.scaleFactor} workarea=${JSON.stringify(primary.workArea)}`);
    // Forward the renderer console: the pet page's own diagnostics (connection,
    // shader, video failures) never reach a terminal otherwise.
    window.webContents.on('console-message', (_event, _level, message, line, source) => {
        console.log(`[pet-renderer] ${source}:${line} ${message}`);
    });
    window.webContents.on('did-fail-load', (_event, code, description, url) => {
        console.log(`[pet-renderer] did-fail-load ${code} ${description} ${url}`);
    });
    // Right-click anywhere on the window (pet body or bubble — the click-through
    // poller lets those through) opens the close menu: the MVP has no taskbar
    // entry or tray, so this is the only self-service exit.
    window.webContents.on('context-menu', () => {
        Menu.buildFromTemplate([
            { label: '退出 dsh pet', click: () => { window.close(); } },
        ]).popup({ window });
    });
    // Connection's token exchange is root-path-only (authorizeIndex admits
    // `/?token=…`, never a subpath): load the authenticated root once to mint
    // the browser cookie, then enter /whale598/ with it. The root load starts the
    // Web GUI; the second navigation aborts it, so the web app is at most a
    // flash.
    await window.loadURL(authenticated).catch(() => { });
    await window.loadURL(petSurfaceUrl(authenticated)).catch((error) => {
        console.error('[pet] the pet surface failed to load:', String(error));
    });
    // Hand the renderer the action catalog (its /action name resolution and
    // idle theater both consume it). The page has finished loading here, so
    // its listener is registered and nothing is lost.
    window.webContents.send('pet:catalog', { character: CHARACTER, actions: actionCatalog });
    // Click-through is decided by the MAIN process: setIgnoreMouseEvents(forward)
    // does not deliver forwarded moves on this Electron/Windows combination, so
    // the renderer never sees the cursor. The main process knows the window
    // bounds and the pet/bubble rects (they mirror the renderer CSS), polls the
    // cursor, and toggles ignore accordingly — no renderer participation.
    // The pet/bubble rects mirror the renderer CSS (pet: 340x200 bottom-center,
    // 12px margin; bubble: 400x300 above it), computed against the CURRENT
    // window size every poll — a fixed rect desyncs the moment the window
    // changes size for any reason.
    const PET_SIZE = { width: 340, height: 200 };
    const BUBBLE_SIZE = { width: 400, height: 300 };
    let bubbleVisible = false;
    // The v3 action witness, ONE object: acceptance writes id/action/
    // requestedBy/startedAt (endedAt/durationMs null), the renderer's clip-end
    // report backfills endedAt/durationMs IN PLACE against the same id — the
    // four acceptance fields never move, so an id-matching poller cannot
    // misread a newer action's record. Consumers poll this instead of the
    // renderer's override, which may set and clear within a tick. A
    // pet-local one-shot (touch reaction, work-landing celebrate) writes its
    // record on completion with id: null. null = no record yet (constant
    // output — the field is always present in /status).
    let lastAction = null;
    // Tool-initiated /action requests awaiting their completion report: the
    // renderer echoes the requestId when the clip ends, so the witness can
    // carry the REQUESTED action name (not the clip file) and the actor.
    // Swept on each acceptance: a report that never comes (a clip id the
    // renderer cannot resolve) must not let the map grow without bound.
    const pendingActionRequests = new Map();
    // The v2 roaming area (§6 /world): null = unset (default work-area
    // clamping applies). Absent/unsupported is NOT expressible here — this
    // implementation always supports /world, so /status reports an explicit
    // null until one is set.
    let activeWorld = readSavedWorld();
    let lastIgnore;
    const updateClickThrough = () => {
        try {
            const bounds = window.getBounds();
            const cursor = screen.getCursorScreenPoint();
            const localX = cursor.x - bounds.x;
            const localY = cursor.y - bounds.y;
            const centeredX = (width) => (bounds.width - width) / 2;
            const petRect = { x: centeredX(PET_SIZE.width), y: bounds.height - 12 - PET_SIZE.height, ...PET_SIZE };
            const bubbleRect = { x: centeredX(BUBBLE_SIZE.width), y: bounds.height - 224 - BUBBLE_SIZE.height, ...BUBBLE_SIZE };
            const inRect = (rect) => localX >= rect.x && localX <= rect.x + rect.width
                && localY >= rect.y && localY <= rect.y + rect.height;
            const overInteractive = inRect(petRect) || (bubbleVisible && inRect(bubbleRect));
            if (lastIgnore !== overInteractive) {
                console.log(`[pet] ignore -> ${String(!overInteractive)} cursorDIP=${cursor.x},${cursor.y} bounds=${JSON.stringify(bounds)}`);
                lastIgnore = overInteractive;
            }
            window.setIgnoreMouseEvents(!overInteractive);
        }
        catch (error) {
            console.error(`[pet] click-through poll failed: ${String(error)}`);
        }
    };
    ipcMain.on('pet:bubble-visibility', (event, visible) => {
        try {
            if (event.sender !== window.webContents)
                return;
            bubbleVisible = visible === true;
        }
        catch (error) {
            console.error('[pet] bubble-visibility failed:', String(error));
        }
    });
    setInterval(updateClickThrough, 120);
    // ── manual drag ───────────────────────────────────────────────────────────
    // The believed origin: initialized once after creation and updated only by
    // our own setBounds — never re-read from getBounds(), which reports whatever
    // DWM last re-measured and would import the ratchet drift into the math.
    let windowOrigin = { x: window.getBounds().x, y: window.getBounds().y };
    let dragAnchor;
    ipcMain.on('pet:drag-start', (event, screenX, screenY) => {
        try {
            if (event.sender !== window.webContents)
                return;
            if (typeof screenX !== 'number' || typeof screenY !== 'number'
                || !Number.isFinite(screenX) || !Number.isFinite(screenY))
                return;
            dragAnchor = { pointerX: screenX, pointerY: screenY, originX: windowOrigin.x, originY: windowOrigin.y };
        }
        catch (error) {
            console.error('[pet] drag-start failed:', String(error), 'args:', JSON.stringify([screenX, screenY]));
        }
    });
    ipcMain.on('pet:drag-move', (event, screenX, screenY) => {
        try {
            const anchor = dragAnchor;
            if (event.sender !== window.webContents || anchor === undefined)
                return;
            if (typeof screenX !== 'number' || typeof screenY !== 'number'
                || !Number.isFinite(screenX) || !Number.isFinite(screenY)) {
                console.error(`[pet] drag-move rejected args: ${JSON.stringify([screenX, screenY])}`);
                return;
            }
            const next = {
                x: Math.round(anchor.originX + (screenX - anchor.pointerX)),
                y: Math.round(anchor.originY + (screenY - anchor.pointerY)),
                width: WINDOW_SIZE.width,
                height: WINDOW_SIZE.height,
            };
            // The roaming area binds the DRAG too (§6: location always sits inside
            // a set world) — an unset world leaves the default work-area regime.
            if (activeWorld !== null) {
                next.x = clampInto(next.x, activeWorld.x, activeWorld.x + activeWorld.width - WINDOW_SIZE.width);
                next.y = clampInto(next.y, activeWorld.y, activeWorld.y + activeWorld.height - WINDOW_SIZE.height);
            }
            if (next.x === windowOrigin.x && next.y === windowOrigin.y)
                return;
            windowOrigin = { x: next.x, y: next.y };
            window.setBounds(next);
        }
        catch (error) {
            console.error('[pet] drag-move failed:', String(error), 'args:', JSON.stringify([screenX, screenY]));
        }
    });
    ipcMain.on('pet:drag-end', (event) => {
        try {
            if (event.sender !== window.webContents)
                return;
            dragAnchor = undefined;
            // Remember where the user parked the pet; restored on the next launch
            // and clearable from the settings page.
            void writeFile(join(DSH_HOME, 'pet-window.json'), `${JSON.stringify(windowOrigin)}\n`, 'utf8')
                .catch((error) => { console.error('[pet] could not save the window position:', String(error)); });
        }
        catch (error) {
            console.error('[pet] drag-end failed:', String(error));
        }
    });
    // ── roaming-area helpers (§6 /world) ──────────────────────────────────────
    const currentLocation = () => {
        const bounds = window.getBounds();
        return { x: bounds.x, y: bounds.y, width: bounds.width, height: bounds.height };
    };
    const writeWorld = () => {
        void writeFile(join(DSH_HOME, 'pet-world.json'), `${JSON.stringify(activeWorld)}\n`, 'utf8')
            .catch((error) => { console.error('[pet] could not save the roaming area:', String(error)); });
    };
    // Pull the window rect fully inside the roaming area (a world smaller than
    // the window pins the low edge). Returns whether the window moved.
    const clampWindowIntoWorld = () => {
        if (activeWorld === null)
            return false;
        const bounds = window.getBounds();
        const x = clampInto(bounds.x, activeWorld.x, activeWorld.x + activeWorld.width - WINDOW_SIZE.width);
        const y = clampInto(bounds.y, activeWorld.y, activeWorld.y + activeWorld.height - WINDOW_SIZE.height);
        if (x === bounds.x && y === bounds.y)
            return false;
        windowOrigin = { x, y };
        window.setBounds({ x, y, width: WINDOW_SIZE.width, height: WINDOW_SIZE.height });
        return true;
    };
    // The default regime (world unset): the whole window rect must fit some
    // display's work area (readSavedPosition's rule); when none does, clamp
    // fully into the primary work area.
    const clampWindowIntoDefaultArea = () => {
        const bounds = window.getBounds();
        const fits = (area) => bounds.x >= area.x && bounds.y >= area.y
            && bounds.x + bounds.width <= area.x + area.width
            && bounds.y + bounds.height <= area.y + area.height;
        if (screen.getAllDisplays().some(display => fits(display.workArea)))
            return false;
        const primary = screen.getPrimaryDisplay().workArea;
        const x = clampInto(bounds.x, primary.x, primary.x + primary.width - WINDOW_SIZE.width);
        const y = clampInto(bounds.y, primary.y, primary.y + primary.height - WINDOW_SIZE.height);
        if (x === bounds.x && y === bounds.y)
            return false;
        windowOrigin = { x, y };
        window.setBounds({ x, y, width: WINDOW_SIZE.width, height: WINDOW_SIZE.height });
        return true;
    };
    // ── control interface ─────────────────────────────────────────────────────
    // The driver's four operations (§6 of DSH-PET.md) as local HTTP, hosted by
    // the main process (renderers cannot listen); the renderer consumes them
    // over IPC. v1 is loopback without auth — the callers are this machine's
    // runtime driver and petctl.
    const pendingInteractions = new Map();
    // The renderer's latest self-report; the /status mirror serves it beside the
    // main process's own facts.
    let statusSnapshot = { state: 'idle' };
    // §6 chat 上行：每宠至多一条在途——该事件被 /events 响应实际携出前
    // 不收新输入（输入卡模态），携出即发送成功。
    let pendingChatSeq = null;
    const touchEvents = [];
    let touchSeq = 0;
    // Parked GET /events?hold=N requests, woken the moment an event lands.
    const eventWaiters = new Set();
    const wakeEventWaiters = () => {
        for (const waiter of [...eventWaiters])
            waiter();
    };
    ipcMain.on('pet:touch', (event, touch) => {
        try {
            if (event.sender !== window.webContents)
                return;
            const part = touch?.part === 'head' || touch?.part === 'body' ? touch.part : 'unknown';
            touchSeq += 1;
            touchEvents.push({ seq: touchSeq, type: 'touch', part, at: Date.now() });
            if (touchEvents.length > 200)
                touchEvents.splice(0, touchEvents.length - 200);
            wakeEventWaiters();
            console.log(`[pet] touch #${String(touchSeq)} (${part})`);
        }
        catch (error) {
            console.error('[pet] touch failed:', String(error));
        }
    });
    ipcMain.handle('pet:chat', (event, message) => {
        try {
            if (event.sender !== window.webContents)
                return { ok: false };
            const text = typeof message?.text === 'string' ? message.text.trim().slice(0, 2000) : '';
            if (text === '')
                return { ok: false, reason: 'empty' };
            if (pendingChatSeq !== null)
                return { ok: false, reason: 'busy' };
            touchSeq += 1;
            pendingChatSeq = touchSeq;
            touchEvents.push({ seq: touchSeq, type: 'chat', text, at: Date.now() });
            if (touchEvents.length > 200)
                touchEvents.splice(0, touchEvents.length - 200);
            wakeEventWaiters();
            console.log(`[pet] chat #${String(touchSeq)} (${String(text.length)} chars)`);
            return { ok: true };
        }
        catch (error) {
            console.error('[pet] chat failed:', String(error));
            return { ok: false };
        }
    });
    ipcMain.on('pet:status-report', (event, snapshot) => {
        try {
            if (event.sender !== window.webContents)
                return;
            statusSnapshot = snapshot;
        }
        catch (error) {
            console.error('[pet] status-report failed:', String(error));
        }
    });
    ipcMain.on('pet:action-done', (event, done) => {
        try {
            if (event.sender !== window.webContents)
                return;
            if (typeof done?.action !== 'string')
                return;
            const requestId = typeof done.requestId === 'string' ? done.requestId : undefined;
            const durationMs = typeof done.durationMs === 'number' && Number.isFinite(done.durationMs)
                ? done.durationMs
                : null;
            const at = Date.now();
            const pending = requestId !== undefined ? pendingActionRequests.get(requestId) : undefined;
            if (pending !== undefined && requestId !== undefined)
                pendingActionRequests.delete(requestId);
            if (requestId !== undefined && lastAction !== null && lastAction.id === requestId && lastAction.endedAt === null) {
                // Completion backfill IN PLACE: the four acceptance fields stay
                // frozen, so an id-matching poller never misreads this record.
                lastAction.durationMs = durationMs;
                lastAction.endedAt = at;
                return;
            }
            // A pet-local one-shot (touch reaction, work-landing celebrate) never
            // had an /action acceptance: write the witness directly, the clip's
            // own duration approximating its start.
            lastAction = {
                id: requestId ?? null,
                action: pending !== undefined ? pending.requested : done.action,
                requestedBy: pending !== undefined ? 'tool' : 'user',
                startedAt: durationMs !== null ? at - durationMs : at,
                durationMs,
                endedAt: at,
            };
        }
        catch (error) {
            console.error('[pet] action-done failed:', String(error));
        }
    });
    ipcMain.on('pet:interaction-answer', (event, message) => {
        try {
            if (event.sender !== window.webContents)
                return;
            if (typeof message?.id !== 'string' || !pendingInteractions.has(message.id))
                return;
            const response = pendingInteractions.get(message.id);
            pendingInteractions.delete(message.id);
            response?.end(` ${JSON.stringify({ ok: true, answer: message.answer ?? null })}`);
        }
        catch (error) {
            console.error('[pet] interaction-answer failed:', String(error));
        }
    });
    const control = createServer((req, res) => {
        const url = new URL(req.url ?? '/', 'http://127.0.0.1');
        const send = (status, body) => {
            res.writeHead(status, { 'content-type': 'application/json', 'cache-control': 'no-store' });
            res.end(JSON.stringify(body));
        };
        if (req.method === 'GET' && url.pathname === '/events') {
            // The poll endpoint for driver-side consumption: everything the user
            // did to the pet since `since`, plus the newest seq (a smaller newest
            // than the caller's last means the pet restarted; re-pull from 0).
            // v4 long-poll: `hold` (seconds, clamped ≤30) parks the request while
            // the queue is empty and answers the instant an event lands or the
            // budget lapses (an empty batch — the caller re-arms). Backlog and a
            // rewind (`latest < since` = the pet restarted) always answer
            // immediately, hold or not.
            const since = Number(url.searchParams.get('since') ?? '0');
            const rawHold = Number(url.searchParams.get('hold') ?? '0');
            const hold = Number.isFinite(rawHold) ? Math.min(30, Math.max(0, rawHold)) : 0;
            const answer = () => {
                const events = touchEvents.filter(entry => entry.seq > since);
                // chat 模态释放：事件被本响应实际携出 = 发送成功（§6 修订）
                if (pendingChatSeq !== null && events.some(entry => entry.seq === pendingChatSeq)) {
                    pendingChatSeq = null;
                }
                send(200, { events, latest: touchSeq });
            };
            const hasBacklog = touchEvents.some(entry => entry.seq > since);
            if (hold <= 0 || touchSeq < since || hasBacklog) {
                answer();
                return;
            }
            let settled = false;
            const finish = () => {
                if (settled)
                    return;
                settled = true;
                eventWaiters.delete(finish);
                clearTimeout(timer);
                answer();
            };
            const timer = setTimeout(finish, hold * 1000);
            eventWaiters.add(finish);
            res.on('close', () => {
                // The caller left (restart, crash, re-discovery): release without
                // writing to the dead socket.
                if (settled)
                    return;
                settled = true;
                eventWaiters.delete(finish);
                clearTimeout(timer);
            });
            return;
        }
        if (req.method === 'GET' && url.pathname === '/capabilities') {
            // v4: the endpoints/events word-lists retired — the version field
            // carries endpoint existence, the event body's own `type` field
            // carries event-type tolerance (§6 revision record).
            send(200, {
                contractVersion: 4,
                states: ['idle', 'thinking', 'working', 'error'],
                // The pet's own action menu, scanned from the media tree at boot —
                // celebrate first (the universal alias), then every playable clip.
                actions: actionIds,
                interactions: ['approval', 'question'],
            });
            return;
        }
        if (url.pathname === '/status') {
            // The mirror: what the pet currently is doing, where it stands. v2:
            // `location` (the pet-body rect) + `world` (the roaming area, null =
            // unset) replace the retired `window`; v3: `lastAction` is ONE object
            // — accepted-on-write, completion backfilled in place, null = no
            // record yet (constant output). `bubble` is the delivery receipt for
            // /say; a conditionally-absent field is a JSON.stringify footgun, so
            // both witnesses stay always-present.
            const bounds = window.getBounds();
            send(200, {
                ...statusSnapshot,
                bubble: bubbleVisible,
                lastAction,
                interaction: pendingInteractions.size > 0,
                location: { x: bounds.x, y: bounds.y, width: bounds.width, height: bounds.height },
                world: activeWorld,
                visible: window.isVisible(),
                pid: process.pid,
            });
            return;
        }
        if (req.method !== 'POST') {
            send(405, { error: 'POST only' });
            return;
        }
        let raw = '';
        req.setEncoding('utf8');
        req.on('data', (chunk) => { raw += chunk; });
        req.on('end', () => {
            let body;
            try {
                body = JSON.parse(raw);
            }
            catch {
                send(400, { error: 'invalid json' });
                return;
            }
            if (url.pathname === '/state') {
                console.log(`[pet] control /state ${JSON.stringify(body)}`);
                window.webContents.send('pet:set-state', body);
                send(200, { ok: true });
                return;
            }
            if (url.pathname === '/say') {
                // Fire-and-forget: the driver says something through the pet; the
                // bubble self-dismisses and never blocks a turn. The TTS pipeline
                // rides along out-of-band (a no-op unless configured): the bubble
                // shows FIRST, the voice follows when the audio lands.
                const text = typeof body.text === 'string' ? body.text.slice(0, 200) : '';
                window.webContents.send('pet:say', { text });
                sayTts.speak(text);
                send(200, { ok: true });
                return;
            }
            if (url.pathname === '/action') {
                // Validate at the boundary: the driver pre-validates against
                // /capabilities, but a raw consumer gets this pet's own menu here.
                // A rejected request is NOT recorded as an action (no requestId, no
                // forwarding) so the wait machinery never waits on nothing.
                const requested = typeof body.action === 'string' ? body.action : 'unknown';
                if (requested !== 'celebrate' && !actionCatalog.some(entry => entry.id === requested)) {
                    send(422, { ok: false, error: `unknown action "${requested}"`, available: actionIds });
                    return;
                }
                // Record the request observably: one-shot playback is fire-and-forget
                // and the renderer's override is not a reliable witness (it may
                // set/clear within one tick) — consumers poll the v3 witness instead
                // of guessing from override. The requestId threads through the
                // renderer's completion report, so the witness names the REQUESTED
                // action and pet_do(wait) can match precisely.
                const requestId = randomUUID();
                const startedAt = Date.now();
                lastAction = {
                    id: requestId,
                    action: requested,
                    requestedBy: 'tool',
                    startedAt,
                    durationMs: null,
                    endedAt: null,
                };
                for (const [key, value] of pendingActionRequests) {
                    if (startedAt - value.at > 120_000)
                        pendingActionRequests.delete(key);
                }
                pendingActionRequests.set(requestId, { requested, at: startedAt });
                window.webContents.send('pet:action', { ...body, requestId });
                send(200, { ok: true, action: requested, requestId });
                return;
            }
            if (url.pathname === '/interaction') {
                // Long-poll: the response IS the user's choice. A driver that gives
                // up aborts the connection; the close handler withdraws the bubble.
                const id = randomUUID();
                res.writeHead(200, { 'content-type': 'application/json', 'cache-control': 'no-store' });
                pendingInteractions.set(id, res);
                // Leading whitespace is valid JSON framing: keepalive spaces stop an
                // idle-body timeout on the driver's fetch without touching the answer.
                const keepalive = setInterval(() => { res.write(' '); }, 60_000);
                res.on('close', () => {
                    clearInterval(keepalive);
                    if (pendingInteractions.delete(id)) {
                        window.webContents.send('pet:interaction-cancel', { id });
                    }
                });
                window.webContents.send('pet:interaction', { id, ...body });
                return;
            }
            if (url.pathname === '/world') {
                // §6 v2: set the roaming area. Effective IMMEDIATELY — a pet outside
                // the rect is clamped in before the response leaves. `{"reset":true}`
                // returns to default work-area clamping. The 200 body carries the
                // EFFECTIVE rect (not a request echo — an implementation may shrink
                // or clamp) and the post-clamp location. A rect that is not four
                // finite positive numbers, or that intersects no display's work
                // area, is a 422, not a silent no-op.
                if (body.reset === true) {
                    activeWorld = null;
                    writeWorld();
                    const moved = clampWindowIntoDefaultArea();
                    send(200, { ok: true, world: null, location: currentLocation(), moved });
                    return;
                }
                const rect = rectOf(body);
                if (rect === null || rect.width <= 0 || rect.height <= 0
                    || !screen.getAllDisplays().some(display => rectsIntersect(rect, display.workArea))) {
                    send(422, { ok: false, error: 'invalid world: expected {x,y,width,height} intersecting a display work area, or {"reset":true}' });
                    return;
                }
                activeWorld = rect;
                writeWorld();
                const moved = clampWindowIntoWorld();
                send(200, { ok: true, world: activeWorld, location: currentLocation(), moved });
                return;
            }
            send(404, { error: 'unknown endpoint' });
        });
    });
    control.listen(Number(process.env.DSH_PET_HTTP_PORT ?? 0), '127.0.0.1', () => {
        const address = control.address();
        const port = typeof address === 'object' && address !== null ? address.port : 0;
        console.log(`[pet] control interface on 127.0.0.1:${String(port)}`);
        // Registry publish: one file per pet under pet-http.d/ — no shared name,
        // no last-writer-wins race (the incident class that produced repeated
        // swap blindness). The legacy single file keeps being written during the
        // transition so pre-registry readers still see this carrier.
        const manifest = `${JSON.stringify({ port, pid: process.pid, since: Date.now(), pet: 'electron' })}\n`;
        // Namespaced under whale598/ (collision avoidance); the driver scans
        // the legacy pet-http.d/ as a read fallback for older pet builds.
        const registryDir = join(DSH_HOME, 'whale598', 'pet-http.d');
        try {
            mkdirSync(registryDir, { recursive: true });
        }
        catch (error) {
            console.error('[pet] could not create the pet registry:', String(error));
        }
        const writeManifest = () => {
            void writeFile(join(registryDir, 'electron.json'), manifest, 'utf8')
                .catch((error) => { console.error('[pet] could not write the registry entry:', String(error)); });
            // legacy 根镜像（pet-http-electron.json）停写：读侧双目录扫描已覆盖
        };
        writeManifest();
        // Re-assert on a cadence so a stale publisher cannot shadow a live pet.
        setInterval(writeManifest, 10_000);
    });
    // Runtime watchdog: a driver-spawned pet outlives nothing. Dispose-time
    // kill only runs on the runtime's graceful shutdown; a terminated runtime
    // leaves a detached pet orphaned on the desktop. Poll the spawning
    // runtime's pid and exit with it.
    const runtimePid = Number(process.env.DSH_PET_RUNTIME_PID);
    if (Number.isInteger(runtimePid) && runtimePid > 0) {
        setInterval(() => {
            try {
                process.kill(runtimePid, 0);
            }
            catch {
                console.log('[pet] the spawning runtime is gone; exiting');
                app.quit();
            }
        }, 10_000);
    }
    window.on('closed', () => {
        // The window is the carrier's whole surface: closing it tears the profile down.
        void handle?.shutdown();
    });
    app.on('before-quit', (event) => {
        // Withdraw our registry entry (and the legacy mirror) so consumers never
        // find a dead port in pet-http.d/ — stale entries were the "旧端点残留"
        // incident class. Best effort: a killed carrier leaves the file, and the
        // readers' pid+probe validation is the backstop.
        for (const file of ['whale598/pet-http.d/electron.json', 'pet-http.d/electron.json', 'pet-http-electron.json']) {
            void rm(join(DSH_HOME, file), { force: true }).catch(() => { });
        }
        if (handle === undefined)
            return;
        event.preventDefault();
        const closing = handle.shutdown();
        handle = undefined;
        void closing.then(() => app.quit());
    });
}
app.on('window-all-closed', () => {
    app.quit();
});
//# sourceMappingURL=main.js.map