import { existsSync } from "node:fs";
import { appendFile, mkdir, readFile, readdir, rename, rm, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import { Service } from "@deepseek-ai/cordis";
//#region lib/types/petdata.js
/**
* The per-pet data store: everything the DRIVER persists about a pet lives
* under `~/.dsh/whale598/<petId>/` — affection ledger, display name, event
* history, tool-call history. One directory per pet, small files, single
* writer (the driver), JSONL for append-only streams with bounded retention.
*
* Legacy layouts (`pet-affection.d/<id>.json`, the single legacy electron
* book, names inside pet-settings.json) are READ as fallbacks and migrate to
* the new layout on the next write — lazy migration, no data-loss window.
* @module dsh-agentic-pet/petdata
*/
/** The consolidated per-pet data root under the dsh home. */
const WHALE_DIR = "whale598";
function petDataDir(home, petId) {
	return join(home, WHALE_DIR, petId);
}
/** New-layout path first; legacy layouts as read fallbacks (per-pet legacy
* dir → the single legacy electron book). The ledger SHAPE is the driver's
* (TouchLedger); this module only owns paths and raw IO. */
function affectionPaths(home, petId) {
	return {
		current: join(petDataDir(home, petId), "pet-affection.json"),
		legacy: [join(home, "pet-affection.d", `${petId}.json`), ...petId === "electron" ? [join(home, "pet-affection.json")] : []]
	};
}
/** Read the affection ledger raw: the current file wins; legacy files answer
* only while the current one is absent (first write migrates the full
* ledger). Returns null when no layout holds data. */
async function readAffectionRaw(home, petId) {
	const { current, legacy } = affectionPaths(home, petId);
	for (const file of [current, ...legacy]) try {
		const parsed = JSON.parse(await readFile(file, "utf8"));
		if (parsed !== null && typeof parsed === "object" && Object.keys(parsed).length > 0) return parsed;
	} catch {}
	return null;
}
async function writeAffectionRaw(home, petId, ledger) {
	const dir = petDataDir(home, petId);
	await mkdir(dir, { recursive: true });
	await writeFile(join(dir, "pet-affection.json"), `${JSON.stringify(ledger)}\n`, "utf8");
}
function petNameFile(home, petId) {
	return join(petDataDir(home, petId), "pet-name.json");
}
/** The user's custom display name: new-layout file → legacy
* pet-settings.json `names` map → undefined (caller applies the built-in
* default). */
async function readPetName(home, petId) {
	try {
		const parsed = JSON.parse(await readFile(petNameFile(home, petId), "utf8"));
		if (typeof parsed.name === "string" && parsed.name.trim() !== "") return parsed.name.trim();
	} catch {}
	try {
		const settings = JSON.parse(await readFile(join(home, "pet-settings.json"), "utf8"));
		const label = (typeof settings.names === "object" && settings.names !== null ? settings.names : {})[petId];
		if (typeof label === "string" && label.trim() !== "") return label.trim();
	} catch {}
}
/** Persist a custom name; `null` reverts to the built-in default (drops the
* override file). Also strips the petId key from the legacy pet-settings
* names map so the old layout cannot resurrect a cleared name. */
async function writePetName(home, petId, name) {
	await mkdir(petDataDir(home, petId), { recursive: true });
	const file = petNameFile(home, petId);
	if (name === null || name.trim() === "") await rm(file, { force: true });
	else await writeFile(file, `${JSON.stringify({ name: name.trim() })}\n`, "utf8");
	try {
		const settingsPath = join(home, "pet-settings.json");
		const settings = JSON.parse(await readFile(settingsPath, "utf8"));
		if (typeof settings.names === "object" && settings.names !== null && petId in settings.names) {
			Reflect.deleteProperty(settings.names, petId);
			if (Object.keys(settings.names).length === 0) delete settings.names;
			await writeFile(settingsPath, `${JSON.stringify(settings, null, 2)}\n`, "utf8");
		}
	} catch {}
}
const JSONL_MAX_LINES = 600;
const JSONL_KEEP_LINES = 500;
function eventsFile(home, petId) {
	return join(petDataDir(home, petId), "events.jsonl");
}
/** Append one record; bounded retention trims the file when it outgrows the
* cap (best-effort — a failed trim never loses the append). */
async function appendJsonl(file, entry) {
	await mkdir(dirname(file), { recursive: true });
	await appendFile(file, `${JSON.stringify(entry)}\n`, "utf8");
	try {
		const lines = (await readFile(file, "utf8")).split("\n").filter((line) => line.trim() !== "");
		if (lines.length > JSONL_MAX_LINES) await writeFile(file, `${lines.slice(lines.length - JSONL_KEEP_LINES).join("\n")}\n`, "utf8");
	} catch {}
}
/** The last `limit` records (oldest last); malformed lines degrade to
* `{raw}` instead of dropping the file. */
async function readJsonl(file, limit) {
	try {
		return (await readFile(file, "utf8")).split("\n").filter((line) => line.trim() !== "").slice(-limit).map((line) => {
			try {
				return JSON.parse(line);
			} catch {
				return { raw: line };
			}
		});
	} catch {
		return [];
	}
}
const GLOBAL_STATE_FILES = [
	"pet-settings.json",
	"pet-inner-voice.json",
	"pet-wake-plans.json",
	"pet-messages.json",
	"pet-interactions.json",
	"pet-binding-status.json",
	"pet-wake-state.json",
	"pet-world.json",
	"pet-window.json"
];
function globalPaths(home, name) {
	return {
		current: join(home, WHALE_DIR, name),
		legacy: join(home, name)
	};
}
function globalFilePath(home, name) {
	return globalPaths(home, name).current;
}
/** Rename legacy → current for every global file that hasn't moved yet.
* Best-effort: a failed rename leaves the legacy copy in place and the read
* fallback still answers. Called once at driver install. */
async function migrateGlobals(home) {
	await mkdir(join(home, WHALE_DIR), { recursive: true });
	for (const name of GLOBAL_STATE_FILES) {
		const { current, legacy } = globalPaths(home, name);
		try {
			if (existsSync(current) || !existsSync(legacy)) continue;
			await rename(legacy, current);
		} catch {}
	}
}
/** Read a global state file: current → legacy → {} (callers' defensive
* field checks treat {} exactly like a missing file). */
async function readGlobalJson(home, name) {
	const { current, legacy } = globalPaths(home, name);
	for (const file of [current, legacy]) try {
		const parsed = JSON.parse(await readFile(file, "utf8"));
		if (parsed && typeof parsed === "object") return parsed;
	} catch {}
	return {};
}
/** Write a global state file (current location only; pretty-printed — these
* files are user-inspectable and hand-editable). */
async function writeGlobalJson(home, name, obj) {
	const { current } = globalPaths(home, name);
	await mkdir(dirname(current), { recursive: true });
	await writeFile(current, `${JSON.stringify(obj, null, 2)}\n`, "utf8");
}
function petStatePaths(home, petId, name) {
	return {
		current: join(petDataDir(home, petId), name),
		legacy: [join(home, WHALE_DIR, name), join(home, name)]
	};
}
/** Read a per-pet state file: pet file → whale598 root → ~/.dsh root → {}
* (callers' defensive field checks treat {} exactly like a missing file). */
async function readPetStateJson(home, petId, name) {
	const { current, legacy } = petStatePaths(home, petId, name);
	for (const file of [current, ...legacy]) try {
		const parsed = JSON.parse(await readFile(file, "utf8"));
		if (parsed && typeof parsed === "object") return parsed;
	} catch {}
	return {};
}
/** Write a per-pet state file (pretty-printed, same user-inspectable
* contract as the globals). */
async function writePetStateJson(home, petId, name, obj) {
	const { current } = petStatePaths(home, petId, name);
	await mkdir(dirname(current), { recursive: true });
	await writeFile(current, `${JSON.stringify(obj, null, 2)}\n`, "utf8");
}
/** Root directories under whale598/ that are NOT pets — machine layers keyed
* by petId (AGENTS.md §8: 机器层目录不是宠物). existingPetIds is the gate
* every per-pet sweep walks through (presence/wake plans/inner-voice loads
* and deletes, migrations, the settings window loop), so a machine dir
* missing from this list becomes a phantom petId — it gets ingested into
* knownPetIds and its "pet files" get rm'd by the save-time cleanups. A new
* machine dir MUST be added here. */
const NON_PET_DIRS = ["pet-http.d", "carrier-instances"];
/** PetIds with a data directory on disk — the sweep basis for per-pet
* migrations and merged loads. Registry-only pets (live, never persisted)
* are absent; callers union their own id sources on top. */
async function existingPetIds(home) {
	try {
		return (await readdir(join(home, WHALE_DIR), { withFileTypes: true })).filter((entry) => entry.isDirectory() && !NON_PET_DIRS.includes(entry.name)).map((entry) => entry.name);
	} catch {
		return [];
	}
}
/** Read a root-level global that is a bare JSON array: whale598 root →
* ~/.dsh root → [] (the interaction ledger's shape — readGlobalJson's object
* check happens to admit arrays, but the array contract deserves its own
* helper). */
async function readGlobalArrayJson(home, name) {
	const { current, legacy } = globalPaths(home, name);
	for (const file of [current, legacy]) try {
		const parsed = JSON.parse(await readFile(file, "utf8"));
		if (Array.isArray(parsed)) return parsed;
	} catch {}
	return [];
}
/** One-time split of a petId-keyed root file into per-pet state files: each
* pet's slice is written (an existing pet file always wins — the split never
* overwrites), then the root copy is renamed to `<name>.bak-migrated-<date>`
* so the root stays clean without losing the original. Best-effort
* throughout; `extract` returns undefined for petIds with no slice. */
async function migrateGlobalSplits(home, name, extract) {
	const global = await readGlobalJson(home, name);
	if (Object.keys(global).length === 0) return;
	const mapKeys = (field) => {
		const value = global[field];
		return typeof value === "object" && value !== null ? Object.keys(value) : [];
	};
	const petIds = [.../* @__PURE__ */ new Set([
		...await existingPetIds(home),
		...mapKeys("pets"),
		...mapKeys("sessions"),
		...mapKeys("generations"),
		...mapKeys("plans")
	])];
	let wrote = false;
	for (const petId of petIds) {
		if (petId === "") continue;
		const slice = extract(global, petId);
		if (slice === void 0) continue;
		const { current } = petStatePaths(home, petId, name);
		if (existsSync(current)) continue;
		await writePetStateJson(home, petId, name, slice);
		wrote = true;
	}
	if (!wrote) return;
	const stamp = (/* @__PURE__ */ new Date()).toISOString().slice(0, 10).replaceAll("-", "");
	for (const file of [globalPaths(home, name).current, globalPaths(home, name).legacy]) try {
		if (!existsSync(file)) continue;
		await rename(file, join(home, WHALE_DIR, `${name}.bak-migrated-${stamp}`));
		break;
	} catch {}
}
//#endregion
//#region lib/types/actions.js
/**
* The action-catalog contract between the pets and the driver: a pet
* ADVERTISES what it can perform (`capabilities.actions` — its own menu,
* derived from its own media), and the driver validates requests against
* that menu instead of hardcoding one. Pure functions only — the seam where
* catalog drift between pet implementations must die.
* @module dsh-agentic-pet/actions
*/
/** Defensive extraction from a raw /capabilities payload: implementations
* may omit or mistype anything. */
function normalizeCapabilities(raw) {
	const record = typeof raw === "object" && raw !== null ? raw : {};
	const actions = Array.isArray(record.actions) ? record.actions.filter((entry) => typeof entry === "string") : [];
	const contractVersion = typeof record.contractVersion === "number" ? record.contractVersion : null;
	const catalogRaw = Array.isArray(record.actionCatalog) ? record.actionCatalog : [];
	const actionCatalog = [];
	for (const item of catalogRaw) {
		if (typeof item !== "object" || item === null) continue;
		const entry = item;
		if (typeof entry.id !== "string" || entry.id === "") continue;
		const tags = Array.isArray(entry.tags) ? entry.tags.filter((tag) => typeof tag === "string" && tag !== "") : [];
		const energy = entry.energy === "low" || entry.energy === "mid" || entry.energy === "high" ? entry.energy : void 0;
		const durationHintMs = typeof entry.durationHintMs === "number" && Number.isFinite(entry.durationHintMs) ? entry.durationHintMs : void 0;
		const textInFrame = typeof entry.textInFrame === "boolean" ? entry.textInFrame : void 0;
		const loop = entry.loop === true ? true : void 0;
		actionCatalog.push({
			id: entry.id,
			tags,
			...energy === void 0 ? {} : { energy },
			...durationHintMs === void 0 ? {} : { durationHintMs },
			...textInFrame === void 0 ? {} : { textInFrame },
			...loop === void 0 ? {} : { loop }
		});
	}
	const suppliedVocabulary = Array.isArray(record.actionTagVocabulary) ? record.actionTagVocabulary.filter((tag) => typeof tag === "string" && tag !== "") : [];
	const actionTagVocabulary = suppliedVocabulary.length > 0 ? [...new Set(suppliedVocabulary)] : [...new Set(actionCatalog.flatMap((entry) => [...entry.tags]))];
	return {
		contractVersion,
		actions: actions.length > 0 ? actions : null,
		actionCatalog: actionCatalog.length > 0 ? actionCatalog : null,
		actionTagVocabulary,
		tagged: actionCatalog.some((entry) => entry.tags.length > 0)
	};
}
/**
* Resolve a pet_do request against a pet's advertised catalog.
* - `celebrate` is the universal alias every pet must honor regardless of
*   its catalog (driver.ts's ledger milestones depend on it).
* - `random` means "you pick": one draw from the pet's own menu (the
*   draw lives here, driver-side, so pets that validate /action against
*   their vocabulary — pure does — never see a sentinel they must reject).
* - Anything else must be IN the catalog; `null` catalog admits only
*   celebrate.
*/
function resolveActionRequest(requested, catalog) {
	if (requested === "celebrate") return {
		kind: "ok",
		action: "celebrate"
	};
	if (requested === "random") {
		const pool = catalog === null ? [] : catalog.filter((entry) => entry !== "celebrate");
		const menu = pool.length > 0 ? pool : ["celebrate"];
		const pick = menu[Math.floor(Math.random() * menu.length)];
		return pick === void 0 ? {
			kind: "ok",
			action: "celebrate"
		} : {
			kind: "ok",
			action: pick
		};
	}
	if (catalog !== null && catalog.includes(requested)) return {
		kind: "ok",
		action: requested
	};
	return {
		kind: "unknown",
		available: catalog ?? ["celebrate"]
	};
}
/** The error-message menu: long catalogs are previewed, with a pointer to
* pet_state {actions:true} for the full list. */
function formatAvailableActions(available, cap = 24) {
	const shown = available.slice(0, cap).join("、");
	const rest = available.length - Math.min(cap, available.length);
	return rest > 0 ? `${shown} …(+${String(rest)} more — pet_state {actions:true} lists all)` : shown;
}
/** Resolve a tag against the CURRENT body's own catalog. Multiple matches are
* a random draw (celebrate is never a tag candidate). No cross-body tag
* vocabulary is consulted. */
function resolveTagRequest(tag, capabilities) {
	const matches = (capabilities?.actionCatalog ?? []).filter((entry) => entry.tags.includes(tag));
	if (matches.length === 0) return {
		kind: "unknown",
		availableTags: capabilities?.actionTagVocabulary ?? [],
		availableActions: capabilities?.actions ?? ["celebrate"]
	};
	const nonCelebrate = matches.filter((entry) => entry.id !== "celebrate");
	const pool = nonCelebrate.length > 0 ? nonCelebrate : matches;
	return {
		kind: "ok",
		action: (pool[Math.floor(Math.random() * pool.length)] ?? matches[0])?.id ?? "celebrate",
		candidates: matches.map((entry) => entry.id)
	};
}
/** Tag menu for errors: an empty vocabulary names the fallback explicitly. */
function formatAvailableTags(tags, cap = 24) {
	if (tags.length === 0) return "（该身体未提供语义标签；请改用 action id 或 celebrate）";
	const shown = tags.slice(0, cap).join("、");
	const rest = tags.length - Math.min(cap, tags.length);
	return rest > 0 ? `${shown} …(+${String(rest)} more — pet_state {actions:true} lists all)` : shown;
}
//#endregion
//#region lib/types/body.js
/**
* body/1 — the body's own description of what it is and what it can do.
* The driver owns this envelope (shapes, validation); the body owns the
* values (ids, tags, usage, fallbacks). Unknown fields are preserved, never
* interpreted here. Capability kinds: listing capabilities (actions,
* expressions, …) follow the catalog/tags/count shape; the three known
* BEHAVIOR kinds (`kind: "facing" | "idle" | "transition"`, body iteration
* Phase 0) carry their own typed shape instead — they describe HOW the body
* moves, not what it lists.
* @module dsh-agentic-pet/body
*/
const BEHAVIOR_KINDS = [
	"facing",
	"idle",
	"transition"
];
const isBehaviorKind = (value) => typeof value === "string" && BEHAVIOR_KINDS.includes(value);
const isRecord = (value) => typeof value === "object" && value !== null && !Array.isArray(value);
const isStringArray = (value) => Array.isArray(value) && value.every((item) => typeof item === "string");
const isRect = (value) => Array.isArray(value) && value.length === 4 && value.every((n) => typeof n === "number" && Number.isFinite(n));
const invalid = (reason) => ({
	kind: "legacy",
	reason
});
/** Validate the body/1 envelope; preserve every unknown field. A missing or
* foreign schema is legacy, not an error: old bodies keep working. */
function normalizeBody(raw) {
	if (!isRecord(raw)) return invalid("body is not an object");
	if (raw.schema !== "body/1") return invalid("schema is not body/1");
	if (raw.bodyId !== void 0 && typeof raw.bodyId !== "string") return invalid("bodyId is not a string");
	if (raw.renderer !== void 0 && typeof raw.renderer !== "string") return invalid("renderer is not a string");
	if (raw.appearance !== void 0) {
		if (!isRecord(raw.appearance) || typeof raw.appearance.name !== "string") return invalid("appearance.name is required");
	}
	if (raw.hitboxes !== void 0) {
		if (!isRecord(raw.hitboxes) || !isStringArray(raw.hitboxes.parts)) return invalid("hitboxes.parts must be a string array");
		if (raw.hitboxes.coordinateSpace !== void 0 && typeof raw.hitboxes.coordinateSpace !== "string") return invalid("hitboxes.coordinateSpace must be a string");
		if (raw.hitboxes.rects !== void 0) {
			if (!isRecord(raw.hitboxes.rects)) return invalid("hitboxes.rects must be an object");
			for (const [part, rect] of Object.entries(raw.hitboxes.rects)) {
				const rects = isRect(rect) ? [rect] : Array.isArray(rect) ? rect : null;
				if (rects === null || rects.some((r) => !isRect(r))) return invalid(`hitboxes.rects.${part} must be a rect or an array of rects (four finite numbers each)`);
			}
		}
	}
	if (raw.capabilities !== void 0) {
		if (!isRecord(raw.capabilities)) return invalid("capabilities is not an object");
		for (const [kind, entry] of Object.entries(raw.capabilities)) {
			const reason = validateCapability(kind, entry);
			if (reason !== null) return invalid(reason);
		}
	}
	if (raw.extensions !== void 0 && !isRecord(raw.extensions)) return invalid("extensions is not an object");
	return {
		kind: "body",
		body: { ...raw }
	};
}
/** Resolve pet_express against the CURRENT body's own expression capability.
* There is no cross-body expression vocabulary. */
function resolveExpressionRequest(body, requested) {
	const expressions = body?.capabilities?.expressions;
	if (expressions === void 0) return { kind: "missing" };
	if (expressions.supported !== true) return {
		kind: "unsupported",
		capability: expressions
	};
	const catalog = expressions.catalog;
	if (catalog !== void 0 && !catalog.includes(requested)) return {
		kind: "unknown",
		available: catalog
	};
	return {
		kind: "ok",
		expression: requested
	};
}
const formatSubstituteArgs = (args) => Object.entries(args).map(([key, value]) => `${key}:${JSON.stringify(value)}`).join(", ");
/** Compute the degradation per REQUEST, not per body: a name that is also an
* action tag gets that tag; otherwise the body's declared default is used
* (and labelled as a default), never presented as a per-request match. */
function suggestExpressionFallback(capability, requested, actionTags) {
	const base = "这具身体没有表情层（发生了什么）。表情能力在 capabilities.expressions 中声明为不支持（为什么）。";
	if (actionTags.includes(requested)) {
		const fallback = {
			tool: "pet_do",
			args: { tag: requested }
		};
		return {
			message: `${base}最接近的是「${requested}」标签下的动作，可以改用 ${fallback.tool} {${formatSubstituteArgs(fallback.args)}}（下一步）。`,
			fallback,
			availableTags: actionTags
		};
	}
	const substitute = capability.fallback?.substitute;
	if (substitute !== void 0) return {
		message: `${base}没有找到与「${requested}」直接匹配的动作；这具身体的默认替代是 ${substitute.tool} {${formatSubstituteArgs(substitute.args)}}（下一步）。`,
		fallback: substitute,
		availableTags: actionTags
	};
	return {
		message: `${base}没有找到与「${requested}」直接匹配的动作${actionTags.length > 0 ? `；可用标签：${actionTags.slice(0, 12).join("、")}` : ""}（下一步）。`,
		fallback: null,
		availableTags: actionTags
	};
}
function formatMissingExpression() {
	return "这具身体没有发布表情自述（发生了什么）。它没有 body/1 的 expressions 能力（为什么）。先 pet_state {body:true} 看身体能力，或改用 pet_do 播动作（下一步）。";
}
function validateCapability(kind, value) {
	if (!isRecord(value)) return `${kind} is not an object`;
	if (typeof value.supported !== "boolean") return `${kind}.supported must be boolean`;
	if (isBehaviorKind(value.kind)) return validateBehaviorCapability(kind, value);
	if (typeof value.usage !== "string" || value.usage.trim() === "") return `${kind}.usage is required`;
	if (value.sample !== void 0 && typeof value.sample !== "boolean") return `${kind}.sample must be boolean`;
	const hasCatalog = value.catalog !== void 0;
	const hasTags = value.tags !== void 0;
	const hasCount = value.count !== void 0;
	if (hasCatalog && !isStringArray(value.catalog)) return `${kind}.catalog must be a string array`;
	if (hasTags && !isStringArray(value.tags)) return `${kind}.tags must be a string array`;
	if (hasCount && (typeof value.count !== "number" || !Number.isFinite(value.count))) return `${kind}.count must be a finite number`;
	if (value.sample === true && !hasCount) return `${kind}.sample requires count`;
	if (value.sample !== true && hasCatalog && hasCount && value.count !== value.catalog.length) return `${kind}.count does not match catalog`;
	if (value.supported && !hasCatalog && !hasTags && !hasCount) return `${kind} supports something but describes no catalog/tags/count`;
	if (!value.supported && (hasCatalog || hasTags || hasCount)) return `${kind} is unsupported but carries catalog/tags/count`;
	if (value.example !== void 0) {
		if (!isRecord(value.example) || typeof value.example.tool !== "string" || !isRecord(value.example.args)) return `${kind}.example must be {tool,args}`;
	}
	if (value.fallback !== void 0) {
		if (!isRecord(value.fallback) || typeof value.fallback.note !== "string" || !isRecord(value.fallback.substitute)) return `${kind}.fallback must be {note,substitute}`;
		const substitute = value.fallback.substitute;
		if (typeof substitute.tool !== "string" || !isRecord(substitute.args)) return `${kind}.fallback.substitute must be {tool,args}`;
		if (substitute.tool === "pet_do" && "action" in substitute.args && "tag" in substitute.args) return `${kind}.fallback.substitute cannot pass both action and tag`;
	}
	return null;
}
const FACING_MODES = [
	"left",
	"right",
	"front"
];
const MIRROR_METHODS = ["mirror", "clips"];
/** Behavior capabilities (kind: facing/idle/transition) describe HOW the
* body moves: usage is optional prose, the catalog/listing shape does not
* apply, and each kind carries its own payload — validated per kind.
* `supported:false` entries must stay bare (same asymmetry as the listing
* rule: empty containers and "not declared" must stay distinguishable). */
function validateBehaviorCapability(kind, value) {
	if (value.usage !== void 0 && (typeof value.usage !== "string" || value.usage.trim() === "")) return `${kind}.usage must be a non-empty string when present`;
	const listingShape = [
		"catalog",
		"tags",
		"count",
		"sample",
		"fallback"
	].find((name) => value[name] !== void 0);
	if (listingShape !== void 0) return `${kind} is a behavior capability (${String(value.kind)}) and must not carry ${listingShape}`;
	if (!value.supported) {
		const carried = {
			facing: ["modes", "method"],
			idle: ["intervalMs", "noRepeat"],
			transition: ["defaultMs", "toIdleMs"]
		}[value.kind].find((name) => value[name] !== void 0);
		if (carried !== void 0) return `${kind} is unsupported but carries ${carried}`;
		return null;
	}
	if (value.kind === "facing") {
		if (!isStringArray(value.modes) || value.modes.length === 0 || !value.modes.every((mode) => FACING_MODES.includes(mode))) return `${kind}.modes must be a non-empty array of ${FACING_MODES.join("|")}`;
		if (value.method === void 0 || !MIRROR_METHODS.includes(value.method)) return `${kind}.method must be ${MIRROR_METHODS.join(" or ")} when supported`;
		return null;
	}
	if (value.kind === "idle") {
		const interval = value.intervalMs;
		if (!Array.isArray(interval) || interval.length !== 2 || !interval.every((n) => typeof n === "number" && Number.isFinite(n) && n >= 0) || interval[0] >= interval[1]) return `${kind}.intervalMs must be [min,max] with 0 <= min < max`;
		if (typeof value.noRepeat !== "number" || !Number.isInteger(value.noRepeat) || value.noRepeat < 1) return `${kind}.noRepeat must be a positive integer`;
		return null;
	}
	const msInRange = (v) => typeof v === "number" && Number.isFinite(v) && v >= 0 && v <= 500;
	if (!msInRange(value.defaultMs)) return `${kind}.defaultMs must be a finite number in [0,500]`;
	if (value.toIdleMs !== void 0) {
		if (!msInRange(value.toIdleMs)) return `${kind}.toIdleMs must be a finite number in [0,500]`;
		if (value.toIdleMs < value.defaultMs) return `${kind}.toIdleMs must be >= defaultMs`;
	}
	return null;
}
//#endregion
//#region lib/types/registry.js
/**
* The pet registry: a directory of per-pet control manifests. Each pet
* implementation owns its own file under whale598/pet-http.d/ (named by its
* pet id) and re-asserts it on a cadence; entries whose publisher pid is dead
* expire by omission. The driver reads the whole table and routes per the
* multi-pet design: a session's state rides its bound pet when that pet is
* alive and broadcasts to every live pet otherwise; interactions broadcast to
* all; the default pet (earliest-booted) resolves unnamed expression targets.
* @module dsh-agentic-pet/registry
*/
const REGISTRY_DIR = `${WHALE_DIR}/pet-http.d`;
/**
* A live pet is one whose control plane ANSWERS, not merely one whose pid
* exists — and not merely one whose port accepts TCP: a frozen pet (stuck
* Qt/Electron event loop) keeps its listening socket open in the kernel, so
* TCP connect succeeds while HTTP never responds. Two layers, each with its
* own budget: a 200ms TCP pre-check fails fast on unreachable ports (a
* firewall dropping SYN would otherwise eat the whole HTTP budget), then the
* HTTP probe catches the frozen-but-listening zombies.
*/
async function probeControlPlane(port) {
	const { createConnection } = await import("node:net");
	if (!await new Promise((resolve) => {
		const socket = createConnection({
			host: "127.0.0.1",
			port
		});
		const done = (ok) => {
			socket.destroy();
			resolve(ok);
		};
		socket.setTimeout(200, () => done(false));
		socket.once("connect", () => done(true));
		socket.once("error", () => done(false));
	})) return false;
	try {
		return (await fetch(`http://127.0.0.1:${String(port)}/status`, { signal: AbortSignal.timeout(800) })).ok;
	} catch {
		return false;
	}
}
/**
* The default-pet order: earliest booted first (`since` ascending). A missing
* or mistyped `since` (0) reads as "unknown boot time" and sorts LAST — it
* must never outrank a publisher that stated its boot time. This turns the
* multi-pet design's de-facto rule ("the default pet is the first STARTED")
* into an actual guarantee: discovery output IS boot order, so every
* `pets[0]` consumer (the driver's unnamed-target fallback) reads the
* same pet. Stable sort: equal `since` values keep registry listing order.
*/
function bootOrder(pets) {
	return [...pets].sort((a, b) => (a.since > 0 ? a.since : Number.POSITIVE_INFINITY) - (b.since > 0 ? b.since : Number.POSITIVE_INFINITY));
}
/** Every live pet in boot order. Dead-pid entries are skipped — they expire
* by omission the next time their file is rewritten — and so are silent
* entries (pid alive, control plane unresponsive). Probes run CONCURRENTLY:
* wall time per pass is the slowest pet (≤800ms frozen budget), not the
* serial sum. */
async function readAllPets(home) {
	let names = [];
	try {
		names = (await readdir(join(home, REGISTRY_DIR))).filter((name) => name.endsWith(".json"));
	} catch {
		return [];
	}
	return bootOrder((await Promise.all(names.map(async (name) => {
		const id = name.slice(0, -5);
		if (id === "") return null;
		try {
			const raw = JSON.parse(await readFile(join(home, REGISTRY_DIR, name), "utf8"));
			const port = typeof raw.port === "number" ? raw.port : NaN;
			const pid = typeof raw.pid === "number" ? raw.pid : NaN;
			if (!Number.isFinite(port) || !Number.isFinite(pid)) return null;
			try {
				process.kill(pid, 0);
			} catch {
				return null;
			}
			if (!await probeControlPlane(port)) return null;
			return {
				id,
				port,
				pid,
				since: typeof raw.since === "number" ? raw.since : 0
			};
		} catch {
			return null;
		}
	}))).filter((entry) => entry !== null));
}
/**
* The default pet for UNNAMED targets: the earliest-booted live entry
* (`pets[0]` — discovery's bootOrder guarantees start order, not listing
* accident). State routing does NOT go through here anymore: an unbound
* (or bound-but-offline) session broadcasts its state to every live pet —
* the driver computes that audience itself. Used by the tools'
* resolveTarget when neither a named pet nor the owning session resolves.
* @returns the entry, or undefined when no pet is alive.
*/
function defaultPet(pets) {
	return pets[0];
}
/** The pets that receive an INTERACTION (all-notify mode): every live pet,
* the session-bound one included. The binding routes STATE — it must never
* mute interactions: excluding the bound pet would silence the only body
* whose bubble the user just proved they answer through, and a single-pet
* deployment would fall back to the web card alone for the rest of the
* session. */
function notifyPets(pets) {
	return [...pets];
}
//#endregion
//#region lib/types/service.js
/**
* The `ctx.petService` capability seam — the dsh three-roles pattern applied
* inside the process boundary. Pets are separate processes by design, so this
* service is NOT the pet itself: it is the typed in-process seam over the
* out-of-process HTTP control plane. Discovery (the whale598/pet-http.d/
* registry), liveness (pid + two-layer probe), retry policy, and the
* /status field matrix (per-implementation extras) are normalized HERE —
* consumers (the driver, the model tools, the settings page, the upcoming
* proactivity scheduler) never see registry files, ports, or raw payloads.
* A new pet implementation joins by publishing the existing HTTP contract;
* this seam never changes for it.
* @module dsh-agentic-pet/service
*/
/** The dsh home holding the pet registry, ledger, and settings files. */
function petHome() {
	return process.env.DSH_HOME ?? join(homedir(), ".dsh");
}
/** Completion requires BOTH the id match and the backfilled `endedAt`: the
* acceptance record carries the same id with `endedAt: null`, so matching on
* id alone would report "finished" the instant the action is accepted. */
function isActionComplete(record, requestId) {
	return record != null && record.id === requestId && record.endedAt !== null;
}
/**
* Abstract pet capability seam. Subclass, implement the abstract methods,
* and load the subclass as a plugin — it registers as `ctx.petService`
* (one implementation per context; loading a second throws, which is
* cordis' standard duplicate-service behavior).
*
* Implementations must honor these semantics:
* - {@link list} returns only pets whose control plane ANSWERS: a dead pid
*   and a frozen publisher (listening socket, silent HTTP) are both skipped,
*   in boot order (earliest `since` first).
* - Interaction BROADCAST is not a route: see `notifyPets` in the registry
*   module for the all-notify view, and `defaultPet` for unnamed targets.
*   State audiences are computed by the driver (bound pet alive → that pet,
*   otherwise every live pet).
* - {@link snapshot} never throws on an unreachable pet — it resolves with
*   `online: false`. Field-matrix differences stay here.
* - {@link call} retries once through a fresh discovery pass, so a pet
*   swap/restart between the caller's list() and the call does not fail a
*   one-shot action outright.
*/
var PetService = class extends Service {
	constructor(ctx) {
		super(ctx, "petService");
	}
	/**
	* The pet's advertised capabilities (`/capabilities`, e.g. its action
	* catalog) with a short TTL cache — the catalog changes only when a pet
	* restarts, and the TTL bounds how long a swapped pet's old menu shadows
	* the new one. Never throws: an unreachable pet reads as "publishes
	* nothing" (`actions: null`), which callers must treat as celebrate-only.
	*/
	async capabilities(_entry) {
		return null;
	}
	/** The body/1 self-description (`/body`); null = legacy, absent or invalid. */
	async body(_entry) {
		return null;
	}
};
/** Defensive field extraction: implementations may omit or mistype anything. */
function normalizeStatus(id, raw, online) {
	const str = (key) => typeof raw[key] === "string" ? raw[key] : void 0;
	const bool = (key) => typeof raw[key] === "boolean" ? raw[key] : void 0;
	const rectOf = (value) => {
		if (typeof value !== "object" || value === null) return void 0;
		const record = value;
		const num = (key) => typeof record[key] === "number" && Number.isFinite(record[key]) ? record[key] : void 0;
		const x = num("x");
		const y = num("y");
		const width = num("width");
		const height = num("height");
		return x !== void 0 && y !== void 0 && width !== void 0 && height !== void 0 ? {
			x,
			y,
			width,
			height
		} : void 0;
	};
	const location = rectOf(raw.location) ?? rectOf(raw.window);
	const world = !("world" in raw) ? void 0 : rectOf(raw.world) ?? null;
	const bodyRuntime = normalizeBodyRuntime(raw);
	return {
		id,
		online,
		state: str("state"),
		animation: str("animation"),
		visible: bool("visible"),
		interaction: bool("interaction"),
		bubble: bool("bubble"),
		lastAction: normalizeLastAction(raw),
		location,
		world,
		...bodyRuntime === void 0 ? {} : { bodyRuntime },
		pid: typeof raw.pid === "number" ? raw.pid : void 0
	};
}
/** B08 bodyRuntime 防御提取：三字段逐个判型，全空 = 老身体（键缺席）。 */
function normalizeBodyRuntime(raw) {
	const value = raw.bodyRuntime;
	if (typeof value !== "object" || value === null) return void 0;
	const record = value;
	const facing = record.facing === "left" || record.facing === "right" ? record.facing : void 0;
	const idleNextAt = typeof record.idleNextAt === "number" && Number.isFinite(record.idleNextAt) ? record.idleNextAt : void 0;
	const lastClip = typeof record.lastClip === "string" && record.lastClip !== "" ? record.lastClip : void 0;
	if (facing === void 0 && idleNextAt === void 0 && lastClip === void 0) return void 0;
	return {
		...facing === void 0 ? {} : { facing },
		...idleNextAt === void 0 ? {} : { idleNextAt },
		...lastClip === void 0 ? {} : { lastClip }
	};
}
/**
* The v3 action witness from either wire shape: the single object
* (`lastAction` with an id/action/startedAt/... face) reads directly; the
* legacy triple (lastAction/lastActionAt/lastActionDone) maps onto it —
* id = the legacy requestId, startedAt = the legacy acceptance timestamp,
* endedAt = the legacy done timestamp. The old `at`'s two meanings
* (electron = completion, pure = acceptance) die here: consumers see one
* shape where acceptance and completion are separate fields. No record
* anywhere normalizes to `null` — the constant-output rule.
*/
function normalizeLastAction(raw) {
	const single = raw.lastAction;
	if (typeof single === "object" && single !== null) {
		const record = single;
		if (typeof record.action !== "string") return null;
		return {
			id: typeof record.id === "string" ? record.id : null,
			action: record.action,
			requestedBy: record.requestedBy === "tool" || record.requestedBy === "user" ? record.requestedBy : null,
			startedAt: typeof record.startedAt === "number" ? record.startedAt : null,
			durationMs: typeof record.durationMs === "number" ? record.durationMs : null,
			endedAt: typeof record.endedAt === "number" ? record.endedAt : null
		};
	}
	const done = raw.lastActionDone;
	if (typeof done === "object" && done !== null && typeof done.action === "string") {
		const record = done;
		const at = typeof record.at === "number" ? record.at : null;
		return {
			id: typeof record.requestId === "string" ? record.requestId : null,
			action: record.action,
			requestedBy: record.requestedBy === "tool" || record.requestedBy === "user" ? record.requestedBy : null,
			startedAt: typeof raw.lastActionAt === "number" ? raw.lastActionAt : at,
			durationMs: typeof record.durationMs === "number" ? record.durationMs : null,
			endedAt: at
		};
	}
	return null;
}
/**
* HTTP control-plane provider: talks to pet processes over the frozen wire
* contract, discovering pets through the whale598/pet-http.d/ registry. A new
* pet implementation is adopted by publishing the same contract — this
* class does not change for it.
*/
var PetHttpService = class PetHttpService extends PetService {
	home;
	capsCache = /* @__PURE__ */ new Map();
	static CAPS_TTL_MS = 3e4;
	bodyCache;
	static BODY_TTL_MS = 3e4;
	listCache;
	static LIST_TTL_MS = 1e3;
	constructor(ctx, home = petHome()) {
		super(ctx);
		this.home = home;
	}
	/** Every live pet in boot order, served from the 1s single-flight cache:
	* concurrent callers share the running probe pass. */
	list() {
		const hit = this.listCache;
		if (hit !== void 0 && Date.now() - hit.at < PetHttpService.LIST_TTL_MS) return hit.flight;
		const flight = readAllPets(this.home);
		this.listCache = {
			at: Date.now(),
			flight
		};
		return flight;
	}
	async snapshot(entry) {
		try {
			const response = await fetch(`http://127.0.0.1:${String(entry.port)}/status`, { signal: AbortSignal.timeout(1500) });
			if (!response.ok) return {
				id: entry.id,
				online: false
			};
			const raw = await response.json();
			return normalizeStatus(entry.id, raw, true);
		} catch {
			return {
				id: entry.id,
				online: false
			};
		}
	}
	async capabilities(entry) {
		const hit = this.capsCache.get(entry.id);
		if (hit !== void 0 && Date.now() - hit.at < PetHttpService.CAPS_TTL_MS) return hit.caps;
		let caps;
		try {
			const response = await fetch(`http://127.0.0.1:${String(entry.port)}/capabilities`, { signal: AbortSignal.timeout(1500) });
			if (!response.ok) throw new Error(`HTTP ${String(response.status)}`);
			caps = normalizeCapabilities(await response.json());
		} catch {
			caps = {
				contractVersion: null,
				actions: null,
				actionCatalog: null,
				actionTagVocabulary: [],
				tagged: false
			};
		}
		this.capsCache.set(entry.id, {
			at: Date.now(),
			caps
		});
		return caps;
	}
	async body(entry) {
		const cache = this.bodyCache ?? (this.bodyCache = /* @__PURE__ */ new Map());
		const hit = cache.get(entry.id);
		if (hit !== void 0 && Date.now() - hit.at < PetHttpService.BODY_TTL_MS) return hit.body;
		let body = null;
		try {
			const response = await fetch(`http://127.0.0.1:${String(entry.port)}/body`, { signal: AbortSignal.timeout(1500) });
			if (response.ok) {
				const normalized = normalizeBody(await response.json());
				if (normalized.kind === "body") body = normalized.body;
			}
		} catch {}
		cache.set(entry.id, {
			at: Date.now(),
			body
		});
		return body;
	}
	async call(entry, path, init) {
		const { timeoutMs, retry } = callBudget(path);
		const attempts = retry ? 2 : 1;
		const callerSignal = init?.signal ?? void 0;
		for (let attempt = 0; attempt < attempts; attempt++) {
			const current = attempt === 0 ? entry : (await readAllPets(this.home)).find((pet) => pet.id === entry.id);
			if (current === void 0) throw new Error(`pet "${entry.id}" is no longer running`);
			let response;
			try {
				const timeout = AbortSignal.timeout(timeoutMs);
				const signal = callerSignal !== void 0 ? AbortSignal.any([callerSignal, timeout]) : timeout;
				response = await fetch(`http://127.0.0.1:${String(current.port)}${path}`, {
					...init,
					signal
				});
			} catch (error) {
				if (attempt === attempts - 1 || callerSignal?.aborted === true) throw error;
				continue;
			}
			if (!response.ok) {
				const detail = await response.text().catch(() => "");
				throw new Error(`pet control ${path} answered HTTP ${String(response.status)}${detail ? `: ${detail.slice(0, 300)}` : ""}`);
			}
			return await response.json();
		}
		throw new Error("unreachable");
	}
};
/**
* Per-endpoint call budgets (§6 v4). One-shot endpoints fail fast — five
* seconds covers loopback many times over. The long-poll endpoints hang BY
* DESIGN, so their budget must exceed the server's hold clamp (≤30s) or
* every hold-to-the-dot answer would surface as a timeout; and they never
* retry — a retried /interaction would raise a second bubble for one ask.
*/
function callBudget(path) {
	if (path === "/interaction" || path.startsWith("/interaction?")) return {
		timeoutMs: 45e3,
		retry: false
	};
	if (path === "/events" || path.startsWith("/events?")) {
		let hold = "0";
		try {
			hold = new URL(path, "http://127.0.0.1").searchParams.get("hold") ?? "0";
		} catch {}
		const holdSeconds = Number(hold);
		if (Number.isFinite(holdSeconds) && holdSeconds > 0) return {
			timeoutMs: 45e3,
			retry: false
		};
	}
	return {
		timeoutMs: 5e3,
		retry: true
	};
}
/**
* A PetService-shaped instance WITHOUT the Service registration side effect.
* The preset realm rejects any non-isolated service publication from its rows
* ("Preset services require isolate realms") — and a same-named registration
* would also overwrite the host row's store slot. The pet tools only consume
* the four methods, which are stateless over the on-disk registry, so a
* prototype instance with `home` set behaves identically to the registered one.
*/
function createUnregisteredPetHttp(home = petHome()) {
	const instance = Object.create(PetHttpService.prototype);
	instance.home = home;
	instance.capsCache = /* @__PURE__ */ new Map();
	instance.listCache = void 0;
	return instance;
}
/**
* Construct and register the HTTP provider, returning the INSTANCE for
* in-bundle consumers. The Service constructor registers synchronously
* ("registered immediately" — vendor/cordis), but `ctx.petService` GETTER
* access from the same tick does not wait for queued plugin fibers — the
* imperative consumers hold the instance instead, and future external
* plugins can still `inject: ['petService']`.
*/
function installPetService(ctx, home) {
	return new PetHttpService(ctx, home);
}
//#endregion
export { writeAffectionRaw as A, petStatePaths as C, readJsonl as D, readGlobalJson as E, writePetName as M, writePetStateJson as N, readPetName as O, petDataDir as S, readGlobalArrayJson as T, existingPetIds as _, defaultPet as a, migrateGlobalSplits as b, resolveExpressionRequest as c, formatAvailableTags as d, resolveActionRequest as f, eventsFile as g, appendJsonl as h, petHome as i, writeGlobalJson as j, readPetStateJson as k, suggestExpressionFallback as l, WHALE_DIR as m, installPetService as n, notifyPets as o, resolveTagRequest as p, isActionComplete as r, formatMissingExpression as s, createUnregisteredPetHttp as t, formatAvailableActions as u, globalFilePath as v, readAffectionRaw as w, migrateGlobals as x, globalPaths as y };
