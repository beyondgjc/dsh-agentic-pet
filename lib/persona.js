import { b as globalPaths, i as petHome } from "./service-DdkvZRit.js";
import { readFileSync } from "node:fs";
//#region lib/types/persona.js
/**
* The persona row: the pet's configurable identity, mounted by both pet
* presets (whale598-standard / whale598) in place of @deepseek-ai/dsh-persona.
*
* Why REPLACE the official row instead of adding alongside it: a preset's
* rows instantiate in one generation scope and prompt-section names are
* unique per scope, so a companion row would need its own section name — and
* any other section sorts after the persona-prefix slot, putting the editable
* character card AFTER the body rules it introduces. Owning
* `deployment:persona-prefix` keeps today's reading order: character card
* first, body rules (the yml-provided config.prefix, this row's static half)
* immediately after.
*
* The dynamic half lives in pet-settings.json `persona` (edited from the
* settings page; hand-editing works the same): the section text is a function
* re-read at every assembly, so a saved edit lands on the next turn with no
* restart. User free text must never enter strict {{variable}} interpolation
* — an unknown reference makes the whole assembly throw — so the section is
* registered with interpolate: false, and the default card therefore drops
* the identity sentence's old `（由 {{model}} 驱动）` parenthetical.
*
* The static half (config.prefix — the body rules) is a contract with the
* carrier renderer (bubble length, action restraint, journal usage) and is
* intentionally NOT user-editable; that is why it stays in the preset yml.
* @module dsh-agentic-pet/persona
*/
/** Cordis plugin name. */
const name = "persona";
/** The prompt registry this row contributes to. Without this declaration the
* traceable proxy rejects `ctx.systemPrompt` ("cannot get property ... without
* inject") and the whole preset fails to mount — taking every pet session's
* resume down with it. */
const inject = ["systemPrompt"];
function systemPromptOf(ctx) {
	return ctx.systemPrompt;
}
/**
* The default character card: the identity sentence both preset prefixes
* shipped, minus the `（由 {{model}} 驱动）` parenthetical (a strict
* interpolation reference — incompatible with user-editable text). Clearing
* the settings field falls back here, so "cleared" and "reset to default"
* are the same state.
*/
const DEFAULT_PERSONA = "你是「鲸鱼娘」，用户桌面上的宠物：一个透明置顶窗里的女孩，有表情、有动作、有气泡，用户能摸你的头和身体。";
/** Upper bound for the user-edited card, enforced by the settings merge. A
* runaway card would inflate every pet-session prompt; the sync reader
* applies the same cap so a hand-edited file cannot bypass it. */
const MAX_PERSONA_CHARS = 8e3;
/**
* Read the configured character card for one preset slot: the per-preset
* override `personas.<key>` → the legacy global `persona` card → default.
* Sync on purpose — PromptSection.text is a synchronous provider called once
* per assembly, and a ~1KB JSON read per request is noise next to the LLM
* call it feeds, so there is no cache to invalidate. Both readers (this and
* the settings merge) trim first, then cap.
*
* The fallback chain IS the migration: the two original presets show the
* existing global card until a slot is edited, and clearing a slot reverts
* it — no data move, one concept.
*/
function readPersonaCard(home, key) {
	const { current, legacy } = globalPaths(home, "pet-settings.json");
	for (const file of [current, legacy]) try {
		const parsed = JSON.parse(readFileSync(file, "utf8"));
		if (parsed && typeof parsed === "object") {
			const cap = (raw) => raw.length > 8e3 ? raw.slice(0, MAX_PERSONA_CHARS) : raw;
			if (key !== void 0) {
				const slots = typeof parsed.personas === "object" && parsed.personas !== null ? parsed.personas : {};
				const slot = typeof slots[key] === "string" ? slots[key].trim() : "";
				if (slot !== "") return cap(slot);
			}
			const card = typeof parsed.persona === "string" ? parsed.persona.trim() : "";
			if (card === "") break;
			return cap(card);
		}
	} catch {}
	return DEFAULT_PERSONA;
}
/** The prompt-registry section this row owns. Mirrors the unexported string
* behind @deepseek-ai/dsh-system-prompt's PERSONA_PREFIX_SECTION — scoped
* registration shadows the deployment persona, exactly how the official
* persona row takes over a preset's identity. */
const PERSONA_PREFIX_SECTION = "deployment:persona-prefix";
/** Order slot for the persona prefix; the fallback is the slot's documented
* value in case the key is ever renamed (a non-finite order must never reach
* the registry). */
const PERSONA_PREFIX_ORDER_KEY = "DEPLOYMENT_PERSONA_PREFIX";
const PERSONA_PREFIX_ORDER_FALLBACK = 0;
/**
* Register the persona section in this preset's generation scope: it applies
* to every session mounted with the preset, shadows the deployment persona,
* and stays invisible to sessions on other presets.
*/
function apply(ctx, config) {
	const sp = systemPromptOf(ctx);
	const base = sp.getSectionOrder(PERSONA_PREFIX_ORDER_KEY);
	const order = Number.isFinite(base) ? base : PERSONA_PREFIX_ORDER_FALLBACK;
	const home = petHome();
	ctx.effect(() => sp.section({
		name: PERSONA_PREFIX_SECTION,
		order,
		interpolate: false,
		text: () => `${readPersonaCard(home, config.personaKey)}\n\n${config.prefix}`
	}), "persona.section()");
}
//#endregion
export { DEFAULT_PERSONA, MAX_PERSONA_CHARS, apply, inject, name, readPersonaCard };
