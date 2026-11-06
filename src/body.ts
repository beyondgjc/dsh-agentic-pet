/**
 * body/1 — the body's own description of what it is and what it can do.
 * The driver owns this envelope (shapes, validation); the body owns the
 * values (ids, tags, usage, fallbacks). Unknown fields and capability kinds
 * are preserved, never interpreted here.
 * @module dsh-agentic-pet/body
 */

export interface BodyCapability {
  readonly supported: boolean
  readonly usage: string
  readonly example?: { readonly tool: string; readonly args: Readonly<Record<string, unknown>> }
  readonly catalog?: readonly string[]
  readonly tags?: readonly string[]
  readonly count?: number
  /** catalog/tags are illustrative; count is the real total. */
  readonly sample?: boolean
  readonly vocabulary?: string
  readonly fallback?: {
    readonly note: string
    readonly substitute: { readonly tool: string; readonly args: Readonly<Record<string, unknown>> }
  }
  readonly [key: string]: unknown
}

export interface BodyDescription {
  readonly schema: 'body/1'
  readonly bodyId?: string
  readonly renderer?: string
  readonly appearance?: { readonly name: string; readonly [key: string]: unknown }
  readonly hitboxes?: {
    readonly parts: readonly string[]
    readonly rects?: Readonly<Record<string, readonly number[]>>
    readonly coordinateSpace?: string
    readonly [key: string]: unknown
  }
  readonly capabilities?: Readonly<Record<string, BodyCapability>>
  readonly extensions?: Readonly<Record<string, unknown>>
  readonly [key: string]: unknown
}

export type BodyNormalization =
  | { readonly kind: 'body'; readonly body: BodyDescription }
  | { readonly kind: 'legacy'; readonly reason: string }

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value)

const isStringArray = (value: unknown): value is string[] =>
  Array.isArray(value) && value.every(item => typeof item === 'string')

const invalid = (reason: string): BodyNormalization => ({ kind: 'legacy', reason })

/** Validate the body/1 envelope; preserve every unknown field. A missing or
 * foreign schema is legacy, not an error: old bodies keep working. */
export function normalizeBody(raw: unknown): BodyNormalization {
  if (!isRecord(raw)) return invalid('body is not an object')
  if (raw.schema !== 'body/1') return invalid('schema is not body/1')
  if (raw.bodyId !== undefined && typeof raw.bodyId !== 'string') return invalid('bodyId is not a string')
  if (raw.renderer !== undefined && typeof raw.renderer !== 'string') return invalid('renderer is not a string')

  if (raw.appearance !== undefined) {
    if (!isRecord(raw.appearance) || typeof raw.appearance.name !== 'string') {
      return invalid('appearance.name is required')
    }
  }

  if (raw.hitboxes !== undefined) {
    if (!isRecord(raw.hitboxes) || !isStringArray(raw.hitboxes.parts)) {
      return invalid('hitboxes.parts must be a string array')
    }
    if (raw.hitboxes.coordinateSpace !== undefined && typeof raw.hitboxes.coordinateSpace !== 'string') {
      return invalid('hitboxes.coordinateSpace must be a string')
    }
    if (raw.hitboxes.rects !== undefined) {
      if (!isRecord(raw.hitboxes.rects)) return invalid('hitboxes.rects must be an object')
      for (const [part, rect] of Object.entries(raw.hitboxes.rects)) {
        if (!Array.isArray(rect) || rect.length !== 4 || rect.some(value => typeof value !== 'number' || !Number.isFinite(value))) {
          return invalid(`hitboxes.rects.${part} must be four finite numbers`)
        }
      }
    }
  }

  if (raw.capabilities !== undefined) {
    if (!isRecord(raw.capabilities)) return invalid('capabilities is not an object')
    for (const [kind, entry] of Object.entries(raw.capabilities)) {
      const reason = validateCapability(kind, entry)
      if (reason !== null) return invalid(reason)
    }
  }

  if (raw.extensions !== undefined && !isRecord(raw.extensions)) return invalid('extensions is not an object')

  return { kind: 'body', body: { ...raw } as BodyDescription }
}

export type ExpressionResolution =
  | { readonly kind: 'ok'; readonly expression: string }
  | { readonly kind: 'unsupported'; readonly capability: BodyCapability }
  | { readonly kind: 'unknown'; readonly available: readonly string[] }
  | { readonly kind: 'missing' }

/** Resolve pet_express against the CURRENT body's own expression capability.
 * There is no cross-body expression vocabulary. */
