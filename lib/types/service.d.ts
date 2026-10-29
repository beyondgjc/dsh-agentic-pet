/**
 * The `ctx.petService` capability seam — the dsh three-roles pattern applied
 * inside the process boundary. Pets are separate processes by design, so this
 * service is NOT the pet itself: it is the typed in-process seam over the
 * out-of-process HTTP control plane. Discovery (pet-http.d/ registry plus
 * legacy folding), liveness (pid + two-layer probe), retry policy, and the
 * /status field matrix (per-implementation extras) are normalized HERE —
 * consumers (the driver, the model tools, the settings page, the upcoming
 * proactivity scheduler) never see registry files, ports, or raw payloads.
 * A new pet implementation joins by publishing the existing HTTP contract;
 * this seam never changes for it.
 * @module dsh-agentic-pet/service
 */
import { Context, Service } from '@deepseek-ai/cordis';
import { type PetCapabilities } from './actions.ts';
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
 * implementations differ (electron adds bubble/lastAction/lastActionAt,
 * pure adds interaction) and the raw payload must never escape: consumers
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
    readonly lastAction?: string | null | undefined;
    readonly lastActionAt?: number | null | undefined;
    readonly lastActionDone?: {
        readonly action: string;
        readonly durationMs: number | null;
        readonly at: number;
        readonly requestedBy?: 'tool' | 'user' | undefined;
        readonly requestId?: string | undefined;
    } | null | undefined;
    readonly window?: {
        readonly x: number;
        readonly y: number;
        readonly width: number;
        readonly height: number;
    } | undefined;
    readonly pid?: number | undefined;
}
/**
 * Abstract pet capability seam. Subclass, implement the abstract methods,
 * and load the subclass as a plugin — it registers as `ctx.petService`
 * (one implementation per context; loading a second throws, which is
 * cordis' standard duplicate-service behavior).
 *
 * Implementations must honor these semantics:
 * - {@link list} returns only pets whose control plane ANSWERS: a dead pid
 *   and a frozen publisher (listening socket, silent HTTP) are both skipped.
 * - {@link route} resolves the STATE carrier for a session: the named bound
 *   pet when alive, else the default pet (the first live entry — de facto
 *   "first started"). Interaction BROADCAST is not a route; see
 *   `notifyPets` in the registry module for the all-notify view.
 * - {@link snapshot} never throws on an unreachable pet — it resolves with
 *   `online: false`. Field-matrix differences stay here.
 * - {@link call} retries once through a fresh discovery pass, so a pet
 *   swap/restart between the caller's list() and the call does not fail a
 *   one-shot action outright.
 */
export declare abstract class PetService extends Service {
    constructor(ctx: Context);
    /** Every live pet (registry entries plus legacy manifests folded under
     * their pet ids). */
    abstract list(): Promise<PetEntry[]>;
    /** The STATE carrier: the bound pet when alive, else the default pet. */
    abstract route(boundPetId?: string): Promise<PetEntry | undefined>;
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
}
/** Defensive field extraction: implementations may omit or mistype anything. */
export declare function normalizeStatus(id: string, raw: Record<string, unknown>, online: boolean): PetSnapshot;
/**
 * HTTP control-plane provider: talks to pet processes over the frozen wire
 * contract, folding legacy single-file manifests into the registry. A new
 * pet implementation is adopted by publishing the same contract — this
 * class does not change for it.
 */
export declare class PetHttpService extends PetService {
    readonly home: string;
    private readonly capsCache;
    private static readonly CAPS_TTL_MS;
    constructor(ctx: Context, home?: string);
    list(): Promise<PetEntry[]>;
    route(boundPetId?: string): Promise<PetEntry | undefined>;
    snapshot(entry: PetEntry): Promise<PetSnapshot>;
    capabilities(entry: PetEntry): Promise<PetCapabilities>;
    call(entry: PetEntry, path: string, init?: RequestInit): Promise<unknown>;
}
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
//# sourceMappingURL=service.d.ts.map