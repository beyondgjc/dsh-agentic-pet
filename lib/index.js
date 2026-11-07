import { _ as writePetName, c as parseClock, d as readAffectionRaw, f as readGlobalJson, g as writeGlobalJson, h as writeAffectionRaw, i as voiceBindingSnapshot, l as eventsFile, m as readPetName, o as installPetService, p as readJsonl, s as petHome, t as installPetDriver, u as globalFilePath, v as isPetPreset, y as patchTouchesElectronBinding } from "./driver-DhLIX7u0.js";
import { createRequire } from "node:module";
import { execFileSync, spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { appendFileSync, existsSync, mkdirSync, readFileSync, renameSync, statSync, unlinkSync, writeFileSync } from "node:fs";
import { mkdir, readFile, rm, unlink, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { dirname, extname, join, normalize, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";
const INSTALL_LOCK_MALFORMED_GRACE_MS = 6e4;
/** True when `pid` names a live process (EPERM means it exists but is not ours). */
function isProcessAlive(pid) {
	if (!Number.isInteger(pid) || pid <= 0) return false;
	try {
		process.kill(pid, 0);
		return true;
	} catch (error) {
		return error.code === "EPERM";
	}
}
/** Parse a lock file; `undefined` means empty/malformed. */
function parseInstallLock(raw) {
	try {
		const value = JSON.parse(raw);
		return typeof value === "object" && value !== null ? value : void 0;
	} catch {
		return;
	}
}
/**
* Whether an existing lock may be taken over by a new installer.
* A dead owner is stale immediately; a live owner keeps its lock until the
* absolute cap (which also bounds PID-reuse false positives). A malformed
* record gets a short grace for a concurrent writer, then goes stale.
*/
function installLockStale(raw, mtimeMs, now, alive = isProcessAlive) {
	if (now - mtimeMs > 18e5) return true;
	const record = raw === void 0 ? void 0 : parseInstallLock(raw);
	const pid = typeof record?.pid === "number" ? record.pid : void 0;
	if (pid === void 0) return now - mtimeMs > INSTALL_LOCK_MALFORMED_GRACE_MS;
	return !alive(pid);
}
// lib/types/electron-runtime-status.js
/**
* Persisted state of the Electron runtime bootstrap, shared by the installer
* path (writer) and the settings page (reader). The settings page is the only
* user-visible surface while the first install downloads ~158 MB, so this
* file is deliberately plain JSON in the pet home rather than process state.
* @module dsh-agentic-pet/electron-runtime-status
*/
function electronRuntimeStatusPath(home) {
	return join(home, "whale598", "electron-runtime.json");
}
function readElectronRuntimeStatus(home) {
	try {
		const parsed = JSON.parse(readFileSync(electronRuntimeStatusPath(home), "utf8"));
		if (typeof parsed !== "object" || parsed === null) return void 0;
		const status = parsed;
		return typeof status.state === "string" ? status : void 0;
	} catch {
		return;
	}
}
function writeElectronRuntimeStatus(home, status) {
	try {
		const path = electronRuntimeStatusPath(home);
		mkdirSync(dirname(path), { recursive: true });
		const tmp = `${path}.${String(process.pid)}.tmp`;
		writeFileSync(tmp, `${JSON.stringify(status)}\n`, "utf8");
		renameSync(tmp, path);
	} catch {}
}
// lib/types/settings-page.js
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
/** The touch ledger the driver owns; reset writes the driver's empty shape. */
const DEFAULT_SETTINGS = {
	proactivity: {
		enabled: false,
		cooldownMinutes: 10,
		idleThresholdMinutes: 5,
		idleAnimation: true,
		idleAnimationGapMinutes: 10
	},
	innerVoice: {
		enabled: true,
		preset: "whale598",
		wakeIntervalMinutes: 2,
		speakProbability: .5,
		touchReplyProbability: .3,
		touchReplyCooldownSeconds: 30,
		selfWakeBusyPolicy: "fire",
		petToPetDelivery: "queue",
		petMessageLimits: {
			minutes5: 5,
			minutes10: 8,
			minutes30: 10,
			minutes60: 15
		},
		boundSessions: {}
	},
	rhythm: { quiet: null },
	journal: {
		enabled: true,
		injectRecent: 3,
		maxEntryChars: 120,
		maxFileBytes: 262144,
		allowUnboundAppend: false
	},
	presenceSummary: { enabled: false },
	tts: { enabled: false },
	debug: { cdp: false }
};
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
		if (size > 1048576) return void 0;
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
	const innerVoice = {
		...DEFAULT_SETTINGS.innerVoice,
		...current.innerVoice
	};
	const rhythm = {
		quiet: null,
		...current.rhythm
	};
	const journal = {
		...DEFAULT_SETTINGS.journal,
		...current.journal
	};
	const presenceSummary = {
		enabled: false,
		...current.presenceSummary
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
	const patchInnerVoice = patch.innerVoice;
	if (typeof patchInnerVoice === "object" && patchInnerVoice !== null) {
		const v = patchInnerVoice;
		if (typeof v.enabled === "boolean") innerVoice.enabled = v.enabled;
		if (typeof v.preset === "string" && v.preset !== "") innerVoice.preset = v.preset;
		const wake = clampNumber(v.wakeIntervalMinutes, 1, 60);
		if (wake !== void 0) innerVoice.wakeIntervalMinutes = wake;
		if (typeof v.speakProbability === "number" && Number.isFinite(v.speakProbability)) innerVoice.speakProbability = Math.min(1, Math.max(0, v.speakProbability));
		if (typeof v.touchReplyProbability === "number" && Number.isFinite(v.touchReplyProbability)) innerVoice.touchReplyProbability = Math.min(1, Math.max(0, v.touchReplyProbability));
		const replyCooldown = clampNumber(v.touchReplyCooldownSeconds, 0, 600);
		if (replyCooldown !== void 0) innerVoice.touchReplyCooldownSeconds = replyCooldown;
		if (v.selfWakeBusyPolicy === "defer" || v.selfWakeBusyPolicy === "fire") innerVoice.selfWakeBusyPolicy = v.selfWakeBusyPolicy;
		if (v.petToPetDelivery === "immediate" || v.petToPetDelivery === "queue") innerVoice.petToPetDelivery = v.petToPetDelivery;
		const patchLimits = v.petMessageLimits;
		if (typeof patchLimits === "object" && patchLimits !== null) {
			const merged = {
				minutes5: 5,
				minutes10: 8,
				minutes30: 10,
				minutes60: 15,
				...innerVoice.petMessageLimits
			};
			const base = {
				minutes5: merged.minutes5 ?? 5,
				minutes10: merged.minutes10 ?? 8,
				minutes30: merged.minutes30 ?? 10,
				minutes60: merged.minutes60 ?? 15
			};
			const clampLimit = (value, fallback) => {
				const parsed = clampNumber(value, 0, 999);
				return parsed === void 0 ? fallback : parsed;
			};
			innerVoice.petMessageLimits = {
				minutes5: clampLimit(patchLimits.minutes5, base.minutes5),
				minutes10: clampLimit(patchLimits.minutes10, base.minutes10),
				minutes30: clampLimit(patchLimits.minutes30, base.minutes30),
				minutes60: clampLimit(patchLimits.minutes60, base.minutes60)
			};
		}
		const bound = v.boundSessions;
		if (typeof bound === "object" && bound !== null) {
			const record = {};
			for (const [petId, sessionId] of Object.entries(bound)) if (petId !== "" && typeof sessionId === "string" && sessionId !== "") record[petId] = sessionId;
			innerVoice.boundSessions = record;
		}
	}
	const patchRhythm = patch.rhythm;
	if (typeof patchRhythm === "object" && patchRhythm !== null) {
		const r = patchRhythm;
		if (r.quiet === null) rhythm.quiet = null;
		else if (typeof r.quiet === "object" && r.quiet !== null) {
			const q = r.quiet;
			const currentQuiet = current.rhythm?.quiet ?? void 0;
			rhythm.quiet = {
				from: typeof q.from === "string" && parseClock(q.from) !== void 0 ? q.from : currentQuiet?.from ?? "01:00",
				to: typeof q.to === "string" && parseClock(q.to) !== void 0 ? q.to : currentQuiet?.to ?? "09:00",
				allowTouchReply: typeof q.allowTouchReply === "boolean" ? q.allowTouchReply : currentQuiet?.allowTouchReply ?? true
			};
		}
	}
	const patchJournal = patch.journal;
	if (typeof patchJournal === "object" && patchJournal !== null) {
		const j = patchJournal;
		if (typeof j.enabled === "boolean") journal.enabled = j.enabled;
		const inject = clampNumber(j.injectRecent, 1, 20);
		if (inject !== void 0) journal.injectRecent = inject;
		const chars = clampNumber(j.maxEntryChars, 40, 1e3);
		if (chars !== void 0) journal.maxEntryChars = chars;
		const bytes = clampNumber(j.maxFileBytes, 4096, 4194304);
		if (bytes !== void 0) journal.maxFileBytes = bytes;
		if (typeof j.allowUnboundAppend === "boolean") journal.allowUnboundAppend = j.allowUnboundAppend;
	}
	const patchPresence = patch.presenceSummary;
	if (typeof patchPresence === "object" && patchPresence !== null) {
		const p = patchPresence;
		if (typeof p.enabled === "boolean") presenceSummary.enabled = p.enabled;
	}
	const patchDebug = patch.debug;
	if (typeof patchDebug === "object" && patchDebug !== null) {
		const d = patchDebug;
		if (typeof d.cdp === "boolean") debug.cdp = d.cdp;
	}
	const tts = { ...current.tts };
	const patchTts = patch.tts;
	if (typeof patchTts === "object" && patchTts !== null) {
		const t = patchTts;
		if (typeof t.enabled === "boolean") tts.enabled = t.enabled;
		const setText = (key) => {
			const value = t[key];
			if (typeof value !== "string") return;
			const trimmed = value.trim();
			if (trimmed === "") Reflect.deleteProperty(tts, key);
			else tts[key] = trimmed;
		};
		setText("apiKey");
		setText("voiceId");
		setText("modelId");
		setText("languageCode");
		if (typeof t.speed === "number" && Number.isFinite(t.speed)) tts.speed = Math.min(2, Math.max(.5, t.speed));
		if (typeof t.volume === "number" && Number.isFinite(t.volume)) tts.volume = Math.min(2, Math.max(.01, t.volume));
	}
	return {
		...current,
		proactivity,
		innerVoice,
		rhythm,
		journal,
		presenceSummary,
		tts,
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
	const command = process.platform === "darwin" ? "open" : "xdg-open";
	spawn(command, [path], {
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
function installSettingsPage(ctx, home, pet, control) {
	const windowPath = globalFilePath(home, "pet-window.json");
	/** Summarize EVERY live pet (id, online flag, normalized /status). */
	const petStatus = async () => {
		return { pets: (await Promise.all((await pet.list()).map((entry) => pet.snapshot(entry)))).map(({ id, online, ...rest }) => ({
			id,
			online,
			...rest
		})) };
	};
	const readSettings = async () => {
		return mergeSettings(await readGlobalJson(home, "pet-settings.json"), {});
	};
	/** Live header first, persisted header second. `checked:false` means the
	
	* host exposed neither source — never turn that into a "missing session".
	
	* `currentPreset` comes from the preset registry / projection cache, NOT
	
	* from the immutable creation-time header field. */
	const findSessionHeader = async (sessionId) => {
		const getService = (name) => ctx.get(name);
		const sessions = getService("sessions");
		const agentPresets = getService("agentPresets");
		const live = sessions?.get(sessionId);
		if (live?.header !== void 0) {
			let currentPreset;
			try {
				const preset = agentPresets?.presetForSession(live);
				if (typeof preset === "string" && preset !== "") currentPreset = preset;
			} catch {}
			return {
				header: live.header,
				checked: true,
				currentPreset
			};
		}
		const persistence = getService("sessionPersistence");
		if (persistence === void 0) return {
			header: void 0,
			checked: sessions !== void 0,
			currentPreset: void 0
		};
		try {
			const header = (await persistence.list()).find((snapshot) => snapshot.header?.id === sessionId)?.header;
			let currentPreset;
			if (header !== void 0) {
				const cache = getService("sessionProjectionCache");
				try {
					const preset = cache?.cachedSnapshot(header)?.values?.agentPreset;
					if (typeof preset === "string" && preset !== "") currentPreset = preset;
				} catch {}
			}
			return {
				header,
				checked: true,
				currentPreset
			};
		} catch {
			return {
				header: void 0,
				checked: false,
				currentPreset: void 0
			};
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
	route("GET", "/api/pet-settings/binding-status", async (_req, res) => {
		writeJson(res, 200, { status: voiceBindingSnapshot() });
	});
	route("POST", "/api/pet-settings/binding-test", async (req, res) => {
		if (control === void 0) {
			writeJson(res, 503, { error: "driver control unavailable" });
			return;
		}
		const body = await readJsonBody(req);
		const petId = typeof body?.petId === "string" && body.petId !== "" ? body.petId : "electron";
		writeJson(res, 200, await control.testBinding(petId));
	});
	route("GET", "/api/pet-settings/read", async (_req, res) => {
		const [settings, windowPosition, status] = await Promise.all([
			readSettings(),
			readGlobalJson(home, "pet-window.json").then((raw) => Object.keys(raw).length > 0 ? raw : null),
			petStatus()
		]);
		const affection = {};
		const bookIds = new Set(status.pets.map((pet) => String(pet.id)));
		bookIds.add("electron");
		for (const id of bookIds) {
			const book = await readAffectionRaw(home, id);
			if (book !== null) affection[id] = book;
		}
		const names = {};
		for (const id of bookIds) {
			const label = await readPetName(home, id);
			if (label !== void 0) names[id] = label;
		}
		const composed = {
			...settings,
			names
		};
		const touchTotals = {};
		for (const id of bookIds) {
			const events = await readJsonl(eventsFile(home, id), 600);
			const totals = {
				total: 0,
				byPart: {}
			};
			for (const event of events) {
				if (event.type !== "touch") continue;
				const part = typeof event.part === "string" ? event.part : "miss";
				totals.total += 1;
				totals.byPart[part] = (totals.byPart[part] ?? 0) + 1;
			}
			if (totals.total > 0) touchTotals[id] = totals;
		}
		writeJson(res, 200, {
			settings: composed,
			affection,
			windowPosition,
			pets: status.pets,
			touchTotals
		});
	});
	route("GET", "/api/pet-settings/electron-runtime", async (_req, res) => {
		writeJson(res, 200, {
			ok: true,
			runtime: readElectronRuntimeStatus(home) ?? null
		});
	});
	route("POST", "/api/pet-settings/update", async (req, res) => {
		const body = await readJsonBody(req);
		const patch = body === void 0 ? void 0 : body.patch;
		if (typeof patch !== "object" || patch === null) {
			writeJson(res, 400, { error: "body must be {patch:{...}}" });
			return;
		}
		const patchNames = patch.names;
		if (typeof patchNames === "object" && patchNames !== null) {
			for (const [petId, label] of Object.entries(patchNames)) await writePetName(home, petId, typeof label === "string" && label.trim() !== "" ? label : null);
			delete patch.names;
		}
		const next = mergeSettings(await readSettings(), patch);
		const warnings = [];
		const patchTouchesBinding = patchTouchesElectronBinding(patch);
		const bound = next.innerVoice?.boundSessions?.electron;
		if (typeof bound === "string" && bound !== "") {
			const found = await findSessionHeader(bound);
			if (found.checked && found.header === void 0) warnings.push(`会话 ${bound} 不存在`);
			else {
				if (found.currentPreset !== void 0 && !isPetPreset(found.currentPreset)) {
					if (patchTouchesBinding) {
						writeJson(res, 400, { error: `这个会话的当前模式是「${found.currentPreset}」，没有 pet_say/pet_do。请改用宠物模式（「精简（仅表达）」或「普通（含工作工具）」）的会话，或新建一个宠物模式会话后再绑定。` });
						return;
					}
					warnings.push("当前已保存的绑定会话不是宠物模式；本次保存已生效，但绑定不会有气泡回应。");
				}
				if (found.currentPreset === void 0 && found.header !== void 0) warnings.push("无法确认这个会话的当前模式；如果它不是宠物模式，绑定后不会有气泡回应。");
			}
		}
		await writeGlobalJson(home, "pet-settings.json", next);
		ctx.emit("pet-settings/changed");
		writeJson(res, 200, {
			ok: true,
			settings: next,
			warnings
		});
	});
	route("POST", "/api/pet-settings/reset-affection", async (_req, res) => {
		await writeAffectionRaw(home, "electron", EMPTY_LEDGER);
		writeJson(res, 200, {
			ok: true,
			affection: EMPTY_LEDGER
		});
	});
	route("POST", "/api/pet-settings/reset-position", async (_req, res) => {
		for (const p of [windowPath, join(home, "pet-window.json")]) await rm(p, { force: true });
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
	route("GET", "/api/pet-settings/tts/voices", async (req, res) => {
		const settings = await readSettings();
		const apiKey = typeof settings.tts?.apiKey === "string" ? settings.tts.apiKey : "";
		if (apiKey === "") {
			writeJson(res, 400, { error: "尚未配置 BreezeBlue API key" });
			return;
		}
		const url = new URL(req.url ?? "/", "http://127.0.0.1");
		const params = new URLSearchParams();
		for (const key of [
			"search",
			"language_code",
			"gender",
			"accent"
		]) {
			const value = url.searchParams.get(key);
			if (value !== null && value !== "") params.set(key, value);
		}
		const rawPageSize = url.searchParams.get("page_size");
		const pageSize = rawPageSize !== null ? clampNumber(Number(rawPageSize), 1, 100) : void 0;
		params.set("page_size", String(pageSize ?? 30));
		try {
			const response = await fetch(`https://api.breeze.blue/v1/voices?${params.toString()}`, {
				headers: { "xi-api-key": apiKey },
				signal: AbortSignal.timeout(1e4)
			});
			if (!response.ok) {
				const detail = await response.text().catch(() => "");
				writeJson(res, 502, { error: response.status === 401 ? "BreezeBlue 拒绝了这个 key（401）：请到 breezeblue.ai 的 Developer Console 复制 brz_ 开头的 API key" : `BreezeBlue HTTP ${String(response.status)}${detail ? `: ${detail.slice(0, 200)}` : ""}` });
				return;
			}
			const raw = await response.json();
			const voices = (Array.isArray(raw.voices) ? raw.voices : []).map((entry) => {
				const voice = entry;
				const str = (key) => typeof voice[key] === "string" ? voice[key] : null;
				return {
					voice_id: str("voice_id") ?? "",
					name: str("name") ?? "",
					language_code: str("language_code"),
					gender: str("gender"),
					tone: Array.isArray(voice.tone) ? voice.tone.filter((item) => typeof item === "string").slice(0, 3) : [],
					accent: str("accent"),
					preview_url: str("preview_url")
				};
			}).filter((voice) => voice.voice_id !== "");
			writeJson(res, 200, {
				voices,
				total: typeof raw.total === "number" ? raw.total : voices.length
			});
		} catch (error) {
			writeJson(res, 502, { error: `声音列表请求失败: ${error instanceof Error ? error.message : String(error)}` });
		}
	});
}
// lib/types/index.js
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
/**
* Services required before the `/pet` route can register. `sessionController`
* is a SIBLING plugin row's service (the api-session-controller row in the
* same composition): a command-style ctx.get from this row's fiber never sees
* it (the petTools/petService precedent), while static inject is resolved by
* the Loader ACROSS rows and waits for that row to mount — the webServer
* precedent. Every profile mounting this bundle mounts the web-app rows too,
* so the dependency is always satisfiable.
*/
const inject = [
	"webServer",
	"connection",
	"sessionController",
	"workspaceController"
];
/** The URL path prefix the pet renderer is served under. No trailing slash. */
const PET_PATH_PREFIX = "/whale598";
/**
* Locator file naming this runtime's authenticated root for the pet carrier.
* The desktop shell keeps its authenticated URL in process memory only, so a
* bundle inside that runtime is the only component positioned to publish it.
* The carrier prefers the env override, then this file's freshest live
* publisher, then falls back to spawning its own profile.
*/
function petLocatorPath() {
	return join(process.env.DSH_HOME ?? join(homedir(), ".dsh"), "whale598", "pet-surface-url.json");
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
const STATIC_MISS_CODES = /* @__PURE__ */ new Set([
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
async function servePetStatic(request, distRoot, distIndex, authorizeIndex) {
	const pathname = decodeURIComponent(new URL(request.url).pathname);
	if (!(pathname === "/whale598" || pathname.startsWith(`/whale598/`))) return new Response(null, { status: 404 });
	const relative = pathname === "/whale598" || pathname === `/whale598/` ? "/" : pathname.slice(9);
	const target = resolve(normalize(join(distRoot, relative)));
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
	/** Carrier spawn diagnostics; the packaged host's stderr is not visible. */
	const logCarrier = (line) => {
		try {
			appendFileSync(join(dirname(petLocatorPath()), "carrier-spawn.log"), `${(/* @__PURE__ */ new Date()).toISOString()} ${line}\n`, "utf8");
		} catch {}
	};
	/**
	* The desktop profile directory is Low-integrity (inheritable), so an
	* electron.exe installed into it by pnpm inherits Low and Chromium crashes
	* on spawn (exit 0x80000003). The host itself runs at Medium, so raising
	* the label in place is enough; a later pnpm install that re-creates the
	* files is healed the same way on the next activation.
	*/
	const ensureElectronUsable = (binary) => {
		if (process.platform !== "win32") return binary;
		try {
			const acl = execFileSync("icacls", [binary], {
				encoding: "utf8",
				windowsHide: true
			});
			if (!/Low Mandatory Level/i.test(acl)) return binary;
			execFileSync("icacls", [
				dirname(binary),
				"/setintegritylevel",
				"(OI)(CI)M",
				"/T"
			], {
				windowsHide: true,
				stdio: "ignore",
				timeout: 3e4
			});
			logCarrier(`raised electron integrity to Medium: ${dirname(binary)}`);
		} catch (error) {
			logCarrier(`could not raise electron integrity: ${error instanceof Error ? error.message : String(error)}`);
		}
		return binary;
	};
	/**
	* Locate the npm `electron` package WITHOUT loading it. Loading the module
	* (`require('electron')`) runs its lazy installer synchronously — a ~250 MB
	* download inside the host's event loop — so only the manifest is resolved
	* here; installing is a separate, background step.
	*/
	const findNpmElectronPackage = () => {
		try {
			const require = createRequire(import.meta.url);
			const pkgDir = dirname(require.resolve("electron/package.json"));
			if (existsSync(join(pkgDir, "package.json"))) return pkgDir;
		} catch {}
		try {
			let dir = dirname(fileURLToPath(import.meta.url));
			for (let i = 0; i < 8; i += 1) {
				const pkgDir = join(dir, "node_modules", "electron");
				if (existsSync(join(pkgDir, "package.json"))) return pkgDir;
				const parent = dirname(dir);
				if (parent === dir) break;
				dir = parent;
			}
		} catch {}
	};
	const npmElectronBinary = (pkgDir) => {
		try {
			const exe = readFileSync(join(pkgDir, "path.txt"), "utf8").trim();
			const binary = join(pkgDir, "dist", exe);
			return existsSync(binary) ? binary : void 0;
		} catch {
			return;
		}
	};
	const installLockPath = (pkgDir) => join(pkgDir, ".dsh-pet-install.lock");
	const acquireInstallLock = (pkgDir) => {
		const lock = installLockPath(pkgDir);
		const write = () => {
			writeFileSync(lock, JSON.stringify({
				pid: process.pid,
				at: Date.now()
			}), { flag: "wx" });
		};
		try {
			write();
			return true;
		} catch {}
		let raw;
		let mtimeMs = 0;
		try {
			raw = readFileSync(lock, "utf8");
			mtimeMs = statSync(lock).mtimeMs;
		} catch {
			try {
				write();
				return true;
			} catch {
				return false;
			}
		}
		const owner = raw === void 0 ? void 0 : parseInstallLock(raw)?.pid;
		const ownerPid = typeof owner === "number" ? owner : void 0;
		if (!installLockStale(raw, mtimeMs, Date.now())) {
			logCarrier(ownerPid === void 0 ? `electron install lock unreadable but fresh; waiting: ${lock}` : `electron install lock held by pid ${String(ownerPid)} (alive); waiting: ${lock}`);
			return false;
		}
		const dead = ownerPid !== void 0 && !isProcessAlive(ownerPid);
		logCarrier(`electron install lock stale (${ownerPid === void 0 ? "unreadable" : `pid ${String(ownerPid)} ${dead ? "dead" : "expired"}`}); taking over: ${lock}`);
		try {
			unlinkSync(lock);
		} catch {}
		try {
			write();
			return true;
		} catch {
			return false;
		}
	};
	const releaseInstallLock = (pkgDir) => {
		const lock = installLockPath(pkgDir);
		try {
			const owner = parseInstallLock(readFileSync(lock, "utf8"))?.pid;
			if (typeof owner === "number" && owner !== process.pid) return;
		} catch {}
		try {
			unlinkSync(lock);
		} catch {}
	};
	const NPMMIRROR_ELECTRON = "https://npmmirror.com/mirrors/electron/";
	const INSTALL_TIMEOUT_MS = 12e5;
	let activeInstallChild;
	const writeRuntimeStatus = (status) => {
		writeElectronRuntimeStatus(petHome(), status);
	};
	/**
	* Install the npm electron binary off the activation path. The package's
	* lazy installer is a large download; running it synchronously (which
	* `require('electron')` does) freezes the host, so it runs as a child with
	* progress in the spawn log. The lock is owner-liveness based: a host that
	* dies mid-download never blocks the next activation.
	*/
	const installNpmElectron = async (pkgDir, attempt) => {
		const installer = join(pkgDir, "install.js");
		if (!existsSync(installer)) {
			logCarrier(`electron binary missing and install.js not found: ${pkgDir}`);
			writeRuntimeStatus({
				state: "unavailable",
				updatedAt: Date.now(),
				error: `install.js not found in ${pkgDir}`
			});
			return {
				kind: "unavailable",
				error: `install.js not found in ${pkgDir}`
			};
		}
		if (!acquireInstallLock(pkgDir)) {
			writeRuntimeStatus({
				state: "busy",
				updatedAt: Date.now()
			});
			return { kind: "busy" };
		}
		const explicitMirror = (process.env.ELECTRON_MIRROR ?? process.env.npm_config_electron_mirror ?? "").trim();
		const mirror = explicitMirror !== "" ? explicitMirror : attempt % 2 === 0 ? NPMMIRROR_ELECTRON : void 0;
		const source = explicitMirror !== "" ? "explicit" : mirror === void 0 ? "github" : "npmmirror";
		const startedAt = Date.now();
		writeRuntimeStatus({
			state: "downloading",
			updatedAt: startedAt,
			startedAt,
			attempt: attempt + 1,
			source
		});
		logCarrier(`electron binary missing; installing in background (attempt ${String(attempt + 1)}, source=${source}): ${pkgDir}`);
		return await new Promise((resolveInstall) => {
			let settled = false;
			let timeout = void 0;
			const finish = (result) => {
				if (settled) return;
				settled = true;
				if (timeout !== void 0) clearTimeout(timeout);
				activeInstallChild = void 0;
				releaseInstallLock(pkgDir);
				if (result.kind === "installed") writeRuntimeStatus({
					state: "ready",
					updatedAt: Date.now(),
					startedAt,
					finishedAt: Date.now(),
					attempt: attempt + 1,
					source
				});
				else if (result.kind === "failed") writeRuntimeStatus({
					state: "failed",
					updatedAt: Date.now(),
					startedAt,
					attempt: attempt + 1,
					source,
					error: result.error
				});
				resolveInstall(result);
			};
			let stderr = "";
			let stdout = "";
			let lastProgress = 0;
			const env = {
				...process.env,
				ELECTRON_RUN_AS_NODE: "1"
			};
			if (mirror === void 0) {
				delete env.ELECTRON_MIRROR;
				delete env.npm_config_electron_mirror;
			} else env.ELECTRON_MIRROR = mirror;
			let child;
			try {
				child = spawn(process.execPath, [installer], {
					cwd: pkgDir,
					env,
					stdio: [
						"ignore",
						"pipe",
						"pipe"
					],
					windowsHide: true
				});
			} catch (error) {
				const message = error instanceof Error ? error.message : String(error);
				logCarrier(`electron install failed to start: ${message}`);
				finish({
					kind: "failed",
					error: message
				});
				return;
			}
			activeInstallChild = child;
			timeout = setTimeout(() => {
				logCarrier(`electron install timed out after ${String(INSTALL_TIMEOUT_MS / 6e4)} min (source=${source}); killing pid=${String(child.pid ?? "unknown")}`);
				child.kill();
				finish({
					kind: "failed",
					error: `timed out after ${String(INSTALL_TIMEOUT_MS / 6e4)} min`
				});
			}, INSTALL_TIMEOUT_MS);
			child.stdout?.setEncoding("utf8");
			child.stdout?.on("data", (chunk) => {
				stdout = `${stdout}${chunk}`.slice(-2e3);
				const now = Date.now();
				if (now - lastProgress > 5e3) {
					lastProgress = now;
					const line = stdout.split(/\r?\n/).map((part) => part.trim()).filter(Boolean).pop();
					if (line !== void 0) logCarrier(`electron install: ${line}`);
				}
			});
			child.stderr?.setEncoding("utf8");
			child.stderr?.on("data", (chunk) => {
				stderr = `${stderr}${chunk}`.slice(-2e3);
			});
			child.on("error", (error) => {
				logCarrier(`electron install failed to start: ${error.message}`);
				finish({
					kind: "failed",
					error: error.message
				});
			});
			child.on("exit", (code) => {
				if (code !== 0) {
					const detail = stderr.trim() || "no stderr";
					logCarrier(`electron install failed (exit ${String(code)}, source=${source}): ${detail}`);
					finish({
						kind: "failed",
						error: `exit ${String(code)}: ${detail}`
					});
					return;
				}
				const binary = npmElectronBinary(pkgDir);
				if (binary === void 0) {
					logCarrier(`electron install exited 0 but the binary is still missing: ${pkgDir}`);
					finish({
						kind: "failed",
						error: "binary still missing after a successful install"
					});
					return;
				}
				logCarrier(`electron installed: ${binary}`);
				finish({
					kind: "installed",
					binary: ensureElectronUsable(binary)
				});
			});
		});
	};
	/**
	* Auto-start the pet window. A bare Electron binary runs any app directory
	* (`electron.exe <dir>`), but a PACKAGED one (the installed desktop) loads
	* its own app and dies on its single-instance lock instead — so the
	* resolution order is an explicit env override, a binary staged beside this
	* package, then the `electron` npm dependency. The carrier's single-instance
	* lock collapses duplicates.
	*/
	const resolveElectron = () => {
		const override = process.env.DSH_PET_ELECTRON;
		if (override !== void 0 && override !== "") {
			if (existsSync(override)) return { binary: override };
			logCarrier(`DSH_PET_ELECTRON is set but missing, falling back: ${override}`);
		}
		const pkgRoot = resolve(join(dirname(fileURLToPath(import.meta.url)), ".."));
		const staged = join(pkgRoot, "electron-bin", process.platform === "win32" ? "electron.exe" : process.platform === "darwin" ? join("Electron.app", "Contents", "MacOS", "Electron") : "electron");
		if (existsSync(staged)) return { binary: staged };
		const npmPackageDir = findNpmElectronPackage();
		if (npmPackageDir !== void 0) {
			const binary = npmElectronBinary(npmPackageDir);
			if (binary !== void 0) return { binary: ensureElectronUsable(binary) };
			return { npmPackageDir };
		}
		logCarrier("no electron binary: no staged electron-bin, no npm electron dependency, and DSH_PET_ELECTRON is unset");
		return {};
	};
	const launchCarrier = (url, carrierDir, electronBinary) => {
		const launchArgs = [carrierDir];
		if (process.env.DSH_PET_NO_SANDBOX === "1") launchArgs.push("--no-sandbox");
		logCarrier(`spawn binary=${electronBinary} args=${JSON.stringify(launchArgs)} pid=${String(process.pid)}`);
		const child = (() => {
			try {
				return spawn(electronBinary, launchArgs, {
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
			} catch (error) {
				logCarrier(`spawn threw: ${error instanceof Error ? error.message : String(error)}`);
				return;
			}
		})();
		if (child === void 0) return;
		logCarrier(`spawned pid=${String(child.pid ?? "unknown")}`);
		let stderrTail = "";
		child.stdout?.setEncoding("utf8");
		child.stdout?.on("data", (chunk) => {
			process.stdout.write(`[pet-carrier] ${chunk}`);
		});
		child.stderr?.setEncoding("utf8");
		child.stderr?.on("data", (chunk) => {
			stderrTail = (stderrTail + chunk).slice(-2e3);
			process.stderr.write(`[pet-carrier] ${chunk}`);
		});
		child.on("error", (error) => {
			logCarrier(`child error: ${error.message}`);
		});
		child.on("exit", (code, signal) => {
			logCarrier(`child exit code=${String(code)} signal=${String(signal)} stderr=${JSON.stringify(stderrTail.slice(-700))}`);
		});
		child.unref();
		ctx.effect(() => () => {
			child.kill();
		}, "pet-surface: carrier shutdown");
	};
	const RETRY_DELAYS_MS = [
		3e4,
		6e4,
		12e4,
		3e5
	];
	let disposed = false;
	let carrierLaunched = false;
	let installInFlight = false;
	let installAttempt = 0;
	let retryTimer;
	const launchOnce = (url, carrierDir, binary) => {
		if (disposed || carrierLaunched) return;
		carrierLaunched = true;
		if (retryTimer !== void 0) {
			clearTimeout(retryTimer);
			retryTimer = void 0;
		}
		launchCarrier(url, carrierDir, binary);
	};
	const ensureCarrier = async (url, carrierDir, pkgDir) => {
		if (disposed || carrierLaunched) return;
		const resolution = resolveElectron();
		if (resolution.binary !== void 0) {
			writeRuntimeStatus({
				state: "ready",
				updatedAt: Date.now()
			});
			launchOnce(url, carrierDir, resolution.binary);
			return;
		}
		const nextPkgDir = resolution.npmPackageDir ?? pkgDir;
		if (installInFlight) return;
		installInFlight = true;
		const attempt = installAttempt;
		installAttempt += 1;
		const result = await installNpmElectron(nextPkgDir, attempt).catch((error) => ({
			kind: "failed",
			error: error instanceof Error ? error.message : String(error)
		}));
		installInFlight = false;
		if (disposed || carrierLaunched) return;
		if (result.kind === "installed") {
			launchOnce(url, carrierDir, result.binary);
			return;
		}
		if (result.kind === "unavailable") {
			logCarrier(`electron auto-install unavailable: ${result.error}`);
			return;
		}
		const reason = result.kind === "busy" ? "blocked by another activation" : `failed (${result.error})`;
		const delay = RETRY_DELAYS_MS[Math.min(installAttempt - 1, RETRY_DELAYS_MS.length - 1)] ?? 3e4;
		logCarrier(`electron install ${reason}; retrying in ${String(delay / 1e3)}s`);
		if (retryTimer !== void 0) clearTimeout(retryTimer);
		retryTimer = setTimeout(() => {
			ensureCarrier(url, carrierDir, nextPkgDir);
		}, delay);
	};
	const spawnPetCarrier = (url) => {
		const carrierDir = resolve(join(dirname(fileURLToPath(import.meta.url)), "..", "carrier"));
		if (process.env.DSH_PET_NO_SPAWN === "1" || !existsSync(join(carrierDir, "package.json"))) return;
		const resolution = resolveElectron();
		if (resolution.binary !== void 0) {
			writeRuntimeStatus({
				state: "ready",
				updatedAt: Date.now()
			});
			launchOnce(url, carrierDir, resolution.binary);
			return;
		}
		if (resolution.npmPackageDir === void 0) {
			logCarrier("no electron binary and no npm electron package; cannot auto-install");
			writeRuntimeStatus({
				state: "unavailable",
				updatedAt: Date.now(),
				error: "electron package not installed"
			});
			return;
		}
		ensureCarrier(url, carrierDir, resolution.npmPackageDir);
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
	const home = petHome();
	const pet = installPetService(ctx, home);
	installSettingsPage(ctx, home, pet, installPetDriver(ctx, home, pet));
	ctx.effect(() => () => {
		disposed = true;
		if (retryTimer !== void 0) clearTimeout(retryTimer);
		activeInstallChild?.kill();
	}, "pet-surface: electron install cleanup");
	ctx.effect(() => () => {
		readFile(petLocatorPath(), "utf8").then((raw) => {
			if (JSON.parse(raw).pid === process.pid) return unlink(petLocatorPath());
		}).catch(() => {});
	}, "pet-surface: locator withdrawal");
}
export { PET_PATH_PREFIX, apply, inject, name, petLocatorPath, servePetStatic };
