/**
 * Pure-function coverage for the action-catalog contract: capability
 * normalization (defensive extraction from arbitrary pet payloads) and the
 * pet_do request resolution against a pet's advertised menu. The catalog is
 * the pet's own — the driver must never grow an opinion about it — so these
 * tests pin the contract edges: universal celebrate, random draws from the
 * pet's menu, legacy pets that publish nothing, and malformed payloads.
 */

import { describe, expect, it } from 'vitest'
import { formatAvailableActions, normalizeCapabilities, resolveActionRequest } from '../src/actions.ts'

describe('normalizeCapabilities', () => {
  it('keeps a well-formed actions array', () => {
    expect(normalizeCapabilities({ actions: ['celebrate', '写福字'] })).toEqual({ actions: ['celebrate', '写福字'] })
  })

  it('folds malformed shapes into a null catalog', () => {
    expect(normalizeCapabilities(undefined)).toEqual({ actions: null })
    expect(normalizeCapabilities('nope')).toEqual({ actions: null })
    expect(normalizeCapabilities({})).toEqual({ actions: null })
    expect(normalizeCapabilities({ actions: 'celebrate' })).toEqual({ actions: null })
    expect(normalizeCapabilities({ actions: [1, null, 'ok'] })).toEqual({ actions: ['ok'] })
  })

  it('folds an advertised-but-empty menu into null (no catalog published)', () => {
    expect(normalizeCapabilities({ actions: [] })).toEqual({ actions: null })
  })
})

describe('resolveActionRequest', () => {
  const menu = ['celebrate', '写福字', '吃Token']

  it('admits celebrate on every pet, catalog or not', () => {
    expect(resolveActionRequest('celebrate', menu)).toEqual({ kind: 'ok', action: 'celebrate' })
    expect(resolveActionRequest('celebrate', null)).toEqual({ kind: 'ok', action: 'celebrate' })
  })

  it('admits a catalog member and rejects an unknown one with the menu', () => {
    expect(resolveActionRequest('写福字', menu)).toEqual({ kind: 'ok', action: '写福字' })
    const unknown = resolveActionRequest('不存在的动作', menu)
    expect(unknown).toEqual({ kind: 'unknown', available: menu })
  })

  it('a legacy pet (null catalog) admits only celebrate', () => {
    expect(resolveActionRequest('写福字', null)).toEqual({ kind: 'unknown', available: ['celebrate'] })
  })

  it('random draws from the pet menu, never the celebrate alias', () => {
    for (let i = 0; i < 50; i++) {
      const pick = resolveActionRequest('random', menu)
      expect(pick.kind).toBe('ok')
      if (pick.kind === 'ok') {
        expect(menu).toContain(pick.action)
        expect(pick.action).not.toBe('celebrate')
      }
    }
  })

  it('random on a legacy pet (or celebrate-only menu) falls back to celebrate', () => {
    expect(resolveActionRequest('random', null)).toEqual({ kind: 'ok', action: 'celebrate' })
    expect(resolveActionRequest('random', ['celebrate'])).toEqual({ kind: 'ok', action: 'celebrate' })
  })
})

describe('formatAvailableActions', () => {
  it('lists a short menu in full', () => {
    expect(formatAvailableActions(['a', 'b'])).toBe('a、b')
  })

  it('previews a long menu with the full-list pointer', () => {
    const long = Array.from({ length: 30 }, (_, i) => `动作${String(i)}`)
    const text = formatAvailableActions(long)
    expect(text).toContain('动作0')
    expect(text).toContain('动作23')
    expect(text).not.toContain('动作24')
    expect(text).toContain('+6 more')
  })
})
