import { i as installPetDriver, n as installPetService } from "./service-DxjBryJy.js";
import { createRequire } from "node:module";
import { spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync } from "node:fs";
import { mkdir, readFile, unlink, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { dirname, extname, join, normalize, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";
//#region lib/types/settings-page.js
/**
* The settings page's host half: local HTTP routes backing the desktop
* sidebar "桌宠" page (the client half lives in ./client/pet-settings.js and
* registers through the web GUI's slot system, per the dsh-qqbot precedent).
* Settings persist in their own JSON file in the dsh home — the platform
* settings service derives namespaces from profile entry config schemas,
* which this bundle does not declare; a file keeps the surface honest.
* Routes use the raw handler form (resource routes postdate rc.3) behind a
* same-origin loopback fence, one registration per path with internal method
* dispatch — the webserver throws on duplicate path registration.
* @module dsh-agentic-pet/settings-page
*/
const DEFAULT_SETTINGS = {
	proactivity: {
		enabled: false,
		cooldownMinutes: 10,
		idleThresholdMinutes: 5,
		idleAnimation: true,
		idleAnimationGapMinutes: 10
	},
	debug: { cdp: false }
};
/** The touch ledger the driver owns; reset writes the driver's empty shape. */
const EMPTY_LEDGER = {
	affection: 0,
	total: 0,
	byPart: {},
	recent: []
};
/** Same-origin loopback fence (dsh-qqbot precedent): local host only, no
* cross-site fetches, and an Origin header — when present — must be this
* server's own host. */
function isTrusted(req) {
	const host = req.headers.host;
	if (typeof host !== "string") return false;
	let hostname;
	try {
		hostname = new URL(`http://${host}`).hostname;
	} catch {
		return false;
	}
	if (!/^(\[::1\]|localhost|127(\.\d{1,3}){3})$/.test(hostname)) return false;
	if (req.headers["sec-fetch-site"] === "cross-site") return false;
	const origin = req.headers.origin;
	if (origin === void 0) return true;
	try {
		return new URL(origin).host === host;
	} catch {
		return false;
	}
}
function writeJson(res, status, body) {
	res.writeHead(status, { "content-type": "application/json; charset=utf-8" });
	res.end(JSON.stringify(body));
}
async function readJsonBody(req) {
	const chunks = [];
	let size = 0;
	for await (const chunk of req) {
		size += chunk.length;
		if (size > 1024 * 1024) return void 0;
		chunks.push(chunk);
	}
	try {
		const parsed = JSON.parse(Buffer.concat(chunks).toString("utf8"));
		return typeof parsed === "object" && parsed !== null ? parsed : void 0;
	} catch {
		return;
	}
}
/** Clamp a number into [min, max]; undefined passthrough for absent input. */
function clampNumber(value, min, max) {
	if (typeof value !== "number" || !Number.isFinite(value)) return void 0;
	return Math.min(max, Math.max(min, Math.round(value)));
}
/** Merge a patch into the settings, accepting only the known keys. */
function mergeSettings(current, patch) {
	const proactivity = {
		...DEFAULT_SETTINGS.proactivity,
		...current.proactivity
	};
	const debug = {
		...DEFAULT_SETTINGS.debug,
		...current.debug
	};
	const patchProactivity = patch.proactivity;
	if (typeof patchProactivity === "object" && patchProactivity !== null) {
		const p = patchProactivity;
		if (typeof p.enabled === "boolean") proactivity.enabled = p.enabled;
		const cooldown = clampNumber(p.cooldownMinutes, 1, 240);
		if (cooldown !== void 0) proactivity.cooldownMinutes = cooldown;
		const idle = clampNumber(p.idleThresholdMinutes, 1, 240);
		if (idle !== void 0) proactivity.idleThresholdMinutes = idle;
		if (typeof p.idleAnimation === "boolean") proactivity.idleAnimation = p.idleAnimation;
		const gap = clampNumber(p.idleAnimationGapMinutes, 1, 120);
		if (gap !== void 0) proactivity.idleAnimationGapMinutes = gap;
	}
	const patchDebug = patch.debug;
	if (typeof patchDebug === "object" && patchDebug !== null) {
		const d = patchDebug;
		if (typeof d.cdp === "boolean") debug.cdp = d.cdp;
	}
	return {
		proactivity,
		debug
	};
}
function openPathInFileManager(path) {
	if (process.platform === "win32") {
		spawn("explorer.exe", [path], {
			detached: true,
			stdio: "ignore"
		}).unref();
		return;
	}
	spawn(process.platform === "darwin" ? "open" : "xdg-open", [path], {
		detached: true,
		stdio: "ignore"
	}).unref();
}
/**
* Register the settings page's routes. One registration per exact path with
* internal method dispatch; every handler runs behind the fence.
* @param ctx - plugin context inside the runtime.
* @param home - the dsh home holding the settings/ledger/manifest files.
*/
function installSettingsPage(ctx, home, pet) {
	const settingsPath = join(home, "pet-settings.json");
	const ledgerPath = join(home, "pet-affection.json");
	const windowPath = join(home, "pet-window.json");
	/** Summarize EVERY live pet (id, online flag, normalized /status). */
	const petStatus = async () => {
		return { pets: (await Promise.all((await pet.list()).map((entry) => pet.snapshot(entry)))).map(({ id, online, ...rest }) => ({
			id,
			online,
			...rest
		})) };
	};
	const readSettings = async () => {
		try {
			return mergeSettings(JSON.parse(await readFile(settingsPath, "utf8")), {});
		} catch {
			return mergeSettings({}, {});
		}
	};
	const routeByPath = /* @__PURE__ */ new Map();
	const route = (method, path, handler) => {
		let handlers = routeByPath.get(path);
		if (handlers === void 0) {
			handlers = /* @__PURE__ */ new Map();
			routeByPath.set(path, handlers);
			ctx.effect(() => ctx.webServer.register({
				kind: "exact",
				path,
				handler: async (req, res) => {
					const httpReq = req;
					const httpRes = res;
					if (!isTrusted(httpReq)) {
						writeJson(httpRes, 403, { error: "refused: same-origin loopback only" });
						return;
					}
					const registered = handlers?.get(String(httpReq.method ?? "").toUpperCase());
					if (registered === void 0) {
						writeJson(httpRes, 405, { error: "method not allowed" });
						return;
					}
					try {
						await registered(httpReq, httpRes);
					} catch (error) {
						writeJson(httpRes, 500, { error: error instanceof Error ? error.message : String(error) });
					}
				}
			}), `pet-surface: settings ${path}`);
		}
		handlers.set(method, handler);
	};
	route("GET", "/api/pet-settings/read", async (_req, res) => {
		const [settings, windowPosition, status] = await Promise.all([
			readSettings(),
			readFile(windowPath, "utf8").then((raw) => JSON.parse(raw), () => null),
			petStatus()
		]);
		const affection = {};
		const legacyBook = await readFile(ledgerPath, "utf8").then((raw) => JSON.parse(raw), () => null);
		const bookIds = new Set(status.pets.map((pet) => String(pet.id)));
		bookIds.add("electron");
		for (const id of bookIds) {
			const book = await readFile(id === "electron" && legacyBook !== null ? ledgerPath : join(home, "pet-affection.d", `${id}.json`), "utf8").then((raw) => JSON.parse(raw), () => null);
			if (book !== null) affection[id] = book;
		}
		writeJson(res, 200, {
			settings,
			affection,
			windowPosition,
			pets: status.pets
		});
	});
	route("POST", "/api/pet-settings/update", async (req, res) => {
		const body = await readJsonBody(req);
		const patch = body === void 0 ? void 0 : body.patch;
		if (typeof patch !== "object" || patch === null) {
			writeJson(res, 400, { error: "body must be {patch:{...}}" });
			return;
		}
		const next = mergeSettings(await readSettings(), patch);
		await writeFile(settingsPath, `${JSON.stringify(next, null, 2)}\n`, "utf8");
		ctx.emit("pet-settings/changed");
		writeJson(res, 200, {
			ok: true,
			settings: next
		});
	});
	route("POST", "/api/pet-settings/reset-affection", async (_req, res) => {
		await writeFile(ledgerPath, `${JSON.stringify(EMPTY_LEDGER)}\n`, "utf8");
		writeJson(res, 200, {
			ok: true,
			affection: EMPTY_LEDGER
		});
	});
	route("POST", "/api/pet-settings/reset-position", async (_req, res) => {
		if (existsSync(windowPath)) await unlink(windowPath);
		writeJson(res, 200, { ok: true });
	});
	route("POST", "/api/pet-settings/open-logs", async (_req, res) => {
		const logsDir = join(home, "logs");
		const target = existsSync(logsDir) ? logsDir : home;
		openPathInFileManager(target);
		writeJson(res, 200, {
			ok: true,
			opened: target
		});
	});
}
//#endregion
//#region lib/types/index.js
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
/** Stable Cordis plugin name. */
const name = "pet-surface";
/** Services required before the `/pet` route can register. */
const inject = ["webServer", "connection"];
/** The URL path prefix the pet renderer is served under. No trailing slash. */
const PET_PATH_PREFIX = "/pet";
/**
* Locator file naming this runtime's authenticated root for the pet carrier.
* The desktop shell keeps its authenticated URL in process memory only, so a
* bundle inside that runtime is the only component positioned to publish it.
* The carrier prefers the env override, then this file's freshest live
* publisher, then falls back to spawning its own profile.
*/
function petLocatorPath() {
	return join(process.env.DSH_HOME ?? join(homedir(), ".dsh"), "pet-surface-url.json");
}
const HTML_MIME = "text/html; charset=utf-8";
const MIME = {
	".html": HTML_MIME,
	".js": "text/javascript; charset=utf-8",
	".css": "text/css; charset=utf-8",
	".png": "image/png",
	".svg": "image/svg+xml",
	".webp": "image/webp",
	".ico": "image/x-icon",
	".json": "application/json",
	".map": "application/json",
	".webmanifest": "application/manifest+json",
	".woff2": "font/woff2"
};
const STATIC_MISS_CODES = new Set([
	"ENOENT",
	"EISDIR",
	"ENOTDIR"
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
		return join(dirname(require.resolve("@deepseek-ai/dsh-pet/package.json")), "dist-renderer", "index.html");
	} catch {
		const shipped = join(dirname(fileURLToPath(import.meta.url)), "..", "carrier", "dist-renderer", "index.html");
		if (existsSync(shipped)) return shipped;
		throw new Error("pet-app: the pet renderer dist is not resolvable from this composition (neither @deepseek-ai/dsh-pet nor the shipped carrier dist)");
	}
}
/** A Response body that is `bytes` itself, without the copy a buffer body gets. */
function bytesBody(bytes) {
	return new ReadableStream({ start(controller) {
		controller.enqueue(bytes);
		controller.close();
	} });
}
/**
* Answer one GET or HEAD `/pet` request. The URL path is the full server
* pathname (`/pet` prefix included); it must be exactly the prefix or stay
* under it. The index entry (`/pet`, `/pet/`, `/pet/index.html`) passes
* Connection's browser authentication; every other file is public with a weak
* ETag and `cache-control: no-cache`, answering a matching `If-None-Match`
* with 304. Traversal outside the dist root is 403, missing paths are 404, a
* malformed percent-escape rejects (the adapter answers 400 over HTTP), and
* non-GET/HEAD is 405. The index serves raw, deliberately NOT through
* webServer.renderIndex: the web boot injections (opaque boot background,
* module-system bootstrap) are Web-GUI concerns that would paint the
* transparent pet window opaque.
*/
async function servePetStatic(request, distRoot, distIndex, authorizeIndex) {
	const pathname = decodeURIComponent(new URL(request.url).pathname);
	const target = resolve(normalize(join(distRoot, pathname === "/pet" || pathname === `/pet/` ? "/" : pathname.slice(4))));
	if (target !== distRoot && !target.startsWith(distRoot + sep)) return new Response(null, { status: 403 });
	let body;
	let headers;
	try {
		if (target === distRoot || target === distIndex) {
			const refusal = authorizeIndex();
			if (refusal !== void 0) return refusal;
			body = await readFile(distIndex, "utf8");
			headers = { "content-type": HTML_MIME };
		} else {
			body = await readFile(target);
			const cache = {
				"cache-control": "no-cache",
				etag: `W/"${createHash("sha1").update(body).digest("base64url")}"`
			};
			if (request.headers.get("if-none-match") === cache.etag) return new Response(null, {
				status: 304,
				headers: cache
			});
			headers = {
				"content-type": MIME[extname(target)] ?? "application/octet-stream",
				...cache
			};
		}
	} catch (error) {
		if (!STATIC_MISS_CODES.has(error.code)) throw error;
		return new Response(null, { status: 404 });
	}
	if (request.method === "HEAD") return new Response(null, {
		status: 200,
		headers
	});
	return new Response(typeof body === "string" ? body : bytesBody(body), {
		status: 200,
		headers
	});
}
/** The environment minus Electron's Node-mode flag, so a spawned GUI child is a GUI child. */
function stripRunAsNode(env) {
	const clean = { ...env };
	delete clean.ELECTRON_RUN_AS_NODE;
	return clean;
}
/** One raw webserver handler request's absolute URL. */
function absoluteUrl(req) {
	return `http://${req.headers.host ?? "127.0.0.1"}${req.url ?? "/"}`;
}
/** Normalize a node header value (string | string[] | undefined) for Fetch. */
function headerValue(value) {
	return Array.isArray(value) ? value.join(", ") : value;
}
/**
* Register the `/pet` prefix route with a raw handler serving the pet renderer
* dist, and publish the locator. The handler form predates resource-typed
* routes, so one code path serves both the installed 0.2.1-rc.3 desktop
* webserver and current builds; authorizeIndex branches on whether the
* webserver carries the resource API (`readResource` arrived with it).
* @param ctx - plugin context carrying the webServer and connection services.
*/
function apply(ctx) {
	const distIndex = resolveDistIndex();
	const distRoot = dirname(distIndex);
	const authorizeIndex = ctx.connection;
	const supportsResourceApi = typeof ctx.webServer.readResource === "function";
	const authorizeToResponse = (req) => {
		if (supportsResourceApi) {
			let status = 401;
			let headers = {};
			let body;
			const requestHeaders = {};
			const host = headerValue(req.headers.host);
			if (host !== void 0) requestHeaders.host = host;
			const cookie = headerValue(req.headers.cookie);
			if (cookie !== void 0) requestHeaders.cookie = cookie;
			return authorizeIndex.authorizeIndex(new Request(absoluteUrl(req), { headers: requestHeaders }), {
				writeHead(nextStatus, nextHeaders) {
					status = nextStatus;
					headers = nextHeaders;
				},
				end(text) {
					body = text;
				}
			}) ? void 0 : new Response(body ?? "", {
				status,
				headers
			});
		}
		let status = 401;
		let headers = {};
		let body;
		return authorizeIndex.authorizeIndex(req, {
			writeHead(nextStatus, nextHeaders) {
				status = nextStatus;
				headers = nextHeaders ?? {};
			},
			setHeader(name, value) {
				headers[name] = String(value);
			},
			end(text) {
				if (text !== void 0) body = String(text);
			}
		}) ? void 0 : new Response(body ?? "", {
			status,
			headers
		});
	};
	ctx.effect(() => ctx.webServer.register({
		kind: "prefix",
		path: PET_PATH_PREFIX,
		handler: async (req, res) => {
			const ifNoneMatch = headerValue(req.headers["if-none-match"]);
			const response = await servePetStatic(new Request(absoluteUrl(req), {
				method: req.method ?? "GET",
				...ifNoneMatch === void 0 ? {} : { headers: { "if-none-match": ifNoneMatch } }
			}), distRoot, distIndex, () => authorizeToResponse(req));
			res.writeHead(response.status, Object.fromEntries(response.headers.entries()));
			if (req.method === "HEAD" || response.body === null) {
				res.end();
				return;
			}
			res.end(Buffer.from(await response.arrayBuffer()));
		}
	}), "pet-surface: /pet route");
	const authenticatedRoot = () => {
		if (ctx.get("webServer") === void 0 || ctx.get("connection") === void 0) return void 0;
		return ctx.connection.authenticatedUrl(`${ctx.webServer.protocol}//127.0.0.1:${String(ctx.webServer.port)}`);
	};
	const publishLocator = (url) => {
		const record = `${JSON.stringify({
			url,
			since: Date.now(),
			pid: process.pid
		})}\n`;
		mkdir(dirname(petLocatorPath()), { recursive: true }).then(() => writeFile(petLocatorPath(), record, "utf8")).catch((error) => {
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
		if (process.env.DSH_PET_ELECTRON !== void 0 && process.env.DSH_PET_ELECTRON !== "") return process.env.DSH_PET_ELECTRON;
		const staged = join(resolve(join(dirname(fileURLToPath(import.meta.url)), "..")), "electron-bin", process.platform === "win32" ? "electron.exe" : process.platform === "darwin" ? join("Electron.app", "Contents", "MacOS", "Electron") : "electron");
		if (existsSync(staged)) return staged;
		try {
			const require = createRequire(import.meta.url);
			const candidate = String(require("electron"));
			if (existsSync(candidate)) return candidate;
		} catch {}
		return process.versions.electron !== void 0 ? process.execPath : void 0;
	};
	const spawnPetCarrier = (url) => {
		const carrierDir = resolve(join(dirname(fileURLToPath(import.meta.url)), "..", "carrier"));
		const electronBinary = resolveElectronBinary();
		if (process.env.DSH_PET_NO_SPAWN === "1" || electronBinary === void 0 || !existsSync(join(carrierDir, "package.json"))) return;
		const child = spawn(electronBinary, [carrierDir], {
			env: {
				...stripRunAsNode(process.env),
				DSH_PET_URL: url,
				DSH_PET_RUNTIME_PID: String(process.pid)
			},
			detached: true,
			stdio: [
				"ignore",
				"pipe",
				"pipe"
			]
		});
		child.stdout?.setEncoding("utf8");
		child.stdout?.on("data", (chunk) => {
			process.stdout.write(`[pet-carrier] ${chunk}`);
		});
		child.stderr?.setEncoding("utf8");
		child.stderr?.on("data", (chunk) => {
			process.stderr.write(`[pet-carrier] ${chunk}`);
		});
		child.unref();
		ctx.effect(() => () => {
			child.kill();
		}, "pet-surface: carrier shutdown");
	};
	const settledReady = () => {
		const url = authenticatedRoot();
		if (url === void 0) return;
		publishLocator(url);
		spawnPetCarrier(url);
	};
	const settled = ctx.get("loader")?.await();
	if (settled === void 0) settledReady();
	else settled.then(settledReady).catch(() => {});
	const pet = installPetService(ctx, dirname(petLocatorPath()));
	installPetDriver(ctx, dirname(petLocatorPath()), pet);
	installSettingsPage(ctx, dirname(petLocatorPath()), pet);
	ctx.effect(() => () => {
		readFile(petLocatorPath(), "utf8").then((raw) => {
			if (JSON.parse(raw).pid === process.pid) return unlink(petLocatorPath());
		}).catch(() => {});
	}, "pet-surface: locator withdrawal");
}
//#endregion
export { PET_PATH_PREFIX, apply, inject, name, petLocatorPath, servePetStatic };
