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
export interface IdleBiasConfig {
    /** 本地小时窗口 [from, to)，from > to 表示跨午夜。 */
    readonly hours: readonly [number, number];
    /** 标签 → 权重乘数（≥0）；表外标签 ×1；片段取最强匹配（max，非乘积）。 */
    readonly weights: Readonly<Record<string, number>>;
}
/** B06 默认表：凌晨安静系 ×1.5、活跃系 ×0.5。 */
export declare const DEFAULT_IDLE_BIAS: IdleBiasConfig;
/** Read `rhythm.idleBias` from pet-settings.json. Absent/invalid = 默认表；
 * 显式 `null` = 关闭（渲染层均匀随机）。 */
export declare function readIdleBias(home: string): Promise<IdleBiasConfig | undefined>;
//# sourceMappingURL=rhythm.d.ts.map