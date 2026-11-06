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

import { homedir } from 'node:os'
import { join } from 'node:path'
import { Context, Service } from '@deepseek-ai/cordis'
import { normalizeCapabilities, type PetCapabilities } from './actions.ts'
import { normalizeBody, type BodyDescription } from './body.ts'
import { readAllPets, type PetEntry } from './registry.ts'

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
 * implementations differ and the raw payload must never escape: consumers
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
  /** The v3 action witness as ONE object; `null` = no record yet. Legacy
   * implementations' lastAction/lastActionAt/lastActionDone triple folds in
   * here, so consumers read a single shape. */
  readonly lastAction?: PetLastAction | null | undefined
  /** v2: where the pet body is (a screen-coordinate rect). Legacy
   * implementations publish the same geometry as `window` — folded in here. */
  readonly location?: { readonly x: number; readonly y: number; readonly width: number; readonly height: number } | undefined
  /** v2: where the pet may roam, THREE states — absent (undefined) = this
   * implementation does not support it; `null` = unset (default clamping
   * applies); object = in effect. The invariant holds per implementation:
   * location always sits inside a set world. */
  readonly world?: { readonly x: number; readonly y: number; readonly width: number; readonly height: number } | null | undefined
  readonly pid?: number | undefined
}

/** The v3 action witness: accepted-on-write four fields, completion backfilled
 * in place (`endedAt`/`durationMs`); `id` matches the /action response's
 * `requestId` for tool-initiated actions (null for pet-local ones). */
export interface PetLastAction {
  readonly id: string | null
  readonly action: string
  readonly requestedBy: 'tool' | 'user' | null
  readonly startedAt: number | null
  readonly durationMs: number | null
  readonly endedAt: number | null
}

/** Completion requires BOTH the id match and the backfilled `endedAt`: the
 * acceptance record carries the same id with `endedAt: null`, so matching on
 * id alone would report "finished" the instant the action is accepted. */
export function isActionComplete(
  record: PetLastAction | null | undefined,
  requestId: string,
): record is PetLastAction & { endedAt: number } {
  return record != null && record.id === requestId && record.endedAt !== null
}

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
export abstract class PetService extends Service {
  constructor(ctx: Context) {
    super(ctx, 'petService')
  }

  /** Every live pet in boot order (earliest `since` first — the default-pet
   * rule is a discovery guarantee, not a listing accident). */
  abstract list(): Promise<PetEntry[]>

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

  /** The body/1 self-description (`/body`); null = legacy, absent or invalid. */
  async body(_entry: PetEntry): Promise<BodyDescription | null> {
    return null
  }
}

/** Defensive field extraction: implementations may omit or mistype anything. */
export function normalizeStatus(id: string, raw: Record<string, unknown>, online: boolean): PetSnapshot {
  const str = (key: string): string | undefined =>
    typeof raw[key] === 'string' ? raw[key] as string : undefined
  const bool = (key: string): boolean | undefined =>
    typeof raw[key] === 'boolean' ? raw[key] as boolean : undefined
  const rectOf = (value: unknown): { x: number; y: number; width: number; height: number } | undefined => {
    if (typeof value !== 'object' || value === null) return undefined
    const record = value as Record<string, unknown>
    const num = (key: string): number | undefined =>
      typeof record[key] === 'number' && Number.isFinite(record[key]) ? record[key] as number : undefined
    const x = num('x')
    const y = num('y')
    const width = num('width')
    const height = num('height')
    return x !== undefined && y !== undefined && width !== undefined && height !== undefined
      ? { x, y, width, height }
      : undefined
  }
  // v2: `location` is the pet-body rect. Legacy implementations publish the
  // same geometry as `window` — folded in, so consumers read one field.
  const location = rectOf(raw.location) ?? rectOf(raw.window)
  // v2 three-state world: the KEY's absence means "unsupported" (a distinct
  // value from an explicit null = "unset, defaults apply").
  const world = !('world' in raw) ? undefined : (rectOf(raw.world) ?? null)
  return {
    id,
    online,
    state: str('state'),
    animation: str('animation'),
    visible: bool('visible'),
    interaction: bool('interaction'),
    bubble: bool('bubble'),
    lastAction: normalizeLastAction(raw),
    location,
    world,
    pid: typeof raw.pid === 'number' ? raw.pid : undefined,
  }
}

