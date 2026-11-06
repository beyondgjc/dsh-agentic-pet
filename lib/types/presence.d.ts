/**
 * "When you were away" facts: per-pet wake/speak/action counters and a
 * last-user-activity checkpoint. Pure helpers; the driver owns the mutable
 * state and persistence.
 * @module dsh-agentic-pet/presence
 */
export interface PresenceCounts {
    wakeCount: number;
    speakCount: number;
    actionCount: number;
    selfWakeCount: number;
}
export interface PresenceFacts extends PresenceCounts {
    plansPending: number;
}
export interface PresenceConfig {
    enabled: boolean;
}
/** The user must have been silent this long before a return summary exists. */
export declare const AWAY_THRESHOLD_MS: number;
export declare const EMPTY_PRESENCE_COUNTS: PresenceCounts;
export declare function normalizePresenceCounts(raw: unknown): PresenceCounts;
export declare function diffPresence(current: PresenceCounts, baseline: PresenceCounts): PresenceCounts;
export declare function hasPresence(facts: PresenceFacts): boolean;
/** One compact line; prompt builders prepend the `[你不在的时候]` tag. */
export declare function formatPresenceLine(facts: PresenceFacts): string;
export declare function readPresenceConfig(home: string): Promise<PresenceConfig>;
//# sourceMappingURL=presence.d.ts.map