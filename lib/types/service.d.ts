/**
 * The `ctx.petService` capability seam — the dsh three-roles pattern applied
 * inside the process boundary. Pets are separate processes by design, so this
 * service is NOT the pet itself: it is the typed in-process seam over the
 * out-of-process HTTP control plane. Discovery (the whale598/pet-http.d/
 * registry), liveness (pid + two-layer probe), retry policy, and the
 * /status field matrix (per-implementation extras) are normalized HERE —
 * consumers (the driver, the model tools, the settings page, the upcoming
 * proactivity scheduler) never see registry files, ports, or raw payloads.
 * A new pet implementation joins by publishing the existing HTTP contract;
 * this seam never changes for it.
 * @module dsh-agentic-pet/service
 */
import { Context, Service } from '@deepseek-ai/cordis';
import { type PetCapabilities } from './actions.ts';
import { type BodyDescription } from './body.ts';
import { type PetEntry } from './registry.ts';
declare module '@deepseek-ai/cordis' {
    interface Context {
        petService: PetService;
    }
}
/** The dsh home holding the pet registry, ledger, and settings files. */
export declare function petHome(): string;
/**
 * Normalized /status snapshot. Fields beyond id/online are optional —
 * implementations differ and the raw payload must never escape: consumers
 * read optional fields with defaults instead of branching per pet.
 */
export interface PetSnapshot {
    readonly id: string;
    readonly online: boolean;
    readonly state?: string | undefined;
    readonly animation?: string | undefined;
    readonly visible?: boolean | undefined;
    readonly interaction?: boolean | undefined;
    readonly bubble?: boolean | undefined;
    /** The v3 action witness as ONE object; `null` = no record yet. Legacy
     * implementations' lastAction/lastActionAt/lastActionDone triple folds in
     * here, so consumers read a single shape. */
    readonly lastAction?: PetLastAction | null | undefined;
    /** v2: where the pet body is (a screen-coordinate rect). Legacy
     * implementations publish the same geometry as `window` — folded in here. */
    readonly location?: {
        readonly x: number;
        readonly y: number;
        readonly width: number;
        readonly height: number;
    } | undefined;
    /** v2: where the pet may roam, THREE states — absent (undefined) = this
     * implementation does not support it; `null` = unset (default clamping
     * applies); object = in effect. The invariant holds per implementation:
     * location always sits inside a set world. */
    readonly world?: {
        readonly x: number;
        readonly y: number;
        readonly width: number;
        readonly height: number;
    } | null | undefined;
    readonly pid?: number | undefined;
}
/** The v3 action witness: accepted-on-write four fields, completion backfilled
 * in place (`endedAt`/`durationMs`); `id` matches the /action response's
 * `requestId` for tool-initiated actions (null for pet-local ones). */
export interface PetLastAction {
    readonly id: string | null;
    readonly action: string;
    readonly requestedBy: 'tool' | 'user' | null;
    readonly startedAt: number | null;
    readonly durationMs: number | null;
    readonly endedAt: number | null;
}
/** Completion requires BOTH the id match and the backfilled `endedAt`: the
 * acceptance record carries the same id with `endedAt: null`, so matching on
 * id alone would report "finished" the instant the action is accepted. */
export declare function isActionComplete(record: PetLastAction | null | undefined, requestId: string): record is PetLastAction & {
    endedAt: number;
};
/**
 * Abstract pet capability seam. Subclass, implement the abstract methods,
 * and load the subclass as a plugin — it registers as `ctx.petService`
 * (one implementation per context; loading a second throws, which is
 * cordis' standard duplicate-service behavior).
 *
 * Implementations must honor these semantics:
 * - {@link list} returns only pets whose control plane ANSWERS: a dead pid
 *   and a frozen publisher (listening socket, silent HTTP) are both skipped,
 *   in boot order (earliest `since` first).
 * - Interaction BROADCAST is not a route: see `notifyPets` in the registry
 *   module for the all-notify view, and `defaultPet` for unnamed targets.
 *   State audiences are computed by the driver (bound pet alive → that pet,
 *   otherwise every live pet).
 * - {@link snapshot} never throws on an unreachable pet — it resolves with
 *   `online: false`. Field-matrix differences stay here.
 * - {@link call} retries once through a fresh discovery pass, so a pet
 *   swap/restart between the caller's list() and the call does not fail a
 *   one-shot action outright.
 */
