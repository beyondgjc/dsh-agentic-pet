/**
 * body/1 envelope coverage: the driver validates the shape, preserves the
 * body's vocabulary and unknown fields, and treats a missing/foreign schema as
 * a legacy body instead of an error.
 */

import { describe, expect, it } from 'vitest'
import {
  formatMissingExpression,
  normalizeBody,
  resolveExpressionRequest,
  suggestExpressionFallback,
  type BodyCapability,
} from '../src/body.ts'

const base = {
  schema: 'body/1',
  bodyId: 'whale-webm',
  renderer: 'webm',
  appearance: { name: '蓝毛小女仆' },
  hitboxes: {
    coordinateSpace: 'frame-px',
    parts: ['head', 'body'],
    rects: { head: [185, 60, 436, 195], body: [212, 60, 428, 330] },
  },
  capabilities: {
    actions: {
      supported: true,
      usage: '用 pet_do 播片段。',
      example: { tool: 'pet_do', args: { tag: '工作' } },
      catalog: ['写代码'],
      tags: ['工作'],
      count: 1,
    },
    expressions: {
      supported: false,
      usage: '这具身体没有表情层。',
      fallback: {
        note: '最接近的是 点击回应-害羞惊讶',
        substitute: { tool: 'pet_do', args: { action: '点击回应-害羞惊讶' } },
      },
    },
  },
  extensions: { 'body/1:whale/geometry': { w: 460, h: 560 } },
} as const

describe('normalizeBody', () => {
  it('accepts a body/1 document and preserves unknown fields and capability kinds', () => {
    const raw = {
      ...base,
      extra: { future: true },
      capabilities: {
        ...base.capabilities,
        futureKind: { supported: false, usage: '未来能力。' },
      },
    }
    const result = normalizeBody(raw)
    expect(result.kind).toBe('body')
    if (result.kind !== 'body') return
    expect(result.body.bodyId).toBe('whale-webm')
    expect(result.body.extra).toEqual({ future: true })
    expect(result.body.capabilities?.futureKind).toEqual({ supported: false, usage: '未来能力。' })
    expect(result.body.extensions).toEqual({ 'body/1:whale/geometry': { w: 460, h: 560 } })
  })

  it('treats a missing or foreign schema as legacy', () => {
    expect(normalizeBody(null).kind).toBe('legacy')
    expect(normalizeBody('body').kind).toBe('legacy')
    expect(normalizeBody({}).kind).toBe('legacy')
    expect(normalizeBody({ schema: 'body/2' }).kind).toBe('legacy')
  })

  it('accepts a schema-only body (nothing else required)', () => {
    const result = normalizeBody({ schema: 'body/1' })
    expect(result.kind).toBe('body')
  })

  it('rejects malformed core fields', () => {
    expect(normalizeBody({ ...base, bodyId: 1 }).kind).toBe('legacy')
    expect(normalizeBody({ ...base, renderer: false }).kind).toBe('legacy')
    expect(normalizeBody({ ...base, appearance: {} }).kind).toBe('legacy')
    expect(normalizeBody({ ...base, hitboxes: { parts: [1] } }).kind).toBe('legacy')
    expect(normalizeBody({ ...base, hitboxes: { parts: ['head'], rects: { head: [1, 2, 3] } } }).kind).toBe('legacy')
    expect(normalizeBody({ ...base, extensions: [] }).kind).toBe('legacy')
  })

  it('rejects malformed capability entries', () => {
    const withCaps = (capabilities: unknown) => normalizeBody({ ...base, capabilities })
    expect(withCaps({ actions: { supported: true } }).kind).toBe('legacy')
    expect(withCaps({ actions: { supported: 'yes', usage: 'x' } }).kind).toBe('legacy')
    expect(withCaps({ actions: { supported: true, usage: 'x' } }).kind).toBe('legacy')
    expect(withCaps({ actions: { supported: true, usage: 'x', catalog: ['a'], count: 2 } }).kind).toBe('legacy')
    expect(withCaps({ actions: { supported: false, usage: 'x', catalog: ['a'] } }).kind).toBe('legacy')
    expect(withCaps({ actions: { supported: false, usage: 'x', tags: ['a'] } }).kind).toBe('legacy')
  })

  it('allows a sample catalog with the real total count', () => {
    const result = normalizeBody({
      ...base,
      capabilities: {
        actions: {
          supported: true,
          usage: '用 pet_do 播片段。',
          catalog: ['写代码'],
          tags: ['工作'],
          count: 106,
          sample: true,
        },
      },
    })
    expect(result.kind).toBe('body')
    if (result.kind !== 'body') return
    expect(result.body.capabilities?.actions).toMatchObject({ count: 106, sample: true })
  })

  it('rejects a sample marker without a real count', () => {
    const result = normalizeBody({
      ...base,
      capabilities: {
        actions: {
          supported: true,
          usage: '用 pet_do 播片段。',
          catalog: ['写代码'],
          sample: true,
        },
      },
    })
    expect(result.kind).toBe('legacy')
  })

  it('requires a single executable fallback path for pet_do', () => {
    const result = normalizeBody({
      ...base,
      capabilities: {
        expressions: {
          supported: false,
          usage: '没有表情层。',
          fallback: {
            note: '最接近的是 点击回应-害羞惊讶',
            substitute: { tool: 'pet_do', args: { action: '点击回应-害羞惊讶', tag: '害羞' } },
          },
        },
      },
    })
    expect(result.kind).toBe('legacy')
  })

  it('accepts an unsupported capability with a structured fallback', () => {
    const result = normalizeBody(base)
    expect(result.kind).toBe('body')
    if (result.kind !== 'body') return
    expect(result.body.capabilities?.expressions?.supported).toBe(false)
    expect(result.body.capabilities?.expressions?.fallback?.substitute.tool).toBe('pet_do')
  })
})

