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
import { homedir } from 'node:os';
import { join } from 'node:path';
import { Service } from '@deepseek-ai/cordis';
import { normalizeCapabilities } from "./actions.js";
import { readAllPets, routePet } from "./registry.js";
/** The dsh home holding the pet registry, ledger, and settings files. */
export function petHome() {
    return process.env.DSH_HOME ?? join(homedir(), '.dsh');
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
export class PetService extends Service {
    constructor(ctx) {
        super(ctx, 'petService');
    }
    /**
     * The pet's advertised capabilities (`/capabilities`, e.g. its action
     * catalog) with a short TTL cache — the catalog changes only when a pet
     * restarts, and the TTL bounds how long a swapped pet's old menu shadows
     * the new one. Never throws: an unreachable pet reads as "publishes
     * nothing" (`actions: null`), which callers must treat as celebrate-only.
     */
    async capabilities(_entry) {
        return null;
    }
}
/** Defensive field extraction: implementations may omit or mistype anything. */
export function normalizeStatus(id, raw, online) {
    const str = (key) => typeof raw[key] === 'string' ? raw[key] : undefined;
    const bool = (key) => typeof raw[key] === 'boolean' ? raw[key] : undefined;
    const rawWindow = raw.window;
    const window = typeof rawWindow === 'object' && rawWindow !== null
        ? (() => {
            const w = rawWindow;
            const num = (key) => typeof w[key] === 'number' ? w[key] : undefined;
            const x = num('x');
            const y = num('y');
            const width = num('width');
            const height = num('height');
            return x !== undefined && y !== undefined && width !== undefined && height !== undefined
                ? { x, y, width, height }
                : undefined;
        })()
        : undefined;
    const rawDone = raw.lastActionDone;
    const lastActionDone = typeof rawDone === 'object' && rawDone !== null
        && typeof rawDone.action === 'string'
        && typeof rawDone.at === 'number'
        ? {
            action: rawDone.action,
            durationMs: typeof rawDone.durationMs === 'number'
                ? rawDone.durationMs
                : null,
            at: rawDone.at,
            requestedBy: rawDone.requestedBy === 'tool'
                || rawDone.requestedBy === 'user'
                ? rawDone.requestedBy
                : undefined,
            requestId: typeof rawDone.requestId === 'string'
                ? rawDone.requestId
                : undefined,
        }
        : undefined;
    return {
        id,
        online,
        state: str('state'),
        animation: str('animation'),
        visible: bool('visible'),
        interaction: bool('interaction'),
        bubble: bool('bubble'),
        lastAction: raw.lastAction === null || typeof raw.lastAction === 'string'
            ? raw.lastAction
            : undefined,
        lastActionAt: typeof raw.lastActionAt === 'number'
            ? raw.lastActionAt
            : raw.lastActionAt === null ? null : undefined,
        lastActionDone: raw.lastActionDone === null ? null : lastActionDone,
        window,
        pid: typeof raw.pid === 'number' ? raw.pid : undefined,
    };
}
/**
 * HTTP control-plane provider: talks to pet processes over the frozen wire
 * contract, folding legacy single-file manifests into the registry. A new
 * pet implementation is adopted by publishing the same contract — this
 * class does not change for it.
 */
export class PetHttpService extends PetService {
    home;
    // Capabilities TTL cache: the catalog is boot-derived per pet process, so
    // 30s bounds how long a restarted pet's old menu lingers. Failures cache
    // as "publishes nothing" — a transient offline moment degrades to
    // celebrate-only for at most one TTL, never to a thrown tool error.
    capsCache = new Map();
    static CAPS_TTL_MS = 30_000;
    constructor(ctx, home = petHome()) {
        super(ctx);
        this.home = home;
    }
    list() {
        return readAllPets(this.home);
    }
    async route(boundPetId) {
        return routePet(await this.list(), boundPetId);
    }
    async snapshot(entry) {
        try {
            const response = await fetch(`http://127.0.0.1:${String(entry.port)}/status`, {
                signal: AbortSignal.timeout(1500),
            });
            if (!response.ok)
                return { id: entry.id, online: false };
            const raw = await response.json();
            return normalizeStatus(entry.id, raw, true);
        }
        catch {
            return { id: entry.id, online: false };
        }
    }
    async capabilities(entry) {
        const hit = this.capsCache.get(entry.id);
        if (hit !== undefined && Date.now() - hit.at < PetHttpService.CAPS_TTL_MS)
            return hit.caps;
        let caps;
        try {
            const response = await fetch(`http://127.0.0.1:${String(entry.port)}/capabilities`, {
                signal: AbortSignal.timeout(1500),
            });
            if (!response.ok)
                throw new Error(`HTTP ${String(response.status)}`);
            caps = normalizeCapabilities(await response.json());
        }
        catch {
            caps = { actions: null };
        }
        this.capsCache.set(entry.id, { at: Date.now(), caps });
        return caps;
    }
    async call(entry, path, init) {
        for (let attempt = 0; attempt < 2; attempt++) {
            const current = attempt === 0
                ? entry
                : (await readAllPets(this.home)).find(pet => pet.id === entry.id);
            if (current === undefined) {
                throw new Error(`pet "${entry.id}" is no longer running`);
            }
            try {
                const response = await fetch(`http://127.0.0.1:${String(current.port)}${path}`, init);
                if (!response.ok) {
                    // The pet's own error body (e.g. the unknown-action menu from
                    // /action) is the useful half of the message — surface it instead
                    // of the bare status line.
                    const detail = await response.text().catch(() => '');
                    throw new Error(`pet control ${path} answered HTTP ${String(response.status)}${detail ? `: ${detail.slice(0, 300)}` : ''}`);
                }
                return await response.json();
            }
            catch (error) {
                if (attempt === 1)
                    throw error;
                // stale entry (pet swapped/restarted mid-call): retry once fresh
            }
        }
        throw new Error('unreachable');
    }
}
/**
 * A PetService-shaped instance WITHOUT the Service registration side effect.
 * The preset realm rejects any non-isolated service publication from its rows
 * ("Preset services require isolate realms") — and a same-named registration
 * would also overwrite the host row's store slot. The pet tools only consume
 * the four methods, which are stateless over the on-disk registry, so a
 * prototype instance with `home` set behaves identically to the registered one.
 */
export function createUnregisteredPetHttp(home = petHome()) {
    const instance = Object.create(PetHttpService.prototype);
    instance.home = home;
    return instance;
}
/**
 * Construct and register the HTTP provider, returning the INSTANCE for
 * in-bundle consumers. The Service constructor registers synchronously
 * ("registered immediately" — vendor/cordis), but `ctx.petService` GETTER
 * access from the same tick does not wait for queued plugin fibers — the
 * imperative consumers hold the instance instead, and future external
 * plugins can still `inject: ['petService']`.
 */
export function installPetService(ctx, home) {
    return new PetHttpService(ctx, home);
}
//# sourceMappingURL=service.js.map