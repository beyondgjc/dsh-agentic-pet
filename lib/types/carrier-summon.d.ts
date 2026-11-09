/**
 * The summon decision: whether — and how — a settings-page summon request may
 * bring the Electron carrier back after the user quit it. Pure and
 * synchronous: every input is injected, so the decision table is unit-testable
 * without a filesystem or a process tree (tests/carrier-summon.spec.ts). The
 * side-effectful half lives in index.ts — summonCarrier() feeds this plan
 * into the existing activation machinery, where spawnPetCarrier() covers both
 * the binary-ready launch and the ensureCarrier install path.
 * @module dsh-agentic-pet/carrier-summon
 */
export type SummonAction = 'spawn' | 'install-electron' | 'skip';
export type SummonSkipReason = 'no-webserver' | 'spawn-disabled' | 'carrier-missing' | 'electron-unavailable';
export interface SummonPlanInput {
    /** Authenticated root URL of the host webserver; absent means no webserver. */
    url?: string;
    /** The DSH_PET_NO_SPOWN=1 operator gate. */
    noSpawn: boolean;
    /** The carrier app directory (carrier/package.json) exists. */
    carrierDirExists: boolean;
    /** resolveElectron() found a runnable electron binary. */
    electronBinaryReady: boolean;
    /** resolveElectron() found the npm electron package, so auto-install may run. */
    electronInstallable: boolean;
}
export interface SummonPlan {
    action: SummonAction;
    reason?: SummonSkipReason;
}
/** What the summon route reports back to the settings page. `reason` carries
 * a stable machine token ('already-running', the plan's skip reasons, or
 * 'unsupported' when no summon face was wired) — the client maps it to copy. */
export interface SummonOutcome {
    ok: boolean;
    started: boolean;
    reason?: string;
}
/**
 * Decide the summon outcome in priority order: environment gates first (a
 * missing webserver or an operator's NO_SPAWN), then install integrity
 * (carrier directory), then electron availability — a staged binary spawns
 * immediately, an npm electron package defers to the installer, anything else
 * is unavailable. The already-running check is the caller's job: it needs the
 * async liveness probe, which this module deliberately does not perform.
 */
export declare function planSummon(input: SummonPlanInput): SummonPlan;
//# sourceMappingURL=carrier-summon.d.ts.map