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
import { mkdir, readFile, appendFile, writeFile } from 'node:fs/promises'
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

export function toolCallsFile(home: string, petId: string): string {
  return join(petDataDir(home, petId), 'toolcalls.jsonl')
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