/**
 * The v3 action witness from either wire shape: the single object
 * (`lastAction` with an id/action/startedAt/... face) reads directly; the
 * legacy triple (lastAction/lastActionAt/lastActionDone) maps onto it —
 * id = the legacy requestId, startedAt = the legacy acceptance timestamp,
 * endedAt = the legacy done timestamp. The old `at`'s two meanings
 * (electron = completion, pure = acceptance) die here: consumers see one
 * shape where acceptance and completion are separate fields. No record
 * anywhere normalizes to `null` — the constant-output rule.
 */
function normalizeLastAction(raw: Record<string, unknown>): PetLastAction | null {
  const single = raw.lastAction
  if (typeof single === 'object' && single !== null) {
    const record = single as Record<string, unknown>
    if (typeof record.action !== 'string') return null
    return {
      id: typeof record.id === 'string' ? record.id : null,
      action: record.action,
      requestedBy: record.requestedBy === 'tool' || record.requestedBy === 'user'
        ? record.requestedBy
        : null,
      startedAt: typeof record.startedAt === 'number' ? record.startedAt : null,
      durationMs: typeof record.durationMs === 'number' ? record.durationMs : null,
      endedAt: typeof record.endedAt === 'number' ? record.endedAt : null,
    }
  }
  const done = raw.lastActionDone
  if (typeof done === 'object' && done !== null && typeof (done as Record<string, unknown>).action === 'string') {
    const record = done as Record<string, unknown>
    const at = typeof record.at === 'number' ? record.at : null
    return {
      id: typeof record.requestId === 'string' ? record.requestId : null,
      action: record.action as string,
      requestedBy: record.requestedBy === 'tool' || record.requestedBy === 'user'
        ? record.requestedBy
        : null,
      startedAt: typeof raw.lastActionAt === 'number' ? raw.lastActionAt : at,
      durationMs: typeof record.durationMs === 'number' ? record.durationMs : null,
      endedAt: at,
    }
  }
  return null
}

