/**
 * The per-pet data store: everything the DRIVER persists about a pet lives
 * under `~/.dsh/whale598/<petId>/` — affection ledger, display name, event
 * history, tool-call history. One directory per pet, small files, single
 * writer (the driver), JSONL for append-only streams with bounded retention.
 *
 * Legacy layouts (`pet-affection.d/<id>.json`, the single legacy electron
 * book, names inside pet-settings.json) are READ as fallbacks and migrate to
 * the new layout on the next write — lazy migration, no data-loss window.
 * @module dsh-agentic-pet/petdata
 */

import { rm } from 'node:fs/promises'
import { mkdir, readFile, appendFile, readdir, writeFile, rename } from 'node:fs/promises'
import { existsSync } from 'node:fs'
import { dirname, join } from 'node:path'

/** The consolidated per-pet data root under the dsh home. */
export const WHALE_DIR = 'whale598'

export function petDataDir(home: string, petId: string): string {
  return join(home, WHALE_DIR, petId)
}

// ── affection ledger ────────────────────────────────────────────────────────

/** New-layout path first; legacy layouts as read fallbacks (per-pet legacy
 * dir → the single legacy electron book). The ledger SHAPE is the driver's
 * (TouchLedger); this module only owns paths and raw IO. */
export function affectionPaths(home: string, petId: string): { current: string; legacy: string[] } {
  return {
    current: join(petDataDir(home, petId), 'pet-affection.json'),
    legacy: [
      join(home, 'pet-affection.d', `${petId}.json`),
      ...(petId === 'electron' ? [join(home, 'pet-affection.json')] : []),
    ],
  }
}

/** Read the affection ledger raw: the current file wins; legacy files answer
 * only while the current one is absent (first write migrates the full
 * ledger). Returns null when no layout holds data. */
export async function readAffectionRaw(home: string, petId: string): Promise<Record<string, unknown> | null> {
  const { current, legacy } = affectionPaths(home, petId)
  for (const file of [current, ...legacy]) {
    try {
      const parsed = JSON.parse(await readFile(file, 'utf8')) as Record<string, unknown>
      if (parsed !== null && typeof parsed === 'object' && Object.keys(parsed).length > 0) return parsed
    } catch { /* try the next layout */ }
  }
  return null
}

export async function writeAffectionRaw(home: string, petId: string, ledger: Record<string, unknown>): Promise<void> {
  const dir = petDataDir(home, petId)
  await mkdir(dir, { recursive: true })
  await writeFile(join(dir, 'pet-affection.json'), `${JSON.stringify(ledger)}\n`, 'utf8')
}

// ── display name ────────────────────────────────────────────────────────────

export function petNameFile(home: string, petId: string): string {
  return join(petDataDir(home, petId), 'pet-name.json')
}

/** The user's custom display name: new-layout file → legacy
 * pet-settings.json `names` map → undefined (caller applies the built-in
 * default). */
export async function readPetName(home: string, petId: string): Promise<string | undefined> {
  try {
    const parsed = JSON.parse(await readFile(petNameFile(home, petId), 'utf8')) as { name?: unknown }
    if (typeof parsed.name === 'string' && parsed.name.trim() !== '') return parsed.name.trim()
  } catch { /* fall through to legacy */ }
  try {
    const settings = JSON.parse(await readFile(join(home, 'pet-settings.json'), 'utf8')) as { names?: unknown }
    const names = typeof settings.names === 'object' && settings.names !== null
      ? settings.names as Record<string, unknown>
      : {}
    const label = names[petId]
    if (typeof label === 'string' && label.trim() !== '') return label.trim()
  } catch { /* no legacy names */ }
  return undefined
}

/** Persist a custom name; `null` reverts to the built-in default (drops the
 * override file). Also strips the petId key from the legacy pet-settings
 * names map so the old layout cannot resurrect a cleared name. */
export async function writePetName(home: string, petId: string, name: string | null): Promise<void> {
  const dir = petDataDir(home, petId)
  await mkdir(dir, { recursive: true })
  const file = petNameFile(home, petId)
  if (name === null || name.trim() === '') {
    await rm(file, { force: true })
  } else {
    await writeFile(file, `${JSON.stringify({ name: name.trim() })}\n`, 'utf8')
  }
  try {
    const settingsPath = join(home, 'pet-settings.json')
    const settings = JSON.parse(await readFile(settingsPath, 'utf8')) as { names?: Record<string, unknown> } & Record<string, unknown>
    if (typeof settings.names === 'object' && settings.names !== null && petId in settings.names) {
      Reflect.deleteProperty(settings.names, petId)
      if (Object.keys(settings.names).length === 0) delete settings.names
      await writeFile(settingsPath, `${JSON.stringify(settings, null, 2)}\n`, 'utf8')
    }
  } catch { /* legacy hygiene is best-effort */ }
}

// ── JSONL streams (events / tool calls) ─────────────────────────────────────

