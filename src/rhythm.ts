/**
 * Quiet-hours parsing and evaluation. Scope is deliberately minimal: quiet
 * suppresses the WORLD clock only. Self-scheduled wakes still fire (with a
 * note in the prompt), touch replies follow `allowTouchReply`, chat is never
 * gated, and the boot greeting is unchanged.
 * @module dsh-agentic-pet/rhythm
 */

import { readGlobalJson } from './petdata.ts'

export interface QuietConfig {
  from: string
  to: string
  allowTouchReply: boolean
}

export interface RhythmConfig {
  quiet?: QuietConfig | null
}

/** "HH:mm" (or "H:mm") → minutes since midnight. Undefined for invalid. */
export function parseClock(value: unknown): number | undefined {
  if (typeof value !== 'string') return undefined
  const match = /^(\d{1,2}):(\d{2})$/.exec(value.trim())
  if (match === null) return undefined
  const hour = Number(match[1])
  const minute = Number(match[2])
  if (!Number.isInteger(hour) || !Number.isInteger(minute)) return undefined
  if (hour < 0 || hour > 23 || minute < 0 || minute > 59) return undefined
  return hour * 60 + minute
}

/** Half-open [from, to); cross-midnight is supported. */
export function isQuietAt(date: Date, quiet: QuietConfig | null | undefined): boolean {
  if (quiet === undefined || quiet === null) return false
  const from = parseClock(quiet.from)
  const to = parseClock(quiet.to)
  if (from === undefined || to === undefined || from === to) return false
  const minutes = date.getHours() * 60 + date.getMinutes()
  return from < to
    ? minutes >= from && minutes < to
    : minutes >= from || minutes < to
}

/** Read `rhythm.quiet` from pet-settings.json; absent/null/invalid = no quiet. */
export async function readRhythmConfig(home: string): Promise<RhythmConfig> {
  try {
    const raw = await readGlobalJson(home, 'pet-settings.json')
    const rhythm = raw.rhythm
    if (typeof rhythm !== 'object' || rhythm === null) return {}
    const quiet = (rhythm as Record<string, unknown>).quiet
    if (typeof quiet !== 'object' || quiet === null) return { quiet: null }
    const record = quiet as Record<string, unknown>
    const from = typeof record.from === 'string' ? record.from : undefined
    const to = typeof record.to === 'string' ? record.to : undefined
    if (from === undefined || to === undefined) return { quiet: null }
    if (parseClock(from) === undefined || parseClock(to) === undefined) return { quiet: null }
    return {
      quiet: {
        from,
        to,
        allowTouchReply: record.allowTouchReply !== false,
      },
    }
  } catch {
    return {}
  }
}
