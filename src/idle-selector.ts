/**
 * Idle-action selector (body iteration Phase 0, P0-5): the pure-function
 * core of "她在自己动" — eligible-pool filtering, weighted random with
 * time-of-day bias, no-repeat exclusion, interval sampling with jitter, and
 * the facing hysteresis/deadzone decision. Every threshold and the RNG are
 * injectable, so the acceptance criteria run as deterministic assertions in
 * vitest; the carrier mirrors these shapes when it wires the renderer (0c).
 * @module dsh-agentic-pet/idle-selector
 */

export type Facing = 'left' | 'right'
export type Rng = () => number

export interface IdleCandidate {
  readonly id: string
  /** Intent tags — the bias table looks up here. */
  readonly tags: readonly string[]
  /** Phase 0 whitelist marker (actions.tags.json `idleEligible`). */
  readonly idleEligible?: boolean
  /** Text-bearing clip: excluded from the left-facing idle pool (REQ-B01). */
  readonly noMirror?: boolean
}

/** Time-of-day bias: a local-hour window ([from, to), `from > to` wraps
 * midnight) and per-tag weight multipliers. Tags absent from the table are
 * ×1; a clip's bias is its STRONGEST matching tag (max, not product — two
 * matching tags must not double-dip). */
export interface IdleBias {
  readonly hours: readonly [number, number]
  readonly weights: Readonly<Record<string, number>>
}

export interface IdlePick {
  readonly id: string
  readonly intervalMs: number
}

export interface IdlePickOptions {
  readonly candidates: readonly IdleCandidate[]
  readonly facing: Facing
  /** Recently played ids — the last `noRepeat` are excluded. */
  readonly recent: readonly string[]
  readonly noRepeat: number
  readonly intervalMs: readonly [number, number]
  /** ± fraction applied on top of the sampled interval (default 0.2),
   * clamped back into the interval bounds. */
  readonly jitter?: number
  readonly bias?: IdleBias
  /** Local hour (0–23) — bias applies only when given. */
  readonly hour?: number
  readonly rng: Rng
}

const inHourWindow = (hour: number, window: readonly [number, number]): boolean => {
  const [from, to] = window
  return from <= to ? hour >= from && hour < to : hour >= from || hour < to
}

/** Effective weight of a candidate under the bias table: the strongest
 * matching tag multiplier, ×1 when no tag matches or no bias applies. */
export function biasWeight(
  candidate: IdleCandidate,
  bias: IdleBias | undefined,
  hour: number | undefined,
): number {
  if (bias === undefined || hour === undefined) return 1
  if (!inHourWindow(hour, bias.hours)) return 1
  let weight = 1
  for (const tag of candidate.tags) {
    const w = bias.weights[tag]
    if (typeof w === 'number' && Number.isFinite(w) && w > weight) weight = w
  }
  return weight
}

/** The pool for this pick: whitelist + facing rule + no-repeat exclusion.
 * Falls back to the full whitelist when the exclusion empties the pool
 * (noRepeat softens variety, never deadlocks it). Returns null when the
 * whitelist itself is empty (body with no idleEligible clips). */
export function eligibleIdlePool(
  candidates: readonly IdleCandidate[],
  facing: Facing,
  recent: readonly string[],
  noRepeat: number,
): IdleCandidate[] {
  const whitelisted = candidates.filter(candidate => candidate.idleEligible === true)
  const facingFiltered = facing === 'left'
    ? whitelisted.filter(candidate => candidate.noMirror !== true)
    : whitelisted
  if (facingFiltered.length === 0) return []
  const excluded = new Set(recent.slice(0, Math.max(0, noRepeat)))
  const fresh = facingFiltered.filter(candidate => !excluded.has(candidate.id))
  return fresh.length > 0 ? fresh : facingFiltered
}

const sampleInterval = (
  bounds: readonly [number, number],
  jitter: number,
  rng: Rng,
): number => {
  const [min, max] = bounds
  const base = min + rng() * (max - min)
  const jittered = base * (1 + (rng() * 2 - 1) * jitter)
  return Math.round(Math.min(max, Math.max(min, jittered)))
}

/** Pick one idle action + the interval until the next one. Pure: the rng is
 * injected, so a fixed seed reproduces the exact sequence. */
export function pickIdle(options: IdlePickOptions): IdlePick | null {
  const pool = eligibleIdlePool(options.candidates, options.facing, options.recent, options.noRepeat)
  if (pool.length === 0) return null
  const weights = pool.map(candidate => biasWeight(candidate, options.bias, options.hour))
  const total = weights.reduce((sum, w) => sum + w, 0)
  let roll = options.rng() * total
  let picked = pool[pool.length - 1]
  if (picked === undefined) return null
  for (let i = 0; i < pool.length; i += 1) {
    const weight = weights[i]
    if (weight === undefined) continue
    roll -= weight
    if (roll < 0) {
      const found = pool[i]
      if (found !== undefined) picked = found
      break
    }
  }
  return {
    id: picked.id,
    intervalMs: sampleInterval(options.intervalMs, options.jitter ?? 0.2, options.rng),
  }
}

/** Facing decision for a cursor offset (cursor x − body center x, px):
 * inside the deadzone keep the current facing (hysteresis), outside flip.
 * The time debounce (40ms) is the caller's — this is the spatial half. */
export function facingForOffset(
  offsetPx: number,
  current: Facing,
  hysteresisPx = 20,
): Facing {
  if (Math.abs(offsetPx) <= hysteresisPx) return current
  return offsetPx > 0 ? 'right' : 'left'
}

/** Deterministic RNG for tests and offline distribution audits. */
export function mulberry32(seed: number): Rng {
  let state = seed >>> 0
  return () => {
    state = (state + 0x6d2b79f5) | 0
    let t = Math.imul(state ^ (state >>> 15), 1 | state)
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296
  }
}
