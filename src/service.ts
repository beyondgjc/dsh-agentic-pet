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

import { homedir } from 'node:os'
import { join } from 'node:path'
import { Context, Service } from '@deepseek-ai/cordis'
import { normalizeCapabilities, type PetCapabilities } from './actions.ts'
import { readAllPets, routePet, type PetEntry } from './registry.ts'

declare module '@deepseek-ai/cordis' {
  interface Context {
    petService: PetService
  }
}

/** The dsh home holding the pet registry, ledger, and settings files. */
export function petHome(): string {
  return process.env.DSH_HOME ?? join(homedir(), '.dsh')
}

/**
 * Normalized /status snapshot. Fields beyond id/online are optional —
 * implementations differ (electron adds bubble/lastAction/lastActionAt,
 * pure adds interaction) and the raw payload must never escape: consumers
 * read optional fields with defaults instead of branching per pet.
 */
export interface PetSnapshot {
  readonly id: string
  readonly online: boolean
  readonly state?: string | undefined
  readonly animation?: string | undefined
  readonly visible?: boolean | undefined
  readonly interaction?: boolean | undefined
  readonly bubble?: boolean | undefined
  readonly lastAction?: string | null | undefined
  readonly lastActionAt?: number | null | undefined
  readonly lastActionDone?: {
    readonly action: string
    readonly durationMs: number | null
    readonly at: number
    readonly requestedBy?: 'tool' | 'user' | undefined
    readonly requestId?: string | undefined
  } | null | undefined
  readonly window?: { readonly x: number; readonly y: number; readonly width: number; readonly height: number } | undefined
  readonly pid?: number | undefined
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
export abstract class PetService extends Service {
  constructor(ctx: Context) {
    super(ctx, 'petService')
  }

  /** Every live pet (registry entries plus legacy manifests folded under
   * their pet ids). */
  abstract list(): Promise<PetEntry[]>

  /** The STATE carrier: the bound pet when alive, else the default pet. */
  abstract route(boundPetId?: string): Promise<PetEntry | undefined>

  /** The normalized mirror of one pet, or `online: false` when unreachable. */
  abstract snapshot(entry: PetEntry): Promise<PetSnapshot>

  /** One JSON call to a pet endpoint, with a single fresh-discovery retry. */
  abstract call(entry: PetEntry, path: string, init?: RequestInit): Promise<unknown>

  /**
   * The pet's advertised capabilities (`/capabilities`, e.g. its action
   * catalog) with a short TTL cache — the catalog changes only when a pet
   * restarts, and the TTL bounds how long a swapped pet's old menu shadows
   * the new one. Never throws: an unreachable pet reads as "publishes
   * nothing" (`actions: null`), which callers must treat as celebrate-only.
   */
  async capabilities(_entry: PetEntry): Promise<PetCapabilities | null> {
    return null
  }
}

/** Defensive field extraction: implementations may omit or mistype anything. */
export function normalizeStatus(id: string, raw: Record<string, unknown>, online: boolean): PetSnapshot {
  const str = (key: string): string | undefined =>
    typeof raw[key] === 'string' ? raw[key] as string : undefined
  const bool = (key: string): boolean | undefined =>
    typeof raw[key] === 'boolean' ? raw[key] as boolean : undefined
  const rawWindow = raw.window
  const window = typeof rawWindow === 'object' && rawWindow !== null
    ? (() => {
      const w = rawWindow as Record<string, unknown>
      const num = (key: string): number | undefined =>
        typeof w[key] === 'number' ? w[key] as number : undefined
      const x = num('x')
      const y = num('y')
      const width = num('width')
      const height = num('height')
      return x !== undefined && y !== undefined && width !== undefined && height !== undefined
        ? { x, y, width, height }
        : undefined
    })()
    : undefined
  const rawDone = raw.lastActionDone
  const lastActionDone = typeof rawDone === 'object' && rawDone !== null
    && typeof (rawDone as Record<string, unknown>).action === 'string'
    && typeof (rawDone as Record<string, unknown>).at === 'number'
    ? {
      action: (rawDone as Record<string, unknown>).action as string,
      durationMs: typeof (rawDone as Record<string, unknown>).durationMs === 'number'
        ? (rawDone as Record<string, unknown>).durationMs as number
        : null,
      at: (rawDone as Record<string, unknown>).at as number,
      requestedBy: (rawDone as Record<string, unknown>).requestedBy === 'tool'
        || (rawDone as Record<string, unknown>).requestedBy === 'user'
        ? (rawDone as Record<string, unknown>).requestedBy as 'tool' | 'user'
        : undefined,
      requestId: typeof (rawDone as Record<string, unknown>).requestId === 'string'
        ? (rawDone as Record<string, unknown>).requestId as string
        : undefined,
    }
    : undefined
  return {
    id,
    online,
    state: str('state'),
    animation: str('animation'),
    visible: bool('visible'),
    interaction: bool('interaction'),
    bubble: bool('bubble'),
    lastAction: raw.lastAction === null || typeof raw.lastAction === 'string'
      ? raw.lastAction as string | null
      : undefined,
    lastActionAt: typeof raw.lastActionAt === 'number'
      ? raw.lastActionAt
      : raw.lastActionAt === null ? null : undefined,
    lastActionDone: raw.lastActionDone === null ? null : lastActionDone,
    window,
    pid: typeof raw.pid === 'number' ? raw.pid : undefined,
  }
}

/**
 * HTTP control-plane provider: talks to pet processes over the frozen wire
 * contract, folding legacy single-file manifests into the registry. A new
 * pet implementation is adopted by publishing the same contract — this
 * class does not change for it.
 */
export class PetHttpService extends PetService {
  // Capabilities TTL cache: the catalog is boot-derived per pet process, so
  // 30s bounds how long a restarted pet's old menu lingers. Failures cache
  // as "publishes nothing" — a transient offline moment degrades to
  // celebrate-only for at most one TTL, never to a thrown tool error.
  private readonly capsCache = new Map<string, { at: number; caps: PetCapabilities }>()
  private static readonly CAPS_TTL_MS = 30_000