/**
 * HTTP control-plane provider: talks to pet processes over the frozen wire
 * contract, discovering pets through the whale598/pet-http.d/ registry. A new
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
  // body/1 is also boot-derived; null caches a missing/invalid document so a
  // legacy pet is not re-probed on every pet_state {body:true}. Optional and
  // lazily created because a hot-reloaded instance can predate this field.
  private bodyCache: Map<string, { at: number; body: BodyDescription | null }> | undefined
  private static readonly BODY_TTL_MS = 30_000
  // Liveness cache (single-flight): EVERY consumer — state pushes, the 5s
  // event supervisor, per-pet event loops, voice gates, wake sweep, tool
  // targeting — shares one probe pass per TTL window. Probing is discovery's
  // cost (loopback-fast for live pets, up to ~800ms for a frozen publisher),
  // so the cache caps the whole system at one pass per second while keeping
  // liveness freshness within a window no consumer can sense (long-poll arms
  // tolerate 30s-scale staleness). The {at, flight} pair is both the TTL and
  // the in-flight dedup: concurrent callers join the running pass.
  private listCache: { at: number; flight: Promise<PetEntry[]> } | undefined
  private static readonly LIST_TTL_MS = 1_000

  constructor(ctx: Context, readonly home: string = petHome()) {
    super(ctx)
  }

  /** Every live pet in boot order, served from the 1s single-flight cache:
   * concurrent callers share the running probe pass. */
  list(): Promise<PetEntry[]> {
    const hit = this.listCache
    if (hit !== undefined && Date.now() - hit.at < PetHttpService.LIST_TTL_MS) return hit.flight
    const flight = readAllPets(this.home)
    this.listCache = { at: Date.now(), flight }
    return flight
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
      caps = {
        contractVersion: null,
        actions: null,
        actionCatalog: null,
        actionTagVocabulary: [],
        tagged: false,
      }
    }
    this.capsCache.set(entry.id, { at: Date.now(), caps })
    return caps
  }

  override async body(entry: PetEntry): Promise<BodyDescription | null> {
    const cache = this.bodyCache ?? (this.bodyCache = new Map())
    const hit = cache.get(entry.id)
    if (hit !== undefined && Date.now() - hit.at < PetHttpService.BODY_TTL_MS) return hit.body
    let body: BodyDescription | null = null
    try {
      const response = await fetch(`http://127.0.0.1:${String(entry.port)}/body`, {
        signal: AbortSignal.timeout(1500),
      })
      if (response.ok) {
        const normalized = normalizeBody(await response.json())
        if (normalized.kind === 'body') body = normalized.body
      }
    } catch {
      // Missing /body is the legacy path, not an error.
    }
    cache.set(entry.id, { at: Date.now(), body })
    return body
  }

  async call(entry: PetEntry, path: string, init?: RequestInit): Promise<unknown> {
    const { timeoutMs, retry } = callBudget(path)
    const attempts = retry ? 2 : 1
    const callerSignal = init?.signal ?? undefined
    for (let attempt = 0; attempt < attempts; attempt++) {
      const current = attempt === 0
        ? entry
        : (await readAllPets(this.home)).find(pet => pet.id === entry.id)
      if (current === undefined) {
        throw new Error(`pet "${entry.id}" is no longer running`)
      }
      let response: Response
      try {
        // Every call carries its own deadline: an unbounded fetch inherits
        // undici's multi-minute default and a dead pet holds the turn for
        // minutes. The caller's own signal (whole-request cancellation)
        // stays honored alongside it.
        const timeout = AbortSignal.timeout(timeoutMs)
        const signal = callerSignal !== undefined ? AbortSignal.any([callerSignal, timeout]) : timeout
        response = await fetch(`http://127.0.0.1:${String(current.port)}${path}`, { ...init, signal })
      } catch (error: unknown) {
        // TRANSPORT failure only — refused, timed out, aborted mid-flight: the
        // pet never answered, so a fresh-discovery retry can legitimately find
        // a swapped pet. The caller's own abort is final: retrying would just
        // reject again on an already-aborted signal.
        if (attempt === attempts - 1 || callerSignal?.aborted === true) throw error
        continue
      }
      // The pet ANSWERED — its status is the verdict, and a retry here would
      // double the side effect (a 4xx says no, a 5xx says error; neither is
      // "stale entry"). Surface the pet's own error body (e.g. the
      // unknown-action menu from /action): the useful half of the message.
      if (!response.ok) {
        const detail = await response.text().catch(() => '')
        throw new Error(`pet control ${path} answered HTTP ${String(response.status)}${detail ? `: ${detail.slice(0, 300)}` : ''}`)
      }
      // A 200 with an unparseable body is equally final — the pet spoke, the
      // wire is what it is (no retry can improve it).
      return await response.json()
    }
    throw new Error('unreachable')
  }
}

/**
 * Per-endpoint call budgets (§6 v4). One-shot endpoints fail fast — five
 * seconds covers loopback many times over. The long-poll endpoints hang BY
 * DESIGN, so their budget must exceed the server's hold clamp (≤30s) or
 * every hold-to-the-dot answer would surface as a timeout; and they never
 * retry — a retried /interaction would raise a second bubble for one ask.
 */
export function callBudget(path: string): { timeoutMs: number; retry: boolean } {
  if (path === '/interaction' || path.startsWith('/interaction?')) return { timeoutMs: 45_000, retry: false }
  if (path === '/events' || path.startsWith('/events?')) {
    let hold = '0'
    try { hold = new URL(path, 'http://127.0.0.1').searchParams.get('hold') ?? '0' } catch { /* malformed path: the short budget applies */ }
    const holdSeconds = Number(hold)
    if (Number.isFinite(holdSeconds) && holdSeconds > 0) return { timeoutMs: 45_000, retry: false }
  }
  return { timeoutMs: 5_000, retry: true }
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
  ;(instance as unknown as { listCache: { at: number; flight: Promise<PetEntry[]> } | undefined }).listCache = undefined
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
