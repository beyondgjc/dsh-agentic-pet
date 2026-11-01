/**
 * The pet registry: a directory of per-pet control manifests, replacing the
 * last-writer-wins single files whose races caused repeated swap incidents
 * (a dying carrier's late write burying a live pet's registration). Each pet
 * implementation owns its own file under whale598/pet-http.d/ (legacy
 * pet-http.d/ still scanned) and re-asserts it on a
 * cadence; entries whose publisher pid is dead expire by omission. The
 * driver reads the whole table and routes per the multi-pet design: the
 * session's bound pet if alive, else the default pet (first alive entry),
 * plus an all-notify broadcast mode for interactions.
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
// other plugins (same reasoning as the /whale598 route prefix). The LEGACY
// directory is still SCANNED as a read fallback — pets running older
// code publish there, and discovery must not drop them.
const REGISTRY_DIR = `${WHALE_DIR}/pet-http.d`
const LEGACY_REGISTRY_DIR = 'pet-http.d'

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

/** Read every live entry in the registry. Dead-pid entries are skipped —
 * they expire by omission the next time their file is rewritten — and so are
 * silent entries (pid alive, control plane unresponsive). */
export async function readLivePets(home: string): Promise<PetEntry[]> {
  // Candidate collection over BOTH directories — the new namespace wins on
  // id collision (an old-dir entry from a previous layout must not shadow a
  // live new-dir entry). Probing happens once per id, after dedup.
  const candidates = new Map<string, string>()
  for (const dir of [join(home, REGISTRY_DIR), join(home, LEGACY_REGISTRY_DIR)]) {
    let names: string[] = []
    try {
      names = (await readdir(dir)).filter(name => name.endsWith('.json'))
    } catch {
      continue // directory absent: zero candidates from it
    }
    for (const name of names) {
      const id = name.slice(0, -5)
      if (id !== '' && !candidates.has(id)) candidates.set(id, join(dir, name))
    }
  }
  const live: PetEntry[] = []
  for (const [id, file] of candidates) {
    try {
      const raw = JSON.parse(await readFile(file, 'utf8')) as {
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
  return live
}

/** Legacy single-file manifests folded into the registry: the electron
 * carrier's dedicated file and the pure pet's shared file, identity-validated
 * and probe-validated, so pre-registry publishers stay drivable. */
const LEGACY_SOURCES: Array<{ id: string; file: string; identity: string }> = [
  { id: 'electron', file: 'pet-http-electron.json', identity: 'electron' },
  { id: 'pure', file: 'pet-http.json', identity: 'python' },
]

/** Every live pet: registry entries plus legacy single-file manifests folded
 * under their pet ids (registry entries win on id collision). */
export async function readAllPets(home: string): Promise<PetEntry[]> {
  const pets = await readLivePets(home)
  for (const { id, file, identity } of LEGACY_SOURCES) {
    if (pets.some(pet => pet.id === id)) continue
    try {
      const manifest = JSON.parse(await readFile(join(home, file), 'utf8')) as {
        port?: unknown
        pid?: unknown
        pet?: unknown
      }
      if (manifest.pet !== identity) continue
      if (typeof manifest.port !== 'number' || typeof manifest.pid !== 'number') continue
      try {
        process.kill(manifest.pid, 0)
      } catch {
        continue
      }
      if (!await probeControlPlane(manifest.port)) continue
      pets.push({ id, port: manifest.port, pid: manifest.pid, since: 0 })
    } catch {
      // absent/unreadable: that pet simply is not running
    }
  }
  return pets
}

/**
 * Resolve the pet that should carry STATE for the given session, per the
 * multi-pet design: the session's bound pet when alive, else the default pet
 * (the first live entry — de facto "first started"). Single-pet deployments
 * degenerate correctly: one live entry is both bound and default.
 * @returns the entry, or undefined when no pet is alive.
 */
export function routePet(pets: PetEntry[], boundPetId: string | undefined): PetEntry | undefined {
  if (boundPetId !== undefined) {
    const bound = pets.find(pet => pet.id === boundPetId)
    if (bound !== undefined) return bound
  }
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