export declare abstract class PetService extends Service {
    constructor(ctx: Context);
    /** Every live pet in boot order (earliest `since` first — the default-pet
     * rule is a discovery guarantee, not a listing accident). */
    abstract list(): Promise<PetEntry[]>;
    /** The normalized mirror of one pet, or `online: false` when unreachable. */
    abstract snapshot(entry: PetEntry): Promise<PetSnapshot>;
    /** One JSON call to a pet endpoint, with a single fresh-discovery retry. */
    abstract call(entry: PetEntry, path: string, init?: RequestInit): Promise<unknown>;
    /**
     * The pet's advertised capabilities (`/capabilities`, e.g. its action
     * catalog) with a short TTL cache — the catalog changes only when a pet
     * restarts, and the TTL bounds how long a swapped pet's old menu shadows
     * the new one. Never throws: an unreachable pet reads as "publishes
     * nothing" (`actions: null`), which callers must treat as celebrate-only.
     */
    capabilities(_entry: PetEntry): Promise<PetCapabilities | null>;
    /** The body/1 self-description (`/body`); null = legacy, absent or invalid. */
    body(_entry: PetEntry): Promise<BodyDescription | null>;
}
/** Defensive field extraction: implementations may omit or mistype anything. */
export declare function normalizeStatus(id: string, raw: Record<string, unknown>, online: boolean): PetSnapshot;
/**
 * HTTP control-plane provider: talks to pet processes over the frozen wire
 * contract, discovering pets through the whale598/pet-http.d/ registry. A new
 * pet implementation is adopted by publishing the same contract — this
 * class does not change for it.
 */
export declare class PetHttpService extends PetService {
    readonly home: string;
    private readonly capsCache;
    private static readonly CAPS_TTL_MS;
    private bodyCache;
    private static readonly BODY_TTL_MS;
    private listCache;
    private static readonly LIST_TTL_MS;
    constructor(ctx: Context, home?: string);
    /** Every live pet in boot order, served from the 1s single-flight cache:
     * concurrent callers share the running probe pass. */
    list(): Promise<PetEntry[]>;
    snapshot(entry: PetEntry): Promise<PetSnapshot>;
    capabilities(entry: PetEntry): Promise<PetCapabilities>;
    body(entry: PetEntry): Promise<BodyDescription | null>;
    call(entry: PetEntry, path: string, init?: RequestInit): Promise<unknown>;
}
/**
 * Per-endpoint call budgets (§6 v4). One-shot endpoints fail fast — five
 * seconds covers loopback many times over. The long-poll endpoints hang BY
 * DESIGN, so their budget must exceed the server's hold clamp (≤30s) or
 * every hold-to-the-dot answer would surface as a timeout; and they never
 * retry — a retried /interaction would raise a second bubble for one ask.
 */
export declare function callBudget(path: string): {
    timeoutMs: number;
    retry: boolean;
};
/**
 * A PetService-shaped instance WITHOUT the Service registration side effect.
 * The preset realm rejects any non-isolated service publication from its rows
 * ("Preset services require isolate realms") — and a same-named registration
 * would also overwrite the host row's store slot. The pet tools only consume
 * the four methods, which are stateless over the on-disk registry, so a
 * prototype instance with `home` set behaves identically to the registered one.
 */
export declare function createUnregisteredPetHttp(home?: string): PetService;
/**
 * Construct and register the HTTP provider, returning the INSTANCE for
 * in-bundle consumers. The Service constructor registers synchronously
 * ("registered immediately" — vendor/cordis), but `ctx.petService` GETTER
 * access from the same tick does not wait for queued plugin fibers — the
 * imperative consumers hold the instance instead, and future external
 * plugins can still `inject: ['petService']`.
 */
export declare function installPetService(ctx: Context, home: string): PetHttpService;
