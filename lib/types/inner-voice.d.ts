/**
 * The inner voice (docs/inner-voice.md): the pet's self-initiated expression
 * loop. This module owns the pure, testable half — config parsing with
 * defaults and clamps, the durable petId→sessionId store, and the wake/touch
 * prompt builders. The driver (driver.ts) owns the wiring: timers, gates,
 * SessionController calls, and the per-pet pending locks.
 * @module dsh-agentic-pet/inner-voice
 */
/** Durable petId → sessionId mapping for the inner-voice sessions. */
export interface InnerVoiceStore {
    readonly sessions: Record<string, {
        sessionId: string;
        createdAt: number;
    }>;
    /** Session-id generation per pet, PERSISTED: must survive reboots AND
     * plugin reinstall — a re-install that restarted the counter would mint
     * ids colliding with archived ones (born dead). */
    readonly generations: Record<string, number>;
}
/** The `innerVoice` half of pet-settings.json, defaults folded in and clamped. */
export interface InnerVoiceConfig {
    enabled: boolean;
    /** Preset id the self-session mounts: the trimmed catalog by default, the
     * full work catalog only if the user opts in. */
    preset: string;
    /** Random-wake cadence in minutes. */
    wakeIntervalMinutes: number;
    /** Probability the wake actually speaks (the gate decides, never the model). */
    speakProbability: number;
    /** Probability a touch earns a reply turn. */
    touchReplyProbability: number;
    /** Minimum seconds between touch-reply turns per pet (0 = no cooldown;
     * the probability gate alone decides). Legacy minute-keyed settings fold
     * in ×60. */
    touchReplyCooldownSeconds: number;
    /** Manually bound sessions (petId → sessionId): the user's own
     * conversations the inner voice should live in — highest priority, used
     * as-is (no creation, no rename, never auto-retired). Empty = automatic
     * management (the durable store + generation mints). */
    boundSessions: Record<string, string>;
}
export declare const VOICE_SESSION_PREFIX = "whale598-";
/** Read `innerVoice` from pet-settings.json; anything missing or mistyped
 * folds to its default (defensive parse, `readAutonomy` precedent). */
export declare function readInnerVoiceConfig(home: string): Promise<InnerVoiceConfig>;
export declare function innerVoiceStorePath(home: string): string;
export declare function loadInnerVoiceStore(home: string): Promise<InnerVoiceStore>;
export declare function saveInnerVoiceStore(home: string, store: InnerVoiceStore): Promise<void>;
export declare function voiceSessionIdFor(petId: string): string;
/** Mint the next voice session id: the bare base for generation 0, `-gN`
 * after any retire. The generation counter lives in memory only — a desktop
 * restart resets it to zero while the archive set still holds every retired
 * id, so a naive mint lands on an ARCHIVED ancestor: the platform accepts
 * the prompt (bare `accepted` receipt) but its gate silently blocks every
 * turn of an archived session — born dead, retired by the 25s window, and
 * the replacement collides again (field spiral 2026-10-31, g1→g3 dead on
 * arrival). The mint therefore SKIPS any id the archive authority still
 * holds; with the counter reset this walks past g1..g16 to the first free
 * slot. The hop cap keeps a pathological archive set from spinning forever.
 * Returns the (possibly advanced) generation so callers persist it — a
 * later mint must not reuse a skipped id either — plus the hop count for
 * the skip log line. */
export declare function mintVoiceSessionId(petId: string, generation: number, isArchived: (sessionId: string) => boolean): {
    sessionId: string;
    generation: number;
    hops: number;
};
export interface GreetPromptFacts {
    affection: number;
}
/** The boot-greeting prompt: fired once per dsh start when the pet first
 * comes online — before the random-wake cadence takes over. Always speaks
 * (no probability gate on this one); the time context rides the preset. */
export declare function buildGreetPrompt(facts: GreetPromptFacts): string;
/** Shared mood vocabulary (pet_state computes the same from the ledger). */
export declare function moodOf(affection: number): 'happy' | 'content' | 'neutral';
/** Touch part → spoken wording; `unknown` never earns a reply turn (the
 * driver filters it before building a prompt). */
export declare function touchPartWording(part: string): string | undefined;
export interface WakePromptFacts {
    affection: number;
    /** Minutes since this pet last spoke on its own; undefined = first wake. */
    minutesSinceLastSpoke: number | undefined;
    /** Minutes since the bound session last showed activity; undefined = none recorded. */
    minutesSinceUserActivity: number | undefined;
    userActive: boolean;
}
/** The wake prompt. Time context is injected by the preset's time-context
 * row; the leading tag doubles as the durable trigger marker in the log. */
export declare function buildWakePrompt(facts: WakePromptFacts): string;
export interface TouchPromptFacts {
    part: string;
    /** Touches on this pet today, from the ledger's recent window. */
    touchesToday: number;
    affection: number;
}
export declare function buildTouchPrompt(facts: TouchPromptFacts): string;
/** The chat上行 prompt (§6 2026-10-31 revision): the user typed at the
 * pet's surface. The text rides verbatim — the pet answers through pet_say
 * (and may pet_do); it is a conversation turn, not a touch reaction. Length
 * clamps to the contract's 2000-character ceiling. */
export declare function buildChatPrompt(text: string): string;
//# sourceMappingURL=inner-voice.d.ts.map