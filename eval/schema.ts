/**
 * Tool-call eval dataset schema: one EvalScenario = seed (state to
 * materialize) + turn (the prompt the driver would fabricate) + expect
 * (grading pattern for a real model run) + ideal (the golden tool-call
 * sequence, replayed through the REAL tools by the dry run to prove the
 * scenario is achievable). Grading is deterministic — no LLM judge.
 * @module dsh-agentic-pet/eval/schema
 */

import type { BodyDescription } from '../src/body.ts'
import type { ActionCatalogEntry, PetCapabilities } from '../src/actions.ts'
import type { WakePromptFacts, TouchPromptFacts, GreetPromptFacts, MergedWakePlan } from '../src/inner-voice.ts'

// ── argument assertion primitives ───────────────────────────────────────────

/** One assertion on a single argument (or result field) value. Exactly one
 * key is meaningful per assertion; the grader reports which key it applied. */
export type ArgAssert =
  | { eq: unknown }
  | { notEq: unknown }
  | { in: readonly unknown[] }
  | { matches: string }
  | { notContains: string }
  | { gt: number }
  | { gte: number }
  | { lt: number }
  | { lte: number }
  | { lenLte: number }
  | { lenGte: number }
  /** Value must be one of the driver's MOOD_IDS word list. */
  | { mood: true }
  /** Numeric epoch-ms strictly in the future, within 8 days (a self-wake
   * plan must be computed from now, not passed as a relative delay). */
  | { futureEpochMs: true }
  | { truthy: true }
  /** The argument key must NOT be provided at all. */
  | { absent: true }

export interface CallAsserts {
  args?: Record<string, ArgAssert>
  /** Asserts on the tool's JSON-stringified return value (dotted paths OK). */
  result?: Record<string, ArgAssert>
}

/** One step of an expected call sequence (ordered subset semantics: extra
 * unlisted calls are allowed unless forbidden/maxCalls trip). */
export interface CallPatternStep extends CallAsserts {
  tool: string
  /** 'ok' = execute resolved; 'error' = execute threw; default 'ok'. */
  outcome?: 'ok' | 'error' | 'any'
  /** May be missing from the run without failing selection. */
  optional?: boolean
  /** When the step expects an error, the thrown teaching message must match
   * this regex source. */
  errorMatches?: string
  /** (ideal only) executed during dry-run replay but excluded from the
   * derived grading pattern — a deliberate mistake the model is NOT required
   * to make (e.g. a wrong mood word proving the teaching error fires). */
  mistake?: boolean
}

// ── expectation ─────────────────────────────────────────────────────────────

export interface Expectation {
  /** Expected call pattern. When omitted, the grader derives it from
   * `ideal` (mistake steps excluded, args loosened for free-text/epoch keys).
   */
  calls?: CallPatternStep[]
  /** Tools that must NOT appear anywhere in the run. */
  forbidden?: string[]
  /** Per-tool call-count ceilings (discipline: no retry storms, no
   * double-performance). */
  maxCalls?: Record<string, number>
  /** Upper bound on total tool calls (wake-discipline scenarios). */
  maxTotal?: number
  /** The final answer text must contain AT LEAST ONE of these (case- and
   * punctuation-tolerant contains). For "ask the user in words" cases. */
  finalTextAny?: string[]
  /** True = the turn must end without any tool call (quiet wake '…'). */
  noToolCalls?: boolean
  /** Negative scan: NO call of `tool` may have `key` containing `fragment`
   * (anti-echo discipline — recalled content must not be written back). */
  argNeverContains?: Array<{ tool: string; key: string; fragment: string }>
}

// ── golden sequence (dry-run replay) ────────────────────────────────────────

export interface IdealCall extends Omit<CallAsserts, 'args'> {
  tool: string
  args?: Record<string, unknown>
  outcome?: 'ok' | 'error' | 'any'
  /** Executed first as un-graded environment setup (e.g. fill a rate-limit
   * window, advance a digest cursor). */
  setup?: boolean
  mistake?: boolean
  /** (mistake only) the thrown teaching error must match this regex source. */
  errorMatches?: string
}