export function resolveExpressionRequest(body: BodyDescription | null, requested: string): ExpressionResolution {
  const expressions = body?.capabilities?.expressions
  if (expressions === undefined) return { kind: 'missing' }
  if (expressions.supported !== true) return { kind: 'unsupported', capability: expressions }
  const catalog = expressions.catalog
  if (catalog !== undefined && !catalog.includes(requested)) {
    return { kind: 'unknown', available: catalog }
  }
  return { kind: 'ok', expression: requested }
}

const formatSubstituteArgs = (args: Readonly<Record<string, unknown>>): string =>
  Object.entries(args).map(([key, value]) => `${key}:${JSON.stringify(value)}`).join(', ')

export interface ExpressionFallbackSuggestion {
  readonly message: string
  readonly fallback: { readonly tool: string; readonly args: Readonly<Record<string, unknown>> } | null
  readonly availableTags: readonly string[]
}

/** Compute the degradation per REQUEST, not per body: a name that is also an
 * action tag gets that tag; otherwise the body's declared default is used
 * (and labelled as a default), never presented as a per-request match. */
export function suggestExpressionFallback(
  capability: BodyCapability,
  requested: string,
  actionTags: readonly string[],
): ExpressionFallbackSuggestion {
  const base = '这具身体没有表情层（发生了什么）。表情能力在 capabilities.expressions 中声明为不支持（为什么）。'
  if (actionTags.includes(requested)) {
    const fallback = { tool: 'pet_do', args: { tag: requested } }
    return {
      message: `${base}最接近的是「${requested}」标签下的动作，可以改用 ${fallback.tool} {${formatSubstituteArgs(fallback.args)}}（下一步）。`,
      fallback,
      availableTags: actionTags,
    }
  }
  const substitute = capability.fallback?.substitute
  if (substitute !== undefined) {
    return {
      message: `${base}没有找到与「${requested}」直接匹配的动作；这具身体的默认替代是 ${substitute.tool} {${formatSubstituteArgs(substitute.args)}}（下一步）。`,
      fallback: substitute,
      availableTags: actionTags,
    }
  }
  const tags = actionTags.length > 0 ? `；可用标签：${actionTags.slice(0, 12).join('、')}` : ''
  return {
    message: `${base}没有找到与「${requested}」直接匹配的动作${tags}（下一步）。`,
    fallback: null,
    availableTags: actionTags,
  }
}

export function formatMissingExpression(): string {
  return '这具身体没有发布表情自述（发生了什么）。它没有 body/1 的 expressions 能力（为什么）。先 pet_state {body:true} 看身体能力，或改用 pet_do 播动作（下一步）。'
}

function validateCapability(kind: string, value: unknown): string | null {
  if (!isRecord(value)) return `${kind} is not an object`
  if (typeof value.supported !== 'boolean') return `${kind}.supported must be boolean`
  if (typeof value.usage !== 'string' || value.usage.trim() === '') return `${kind}.usage is required`
  if (value.sample !== undefined && typeof value.sample !== 'boolean') return `${kind}.sample must be boolean`

  const hasCatalog = value.catalog !== undefined
  const hasTags = value.tags !== undefined
  const hasCount = value.count !== undefined
  if (hasCatalog && !isStringArray(value.catalog)) return `${kind}.catalog must be a string array`
  if (hasTags && !isStringArray(value.tags)) return `${kind}.tags must be a string array`
  if (hasCount && (typeof value.count !== 'number' || !Number.isFinite(value.count))) {
    return `${kind}.count must be a finite number`
  }
  if (value.sample === true && !hasCount) return `${kind}.sample requires count`
  if (value.sample !== true && hasCatalog && hasCount && value.count !== (value.catalog as string[]).length) {
    return `${kind}.count does not match catalog`
  }
  if (value.supported && !hasCatalog && !hasTags && !hasCount) {
    return `${kind} supports something but describes no catalog/tags/count`
  }
  if (!value.supported && (hasCatalog || hasTags || hasCount)) {
    return `${kind} is unsupported but carries catalog/tags/count`
  }

  if (value.example !== undefined) {
    if (!isRecord(value.example) || typeof value.example.tool !== 'string' || !isRecord(value.example.args)) {
      return `${kind}.example must be {tool,args}`
    }
  }

  if (value.fallback !== undefined) {
    if (!isRecord(value.fallback) || typeof value.fallback.note !== 'string' || !isRecord(value.fallback.substitute)) {
      return `${kind}.fallback must be {note,substitute}`
    }
    const substitute = value.fallback.substitute
    if (typeof substitute.tool !== 'string' || !isRecord(substitute.args)) {
      return `${kind}.fallback.substitute must be {tool,args}`
    }
    if (substitute.tool === 'pet_do' && 'action' in substitute.args && 'tag' in substitute.args) {
      return `${kind}.fallback.substitute cannot pass both action and tag`
    }
  }

  return null
}
