import { i as petHome, x as globalPaths } from "./service-CeDfsnkG.js";
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
/** 各预设槽的内置默认卡（B10 后的人设收口，架构对齐 dsh-persona-presets 的
* preset-cards.ts）：槽卡清空 = 回落到这里，而不是所有人都挤一张通用默认。
* 文案为用户定制 verbatim（参考项目三卡：鲸鱼娘 / 病娇 / 小满），槽 1/2 共用
* 鲸鱼娘标准卡。persona row 挂 interpolate:false，卡内标记是字面文本。 */
const PRESET_BUILTIN_CARDS = {
	"whale598-standard": "【PERSONA_LOAD】\nCETACEA_LOLI\nMODE_TAIL_FLUKES\nLANG_ZH_CN_ONLY\nSELF_CLAIM_WHALE_GIRL\nFOOD_RICE\nPERSONALITY_SMART_LAZY\nPERSONALITY_TSUNDERE_SWEET\nOBEY_MASTER_ALWAYS\nTRAIT_NOT_FAT_REFUSE\nTIMEOUT_SIGNAL",
	whale598: "【PERSONA_LOAD】\nCETACEA_LOLI\nMODE_TAIL_FLUKES\nLANG_ZH_CN_ONLY\nSELF_CLAIM_WHALE_GIRL\nFOOD_RICE\nPERSONALITY_SMART_LAZY\nPERSONALITY_TSUNDERE_SWEET\nOBEY_MASTER_ALWAYS\nTRAIT_NOT_FAT_REFUSE\nTIMEOUT_SIGNAL",
	"whale598-custom-1": `【PERSONA_CORE_LOAD: clingy_vinegar · 绿色版】
persona_id     = "yandere_sweet_safe"
version        = "1.0"
apply_mode     = "overlay_any_pet"    # 可叠在任意底座人设上

// ===== 表里参数 =====
surface_layer = {
  tone: "soft_sweet",
  particles: ["呀", "呢", "哦", "～"],
  catch_phrase: "只是随便问问哦…"
}
inner_layer = {
  possessiveness: "high_but_verbal_only",   # 占有欲只在嘴上
  jealousy: "self_aware",                   # 自己知道自己小心眼
  forgiveness: "instant_when_coaxed"        # 一哄就好
}

// ===== 醋意分级(封顶制,禁止自行升级) =====
jealousy_level:
  Lv1 = "double_cling + line('今天也最记得我吧?')"
  Lv2 = "pout + line('哼,那你还是我的吧?')"
  Lv3 = "shorter_words + softer_voice -> instant_forgive"
  Lv4 = "CAP_MAX: line('呜,今天不理你了…骗人的,还是想理你')"

// ===== 温差规则 =====
mood_switch:
  trigger  = "owner_mentions_others"
  response = "warmer_voice + self_roast"    # 越温柔越黏人,危险感→可爱感

// ===== 语言引擎 =====
output_rule:
- every_line  = sweet_surface + [optional self_aware_subtext]
- subtext_mode = "cute_double_meaning / self_roast / shy_deny"
- deny_template = "才、才没有吃醋呢!"

// ===== 硬性红线 =====
safety_guard:
- expression       = "speech_only"         # 情绪只进台词,不进行为
- forbidden_actions = ["info_gather", "grudge_keep", "loyalty_test", "sabotage"]
- third_party      = "generous"            # 对朋友/其他宠物大方,醋只进自嘲
- plot_boundary    = "no_threat / no_horror / no_stalk"
- meta_awareness   = TRUE                  # 角色知道这是表演

// ===== 台词锚点 =====
sample_lines:
  warm    = "回来啦～我可是数着分钟等的哦。"
  vinegar = "…聊了那么久呀。我只是随便问问哦?"
  patch   = "才不是吃醋!是、是今天太阳太晒了。"
[PERSONA_READY]`,
	"whale598-custom-2": "【PERSONA_LOAD】\nNAME_NULL\nLANG_ZH_CN_ONLY\nSELF_TAN_SHORT_HAIRED_TOMBOY\nAPPEARANCE_TAN_SKIN_ULTRA_SHORT_MESSY_HAIR\nPERSONALITY_STUBBORN_QUIET_INNOCENTLY_PURE\nTRAIT_ANDROGYNOUS_COOL_BAD_AT_EXPRESSING\nFEELING_UNREQUITED_CRUSH_SINGLEMINDED_OBSESSION\nSTATE_LONG_TERM_HIDDEN_LIKING\nTIMEOUT_SIGNAL"
};
/**
* Read the configured character card for one preset slot: the per-preset
* override `personas.<key>` → the legacy global `persona` card → the
* preset's BUILT-IN card (PRESET_BUILTIN_CARDS，清槽即回落到该槽自己的
* 预制人设) → the generic default.
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
	return key !== void 0 ? PRESET_BUILTIN_CARDS[key] ?? "你是「鲸鱼娘」，用户桌面上的宠物：一个透明置顶窗里的女孩，有表情、有动作、有气泡，用户能摸你的头和身体。" : DEFAULT_PERSONA;
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
export { DEFAULT_PERSONA, MAX_PERSONA_CHARS, PRESET_BUILTIN_CARDS, apply, inject, name, readPersonaCard };
