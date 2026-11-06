/**
 * body/1 — the body's own description of what it is and what it can do.
 * The driver owns this envelope (shapes, validation); the body owns the
 * values (ids, tags, usage, fallbacks). Unknown fields and capability kinds
 * are preserved, never interpreted here.
 * @module dsh-agentic-pet/body
 */
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
function validateCapability(kind, value) {
    if (!isRecord(value))
        return `${kind} is not an object`;
    if (typeof value.supported !== 'boolean')
        return `${kind}.supported must be boolean`;
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
//# sourceMappingURL=body.js.map