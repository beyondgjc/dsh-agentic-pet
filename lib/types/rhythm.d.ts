/**
 * Quiet-hours parsing and evaluation. Scope is deliberately minimal: quiet
 * suppresses the WORLD clock only. Self-scheduled wakes still fire (with a
 * note in the prompt), touch replies follow `allowTouchReply`, chat is never
 * gated, and the boot greeting is unchanged.
 * @module dsh-agentic-pet/rhythm
 */
export interface QuietConfig {
    from: string;
    to: string;
    allowTouchReply: boolean;
}
export interface RhythmConfig {
    quiet?: QuietConfig | null;
}
/** "HH:mm" (or "H:mm") → minutes since midnight. Undefined for invalid. */
export declare function parseClock(value: unknown): number | undefined;
/** Half-open [from, to); cross-midnight is supported. */
export declare function isQuietAt(date: Date, quiet: QuietConfig | null | undefined): boolean;
/** Read `rhythm.quiet` from pet-settings.json; absent/null/invalid = no quiet. */
export declare function readRhythmConfig(home: string): Promise<RhythmConfig>;
//# sourceMappingURL=rhythm.d.ts.map