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
export declare const INSTANCES_FILE = "multi-instances.json";
export declare const PRIMARY_PET_ID = "electron";
export declare const DEFAULT_MAX_INSTANCES = 3;
/** The desktop placement stagger ordinal: electron = 0, electron-N = N-1.
 * THE shape knowledge for extra-instance ids lives here (isExtraInstanceId /
 * instanceSlotOf / nextInstanceId) — call sites must not re-parse the id. */
export declare function instanceSlotOf(petId: string): number;
export interface InstancePlan {
    maxInstances: number;
    instances: string[];
}
/** Defensive extraction: a mistyped file degrades to defaults instead of
 * blocking summons; the primary id is never stored as a desired instance. */
export declare function parseInstancePlan(raw: Record<string, unknown>): InstancePlan;
export declare function readInstancePlan(home: string): Promise<InstancePlan>;
export declare function writeInstancePlan(home: string, plan: InstancePlan): Promise<void>;
export declare function withInstancePlanLock<T>(home: string, fn: (plan: InstancePlan) => {
    value: T;
    plan: InstancePlan;
}): Promise<T>;
/** Next free instance id: electron-2, electron-3… — the lowest ordinal that
 * collides with neither the taken ids nor the running ones. */
export declare function nextInstanceId(taken: Iterable<string>): string;
/** Whether a petId names an extra electron-kind instance (electron-2, …). */
export declare function isExtraInstanceId(petId: string): boolean;
export type SummonAdmission = {
    ok: true;
} | {
    ok: false;
    reason: 'duplicate' | 'limit';
};
/** Summon admission (防呆): the primary plus the desired/running extras must
 * stay under the cap, and an already-running instance is a duplicate, not a
 * summon. `liveExtraIds` covers extras running without (yet) being in the
 * desired set; `candidate` is the id about to be summoned (counted toward
 * the cap even when not yet in either set). */
export declare function admitSummon(plan: InstancePlan, liveExtraIds: Iterable<string>, candidate?: string): SummonAdmission;
//# sourceMappingURL=instances.d.ts.map