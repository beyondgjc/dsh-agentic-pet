/**
 * Idle selector (body iteration Phase 0, P0-5): deterministic coverage of
 * the pure core — whitelist/facing/no-repeat pool filtering, interval
 * sampling with jitter clamp, time-of-day bias (max-not-product), and the
 * facing hysteresis deadzone. Fixed seeds make every threshold an assertion.
 */

import { describe, expect, it } from 'vitest'
import {
  biasWeight,
  eligibleIdlePool,
  facingForOffset,
  mulberry32,
  pickIdle,
  type IdleCandidate,
} from '../src/idle-selector.ts'

const candidate = (id: string, extra: Partial<IdleCandidate> = {}): IdleCandidate => ({
  id,
  tags: ['待机'],
  idleEligible: true,
  ...extra,
})

const POOL: IdleCandidate[] = [
  candidate('待机呼吸休闲'),
  candidate('原地小憩沉眠'),
  candidate('摇扇纳凉'),
  candidate('撸猫'),
  candidate('写代码', { tags: ['工作', '专注'], idleEligible: false, noMirror: true }),
  candidate('写福字', { tags: ['节日'], idleEligible: true, noMirror: true }),
]

const BOUNDS: readonly [number, number] = [40000, 120000]

describe('eligibleIdlePool', () => {
  it('keeps only idleEligible clips and never the non-eligible ones', () => {
    const pool = eligibleIdlePool(POOL, 'right', [], 2)
    expect(pool.map(item => item.id).sort()).toEqual([
      '待机呼吸休闲', '写福字', '撸猫', '原地小憩沉眠', '摇扇纳凉',
    ].sort())
    expect(pool.some(item => item.id === '写代码')).toBe(false)
  })

  it('excludes noMirror clips when facing left', () => {
    const pool = eligibleIdlePool(POOL, 'left', [], 2)
    expect(pool.some(item => item.id === '写福字')).toBe(false)
    expect(pool.length).toBe(4)
  })

  it('excludes the last noRepeat ids, then falls back to the full pool', () => {
    const fresh = eligibleIdlePool(POOL, 'right', ['待机呼吸休闲', '撸猫'], 2)
    expect(fresh.map(item => item.id)).not.toContain('待机呼吸休闲')
    expect(fresh.map(item => item.id)).not.toContain('撸猫')
    // Everything excluded → soften, don't deadlock (fallback to full pool).
    const two = [candidate('a'), candidate('b')]
    const allExcluded = eligibleIdlePool(two, 'right', ['a', 'b'], 2)
    expect(allExcluded.map(item => item.id).sort()).toEqual(['a', 'b'])
  })

  it('returns an empty pool for a body without idleEligible clips', () => {
    expect(eligibleIdlePool([candidate('写代码', { idleEligible: false })], 'right', [], 2)).toEqual([])
  })
})

describe('pickIdle', () => {
  it('is deterministic under a fixed seed', () => {
    const a = pickIdle({ candidates: POOL, facing: 'right', recent: [], noRepeat: 2, intervalMs: BOUNDS, rng: mulberry32(7) })
    const b = pickIdle({ candidates: POOL, facing: 'right', recent: [], noRepeat: 2, intervalMs: BOUNDS, rng: mulberry32(7) })
    expect(a).toEqual(b)
  })

  it('never leaves the interval bounds, jitter clamped', () => {
    const rng = mulberry32(42)
    for (let i = 0; i < 500; i += 1) {
      const picked = pickIdle({ candidates: POOL, facing: 'right', recent: [], noRepeat: 2, intervalMs: BOUNDS, jitter: 0.5, rng })
      expect(picked).not.toBeNull()
      expect(picked!.intervalMs).toBeGreaterThanOrEqual(BOUNDS[0])
      expect(picked!.intervalMs).toBeLessThanOrEqual(BOUNDS[1])
    }
  })

  it('respects noRepeat across consecutive picks when fed back', () => {
    const rng = mulberry32(1)
    const recent: string[] = []
    for (let i = 0; i < 30; i += 1) {
      const picked = pickIdle({ candidates: POOL, facing: 'right', recent, noRepeat: 2, intervalMs: BOUNDS, rng })
      expect(picked).not.toBeNull()
      expect(recent.slice(0, 2)).not.toContain(picked!.id)
      recent.unshift(picked!.id)
    }
  })

  it('applies the time-of-day bias: night weights shift the distribution', () => {
    // 小憩2 carries a tag ONLY it has — the ×9 weight makes it ~64% of the
    // night pool (9/(9+5×1)), vs uniform 1/6 by day (bias window closed).
    const nightBias = {
      hours: [1, 6] as readonly [number, number],
      weights: { 夜行动作: 9 },
    }
    const count = (hour: number | undefined): number => {
      const rng = mulberry32(99)
      let hits = 0
      for (let i = 0; i < 400; i += 1) {
        const picked = pickIdle({
          candidates: [...POOL, candidate('原地小憩沉眠2', { tags: ['夜行动作', '放松'] })],
          facing: 'right',
          recent: [],
          noRepeat: 2,
          intervalMs: BOUNDS,
          bias: nightBias,
          ...(hour === undefined ? {} : { hour }),
          rng,
        })
        if (picked?.id === '原地小憩沉眠2') hits += 1
      }
      return hits
    }
    const night = count(3)
    const day = count(14)
    expect(night).toBeGreaterThan(200)
    expect(day).toBeLessThan(120)
  })

  it('biasWeight takes the strongest matching tag, not the product', () => {
    const bias = { hours: [1, 6] as readonly [number, number], weights: { 疲惫: 1.5, 待机: 1.5, 活泼: 0.5 } }
    expect(biasWeight(candidate('x', { tags: ['疲惫', '待机'] }), bias, 3)).toBe(1.5)
    expect(biasWeight(candidate('x', { tags: ['工作'] }), bias, 3)).toBe(1)
    expect(biasWeight(candidate('x', { tags: ['待机'] }), bias, undefined)).toBe(1)
    expect(biasWeight(candidate('x', { tags: ['待机'] }), bias, 14)).toBe(1)
  })

  it('returns null when nothing is eligible', () => {
    expect(pickIdle({ candidates: [candidate('写代码', { idleEligible: false })], facing: 'right', recent: [], noRepeat: 2, intervalMs: BOUNDS, rng: mulberry32(3) })).toBeNull()
  })
})

describe('facingForOffset', () => {
  it('flips outside the deadzone and holds inside', () => {
    expect(facingForOffset(500, 'left')).toBe('right')
    expect(facingForOffset(-500, 'right')).toBe('left')
    expect(facingForOffset(20, 'left')).toBe('left')
    expect(facingForOffset(-20, 'right')).toBe('right')
    expect(facingForOffset(0, 'right')).toBe('right')
  })

  it('honors a custom hysteresis', () => {
    expect(facingForOffset(35, 'left', 40)).toBe('left')
    expect(facingForOffset(45, 'left', 40)).toBe('right')
  })
})
