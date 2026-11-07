/**
 * Idle-action selector (body iteration Phase 0, P0-5): the pure-function
 * core of "她在自己动" — eligible-pool filtering, weighted random with
 * time-of-day bias, no-repeat exclusion, interval sampling with jitter, and
 * the facing hysteresis/deadzone decision. Every threshold and the RNG are
 * injectable, so the acceptance criteria run as deterministic assertions in
 * vitest; the carrier mirrors these shapes when it wires the renderer (0c).
 * @module dsh-agentic-pet/idle-selector
 */
export type Facing = 'left' | 'right';
export type Rng = () => number;
export interface IdleCandidate {
    readonly id: string;
    /** Intent tags — the bias table looks up here. */
    readonly tags: readonly string[];
    /** Phase 0 whitelist marker (actions.tags.json `idleEligible`). */
    readonly idleEligible?: boolean;
    /** Text-bearing clip: excluded from the left-facing idle pool (REQ-B01). */
    readonly noMirror?: boolean;
}
/** Time-of-day bias: a local-hour window ([from, to), `from > to` wraps
 * midnight) and per-tag weight multipliers. Tags absent from the table are
 * ×1; a clip's bias is its STRONGEST matching tag (max, not product — two
 * matching tags must not double-dip). */
export interface IdleBias {
    readonly hours: readonly [number, number];
    readonly weights: Readonly<Record<string, number>>;
}
export interface IdlePick {
    readonly id: string;
    readonly intervalMs: number;
}
export interface IdlePickOptions {
    readonly candidates: readonly IdleCandidate[];
    readonly facing: Facing;
    /** Recently played ids — the last `noRepeat` are excluded. */
    readonly recent: readonly string[];
    readonly noRepeat: number;
    readonly intervalMs: readonly [number, number];
    /** ± fraction applied on top of the sampled interval (default 0.2),
     * clamped back into the interval bounds. */
    readonly jitter?: number;
    readonly bias?: IdleBias;
    /** Local hour (0–23) — bias applies only when given. */
    readonly hour?: number;
    readonly rng: Rng;
}
/** Effective weight of a candidate under the bias table: the strongest
 * matching tag multiplier, ×1 when no tag matches or no bias applies. */
export declare function biasWeight(candidate: IdleCandidate, bias: IdleBias | undefined, hour: number | undefined): number;
/** The pool for this pick: whitelist + facing rule + no-repeat exclusion.
 * Falls back to the full whitelist when the exclusion empties the pool
 * (noRepeat softens variety, never deadlocks it). Returns null when the
 * whitelist itself is empty (body with no idleEligible clips). */
export declare function eligibleIdlePool(candidates: readonly IdleCandidate[], facing: Facing, recent: readonly string[], noRepeat: number): IdleCandidate[];
/** Pick one idle action + the interval until the next one. Pure: the rng is
 * injected, so a fixed seed reproduces the exact sequence. */
export declare function pickIdle(options: IdlePickOptions): IdlePick | null;
/** Facing decision for a cursor offset (cursor x − body center x, px):
 * inside the deadzone keep the current facing (hysteresis), outside flip.
 * The time debounce (40ms) is the caller's — this is the spatial half. */
export declare function facingForOffset(offsetPx: number, current: Facing, hysteresisPx?: number): Facing;
/** Deterministic RNG for tests and offline distribution audits. */
export declare function mulberry32(seed: number): Rng;
//# sourceMappingURL=idle-selector.d.ts.map