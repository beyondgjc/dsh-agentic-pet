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
import { spawn } from 'node:child_process';
import { createHash } from 'node:crypto';
import { existsSync, readFileSync } from 'node:fs';
import { mkdir, readFile, unlink, writeFile } from 'node:fs/promises';
import { homedir } from 'node:os';
import { createRequire } from 'node:module';
import { dirname, extname, join, normalize, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import { installPetDriver } from "./driver.js";
import { installSettingsPage } from "./settings-page.js";
import { installPetService } from "./service.js";
/** Stable Cordis plugin name. */
export const name = 'pet-surface';
/**
 * Services required before the `/pet` route can register. `sessionController`
 * is a SIBLING plugin row's service (the api-session-controller row in the
 * same composition): a command-style ctx.get from this row's fiber never sees
 * it (the petTools/petService precedent), while static inject is resolved by
 * the Loader ACROSS rows and waits for that row to mount — the webServer
 * precedent. Every profile mounting this bundle mounts the web-app rows too,
 * so the dependency is always satisfiable.
 */
export const inject = ['webServer', 'connection', 'sessionController', 'workspaceController'];
/** The URL path prefix the pet renderer is served under. No trailing slash. */
export const PET_PATH_PREFIX = '/whale598';
// ↑ 前缀含专属标识（whale598）：'/pet' 太通用，易与其他插件的路由注册撞车。
/**
 * Locator file naming this runtime's authenticated root for the pet carrier.
 * The desktop shell keeps its authenticated URL in process memory only, so a
 * bundle inside that runtime is the only component positioned to publish it.
 * The carrier prefers the env override, then this file's freshest live
 * publisher, then falls back to spawning its own profile.
 */
export function petLocatorPath() {
    return join(process.env.DSH_HOME ?? join(homedir(), '.dsh'), 'pet-surface-url.json');
}
const HTML_MIME = 'text/html; charset=utf-8';
const MIME = {
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
};
const STATIC_MISS_CODES = new Set([
    'ENOENT',
    'EISDIR',
    'ENOTDIR',
]);
/**
 * Dist location is workspace knowledge of this bundle: anchored on the pet app
 * package manifest, not configured. Existence is a request-time concern — the
 * route reads files per request, so a composition whose pet page is never
 * visited boots without the dist being built.
 */
function resolveDistIndex() {
    const require = createRequire(import.meta.url);
    try {
        // Source/暂装 layout: the renderer package's dist (canonical, freshly
        // built by every deploy).
        return join(dirname(require.resolve('@deepseek-ai/dsh-pet/package.json')), 'dist-renderer', 'index.html');
    }
    catch {
        // Installed-from-registry layout: @deepseek-ai/dsh-pet is not a
        // dependency of the published package — the tgz ships the same dist
        // inside carrier/ (files: carrier/**), one directory up from lib/.
        const shipped = join(dirname(fileURLToPath(import.meta.url)), '..', 'carrier', 'dist-renderer', 'index.html');
        if (existsSync(shipped))
            return shipped;
        throw new Error('pet-app: the pet renderer dist is not resolvable from this composition (neither @deepseek-ai/dsh-pet nor the shipped carrier dist)');
    }
}
/** A Response body that is `bytes` itself, without the copy a buffer body gets. */
function bytesBody(bytes) {
    return new ReadableStream({
        start(controller) {
            controller.enqueue(bytes);
            controller.close();
        },
    });
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
export async function servePetStatic(request, distRoot, distIndex, authorizeIndex) {
    const pathname = decodeURIComponent(new URL(request.url).pathname);
    // Prefix guard: anything not under PET_PATH_PREFIX is an ordinary miss.
    // (The webserver only routes the prefix here, but servePetStatic is also
    // unit-driven — and a path SHORTER than the prefix would degenerate the
    // slice below into serving the index to a foreign path.)
    if (!(pathname === PET_PATH_PREFIX || pathname.startsWith(`${PET_PATH_PREFIX}/`))) {
        return new Response(null, { status: 404 });
    }
    const relative = pathname === PET_PATH_PREFIX || pathname === `${PET_PATH_PREFIX}/`
        ? '/'
        : pathname.slice(PET_PATH_PREFIX.length);
    const target = resolve(normalize(join(distRoot, relative)));
    // Traversal rejection: the target must be distRoot itself (`/`) or stay
    // under it. `sep`, not '/': resolve() emits backslash paths on Windows,
    // where a '/' suffix would reject every legitimate subpath as traversal.
    if (target !== distRoot && !target.startsWith(distRoot + sep))
        return new Response(null, { status: 403 });
    let body;
    let headers;
    try {
        if (target === distRoot || target === distIndex) {
            const refusal = authorizeIndex();
            if (refusal !== undefined)
                return refusal;
            body = await readFile(distIndex, 'utf8');
            headers = { 'content-type': HTML_MIME };
        }
        else {
            body = await readFile(target);
            // Weak: gzip changes the transferred bytes.
            const cache = { 'cache-control': 'no-cache', etag: `W/"${createHash('sha1').update(body).digest('base64url')}"` };
            if (request.headers.get('if-none-match') === cache.etag)
                return new Response(null, { status: 304, headers: cache });
            headers = { 'content-type': MIME[extname(target)] ?? 'application/octet-stream', ...cache };
        }
    }
    catch (error) {
        // Only absent or non-file targets are 404; other filesystem failures reach
        // the adapter, which answers 400 over HTTP.
        if (!STATIC_MISS_CODES.has(error.code))
            throw error;
        return new Response(null, { status: 404 });
    }
    if (request.method === 'HEAD')
        return new Response(null, { status: 200, headers });
    return new Response(typeof body === 'string' ? body : bytesBody(body), { status: 200, headers });
}
/** The environment minus Electron's Node-mode flag, so a spawned GUI child is a GUI child. */
function stripRunAsNode(env) {
    const clean = { ...env };
    delete clean.ELECTRON_RUN_AS_NODE;
    return clean;
}
/** One raw webserver handler request's absolute URL. */
function absoluteUrl(req) {
    return `http://${req.headers.host ?? '127.0.0.1'}${req.url ?? '/'}`;
}
/** Normalize a node header value (string | string[] | undefined) for Fetch. */
function headerValue(value) {
    return Array.isArray(value) ? value.join(', ') : value;
}
/**
 * Register the `/pet` prefix route with a raw handler serving the pet renderer
 * dist, and publish the locator. The handler form predates resource-typed
 * routes, so one code path serves both the installed 0.2.1-rc.3 desktop
 * webserver and current builds; authorizeIndex branches on whether the
 * webserver carries the resource API (`readResource` arrived with it).
 * @param ctx - plugin context carrying the webServer and connection services.
 */
export function apply(ctx) {
    const distIndex = resolveDistIndex();
    const distRoot = dirname(distIndex);
    const authorizeIndex = ctx.connection;
    const supportsResourceApi = typeof ctx.webServer.readResource === 'function';
    const authorizeToResponse = (req) => {
        if (supportsResourceApi) {
            // Current Connection writes its refusal through a Fetch adapter. The
            // synthetic Request carries the audience (Host) and the admission
            // cookie: audience mismatches reject an otherwise valid cookie.
            let status = 401;
            let headers = {};
            let body;
            const requestHeaders = {};
            const host = headerValue(req.headers.host);
            if (host !== undefined)
                requestHeaders.host = host;
            const cookie = headerValue(req.headers.cookie);
            if (cookie !== undefined)
                requestHeaders.cookie = cookie;
            const admitted = authorizeIndex.authorizeIndex(new Request(absoluteUrl(req), { headers: requestHeaders }), {
                writeHead(nextStatus, nextHeaders) {
                    status = nextStatus;
                    headers = nextHeaders;
                },
                end(text) { body = text; },
            });
            return admitted ? undefined : new Response(body ?? '', { status, headers });
        }
        // Pre-resource Connection form: authorizeIndex answers a refusal by
        // writing the raw response itself; capture that write as a Response.
        let status = 401;
        let headers = {};
        let body;
        const capture = {
            writeHead(nextStatus, nextHeaders) {
                status = nextStatus;
                headers = nextHeaders ?? {};
            },
            setHeader(name, value) { headers[name] = String(value); },
            end(text) { if (text !== undefined)
                body = String(text); },
        };
        const admitted = authorizeIndex.authorizeIndex(req, capture);
        return admitted ? undefined : new Response(body ?? '', { status, headers });
    };
    ctx.effect(() => ctx.webServer.register({
        kind: 'prefix',
        path: PET_PATH_PREFIX,
        handler: async (req, res) => {
            const ifNoneMatch = headerValue(req.headers['if-none-match']);
            const request = new Request(absoluteUrl(req), {
                method: req.method ?? 'GET',
                ...(ifNoneMatch === undefined ? {} : { headers: { 'if-none-match': ifNoneMatch } }),
            });
            const response = await servePetStatic(request, distRoot, distIndex, () => authorizeToResponse(req));
            res.writeHead(response.status, Object.fromEntries(response.headers.entries()));
            if (req.method === 'HEAD' || response.body === null) {
                res.end();
                return;
            }
            res.end(Buffer.from(await response.arrayBuffer()));
        },
    }), 'pet-surface: /pet route');
    // Publish the locator after the tree settles (the webserver's port is part
    // of the boot the Loader still owns mid-activation), mirroring how web-app
    // times its URL line. A hand-built tree without a Loader is already whole.
    const authenticatedRoot = () => {
        if (ctx.get('webServer') === undefined || ctx.get('connection') === undefined)
            return undefined;
        return ctx.connection.authenticatedUrl(`${ctx.webServer.protocol}//127.0.0.1:${String(ctx.webServer.port)}`);
    };
    const publishLocator = (url) => {
        const record = `${JSON.stringify({ url, since: Date.now(), pid: process.pid })}\n`;
        void mkdir(dirname(petLocatorPath()), { recursive: true })
            .then(() => writeFile(petLocatorPath(), record, 'utf8'))
            .catch((error) => {
            console.error(`pet-surface: could not write the locator file: ${error instanceof Error ? error.message : String(error)}`);
        });
    };
    /**
     * Auto-start the pet window. A bare Electron binary runs any app directory
     * (`electron.exe <dir>`), but a PACKAGED one (the installed desktop) loads
     * its own app and dies on its single-instance lock instead — so the host's
     * `process.execPath` is only a last resort and the resolution order is an
     * explicit env override, a binary staged beside this package, then the
     * `electron` npm dependency (its module resolves to the binary path).
     * The carrier's single-instance lock collapses duplicates.
     */
    const resolveElectronBinary = () => {
        if (process.env.DSH_PET_ELECTRON !== undefined && process.env.DSH_PET_ELECTRON !== '') {
            return process.env.DSH_PET_ELECTRON;
        }
        const pkgRoot = resolve(join(dirname(fileURLToPath(import.meta.url)), '..'));
        const staged = join(pkgRoot, 'electron-bin', process.platform === 'win32' ? 'electron.exe'
            : process.platform === 'darwin' ? join('Electron.app', 'Contents', 'MacOS', 'Electron')
                : 'electron');
        if (existsSync(staged))
            return staged;
        try {
            const require = createRequire(import.meta.url);
            // In a Node host the electron package's module resolves to its binary
            // path; inside an Electron main process it is the API object and the
            // existence check below rejects it.
            const candidate = String(require('electron'));
            if (existsSync(candidate))
                return candidate;
        }
        catch { /* no electron dependency in this composition */ }
        // npm-electron fallback: an npm install carries the electron
        // DEPENDENCY (node_modules/electron/dist/electron.exe) instead of a
        // staged electron-bin — and require('electron') inside an Electron
        // host returns the API object, not a binary path. Walk up from the
        // driver's own location to find the dependency's binary.
        try {
            let dir = dirname(fileURLToPath(import.meta.url));
            for (let i = 0; i < 8; i += 1) {
                const pkgDir = join(dir, 'node_modules', 'electron');
                const exe = readFileSync(join(pkgDir, 'path.txt'), 'utf8').trim();
                const binary = join(pkgDir, 'dist', exe);
                if (existsSync(binary))
                    return binary;
                const parent = dirname(dir);
                if (parent === dir)
                    break;
                dir = parent;
            }
        }
        catch { /* electron dependency not found on disk */ }
        return process.versions.electron !== undefined ? process.execPath : undefined;
    };
    const spawnPetCarrier = (url) => {
        const carrierDir = resolve(join(dirname(fileURLToPath(import.meta.url)), '..', 'carrier'));
        const electronBinary = resolveElectronBinary();
        if (process.env.DSH_PET_NO_SPAWN === '1' || electronBinary === undefined
            || !existsSync(join(carrierDir, 'package.json')))
            return;
        const child = spawn(electronBinary, [carrierDir], {
            // The host often runs inside its own Electron binary in Node mode
            // (ELECTRON_RUN_AS_NODE=1, e.g. the desktop's host child); inheriting
            // that flag would boot the carrier headless in Node mode too.
            env: {
                ...stripRunAsNode(process.env),
                DSH_PET_URL: url,
                // The carrier's liveness anchor: dispose-time kill never runs when the
                // runtime is terminated (only on graceful shutdown), and a detached
                // child escapes OS tree-kills — the carrier polls this pid itself.
                DSH_PET_RUNTIME_PID: String(process.pid),
            },
            detached: true,
            stdio: ['ignore', 'pipe', 'pipe'],
        });
        // Piped, not ignored: the carrier's diagnostics (control-interface calls,
        // load failures) are the only visibility into an auto-started pet.
        child.stdout?.setEncoding('utf8');
        child.stdout?.on('data', (chunk) => { process.stdout.write(`[pet-carrier] ${chunk}`); });
        child.stderr?.setEncoding('utf8');
        child.stderr?.on('data', (chunk) => { process.stderr.write(`[pet-carrier] ${chunk}`); });
        child.unref();
        ctx.effect(() => () => { child.kill(); }, 'pet-surface: carrier shutdown');
    };
    const settledReady = () => {
        const url = authenticatedRoot();
        if (url === undefined)
            return;
        publishLocator(url);
        // Multi-pet: the registry decides who is driven. The electron carrier
        // still auto-spawns (it IS this bundle's pet); the user's settings-page
        // close control and the pure pet's own supervision govern the rest. The
        // old activePet gate retired with the single-manifest design.
        spawnPetCarrier(url);
    };
    const settled = ctx.get('loader')?.await();
    if (settled === undefined)
        settledReady();
    else
        void settled.then(settledReady).catch(() => { });
    // The DSH-knowledge half (§7.2): converge this runtime's in-process events
    // into pet operations over the control interface. Installed regardless of
    // spawning — a manually launched pet is driven through the same manifest.
    // The pet capability seam first: discovery, liveness, and /status
    // normalization live behind it. The INSTANCE is passed to the imperative
    // consumers below — ctx.petService GETTER access from the same tick does
    // not wait for queued plugin fibers and threw "not found", failing the
    // whole apply (routes rolled back, locator withdrawn, carrier killed).
    // Future external plugins can still inject: ['petService'].
    const pet = installPetService(ctx, dirname(petLocatorPath()));
    installPetDriver(ctx, dirname(petLocatorPath()), pet);
    // The model-expression tools moved behind the pet preset (presets/pet.patch.yml
    // composes the ./tools entry) — sessions mounting other presets keep a clean
    // tool catalog. The host-side glue above stays unconditional.
    // The desktop sidebar settings page's host half (client half: ./client/).
    installSettingsPage(ctx, dirname(petLocatorPath()), pet);
    // Withdraw on dispose while still our own entry, so a shut-down runtime does
    // not shadow a live publisher's file.
    ctx.effect(() => () => {
        void readFile(petLocatorPath(), 'utf8').then((raw) => {
            const record = JSON.parse(raw);
            if (record.pid === process.pid)
                return unlink(petLocatorPath());
            return undefined;
        }).catch(() => { });
    }, 'pet-surface: locator withdrawal');
}
//# sourceMappingURL=index.js.map