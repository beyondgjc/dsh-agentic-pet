/**
 * body/1 — the body's own description of what it is and what it can do.
 * The driver owns this envelope (shapes, validation); the body owns the
 * values (ids, tags, usage, fallbacks). Unknown fields are preserved, never
 * interpreted here. Capability kinds: listing capabilities (actions,
 * expressions, …) follow the catalog/tags/count shape; the three known
 * BEHAVIOR kinds (`kind: "facing" | "idle" | "transition"`, body iteration
 * Phase 0) carry their own typed shape instead — they describe HOW the body
 * moves, not what it lists.
 * @module dsh-agentic-pet/body
 */
const BEHAVIOR_KINDS = ['facing', 'idle', 'transition'];
const isBehaviorKind = (value) => typeof value === 'string' && BEHAVIOR_KINDS.includes(value);
const isRecord = (value) => typeof value === 'object' && value !== null && !Array.isArray(value);
const isStringArray = (value) => Array.isArray(value) && value.every(item => typeof item === 'string');
const invalid = (reason) => ({ kind: 'legacy', reason });
/** Validate the body/1 envelope; preserve every unknown field. A missing or
 * foreign schema is legacy, not an error: old bodies keep working. */
export function normalizeBody(raw) {
    if (!isRecord(raw))
        return invalid('body is not an object');
    if (raw.schema !== 'body/1')
        return invalid('schema is not body/1');
    if (raw.bodyId !== undefined && typeof raw.bodyId !== 'string')
        return invalid('bodyId is not a string');
    if (raw.renderer !== undefined && typeof raw.renderer !== 'string')
        return invalid('renderer is not a string');
    if (raw.appearance !== undefined) {
        if (!isRecord(raw.appearance) || typeof raw.appearance.name !== 'string') {
            return invalid('appearance.name is required');
        }
    }
    if (raw.hitboxes !== undefined) {
        if (!isRecord(raw.hitboxes) || !isStringArray(raw.hitboxes.parts)) {
            return invalid('hitboxes.parts must be a string array');
        }
        if (raw.hitboxes.coordinateSpace !== undefined && typeof raw.hitboxes.coordinateSpace !== 'string') {
            return invalid('hitboxes.coordinateSpace must be a string');
        }
        if (raw.hitboxes.rects !== undefined) {
            if (!isRecord(raw.hitboxes.rects))
                return invalid('hitboxes.rects must be an object');
            for (const [part, rect] of Object.entries(raw.hitboxes.rects)) {
                if (!Array.isArray(rect) || rect.length !== 4 || rect.some(value => typeof value !== 'number' || !Number.isFinite(value))) {
                    return invalid(`hitboxes.rects.${part} must be four finite numbers`);
                }
            }
        }
    }
    if (raw.capabilities !== undefined) {
        if (!isRecord(raw.capabilities))
            return invalid('capabilities is not an object');
        for (const [kind, entry] of Object.entries(raw.capabilities)) {
            const reason = validateCapability(kind, entry);
            if (reason !== null)
                return invalid(reason);
        }
    }
    if (raw.extensions !== undefined && !isRecord(raw.extensions))
        return invalid('extensions is not an object');
    return { kind: 'body', body: { ...raw } };
}
/** Resolve pet_express against the CURRENT body's own expression capability.
 * There is no cross-body expression vocabulary. */
export function resolveExpressionRequest(body, requested) {
    const expressions = body?.capabilities?.expressions;
    if (expressions === undefined)
        return { kind: 'missing' };
    if (expressions.supported !== true)
        return { kind: 'unsupported', capability: expressions };
    const catalog = expressions.catalog;
    if (catalog !== undefined && !catalog.includes(requested)) {
        return { kind: 'unknown', available: catalog };
    }
    return { kind: 'ok', expression: requested };
}
const formatSubstituteArgs = (args) => Object.entries(args).map(([key, value]) => `${key}:${JSON.stringify(value)}`).join(', ');
/** Compute the degradation per REQUEST, not per body: a name that is also an
 * action tag gets that tag; otherwise the body's declared default is used
 * (and labelled as a default), never presented as a per-request match. */
