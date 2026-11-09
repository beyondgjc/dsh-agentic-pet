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
import { join } from 'node:path';
import { WHALE_DIR, readGlobalJson, writeGlobalJson } from "./petdata.js";
export const INSTANCES_FILE = 'multi-instances.json';
export const PRIMARY_PET_ID = 'electron';
export const DEFAULT_MAX_INSTANCES = 3;
/** The desktop placement stagger ordinal: electron = 0, electron-N = N-1.
 * THE shape knowledge for extra-instance ids lives here (isExtraInstanceId /
 * instanceSlotOf / nextInstanceId) — call sites must not re-parse the id. */
export function instanceSlotOf(petId) {
    if (petId === PRIMARY_PET_ID)
        return 0;
    const ordinal = Number(petId.split('-')[1] ?? Number.NaN);
    return Number.isInteger(ordinal) && ordinal >= 2 ? ordinal - 1 : 0;
}
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
/** Serialize desired-set read-modify-writes per home (board.ts lock
 * precedent): two concurrent summons both read the plan, both push, and the
 * last write would drop the other's instance from the desired set. The
 * callback receives the freshly-read plan, mutates it, and returns
 * `{ value, plan }` — the plan is written back inside the lock. */
const planQueues = new Map();
export function withInstancePlanLock(home, fn) {
    const key = join(home, WHALE_DIR, INSTANCES_FILE);
    const previous = planQueues.get(key) ?? Promise.resolve();
    const run = previous.then(async () => {
        const plan = await readInstancePlan(home);
        const outcome = fn(plan);
        await writeInstancePlan(home, outcome.plan);
        return outcome.value;
    }, async () => {
        const plan = await readInstancePlan(home);
        const outcome = fn(plan);
        await writeInstancePlan(home, outcome.plan);
        return outcome.value;
    });
    planQueues.set(key, run.then(() => undefined, () => undefined));
    return run;
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