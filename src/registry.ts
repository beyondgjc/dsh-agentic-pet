/**
 * The pet registry: a directory of per-pet control manifests. Each pet
 * implementation owns its own file under whale598/pet-http.d/ (named by its
 * pet id) and re-asserts it on a cadence; entries whose publisher pid is dead
 * expire by omission. The driver reads the whole table and routes per the
 * multi-pet design: a session's state rides its bound pet when that pet is
 * alive and broadcasts to every live pet otherwise; interactions broadcast to
 * all; the default pet (earliest-booted) resolves unnamed expression targets.
 * @module dsh-agentic-pet/registry
 */

import { readFile, readdir } from 'node:fs/promises'
import { join } from 'node:path'
import { WHALE_DIR } from './petdata.ts'

/** One pet's published control facts. */
export interface PetEntry {
  /** Stable pet id — also the registry file stem (e.g. 'electron', 'pure'). */
  readonly id: string
  readonly port: number
  readonly pid: number
  /** When this exact publisher booted; a stale file from a previous
   * generation of the same pet is superseded by pid identity. */
  readonly since: number
}

// Registry directory: namespaced under whale598/ to avoid collisions with
// other plugins (same reasoning as the /whale598 route prefix). This is the
// SINGLE discovery source — the pre-registry single-file manifests and the
// legacy root pet-http.d/ are retired: every current implementation
// re-asserts the namespaced registry.
const REGISTRY_DIR = `${WHALE_DIR}/pet-http.d`

/**
 * A live pet is one whose control plane ANSWERS, not merely one whose pid
 * exists — and not merely one whose port accepts TCP: a frozen pet (stuck
 * Qt/Electron event loop) keeps its listening socket open in the kernel, so
 * TCP connect succeeds while HTTP never responds. Two layers, each with its
 * own budget: a 200ms TCP pre-check fails fast on unreachable ports (a
 * firewall dropping SYN would otherwise eat the whole HTTP budget), then the
 * HTTP probe catches the frozen-but-listening zombies.
 */
export async function probeControlPlane(port: number): Promise<boolean> {
  const { createConnection } = await import('node:net')
  const tcpAlive = await new Promise<boolean>((resolve) => {
    const socket = createConnection({ host: '127.0.0.1', port })
    const done = (ok: boolean): void => {
      socket.destroy()
      resolve(ok)
    }
    socket.setTimeout(200, () => done(false))
    socket.once('connect', () => done(true))
    socket.once('error', () => done(false))
  })
  if (!tcpAlive) return false
  try {
    const response = await fetch(`http://127.0.0.1:${String(port)}/status`, {
      signal: AbortSignal.timeout(800),
    })
    return response.ok
  } catch {
    return false
  }
}

/**
 * The default-pet order: earliest booted first (`since` ascending). A missing
 * or mistyped `since` (0) reads as "unknown boot time" and sorts LAST — it
 * must never outrank a publisher that stated its boot time. This turns the
 * multi-pet design's de-facto rule ("the default pet is the first STARTED")
 * into an actual guarantee: discovery output IS boot order, so every
 * `pets[0]` consumer (defaultPet, pet_state's defaultPet) reads the
 * same pet. Stable sort: equal `since` values keep registry listing order.
 */
export function bootOrder(pets: PetEntry[]): PetEntry[] {
  return [...pets].sort(
    (a, b) =>
      (a.since > 0 ? a.since : Number.POSITIVE_INFINITY) -
      (b.since > 0 ? b.since : Number.POSITIVE_INFINITY),
  )
}

/** Every live pet in boot order. Dead-pid entries are skipped — they expire
 * by omission the next time their file is rewritten — and so are silent
 * entries (pid alive, control plane unresponsive). */
export async function readAllPets(home: string): Promise<PetEntry[]> {
  let names: string[] = []
  try {
    names = (await readdir(join(home, REGISTRY_DIR))).filter(name => name.endsWith('.json'))
  } catch {
    return [] // directory absent: no pets have ever registered
  }
  const live: PetEntry[] = []
  for (const name of names) {
    const id = name.slice(0, -5)
    if (id === '') continue
    try {
      const raw = JSON.parse(await readFile(join(home, REGISTRY_DIR, name), 'utf8')) as {
        port?: unknown
        pid?: unknown
        since?: unknown
      }
      const port = typeof raw.port === 'number' ? raw.port : Number.NaN
      const pid = typeof raw.pid === 'number' ? raw.pid : Number.NaN
      if (!Number.isFinite(port) || !Number.isFinite(pid)) continue
      try {
        process.kill(pid, 0)
      } catch {
        continue // dead publisher: not a live pet
      }
      if (!await probeControlPlane(port)) continue // frozen publisher
      live.push({
        id,
        port,
        pid,
        since: typeof raw.since === 'number' ? raw.since : 0,
      })
    } catch {
      // unreadable file: skip, its owner will rewrite it
    }
  }
  return bootOrder(live)
}

/**
 * The default pet for UNNAMED targets: the earliest-booted live entry
 * (`pets[0]` — discovery's bootOrder guarantees start order, not listing
 * accident). State routing does NOT go through here anymore: an unbound
 * (or bound-but-offline) session broadcasts its state to every live pet —
 * the driver computes that audience itself. Used by the tools'
 * resolveTarget when neither a named pet nor the owning session resolves.
 * @returns the entry, or undefined when no pet is alive.
 */
export function defaultPet(pets: PetEntry[]): PetEntry | undefined {
  return pets[0]
}

/** The pets that receive an INTERACTION (all-notify mode): every live pet,
 * the session-bound one included. The binding routes STATE — it must never
 * mute interactions: excluding the bound pet would silence the only body
 * whose bubble the user just proved they answer through, and a single-pet
 * deployment would fall back to the web card alone for the rest of the
 * session. */
export function notifyPets(pets: PetEntry[]): PetEntry[] {
  return [...pets]
}