const JSONL_MAX_LINES = 600
const JSONL_KEEP_LINES = 500

export function eventsFile(home: string, petId: string): string {
  return join(petDataDir(home, petId), 'events.jsonl')
}

/** Append one record; bounded retention trims the file when it outgrows the
 * cap (best-effort — a failed trim never loses the append). */
export async function appendJsonl(file: string, entry: Record<string, unknown>): Promise<void> {
  await mkdir(dirname(file), { recursive: true })
  await appendFile(file, `${JSON.stringify(entry)}\n`, 'utf8')
  try {
    const raw = await readFile(file, 'utf8')
    const lines = raw.split('\n').filter(line => line.trim() !== '')
    if (lines.length > JSONL_MAX_LINES) {
      await writeFile(file, `${lines.slice(lines.length - JSONL_KEEP_LINES).join('\n')}\n`, 'utf8')
    }
  } catch { /* retention is best-effort */ }
}

/** The last `limit` records (oldest last); malformed lines degrade to
 * `{raw}` instead of dropping the file. */
export async function readJsonl(file: string, limit: number): Promise<Array<Record<string, unknown>>> {
  try {
    const raw = await readFile(file, 'utf8')
    const lines = raw.split('\n').filter(line => line.trim() !== '')
    return lines.slice(-limit).map((line) => {
      try { return JSON.parse(line) as Record<string, unknown> } catch { return { raw: line } }
    })
  } catch {
    return []
  }
}


// ── global (cross-pet) state files ─────────────────────────────────────────
// Consolidated under whale598/ (collision avoidance, same as the registry and
// route). Reads try BOTH locations (current → legacy root), writes go to the
// current only, and migrateGlobals renames legacy → current once at driver
// install. pet-settings.json is SHARED with the carrier — both sides read
// current-first, so the move is safe when they ship in lockstep (same npm
// package); a mixed-version deployment degrades to the legacy copy.

export const GLOBAL_STATE_FILES = [
  'pet-settings.json',
  'pet-inner-voice.json',
  'pet-wake-plans.json',
  'pet-messages.json',
  'pet-interactions.json',
  'pet-binding-status.json',
  'pet-wake-state.json',
  'pet-world.json',
  'pet-window.json',
]

export function globalPaths(home: string, name: string): { current: string; legacy: string } {
  return { current: join(home, WHALE_DIR, name), legacy: join(home, name) }
}

export function globalFilePath(home: string, name: string): string {
  return globalPaths(home, name).current
}

/** Rename legacy → current for every global file that hasn't moved yet.
 * Best-effort: a failed rename leaves the legacy copy in place and the read
 * fallback still answers. Called once at driver install. */
export async function migrateGlobals(home: string): Promise<void> {
  await mkdir(join(home, WHALE_DIR), { recursive: true })
  for (const name of GLOBAL_STATE_FILES) {
    const { current, legacy } = globalPaths(home, name)
    try {
      if (existsSync(current) || !existsSync(legacy)) continue
      await rename(legacy, current)
    } catch { /* best effort */ }
  }
}

/** Read a global state file: current → legacy → {} (callers' defensive
 * field checks treat {} exactly like a missing file). */
export async function readGlobalJson(home: string, name: string): Promise<Record<string, unknown>> {
  const { current, legacy } = globalPaths(home, name)
  for (const file of [current, legacy]) {
    try {
      const parsed = JSON.parse(await readFile(file, 'utf8')) as Record<string, unknown>
      if (parsed && typeof parsed === 'object') return parsed
    } catch { /* try the next location */ }
  }
  return {}
}

/** Write a global state file (current location only; pretty-printed — these
 * files are user-inspectable and hand-editable). */
export async function writeGlobalJson(home: string, name: string, obj: Record<string, unknown>): Promise<void> {
  const { current } = globalPaths(home, name)
  await mkdir(dirname(current), { recursive: true })
  await writeFile(current, `${JSON.stringify(obj, null, 2)}\n`, 'utf8')
}

// ── per-pet state files (the petId-scoped siblings of the globals) ──────────
// Ownership rule (AGENTS.md §8「whale598 文件归属规则」): a pet's OWN state
// lives in whale598/<petId>/; the whale598 root keeps plugin-level,
// host-level, and cross-pet comparative state only. Reads fall back
// current → whale598 root → ~/.dsh root (two migration layers), writes go
// to the pet file only.

export function petStatePaths(home: string, petId: string, name: string): { current: string; legacy: string[] } {
  return {
    current: join(petDataDir(home, petId), name),
    legacy: [join(home, WHALE_DIR, name), join(home, name)],
  }
}

/** Read a per-pet state file: pet file → whale598 root → ~/.dsh root → {}
 * (callers' defensive field checks treat {} exactly like a missing file). */
