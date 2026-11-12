/**
 * dsh-pet Electron main process. Owns the pet window (transparent,
 * always-on-top, click-through outside the pet body), the pet-profile child
 * process (spawned through Electron's own binary in Node mode, mirroring
 * apps/desktop-host), and the pet-asset protocol that streams the pet's
 * animation media from a local directory without vendoring it into the
 * repository.
 */
import { app, BrowserWindow, ipcMain, protocol } from 'electron';
import { spawn } from 'node:child_process';
import { readFile } from 'node:fs/promises';
import { dirname, join, normalize, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import { initProfile } from '@deepseek-ai/dsh-app-boot';
import { dshHomePath } from '@deepseek-ai/dsh-home-paths';
import { PROFILE_TEMPLATES } from '@deepseek-ai/dsh-official-bundles';
const HERE = dirname(fileURLToPath(import.meta.url));
const PET_PROFILE_NAME = 'pet';
const ASSET_SCHEME = 'pet-asset';
/** Bounded wait for the profile child's graceful shutdown before it is left to the OS. */
const SHUTDOWN_TIMEOUT_MS = 10_000;
process.env.ELECTRON_DISABLE_SECURITY_WARNINGS = 'true';
// Registered before app ready, per Electron protocol registration rules. The
// scheme carries the pet's media under its path; media elements load it
// no-cors, so no CORS privilege is required.
protocol.registerSchemesAsPrivileged([
    { scheme: ASSET_SCHEME, privileges: { supportFetchAPI: true, stream: true } },
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
    // Source-checkout fallback: the pet surface shares the retired standalone
    // pet's media until a packaged asset story ships. lib/ → apps/pet → apps →
    // deepseek-harness → the dsh checkout's parent holds the pet checkout.
    return resolve(HERE, '..', '..', '..', '..', 'dsh-pet-indesktop', 'assets', 'characters');
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
            headers: { 'content-type': mimeOf(target) },
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
    const child = spawn(process.execPath, [join(HERE, 'host-child.js')], {
        env: { ...process.env, ELECTRON_RUN_AS_NODE: '1' },
        stdio: ['ignore', 'pipe', 'pipe', 'ipc'],
    });
    let stderr = '';
    child.stderr?.setEncoding('utf8');
    child.stderr?.on('data', (chunk) => { stderr += chunk; });
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
function createPetWindow(url) {
    const window = new BrowserWindow({
        width: 460,
        height: 560,
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
    // Mouse events start forwarded: the renderer toggles ignore off only while
    // the pointer is over the pet body or a bubble, so the desktop underneath
    // stays clickable everywhere else.
    window.setIgnoreMouseEvents(true, { forward: true });
    void window.loadURL(url);
    return window;
}
async function main() {
    registerAssetProtocol();
    await app.whenReady();
    // Ensure the shipped pet profile exists; initProfile is idempotent.
    const template = PROFILE_TEMPLATES[PET_PROFILE_NAME];
    if (template === undefined)
        throw new Error('pet: no shipped profile template named "pet"');
    initProfile(dshHomePath('profiles', PET_PROFILE_NAME), template.bundles);
    let handle;
    const attachUrl = process.env.DSH_PET_URL;
    let url;
    try {
        if (attachUrl !== undefined && attachUrl !== '') {
            url = attachUrl;
        }
        else {
            handle = spawnHostChild();
            url = await handle.url;
        }
    }
    catch (error) {
        new BrowserWindow({ width: 520, height: 320 }).loadURL('data:text/html;charset=utf-8,' + encodeURIComponent(`<pre style="font-family:monospace;white-space:pre-wrap">dsh pet 载体启动失败：\n\n${String(error instanceof Error ? error.message : error)}` +
            `\n\n素材目录（可配置 DSH_PET_ASSETS_DIR）：${resolveAssetsRoot()}</pre>`));
        return;
    }
    const window = createPetWindow(`${url.replace(/\/+$/u, '')}/pet/`);
    ipcMain.on('pet:click-through', (event, enabled) => {
        if (event.sender !== window.webContents)
            return;
        window.setIgnoreMouseEvents(enabled === true, { forward: true });
    });
    window.on('closed', () => {
        // The window is the carrier's whole surface: closing it tears the profile down.
        void handle?.shutdown();
    });
    app.on('before-quit', (event) => {
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