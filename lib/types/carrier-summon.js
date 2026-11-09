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
/**
 * Decide the summon outcome in priority order: environment gates first (a
 * missing webserver or an operator's NO_SPAWN), then install integrity
 * (carrier directory), then electron availability — a staged binary spawns
 * immediately, an npm electron package defers to the installer, anything else
 * is unavailable. The already-running check is the caller's job: it needs the
 * async liveness probe, which this module deliberately does not perform.
 */
export function planSummon(input) {
    if (input.url === undefined)
        return { action: 'skip', reason: 'no-webserver' };
    if (input.noSpawn)
        return { action: 'skip', reason: 'spawn-disabled' };
    if (!input.carrierDirExists)
        return { action: 'skip', reason: 'carrier-missing' };
    if (input.electronBinaryReady)
        return { action: 'spawn' };
    if (input.electronInstallable)
        return { action: 'install-electron' };
    return { action: 'skip', reason: 'electron-unavailable' };
}
//# sourceMappingURL=carrier-summon.js.map