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
import type { Context } from '@deepseek-ai/cordis';
/**
 * The default character card: the identity sentence both preset prefixes
 * shipped, minus the `（由 {{model}} 驱动）` parenthetical (a strict
 * interpolation reference — incompatible with user-editable text). Clearing
 * the settings field falls back here, so "cleared" and "reset to default"
 * are the same state.
 */
export declare const DEFAULT_PERSONA = "\u4F60\u662F\u300C\u9CB8\u9C7C\u5A18\u300D\uFF0C\u7528\u6237\u684C\u9762\u4E0A\u7684\u5BA0\u7269\uFF1A\u4E00\u4E2A\u900F\u660E\u7F6E\u9876\u7A97\u91CC\u7684\u5973\u5B69\uFF0C\u6709\u8868\u60C5\u3001\u6709\u52A8\u4F5C\u3001\u6709\u6C14\u6CE1\uFF0C\u7528\u6237\u80FD\u6478\u4F60\u7684\u5934\u548C\u8EAB\u4F53\u3002";
/** Upper bound for the user-edited card, enforced by the settings merge. A
 * runaway card would inflate every pet-session prompt; the sync reader
 * applies the same cap so a hand-edited file cannot bypass it. */
export declare const MAX_PERSONA_CHARS = 8000;
/**
 * Read the configured character card: whale598/pet-settings.json → legacy
 * root → default. Sync on purpose — PromptSection.text is a synchronous
 * provider called once per assembly, and a ~1KB JSON read per request is
 * noise next to the LLM call it feeds, so there is no cache to invalidate.
 * Both readers (this and the settings merge) trim first, then cap.
 */
export declare function readPersonaCard(home: string): string;
/**
 * Row config, passed by the preset ymls. Deliberately schema-less — the only
 * writer is our own presets, and a schema library dependency just to shape
 * that is not worth it.
 */
export interface PersonaRowConfig {
    /** Static body-rules prose appended after the character card. */
    prefix: string;
}
/**
 * Register the persona section in this preset's generation scope: it applies
 * to every session mounted with the preset, shadows the deployment persona,
 * and stays invisible to sessions on other presets.
 */
export declare function apply(ctx: Context, config: PersonaRowConfig): void;
//# sourceMappingURL=persona.d.ts.map