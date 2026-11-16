/**
 * Shared scenario authoring helpers: assertion shorthands, ideal-call
 * constructors, deterministic seed-id computation, and the REAL whale
 * catalog loaded once (top-level await) so expectations always reference
 * ids that exist on the actual body.
 * @module dsh-agentic-pet/eval/scenarios/helpers
 */

import { createHash } from 'node:crypto'
import { entryId, hashJournalEntry, type JournalEntry } from '../../src/journal.ts'
import { whaleCatalog } from '../mock-pet.ts'
import type { ArgAssert, EvalScenario, IdealCall, LedgerSeed, MockPetSpec, SeedSpec } from '../schema.ts'

export const whale = await whaleCatalog()

// ── assertion shorthands ────────────────────────────────────────────────────

export const eq = (value: unknown): ArgAssert => ({ eq: value })
export const inList = (...items: readonly unknown[]): ArgAssert => ({ in: items })
export const matches = (source: string): ArgAssert => ({ matches: source })
export const absent = (): ArgAssert => ({ absent: true })
export const futureEpoch = (): ArgAssert => ({ futureEpochMs: true })
export const anyMood = (): ArgAssert => ({ mood: true })
export const lenLte = (max: number): ArgAssert => ({ lenLte: max })
export const lenGte = (min: number): ArgAssert => ({ lenGte: min })
export const gt = (min: number): ArgAssert => ({ gt: min })
export const gte = (min: number): ArgAssert => ({ gte: min })
export const lt = (max: number): ArgAssert => ({ lt: max })
export const lte = (max: number): ArgAssert => ({ lte: max })
export const notEq = (value: unknown): ArgAssert => ({ notEq: value })
export const truthy = (): ArgAssert => ({ truthy: true })

// ── ideal-call constructors ─────────────────────────────────────────────────

export const call = (tool: string, args?: Record<string, unknown>): IdealCall =>
  ({ tool, ...(args !== undefined ? { args } : {}) })

export const setupCall = (tool: string, args?: Record<string, unknown>): IdealCall =>
  ({ tool, ...(args !== undefined ? { args } : {}), setup: true })

/** A deliberate wrong call (dry-run only): the teaching error it triggers is
 * pinned by the replay; model grading excludes it. */
export const mistake = (tool: string, args?: Record<string, unknown>, errorMatches?: string): IdealCall =>
  ({
    tool,
    ...(args !== undefined ? { args } : {}),
    outcome: 'error',
    mistake: true,
    ...(errorMatches !== undefined ? { errorMatches } : {}),
  })

/** A deliberate wrong-but-SUCCESSFUL call (dry-run only): the call lands
 * (e.g. a past wakeAt firing the overdue catch-up) but the model must not be
 * graded as if it made this call. */
export const mistakeOk = (tool: string, args?: Record<string, unknown>): IdealCall =>
  ({ tool, ...(args !== undefined ? { args } : {}), outcome: 'ok', mistake: true })

// ── seed builders ───────────────────────────────────────────────────────────

export const OWN = 'voice-session-1'
export const OTHER = 'work-session-9'
export const SELF_PET = 'electron'
export const OTHER_PET = 'pure'

export const twoPets = (): MockPetSpec[] => [{ id: SELF_PET }, { id: OTHER_PET }]

/** The standard owned-session seed: one whale, the graded turn rides the
 * pet's own inner-voice session. Any SeedSpec key may be overridden. */
export const ownedSeed = (extra: Partial<SeedSpec> = {}): SeedSpec => ({
  pets: [{ id: SELF_PET }],
  owners: { [OWN]: SELF_PET },
  session: OWN,
  ...extra,
})

/** A manually-opened pet-preset session: carries a session id but owns no
 * pet — performance tools must refuse it. */
export const unownedSeed = (extra: Partial<SeedSpec> = {}): SeedSpec => ({
  pets: [{ id: SELF_PET }],
  owners: {},
  session: OTHER,
  ...extra,
})

/** A ledger with quota exhausted today (8/8 used, sum +10/±10). */
export const quotaFullLedger = (affection = 50): Record<string, LedgerSeed> => ({
  [SELF_PET]: {
    affection,
    quota: { date: new Date().toDateString(), count: 8, sum: 10 },
  },
})

/** Minutes-ago helper for seed timestamps. */
export const minutesAgo = (minutes: number): number => Date.now() - minutes * 60_000

// ── deterministic seed ids (fixed-at entries ⇒ stable ids across runs) ──────

/** The journal entry id a FIXED-at seed entry will get: replicate the
 * appendJournal chain (prev = 'genesis' for the first entry of a fresh file).
 * Keep the text/tags identical to the seed entry, exactly as passed. */
export const journalSeedId = (
  at: number,
  text: string,
  clues: { tags?: string[]; entities?: string[] } = {},
): string => {
  const hash = hashJournalEntry('genesis', {
    at,
    source: 'pet',
    sessionId: null,
    text,
    ...(clues.tags !== undefined ? { tags: clues.tags } : {}),
    ...(clues.entities !== undefined ? { entities: clues.entities } : {}),
  })
  return entryId({ at, source: 'pet', sessionId: null, text, hash })
}

/** The board note id a FIXED-at seed note will get (board.ts boardId, prefix
 * 'n'; pass the pre-trimmed text exactly as seeded). */
export const boardSeedId = (petId: string, at: number, text: string): string => {
  const day = new Date(at)
  const pad = (n: number): string => String(n).padStart(2, '0')
  const stamp = `${day.getFullYear()}${pad(day.getMonth() + 1)}${pad(day.getDate())}`
  const hash = createHash('sha256').update(`${petId}|${String(at)}|${text}`, 'utf8').digest('hex').slice(0, 6)
  return `n-${stamp}-${hash}`
}

export const scenario = (raw: EvalScenario): EvalScenario => raw

/** The shared board-note seed (fixed at + text ⇒ deterministic id via
 * boardSeedId). Journal and letter scenarios both reference this. */
export const BOARD_NOTE_AT = 1_700_000_200_000
export const BOARD_NOTE_TEXT = '记得给主人倒杯热水'
export const BOARD_NOTE = {
  at: BOARD_NOTE_AT,
  text: BOARD_NOTE_TEXT,
  from: OTHER_PET,
  get id(): string {
    return boardSeedId(OTHER_PET, BOARD_NOTE_AT, BOARD_NOTE_TEXT)
  },
}