export function suggestExpressionFallback(capability, requested, actionTags) {
    const base = '这具身体没有表情层（发生了什么）。表情能力在 capabilities.expressions 中声明为不支持（为什么）。';
    if (actionTags.includes(requested)) {
        const fallback = { tool: 'pet_do', args: { tag: requested } };
        return {
            message: `${base}最接近的是「${requested}」标签下的动作，可以改用 ${fallback.tool} {${formatSubstituteArgs(fallback.args)}}（下一步）。`,
            fallback,
            availableTags: actionTags,
        };
    }
    const substitute = capability.fallback?.substitute;
    if (substitute !== undefined) {
        return {
            message: `${base}没有找到与「${requested}」直接匹配的动作；这具身体的默认替代是 ${substitute.tool} {${formatSubstituteArgs(substitute.args)}}（下一步）。`,
            fallback: substitute,
            availableTags: actionTags,
        };
    }
    const tags = actionTags.length > 0 ? `；可用标签：${actionTags.slice(0, 12).join('、')}` : '';
    return {
        message: `${base}没有找到与「${requested}」直接匹配的动作${tags}（下一步）。`,
        fallback: null,
        availableTags: actionTags,
    };
}
export function formatMissingExpression() {
    return '这具身体没有发布表情自述（发生了什么）。它没有 body/1 的 expressions 能力（为什么）。先 pet_state {body:true} 看身体能力，或改用 pet_do 播动作（下一步）。';
}
function validateCapability(kind, value) {
    if (!isRecord(value))
        return `${kind} is not an object`;
    if (typeof value.supported !== 'boolean')
        return `${kind}.supported must be boolean`;
    if (isBehaviorKind(value.kind))
        return validateBehaviorCapability(kind, value);
    if (typeof value.usage !== 'string' || value.usage.trim() === '')
        return `${kind}.usage is required`;
    if (value.sample !== undefined && typeof value.sample !== 'boolean')
        return `${kind}.sample must be boolean`;
    const hasCatalog = value.catalog !== undefined;
    const hasTags = value.tags !== undefined;
    const hasCount = value.count !== undefined;
    if (hasCatalog && !isStringArray(value.catalog))
        return `${kind}.catalog must be a string array`;
    if (hasTags && !isStringArray(value.tags))
        return `${kind}.tags must be a string array`;
    if (hasCount && (typeof value.count !== 'number' || !Number.isFinite(value.count))) {
        return `${kind}.count must be a finite number`;
    }
    if (value.sample === true && !hasCount)
        return `${kind}.sample requires count`;
    if (value.sample !== true && hasCatalog && hasCount && value.count !== value.catalog.length) {
        return `${kind}.count does not match catalog`;
    }
    if (value.supported && !hasCatalog && !hasTags && !hasCount) {
        return `${kind} supports something but describes no catalog/tags/count`;
    }
    if (!value.supported && (hasCatalog || hasTags || hasCount)) {
        return `${kind} is unsupported but carries catalog/tags/count`;
    }
    if (value.example !== undefined) {
        if (!isRecord(value.example) || typeof value.example.tool !== 'string' || !isRecord(value.example.args)) {
            return `${kind}.example must be {tool,args}`;
        }
    }
    if (value.fallback !== undefined) {
        if (!isRecord(value.fallback) || typeof value.fallback.note !== 'string' || !isRecord(value.fallback.substitute)) {
            return `${kind}.fallback must be {note,substitute}`;
        }
        const substitute = value.fallback.substitute;
        if (typeof substitute.tool !== 'string' || !isRecord(substitute.args)) {
            return `${kind}.fallback.substitute must be {tool,args}`;
        }
        if (substitute.tool === 'pet_do' && 'action' in substitute.args && 'tag' in substitute.args) {
            return `${kind}.fallback.substitute cannot pass both action and tag`;
        }
    }
    return null;
}
const FACING_MODES = ['left', 'right', 'front'];
const MIRROR_METHODS = ['mirror', 'clips'];
/** Behavior capabilities (kind: facing/idle/transition) describe HOW the
 * body moves: usage is optional prose, the catalog/listing shape does not
 * apply, and each kind carries its own payload — validated per kind.
 * `supported:false` entries must stay bare (same asymmetry as the listing
 * rule: empty containers and "not declared" must stay distinguishable). */
function validateBehaviorCapability(kind, value) {
    if (value.usage !== undefined && (typeof value.usage !== 'string' || value.usage.trim() === '')) {
        return `${kind}.usage must be a non-empty string when present`;
    }
    const listingShape = ['catalog', 'tags', 'count', 'sample', 'fallback'].find(name => value[name] !== undefined);
    if (listingShape !== undefined) {
        return `${kind} is a behavior capability (${String(value.kind)}) and must not carry ${listingShape}`;
    }
    if (!value.supported) {
        const payloads = {
            facing: ['modes', 'method'],
            idle: ['intervalMs', 'noRepeat'],
            transition: ['defaultMs', 'toIdleMs'],
        };
        const carried = payloads[value.kind].find(name => value[name] !== undefined);
        if (carried !== undefined)
            return `${kind} is unsupported but carries ${carried}`;
        return null;
    }
    if (value.kind === 'facing') {
        if (!isStringArray(value.modes) || value.modes.length === 0 || !value.modes.every(mode => FACING_MODES.includes(mode))) {
            return `${kind}.modes must be a non-empty array of ${FACING_MODES.join('|')}`;
        }
        if (value.method === undefined || !MIRROR_METHODS.includes(value.method)) {
            return `${kind}.method must be ${MIRROR_METHODS.join(' or ')} when supported`;
        }
        return null;
    }
    if (value.kind === 'idle') {
        const interval = value.intervalMs;
        if (!Array.isArray(interval) || interval.length !== 2
            || !interval.every(n => typeof n === 'number' && Number.isFinite(n) && n >= 0)
            || interval[0] >= interval[1]) {
            return `${kind}.intervalMs must be [min,max] with 0 <= min < max`;
        }
        if (typeof value.noRepeat !== 'number' || !Number.isInteger(value.noRepeat) || value.noRepeat < 1) {
            return `${kind}.noRepeat must be a positive integer`;
        }
        return null;
    }
    // kind === 'transition'
    const msInRange = (v) => typeof v === 'number' && Number.isFinite(v) && v >= 0 && v <= 500;
    if (!msInRange(value.defaultMs))
        return `${kind}.defaultMs must be a finite number in [0,500]`;
    if (value.toIdleMs !== undefined) {
        if (!msInRange(value.toIdleMs))
            return `${kind}.toIdleMs must be a finite number in [0,500]`;
        if (value.toIdleMs < value.defaultMs)
            return `${kind}.toIdleMs must be >= defaultMs`;
    }
    return null;
}
//# sourceMappingURL=body.js.map