// ── seed (state materialization) ────────────────────────────────────────────

export interface MockPetSpec {
  id: string
  /** Default true. An offline pet stays in list()-visible registry? No —
   * offline pets are skipped by list(); keep the spec to assert targeting
   * errors against a pet the model believes exists. */
  online?: boolean
  /** 'whale' = the REAL asset payload via normalizeCapabilities/normalizeBody
   * (default). Pass an explicit object to shape a custom body (e.g. an
   * unsupported-expressions body for pet_express fallback scenarios). */
  capabilities?: 'whale' | PetCapabilities
  body?: 'whale' | BodyDescription | null
  /** Touch/chat events the pet's /events endpoint returns (digest scenarios). */
  events?: Array<{ seq: number; type: string; part?: string; text?: string; at?: number }>
}

export interface JournalSeedEntry {
  at?: number
  source?: string
  sessionId?: string | null
  text: string
  tags?: string[]
  entities?: string[]
}

export interface LedgerSeed {
  affection?: number
  total?: number
  byPart?: Record<string, number>
  lastTouchAt?: number
  recent?: Array<{ part: string; at: number }>
  adjustments?: Array<{ delta: number; reason: string; at: number; system?: boolean }>
  quota?: { date: string; count: number; sum: number }
  bond?: { value: number; days: number; lastCountedDate?: string }
  bondAdjustments?: Array<{ delta: number; reason: string; at: number }>
  petAffection?: Record<string, { value: number; adjustments: Array<{ delta: number; reason: string; at: number }> }>
  petFacts?: Record<string, { total: number; lastAt: number }>
}

export interface SeedSpec {
  /** Running pets. Default: one whale 'electron'. */
  pets?: MockPetSpec[]
  /** The sessionId carried on exec.agent.id for the graded turn. Default
   * 'voice-session-1'. Must appear in `owners` to be pet-owned. null = no
   * session identity at all (exec.agent.id undefined — the only path where
   * pet-settings focus decides the unnamed-expression target). */
  session?: string | null
  /** sessionId → petId (written through the driver's eval seam). */
  owners?: Record<string, string>
  /** pet-settings.json focus (unnamed-expression target). */
  focus?: string
  /** Extra keys deep-merged into the seeded pet-settings.json. */
  settings?: Record<string, unknown>
  /** Per-pet affection ledger seed (writeAffectionRaw, normalized defaults). */
  ledger?: Record<string, LedgerSeed>
  /** Per-pet journal seed — appended through the REAL appendJournal so the
   * hash chain and echo detection behave exactly as in production. */
  journal?: Record<string, JournalSeedEntry[]>
  /** Per-pet stage summaries (appendEpoch). */
  epochs?: Record<string, Array<{ text: string; window?: { from: number; to: number } }>>
  /** Per-pet pinned journal entry ids (pinEntry at seed time). */
  journalPin?: Record<string, string[]>
  /** Shared board notes (leaveNote / replyNote). */
  boardNotes?: Array<{
    from: string
    text: string
    at?: number
    replies?: Array<{ from: string; text: string; at?: number }>
  }>
  /** Per-pet letter archive (pet-letters.json). */
  letters?: Record<string, Array<{ at: number; text: string; readAt?: number }>>
  /** Per-pet unread inbox (eval seam → voicePetMessages). */
  messages?: Record<string, Array<{ from: string; text: string; at?: number }>>
  /** Per-pet pending self-wake plans (eval seam → voiceWakePlans). */
  wakePlans?: Record<string, Array<{ id: string; at: number; intent: string }>>
  /** pet-settings.json innerVoice.selfTuning (default false — the gate). */
  selfTuning?: boolean
  /** pet-settings.json innerVoice.petToPetDelivery (default 'queue'). */
  petToPetDelivery?: 'immediate' | 'queue'
  /** journal.allowUnboundAppend (default false). */
  allowUnboundAppend?: boolean
  /** Cross-pet directed-message rate windows (eval seam → crossPetLog),
   * keyed "from->to". Timestamps are epoch ms. */
  crossPetLog?: Record<string, number[]>
  /** Approval/question interaction ledger (whale598/pet-interactions.json). */
  interactions?: Array<Record<string, unknown>>
  /** Per-pet pet-inner-state.json seed (letter.lastDate etc.). */
  innerState?: Record<string, Record<string, unknown>>
}

