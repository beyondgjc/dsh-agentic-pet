/**
 * Pure-function coverage for the action-catalog contract: capability
 * normalization (defensive extraction from arbitrary pet payloads) and the
 * pet_do request resolution against a pet's advertised menu. The catalog is
 * the pet's own — the driver must never grow an opinion about it — so these
 * tests pin the contract edges: universal celebrate, random draws from the
 * pet's menu, legacy pets that publish nothing, and malformed payloads.
 */

import { describe, expect, it } from 'vitest'
import {
  formatAvailableActions,
  formatAvailableTags,
  normalizeCapabilities,
  resolveActionRequest,
  resolveTagRequest,
} from '../src/actions.ts'
import { callBudget } from '../src/service.ts'

const emptyCaps = {
  contractVersion: null,
  actions: null,
  actionCatalog: null,
  actionTagVocabulary: [],
  tagged: false,
}

describe('normalizeCapabilities', () => {
  it('keeps a well-formed actions array with the contract version', () => {
    expect(normalizeCapabilities({ contractVersion: 4, actions: ['celebrate', '写福字'] }))
      .toEqual({ ...emptyCaps, contractVersion: 4, actions: ['celebrate', '写福字'] })
  })

  it('folds malformed shapes into a null catalog and a null version', () => {
    expect(normalizeCapabilities(undefined)).toEqual(emptyCaps)
    expect(normalizeCapabilities('nope')).toEqual(emptyCaps)
    expect(normalizeCapabilities({})).toEqual(emptyCaps)
    expect(normalizeCapabilities({ actions: 'celebrate' })).toEqual(emptyCaps)
    expect(normalizeCapabilities({ actions: [1, null, 'ok'] }))
      .toEqual({ ...emptyCaps, actions: ['ok'] })
    // a legacy v1 pet (version absent) is distinct from a mistyped version
    expect(normalizeCapabilities({ actions: ['celebrate'], endpoints: [] }))
      .toEqual({ ...emptyCaps, actions: ['celebrate'] })
    expect(normalizeCapabilities({ contractVersion: '4', actions: [] }))
      .toEqual(emptyCaps)
  })

  it('folds an advertised-but-empty menu into null (no catalog published)', () => {
    expect(normalizeCapabilities({ contractVersion: 4, actions: [] }))
      .toEqual({ ...emptyCaps, contractVersion: 4 })
  })

  it('normalizes a body-owned action catalog and derives the tag vocabulary', () => {
    const caps = normalizeCapabilities({
      contractVersion: 4,
      actions: ['写代码', '庆祝', '待机呼吸休闲'],
      actionCatalog: [
        { id: '写代码', tags: ['工作', '专注'], energy: 'mid', durationHintMs: 3000 },
        { id: '庆祝', tags: ['庆祝'], energy: 'high', textInFrame: true },
        { id: '待机呼吸休闲', tags: ['待机'], loop: true },
        { id: 'bad-energy', tags: ['日常'], energy: 'extreme', loop: 'yes' },
        { id: '', tags: ['dropped'] },
      ],
      actionTagVocabulary: ['工作', '专注', '庆祝', '日常'],
    })
    expect(caps.actionCatalog).toEqual([
      { id: '写代码', tags: ['工作', '专注'], energy: 'mid', durationHintMs: 3000 },
      { id: '庆祝', tags: ['庆祝'], energy: 'high', textInFrame: true },
      { id: '待机呼吸休闲', tags: ['待机'], loop: true },
      { id: 'bad-energy', tags: ['日常'] },
    ])
    expect(caps.actionTagVocabulary).toEqual(['工作', '专注', '庆祝', '日常'])
    expect(caps.tagged).toBe(true)
  })

  it('derives the vocabulary from the catalog when the body omits it', () => {
    const caps = normalizeCapabilities({
      actions: ['a', 'b'],
      actionCatalog: [
        { id: 'a', tags: ['亲近', '撒娇'] },
        { id: 'b', tags: ['亲近'] },
      ],
    })
    expect(caps.actionTagVocabulary).toEqual(['亲近', '撒娇'])
  })

  it('a legacy body has no tags and is not tagged', () => {
    const caps = normalizeCapabilities({ actions: ['celebrate'] })
    expect(caps.actionCatalog).toBeNull()
    expect(caps.actionTagVocabulary).toEqual([])
    expect(caps.tagged).toBe(false)
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

describe('resolveTagRequest', () => {
  const caps = normalizeCapabilities({
    contractVersion: 4,
    actions: ['a', 'b', 'c', 'celebrate'],
    actionCatalog: [
      { id: 'a', tags: ['亲近', '撒娇'] },
      { id: 'b', tags: ['亲近'] },
      { id: 'c', tags: ['工作'] },
      { id: 'celebrate', tags: ['庆祝'] },
    ],
    actionTagVocabulary: ['亲近', '撒娇', '工作', '庆祝'],
  })

  it('matches the current body tags and returns all candidates', () => {
    const result = resolveTagRequest('亲近', caps)
    expect(result.kind).toBe('ok')
    if (result.kind === 'ok') {
      expect(['a', 'b']).toContain(result.action)
      expect(result.candidates).toEqual(['a', 'b'])
    }
    expect(resolveTagRequest('工作', caps)).toEqual({ kind: 'ok', action: 'c', candidates: ['c'] })
  })

  it('never draws the celebrate alias when another match exists', () => {
    for (let i = 0; i < 50; i += 1) {
      const result = resolveTagRequest('庆祝', caps)
      expect(result.kind).toBe('ok')
      if (result.kind === 'ok') expect(result.action).toBe('celebrate') // only match, explicit fallback
    }
    const withOther = normalizeCapabilities({
      actions: ['celebrate', 'x'],
      actionCatalog: [
        { id: 'celebrate', tags: ['庆祝'] },
        { id: 'x', tags: ['庆祝'] },
      ],
    })
    for (let i = 0; i < 50; i += 1) {
      const result = resolveTagRequest('庆祝', withOther)
      if (result.kind === 'ok') expect(result.action).toBe('x')
    }
  })

  it('an unknown tag names the body vocabulary and action fallback', () => {
    expect(resolveTagRequest('不存在', caps)).toEqual({
      kind: 'unknown',
      availableTags: ['亲近', '撒娇', '工作', '庆祝'],
      availableActions: ['a', 'b', 'c', 'celebrate'],
    })
  })

  it('a legacy body has no tag vocabulary', () => {
    expect(resolveTagRequest('亲近', null)).toEqual({
      kind: 'unknown',
      availableTags: [],
      availableActions: ['celebrate'],
    })
  })
})

describe('formatAvailableTags', () => {
  it('names the missing-vocabulary fallback explicitly', () => {
    expect(formatAvailableTags([])).toContain('未提供语义标签')
  })

  it('previews a long vocabulary', () => {
    const tags = Array.from({ length: 30 }, (_, i) => `标签${String(i)}`)
    const text = formatAvailableTags(tags)
    expect(text).toContain('标签0')
    expect(text).toContain('标签23')
    expect(text).not.toContain('标签24')
    expect(text).toContain('+6 more')
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

describe('callBudget (per-endpoint call budgets, §6 v4)', () => {
  it('gives one-shot endpoints the short fail-fast budget with one retry', () => {
    for (const path of ['/say', '/action', '/state', '/status', '/capabilities', '/world']) {
      expect(callBudget(path)).toEqual({ timeoutMs: 5_000, retry: true })
    }
  })

  it('gives a holding /events the long budget and never retries', () => {
    expect(callBudget('/events?since=5&hold=30')).toEqual({ timeoutMs: 45_000, retry: false })
    expect(callBudget('/events?hold=1')).toEqual({ timeoutMs: 45_000, retry: false })
  })

  it('a hold=0 /events reads as the immediate semantics: short budget', () => {
    expect(callBudget('/events?since=5')).toEqual({ timeoutMs: 5_000, retry: true })
    expect(callBudget('/events?since=5&hold=0')).toEqual({ timeoutMs: 5_000, retry: true })
  })

  it('the interaction long poll gets the long budget and never retries (a retry would raise a second bubble)', () => {
    expect(callBudget('/interaction')).toEqual({ timeoutMs: 45_000, retry: false })
  })
})