  constructor(ctx: Context, readonly home: string = petHome()) {
    super(ctx)
  }

  list(): Promise<PetEntry[]> {
    return readAllPets(this.home)
  }

  async route(boundPetId?: string): Promise<PetEntry | undefined> {
    return routePet(await this.list(), boundPetId)
  }

  async snapshot(entry: PetEntry): Promise<PetSnapshot> {
    try {
      const response = await fetch(`http://127.0.0.1:${String(entry.port)}/status`, {
        signal: AbortSignal.timeout(1500),
      })
      if (!response.ok) return { id: entry.id, online: false }
      const raw = await response.json() as Record<string, unknown>
      return normalizeStatus(entry.id, raw, true)
    } catch {
      return { id: entry.id, online: false }
    }
  }

  override async capabilities(entry: PetEntry): Promise<PetCapabilities> {
    const hit = this.capsCache.get(entry.id)
    if (hit !== undefined && Date.now() - hit.at < PetHttpService.CAPS_TTL_MS) return hit.caps
    let caps: PetCapabilities
    try {
      const response = await fetch(`http://127.0.0.1:${String(entry.port)}/capabilities`, {
        signal: AbortSignal.timeout(1500),
      })
      if (!response.ok) throw new Error(`HTTP ${String(response.status)}`)
      caps = normalizeCapabilities(await response.json())
    } catch {
      caps = { actions: null }
    }
    this.capsCache.set(entry.id, { at: Date.now(), caps })
    return caps
  }

  async call(entry: PetEntry, path: string, init?: RequestInit): Promise<unknown> {
    for (let attempt = 0; attempt < 2; attempt++) {
      const current = attempt === 0
        ? entry
        : (await readAllPets(this.home)).find(pet => pet.id === entry.id)
      if (current === undefined) {
        throw new Error(`pet "${entry.id}" is no longer running`)
      }
      try {
        const response = await fetch(`http://127.0.0.1:${String(current.port)}${path}`, init)
        if (!response.ok) {
          // The pet's own error body (e.g. the unknown-action menu from
          // /action) is the useful half of the message — surface it instead
          // of the bare status line.
          const detail = await response.text().catch(() => '')
          throw new Error(`pet control ${path} answered HTTP ${String(response.status)}${detail ? `: ${detail.slice(0, 300)}` : ''}`)
        }
        return await response.json()
      } catch (error: unknown) {
        if (attempt === 1) throw error
        // stale entry (pet swapped/restarted mid-call): retry once fresh
      }
    }
    throw new Error('unreachable')
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
export function createUnregisteredPetHttp(home: string = petHome()): PetService {
  const instance = Object.create(PetHttpService.prototype) as PetHttpService
  ;(instance as { home: string }).home = home
  // Object.create skips the constructor, so CLASS FIELDS never initialize:
  // `capsCache` is one, and `capabilities()` dereferenced it as undefined
  // (Cannot read properties of undefined (reading 'get')) — only the
  // capability callers (pet_do, pet_state {actions:true}) blew up. Every new
  // instance field on PetHttpService must be initialized HERE too.
  ;(instance as unknown as { capsCache: Map<string, { at: number; caps: PetCapabilities }> }).capsCache = new Map()
  return instance
}

/**
 * Construct and register the HTTP provider, returning the INSTANCE for
 * in-bundle consumers. The Service constructor registers synchronously
 * ("registered immediately" — vendor/cordis), but `ctx.petService` GETTER
 * access from the same tick does not wait for queued plugin fibers — the
 * imperative consumers hold the instance instead, and future external
 * plugins can still `inject: ['petService']`.
 */
export function installPetService(ctx: Context, home: string): PetHttpService {
  return new PetHttpService(ctx, home)
}