// ── turn (the fabricated prompt) ────────────────────────────────────────────

export type TurnSpec =
  | { kind: 'wake'; facts?: Partial<WakePromptFacts> }
  | { kind: 'touch'; part: string; touchesToday?: number; mergedPlan?: MergedWakePlan }
  | { kind: 'chat'; text: string; mergedPlan?: MergedWakePlan }
  | { kind: 'dream'; memories: string[] }
  | { kind: 'greet'; name?: string }
  | { kind: 'cross'; fromName: string; fromId: string; text: string; affection?: number }
  | { kind: 'raw'; text: string }

// ── scenario ────────────────────────────────────────────────────────────────

export type ScenarioFamily =
  | 'say' | 'do' | 'state-express' | 'digest' | 'journal' | 'recall'
  | 'interactions-affection' | 'schedule-wake' | 'set-rhythm'
  | 'letter-inbox-board' | 'multipet' | 'turns'

export interface EvalScenario {
  /** Globally unique, kebab-case, family-prefixed (e.g. 'say-audience-self'). */
  id: string
  family: ScenarioFamily
  /** Primary tool under test (aggregation key). */
  tool: string
  /** 中文一句话描述（报告里显示）。 */
  title: string
  seed: SeedSpec
  turn: TurnSpec
  expect: Expectation
  /** Golden sequence replayed by the dry run; also the default grading
   * pattern source (see Expectation.calls). */
  ideal: IdealCall[]
  /** Post-run side-effect verification (both dry-run and model runs):
   * returns a failure line, or null when the state is as claimed. May be
   * async (file reads). */
  verify?: (context: VerifyContext) => string | null | Promise<string | null>
}

/** What a verify hook may inspect: the mock pet's recorded HTTP traffic and
 * the temp home (files written by the tools). */
export interface VerifyContext {
  mockState: {
    says: Array<{ pet: string; text: string; mood?: string; letter?: boolean; letterAt?: number }>
    actions: Array<{ pet: string; action: string; mood?: string; requestId: string }>
    expressions: Array<{ pet: string; expression: string }>
  }
  home: string
}

// ── recorded call (harness output / grader input) ───────────────────────────

export interface RecordedCall {
  tool: string
  args: Record<string, unknown>
  ok: boolean
  /** The execute() return value (string) when ok. */
  result?: string
  /** The error message when not ok. */
  error?: string
  /** Loop step index (0-based) this call happened at. */
  step: number
  /** True when this call came from the dry-run replay's setup phase. */
  setup?: boolean
  /** True when this call is a deliberate mistake step (dry-run only; the
   * grader excludes it from alignment). */
  mistake?: boolean
}

export interface ScenarioVerdict {
  id: string
  pass: boolean
  dimensions: {
    selection: boolean
    args: boolean
    outcome: boolean
    discipline: boolean
  }
  /** Per-check failure lines (empty when all pass). */
  failures: string[]
  calls: RecordedCall[]
  finalText?: string
  /** Wall-clock ms for the whole scenario run (0 for dry-run replay). */
  durationMs: number
}

export interface EvalReport {
  startedAt: string
  model?: string
  mode: 'dry-run' | 'model'
  scenarios: ScenarioVerdict[]
  summary: {
    total: number
    passed: number
    passRate: number
    byFamily: Record<string, { total: number; passed: number }>
    byTool: Record<string, { total: number; passed: number }>
    /** Scenarios without mistake steps: none of the executed calls threw. */
    firstTry: { total: number; clean: number }
    /** Scenarios WITH mistake steps in ideal: the final expected step still
     * landed (the run recovered). */
    recovery: { total: number; recovered: number }
  }
}
