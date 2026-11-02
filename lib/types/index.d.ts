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
import type { Context } from '@deepseek-ai/cordis';
/** Stable Cordis plugin name. */
export declare const name = "pet-surface";
/**
 * Services required before the `/pet` route can register. `sessionController`
 * is a SIBLING plugin row's service (the api-session-controller row in the
 * same composition): a command-style ctx.get from this row's fiber never sees
 * it (the petTools/petService precedent), while static inject is resolved by
 * the Loader ACROSS rows and waits for that row to mount — the webServer
 * precedent. Every profile mounting this bundle mounts the web-app rows too,
 * so the dependency is always satisfiable.
 */
export declare const inject: string[];
/** The URL path prefix the pet renderer is served under. No trailing slash. */
export declare const PET_PATH_PREFIX = "/whale598";
/**
 * Locator file naming this runtime's authenticated root for the pet carrier.
 * The desktop shell keeps its authenticated URL in process memory only, so a
 * bundle inside that runtime is the only component positioned to publish it.
 * The carrier prefers the env override, then this file's freshest live
 * publisher, then falls back to spawning its own profile.
 */
export declare function petLocatorPath(): string;
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
export declare function servePetStatic(request: Request, distRoot: string, distIndex: string, authorizeIndex: () => Response | undefined): Promise<Response>;
/**
 * Register the `/pet` prefix route with a raw handler serving the pet renderer
 * dist, and publish the locator. The handler form predates resource-typed
 * routes, so one code path serves both the installed 0.2.1-rc.3 desktop
 * webserver and current builds; authorizeIndex branches on whether the
 * webserver carries the resource API (`readResource` arrived with it).
 * @param ctx - plugin context carrying the webServer and connection services.
 */
export declare function apply(ctx: Context): void;
