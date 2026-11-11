/**
 * Binding facts shared by the driver and the settings page: preset
 * validation, attach-failure classification, path containment, and the
 * public diagnostics shape. Pure functions only — the mutable owner map
 * stays in the driver.
 * @module dsh-agentic-pet/binding
 */
/** Presets that mount the pet tool row (`pet-tools`). */
export const PET_PRESET_IDS = new Set([
    'whale598',
    'whale598-standard',
    'whale598-custom-1',
    'whale598-custom-2',
    'pet-inner-voice',
    'pet',
]);
/** Display names for the preset ids, settings page and validation copy. The
 * custom ids are placeholder-named (自定义1/2) until the user renames them —
 * ids are sticky (creation-time session metadata), display names are free. */
export const PET_PRESET_LABELS = {
    whale598: '精简（仅表达）',
    'whale598-standard': '普通（含工作工具）',
    'whale598-custom-1': '自定义1',
    'whale598-custom-2': '自定义2',
};
export function isPetPreset(preset) {
    if (preset === undefined || preset === null || preset === '')
        return false;
    return PET_PRESET_IDS.has(preset);
}
/** Parse the host's attachSession rejection into a stable code. The cwd is
 * the only field worth surfacing verbatim; everything else is a category. */
export function classifyAttachFailure(message) {
    const cwd = /its cwd resolves to '([^']+)'/.exec(message);
    if (cwd !== null)
        return { errorCode: 'cwd-mismatch', actualCwd: cwd[1] ?? null };
    if (/no such session/i.test(message))
        return { errorCode: 'session-missing', actualCwd: null };
    if (/carries no cwd|does not resolve|not a directory/i.test(message)) {
        return { errorCode: 'attach-failed', actualCwd: null };
    }
    return { errorCode: 'attach-failed', actualCwd: null };
}
/** Whether this settings patch actually edits the electron binding. Unrelated
 * saves must not be hard-rejected because an EXISTING binding is invalid. */
export function patchTouchesElectronBinding(patch) {
    const inner = patch.innerVoice;
    if (typeof inner !== 'object' || inner === null)
        return false;
    const bound = inner.boundSessions;
    if (typeof bound !== 'object' || bound === null)
        return false;
    return Object.prototype.hasOwnProperty.call(bound, 'electron');
}
/** The host attaches a session only when its cwd IS the workspace path
 * (canonical equality), not a descendant. */
export function isPetWorkspace(cwd, root) {
    if (cwd === undefined || cwd === null || cwd === '')
        return false;
    const normalize = (value) => value.replace(/\\/g, '/').replace(/\/+$/, '').toLowerCase();
    return normalize(cwd) === normalize(root);
}
/** The collision guard for manually bound sessions: one session is exactly
 * one pet's brain (`voiceOwners` is sessionId → petId, so a second claimant
 * would hijack the mapping). Returns the OTHER petId currently holding
 * `sessionId` — via its configured binding or its durable store entry — or
 * undefined when the session is free for `selfPetId`. */
export function sessionOccupiedBy(sessionId, selfPetId, boundSessions, storeSessions) {
    for (const [petId, bound] of Object.entries(boundSessions)) {
        if (petId !== selfPetId && bound === sessionId)
            return petId;
    }
    for (const [petId, entry] of Object.entries(storeSessions)) {
        if (petId !== selfPetId && entry?.sessionId === sessionId)
            return petId;
    }
    return undefined;
}
/** The machine token for an occupied-session refusal (one spelling for the
 * reconcile error, the test answer, and the client's prefix parse). */
export function sessionOccupiedTag(occupiedBy) {
    return `session-occupied-by:${occupiedBy}`;
}
//# sourceMappingURL=binding.js.map