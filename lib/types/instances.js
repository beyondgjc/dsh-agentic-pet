/**
 * The multi-instance registry (Phase 1 of the multi-pet design,
 * whale598/docs/pet-multi-instance-design.md): which electron-kind instances
 * the user wants on the desktop, plus the id arithmetic and the summon
 * admission rule. The PRIMARY (`electron`) is never in the desired set — it
 * is this bundle's own carrier and spawns at activation regardless; the set
 * only names EXTRA instances.
 *
 * Storage: whale598/multi-instances.json — plugin-level state per the
 * ownership rules (AGENTS.md §8), deliberately NOT pet-settings.json: the
 * set changes on every summon/dismiss and must not ride the carrier-shared
 * settings file's merge path.
 * @module dsh-agentic-pet/instances
 */
import { readGlobalJson, writeGlobalJson } from "./petdata.js";
export const INSTANCES_FILE = 'multi-instances.json';
export const PRIMARY_PET_ID = 'electron';
export const DEFAULT_MAX_INSTANCES = 3;
/** Defensive extraction: a mistyped file degrades to defaults instead of
 * blocking summons; the primary id is never stored as a desired instance. */
export function parseInstancePlan(raw) {
    const rawMax = raw.maxInstances;
    const maxInstances = typeof rawMax === 'number' && Number.isFinite(rawMax) && rawMax >= 1
        ? Math.floor(rawMax)
        : DEFAULT_MAX_INSTANCES;
    const rawInstances = raw.instances;
    const instances = Array.isArray(rawInstances)
        ? [...new Set(rawInstances.filter((id) => typeof id === 'string' && id !== '' && id !== PRIMARY_PET_ID))]
        : [];
    return { maxInstances, instances };
}
export async function readInstancePlan(home) {
    const raw = await readGlobalJson(home, INSTANCES_FILE);
    return parseInstancePlan(raw);
}
export async function writeInstancePlan(home, plan) {
    await writeGlobalJson(home, INSTANCES_FILE, {
        maxInstances: plan.maxInstances,
        instances: plan.instances,
    });
}
/** Next free instance id: electron-2, electron-3… — the lowest ordinal that
 * collides with neither the taken ids nor the running ones. */
export function nextInstanceId(taken) {
    const used = new Set(taken);
    let ordinal = 2;
    while (used.has(`electron-${String(ordinal)}`))
        ordinal += 1;
    return `electron-${String(ordinal)}`;
}
/** Whether a petId names an extra electron-kind instance (electron-2, …). */
export function isExtraInstanceId(petId) {
    return /^electron-\d+$/.test(petId);
}
/** Summon admission (防呆): the primary plus the desired/running extras must
 * stay under the cap, and an already-running instance is a duplicate, not a
 * summon. `liveExtraIds` covers extras running without (yet) being in the
 * desired set; `candidate` is the id about to be summoned (counted toward
 * the cap even when not yet in either set). */
export function admitSummon(plan, liveExtraIds, candidate) {
    const live = new Set(liveExtraIds);
    if (candidate !== undefined && live.has(candidate))
        return { ok: false, reason: 'duplicate' };
    const all = new Set([...plan.instances, ...live]);
    if (candidate !== undefined)
        all.add(candidate);
    if (1 + all.size > plan.maxInstances)
        return { ok: false, reason: 'limit' };
    return { ok: true };
}
//# sourceMappingURL=instances.js.map