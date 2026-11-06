/**
 * body/1 envelope coverage: the driver validates the shape, preserves the
 * body's vocabulary and unknown fields, and treats a missing/foreign schema as
 * a legacy body instead of an error.
 */

import { describe, expect, it } from 'vitest'
import { normalizeBody } from '../src/body.ts'

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