describe('pet_express resolution', () => {
  const whale = normalizeBody(base)
  if (whale.kind !== 'body') throw new Error('fixture must be a body')

  it('degrades per request: a name that is an action tag becomes that tag', () => {
    const resolution = resolveExpressionRequest(whale.body, '害羞')
    expect(resolution.kind).toBe('unsupported')
    if (resolution.kind !== 'unsupported') return
    const tags = ['害羞', '开心', '工作']
    const shy = suggestExpressionFallback(resolution.capability, '害羞', tags)
    expect(shy.fallback).toEqual({ tool: 'pet_do', args: { tag: '害羞' } })
    expect(shy.message).toBe(
      '这具身体没有表情层（发生了什么）。表情能力在 capabilities.expressions 中声明为不支持（为什么）。最接近的是「害羞」标签下的动作，可以改用 pet_do {tag:"害羞"}（下一步）。',
    )
    const happy = suggestExpressionFallback(resolution.capability, '开心', tags)
    expect(happy.fallback).toEqual({ tool: 'pet_do', args: { tag: '开心' } })
    expect(happy.message).toContain('「开心」标签下的动作')
  })

  it('uses the body default only when no action tag matches', () => {
    const resolution = resolveExpressionRequest(whale.body, '星星眼')
    if (resolution.kind !== 'unsupported') throw new Error('fixture must be unsupported')
    const stars = suggestExpressionFallback(resolution.capability, '星星眼', ['害羞', '开心'])
    expect(stars.fallback).toEqual({ tool: 'pet_do', args: { action: '点击回应-害羞惊讶' } })
    expect(stars.message).toContain('没有找到与「星星眼」直接匹配的动作')
    expect(stars.message).toContain('默认替代')
  })

  it('returns no fallback when neither a tag nor a default exists', () => {
    const capability: BodyCapability = { supported: false, usage: '没有表情层。' }
    const result = suggestExpressionFallback(capability, '星星眼', ['害羞'])
    expect(result.fallback).toBeNull()
    expect(result.availableTags).toEqual(['害羞'])
    expect(result.message).toContain('可用标签：害羞')
  })

  it('resolves a supported whale-test catalog and rejects an unknown name', () => {
    const supported = normalizeBody({
      ...base,
      bodyId: 'whale-test',
      capabilities: {
        ...base.capabilities,
        expressions: {
          supported: true,
          usage: '用 pet_express 切表情。',
          catalog: ['开心', '害羞', '星星眼'],
          tags: ['开心', '害羞'],
          count: 3,
        },
      },
    })
    if (supported.kind !== 'body') throw new Error('fixture must be a body')
    for (const expression of ['开心', '害羞', '星星眼']) {
      expect(resolveExpressionRequest(supported.body, expression)).toEqual({ kind: 'ok', expression })
    }
    expect(resolveExpressionRequest(supported.body, '得意')).toEqual({
      kind: 'unknown',
      available: ['开心', '害羞', '星星眼'],
    })
  })

  it('treats a missing body or missing expressions capability as missing', () => {
    expect(resolveExpressionRequest(null, '头顶鲸').kind).toBe('missing')
    const bare = normalizeBody({ schema: 'body/1' })
    if (bare.kind !== 'body') throw new Error('fixture must be a body')
    expect(resolveExpressionRequest(bare.body, '头顶鲸').kind).toBe('missing')
    expect(formatMissingExpression()).toContain('body/1')
  })
})