export async function readPetStateJson(home: string, petId: string, name: string): Promise<Record<string, unknown>> {
  const { current, legacy } = petStatePaths(home, petId, name)
  for (const file of [current, ...legacy]) {
    try {
      const parsed = JSON.parse(await readFile(file, 'utf8')) as Record<string, unknown>
      if (parsed && typeof parsed === 'object') return parsed
    } catch { /* try the next location */ }
  }
  return {}
}

/** Write a per-pet state file (pretty-printed, same user-inspectable
 * contract as the globals). */
export async function writePetStateJson(home: string, petId: string, name: string, obj: Record<string, unknown>): Promise<void> {
  const { current } = petStatePaths(home, petId, name)
  await mkdir(dirname(current), { recursive: true })
  await writeFile(current, `${JSON.stringify(obj, null, 2)}\n`, 'utf8')
}

/** Root directories under whale598/ that are NOT pets — machine layers keyed
 * by petId (AGENTS.md §8: 机器层目录不是宠物). existingPetIds is the gate
 * every per-pet sweep walks through (presence/wake plans/inner-voice loads
 * and deletes, migrations, the settings window loop), so a machine dir
 * missing from this list becomes a phantom petId — it gets ingested into
 * knownPetIds and its "pet files" get rm'd by the save-time cleanups. A new
 * machine dir MUST be added here. */
const NON_PET_DIRS = ['pet-http.d', 'carrier-instances']

/** PetIds with a data directory on disk — the sweep basis for per-pet
 * migrations and merged loads. Registry-only pets (live, never persisted)
 * are absent; callers union their own id sources on top. */
export async function existingPetIds(home: string): Promise<string[]> {
  try {
    const entries = await readdir(join(home, WHALE_DIR), { withFileTypes: true })
    return entries.filter(entry => entry.isDirectory() && !NON_PET_DIRS.includes(entry.name)).map(entry => entry.name)
  } catch {
    return []
  }
}

/** 彻底销毁一只额外实例的全部数据（本子/好感/名字/窗口位置/绑定切片）：
 * rm -rf whale598/<petId>/。送走只是离开（数据休眠，可复活）；销毁才是抹除。
 * 守卫收紧到额外实例 id 形状——主身（electron）与 unknown 名字永远够不到
 * 这把删除，防止调用方传错参数变成任意目录删除。 */
export async function destroyPetData(home: string, petId: string): Promise<void> {
  if (!/^electron-\d+$/.test(petId)) throw new Error(`destroyPetData: "${petId}" 不是可销毁的额外实例 id（主身与未知名字不可销毁）`)
  await rm(petDataDir(home, petId), { recursive: true, force: true })
}

/** Read a root-level global that is a bare JSON array: whale598 root →
 * ~/.dsh root → [] (the interaction ledger's shape — readGlobalJson's object
 * check happens to admit arrays, but the array contract deserves its own
 * helper). */
export async function readGlobalArrayJson(home: string, name: string): Promise<unknown[]> {
  const { current, legacy } = globalPaths(home, name)
  for (const file of [current, legacy]) {
    try {
      const parsed = JSON.parse(await readFile(file, 'utf8')) as unknown
      if (Array.isArray(parsed)) return parsed
    } catch { /* try the next location */ }
  }
  return []
}

/** One-time split of a petId-keyed root file into per-pet state files: each
 * pet's slice is written (an existing pet file always wins — the split never
 * overwrites), then the root copy is renamed to `<name>.bak-migrated-<date>`
 * so the root stays clean without losing the original. Best-effort
 * throughout; `extract` returns undefined for petIds with no slice. */
export async function migrateGlobalSplits(
  home: string,
  name: string,
  extract: (global: Record<string, unknown>, petId: string) => Record<string, unknown> | undefined,
): Promise<void> {
  const global = await readGlobalJson(home, name)
  if (Object.keys(global).length === 0) return
  const mapKeys = (field: string): string[] => {
    const value = global[field]
    return typeof value === 'object' && value !== null ? Object.keys(value as Record<string, unknown>) : []
  }
  const petIds = [...new Set([
    ...(await existingPetIds(home)),
    ...mapKeys('pets'), ...mapKeys('sessions'), ...mapKeys('generations'), ...mapKeys('plans'),
  ])]
  let wrote = false
  for (const petId of petIds) {
    if (petId === '') continue
    const slice = extract(global, petId)
    if (slice === undefined) continue
    const { current } = petStatePaths(home, petId, name)
    if (existsSync(current)) continue
    await writePetStateJson(home, petId, name, slice)
    wrote = true
  }
  if (!wrote) return
  const stamp = new Date().toISOString().slice(0, 10).replaceAll('-', '')
  for (const file of [globalPaths(home, name).current, globalPaths(home, name).legacy]) {
    try {
      if (!existsSync(file)) continue
      await rename(file, join(home, WHALE_DIR, `${name}.bak-migrated-${stamp}`))
      break
    } catch { /* best effort */ }
  }
}
