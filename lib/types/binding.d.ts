/**
 * Binding facts shared by the driver and the settings page: preset
 * validation, attach-failure classification, path containment, and the
 * public diagnostics shape. Pure functions only — the mutable owner map
 * stays in the driver.
 * @module dsh-agentic-pet/binding
 */
/** Presets that mount the pet tool row (`pet-tools`). */
export declare const PET_PRESET_IDS: ReadonlySet<string>;
export declare function isPetPreset(preset: string | undefined | null): boolean;
export type VoiceAttachErrorCode = 'none' | 'cwd-mismatch' | 'registry-missing' | 'session-archived' | 'session-missing' | 'preset-mismatch' | 'attach-failed';
export interface VoiceAttachState {
    ok: boolean;
    errorCode: VoiceAttachErrorCode;
    error: string | null;
    expectedCwd: string;
    actualCwd: string | null;
    at: number;
}
export interface VoiceBindingView {
    source: 'boundSessions' | 'innerVoiceStore' | 'none';
    configuredSessionId: string | null;
    expectedSessionId: string | null;
    effectiveSessionId: string | null;
    storeSessionId: string | null;
    usable: boolean;
    /** The CURRENT preset (live projection or projection cache), not the
     * session header's creation-time value. */
    preset: string | null;
    presetWarning: boolean;
    cwd: string | null;
    lastError: string | null;
    armed: boolean;
    armedAt: number | null;
    attach: VoiceAttachState | null;
    owners: string[];
    staleOwners: string[];
}
export interface VoiceBindingFailure {
    at: number;
    petId: string;
    sessionId: string;
    errorCode: VoiceAttachErrorCode;
    error: string;
    expectedCwd: string;
    actualCwd: string | null;
}
export interface VoiceBindingSnapshot {
    updatedAt: number;
    pets: Record<string, VoiceBindingView>;
    failures: VoiceBindingFailure[];
}
export interface SessionHeaderInfo {
    id?: string;
    agentPreset?: string;
    cwd?: string;
    title?: string;
}
/** Structural face of the host's live Session store (`ctx.get('sessions')`).
 * `get()` only sees LIVE sessions; a stored-but-not-open binding is found
 * through {@link SessionPersistenceFace} instead. */
export interface SessionStoreFace {
    get(sessionId: string): {
        header?: SessionHeaderInfo;
    } | undefined;
}
/** Structural face of the host's session persistence listing. */
export interface SessionPersistenceFace {
    list(options?: unknown): Promise<readonly {
        header?: SessionHeaderInfo;
    }[]>;
}
/** Structural face of the host's preset registry. `presetForSession` reads
 * the session's committed `agent-preset/selected` projection — the current
 * mode, unlike the immutable creation-time header field. */
export interface AgentPresetFace {
    presetForSession(session: unknown): string | null;
}
/** Structural face of the zero-I/O projection cache, used to read the
 * current preset of a stored-but-not-open session. */
export interface SessionProjectionCacheFace {
    cachedSnapshot(meta: unknown): {
        values?: {
            agentPreset?: unknown;
        };
    } | undefined;
}
/** Parse the host's attachSession rejection into a stable code. The cwd is
 * the only field worth surfacing verbatim; everything else is a category. */
export declare function classifyAttachFailure(message: string): {
    errorCode: VoiceAttachErrorCode;
    actualCwd: string | null;
};
/** Whether this settings patch actually edits the electron binding. Unrelated
 * saves must not be hard-rejected because an EXISTING binding is invalid. */
export declare function patchTouchesElectronBinding(patch: Record<string, unknown>): boolean;
/** The host attaches a session only when its cwd IS the workspace path
 * (canonical equality), not a descendant. */
export declare function isPetWorkspace(cwd: string | undefined | null, root: string): boolean;
//# sourceMappingURL=binding.d.ts.map