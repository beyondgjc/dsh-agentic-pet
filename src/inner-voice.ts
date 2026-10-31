/**
 * The inner voice (docs/inner-voice.md): the pet's self-initiated expression
 * loop. This module owns the pure, testable half — config parsing with
 * defaults and clamps, the durable petId→sessionId store, and the wake/touch
 * prompt builders. The driver (driver.ts) owns the wiring: timers, gates,
 * SessionController calls, and the per-pet pending locks.
 * @module dsh-agentic-pet/inner-voice
 */

import { readFile, writeFile } from 'node:fs/promises'
import { join } from 'node:path'

/** Durable petId → sessionId mapping for the inner-voice sessions. */
export interface InnerVoiceStore {
  readonly sessions: Record<string, { sessionId: string; createdAt: number }>
  /** Session-id generation per pet, PERSISTED: must survive reboots AND
   * plugin reinstall — a re-install that restarted the counter would mint
   * ids colliding with archived ones (born dead). */
  readonly generations: Record<string, number>
}

/** The `innerVoice` half of pet-settings.json, defaults folded in and clamped. */
export interface InnerVoiceConfig {
  enabled: boolean
  /** Preset id the self-session mounts: the trimmed catalog by default, the
   * full work catalog only if the user opts in. */
  preset: string
  /** Random-wake cadence in minutes. */
  wakeIntervalMinutes: number
  /** Probability the wake actually speaks (the gate decides, never the model). */
  speakProbability: number
  /** Probability a touch earns a reply turn. */
  touchReplyProbability: number
  /** Minimum seconds between touch-reply turns per pet (0 = no cooldown;
   * the probability gate alone decides). Legacy minute-keyed settings fold
   * in ×60. */
  touchReplyCooldownSeconds: number
  /** Manually bound sessions (petId → sessionId): the user's own
   * conversations the inner voice should live in — highest priority, used
   * as-is (no creation, no rename, never auto-retired). Empty = automatic
   * management (the durable store + generation mints). */
  boundSessions: Record<string, string>
}

export const VOICE_SESSION_PREFIX = 'whale598-'

const clamp = (value: number, min: number, max: number): number =>
  Math.min(max, Math.max(min, value))

const finite01 = (value: unknown, fallback: number): number =>
  typeof value === 'number' && Number.isFinite(value) ? clamp(value, 0, 1) : fallback

/** Read `innerVoice` from pet-settings.json; anything missing or mistyped
 * folds to its default (defensive parse, `readAutonomy` precedent). */
export async function readInnerVoiceConfig(home: string): Promise<InnerVoiceConfig> {
  try {
    const raw = JSON.parse(await readFile(join(home, 'pet-settings.json'), 'utf8')) as {
      innerVoice?: unknown
    }
    const v = (typeof raw.innerVoice === 'object' && raw.innerVoice !== null ? raw.innerVoice : {}) as {
      enabled?: unknown
      preset?: unknown
      wakeIntervalMinutes?: unknown
      speakProbability?: unknown
      touchReplyProbability?: unknown
      touchReplyCooldownSeconds?: unknown
      touchReplyCooldownMinutes?: unknown
      boundSessions?: unknown
    }
    // Cooldown in seconds (0 allowed = gate off). The legacy minute key folds
    // in only while the seconds key is absent, so a saved seconds value is
    // never clobbered by the stale minutes one.
    const legacyMinutes = typeof v.touchReplyCooldownMinutes === 'number' && Number.isFinite(v.touchReplyCooldownMinutes)
      ? v.touchReplyCooldownMinutes
      : undefined
    const secondsRaw = typeof v.touchReplyCooldownSeconds === 'number' && Number.isFinite(v.touchReplyCooldownSeconds)
      ? v.touchReplyCooldownSeconds
      : legacyMinutes !== undefined ? legacyMinutes * 60 : undefined
    // Manual bindings: only well-formed petId → sessionId pairs survive.
    const boundSessions: Record<string, string> = {}
    if (typeof v.boundSessions === 'object' && v.boundSessions !== null) {
      for (const [petId, sessionId] of Object.entries(v.boundSessions as Record<string, unknown>)) {
        if (petId !== '' && typeof sessionId === 'string' && sessionId !== '') boundSessions[petId] = sessionId
      }
    }
    return {
      enabled: v.enabled !== false,
      preset: typeof v.preset === 'string' && v.preset !== '' ? v.preset : 'pet-inner-voice',
      wakeIntervalMinutes: typeof v.wakeIntervalMinutes === 'number' && Number.isFinite(v.wakeIntervalMinutes)
        ? clamp(Math.round(v.wakeIntervalMinutes), 1, 60)
        : 2,
      speakProbability: finite01(v.speakProbability, 0.5),
      touchReplyProbability: finite01(v.touchReplyProbability, 0.3),
      touchReplyCooldownSeconds: secondsRaw === undefined ? 30 : clamp(Math.round(secondsRaw), 0, 600),
      boundSessions,
    }
  } catch {
    return {
      enabled: true,
      preset: 'pet-inner-voice',
      wakeIntervalMinutes: 2,
      speakProbability: 0.5,
      touchReplyProbability: 0.3,
      touchReplyCooldownSeconds: 30,
      boundSessions: {},
    }
  }
}

export function innerVoiceStorePath(home: string): string {
  return join(home, 'pet-inner-voice.json')
}

/** Defensive extraction of the persisted generation counters (petId → n). */
function generationsOf(raw: { generations?: unknown }): Record<string, number> {
  const out: Record<string, number> = {}
  if (typeof raw.generations === 'object' && raw.generations !== null) {
    for (const [petId, n] of Object.entries(raw.generations as Record<string, unknown>)) {
      if (petId !== '' && typeof n === 'number' && Number.isFinite(n) && n >= 0) out[petId] = Math.floor(n)
    }
  }
  return out
}

export async function loadInnerVoiceStore(home: string): Promise<InnerVoiceStore> {
  try {
    const raw = JSON.parse(await readFile(innerVoiceStorePath(home), 'utf8')) as {
      sessions?: unknown
      generations?: unknown
    }
    const sessions: InnerVoiceStore['sessions'] = {}
    for (const [petId, entry] of Object.entries(
      typeof raw.sessions === 'object' && raw.sessions !== null ? raw.sessions : {},
    )) {
      const record = entry as { sessionId?: unknown; createdAt?: unknown }
      if (typeof record?.sessionId === 'string' && record.sessionId !== '') {
        sessions[petId] = {
          sessionId: record.sessionId,
          createdAt: typeof record.createdAt === 'number' ? record.createdAt : 0,
        }
      }
    }
    return { sessions, generations: generationsOf(raw) }
  } catch {
    return { sessions: {}, generations: {} }
  }
}

export async function saveInnerVoiceStore(home: string, store: InnerVoiceStore): Promise<void> {
  try {
    await writeFile(innerVoiceStorePath(home), `${JSON.stringify(store)}\n`, 'utf8')
  } catch (error: unknown) {
    console.error(`pet-surface inner-voice: could not write the store: ${error instanceof Error ? error.message : String(error)}`)
  }
}

export function voiceSessionIdFor(petId: string): string {
  return `${VOICE_SESSION_PREFIX}${petId}`
}

/** Mint the next voice session id: the bare base for generation 0, `-gN`
 * after any retire. The generation counter lives in memory only — a desktop
 * restart resets it to zero while the archive set still holds every retired
 * id, so a naive mint lands on an ARCHIVED ancestor: the platform accepts
 * the prompt (bare `accepted` receipt) but its gate silently blocks every
 * turn of an archived session — born dead, retired by the 25s window, and
 * the replacement collides again (field spiral 2026-10-31, g1→g3 dead on
 * arrival). The mint therefore SKIPS any id the archive authority still
 * holds; with the counter reset this walks past g1..g16 to the first free
 * slot. The hop cap keeps a pathological archive set from spinning forever.
 * Returns the (possibly advanced) generation so callers persist it — a
 * later mint must not reuse a skipped id either — plus the hop count for
 * the skip log line. */
export function mintVoiceSessionId(
  petId: string,
  generation: number,
  isArchived: (sessionId: string) => boolean,
): { sessionId: string; generation: number; hops: number } {
  const MINT_HOP_CAP = 500
  let g = Math.max(0, Math.floor(generation))
  // UNIFORM FORMAT (user decision): every generation carries the -gN suffix —
  // gen0 is `whale598-<petId>-g0`, not a bare base id. One shape, no
  // special first-generation case.
  let sessionId = `${voiceSessionIdFor(petId)}-g${String(g)}`
  let hops = 0
  while (isArchived(sessionId) && hops < MINT_HOP_CAP) {
    g += 1
    sessionId = `${voiceSessionIdFor(petId)}-g${String(g)}`
    hops += 1
  }
  return { sessionId, generation: g, hops }
}

export interface GreetPromptFacts {
  affection: number
}

/** The boot-greeting prompt: fired once per dsh start when the pet first
 * comes online — before the random-wake cadence takes over. Always speaks
 * (no probability gate on this one); the time context rides the preset. */
export function buildGreetPrompt(facts: GreetPromptFacts): string {
  return [
    '[启动问好]',
    `用户刚打开 DeepSeek，你的世界刚亮起来（好感 ${String(facts.affection)}，${moodOf(facts.affection)}）。`,
    '主动打个招呼（pet_say）——按当下的时辰自然问好，一两句就好，别问问题等回答。',
  ].join(' ')
}

/** Shared mood vocabulary (pet_state computes the same from the ledger). */
export function moodOf(affection: number): 'happy' | 'content' | 'neutral' {
  return affection >= 80 ? 'happy' : affection >= 40 ? 'content' : 'neutral'
}

/** Touch part → spoken wording; `unknown` never earns a reply turn (the
 * driver filters it before building a prompt). */
export function touchPartWording(part: string): string | undefined {
  if (part === 'head') return '头'
  if (part === 'body') return '身体'
  return undefined
}

export interface WakePromptFacts {
  affection: number
  /** Minutes since this pet last spoke on its own; undefined = first wake. */
  minutesSinceLastSpoke: number | undefined
  /** Minutes since the bound session last showed activity; undefined = none recorded. */
  minutesSinceUserActivity: number | undefined
  userActive: boolean
}

/** The wake prompt. Time context is injected by the preset's time-context
 * row; the leading tag doubles as the durable trigger marker in the log. */
export function buildWakePrompt(facts: WakePromptFacts): string {
  const lastSpoke = facts.minutesSinceLastSpoke === undefined
    ? '这是你今天第一次醒来'
    : `你上次开口是 ${String(facts.minutesSinceLastSpoke)} 分钟前`
  const user = facts.userActive
    ? `用户最近正在会话中工作（${String(facts.minutesSinceUserActivity ?? 0)} 分钟内有动静）`
    : '用户最近没有活动'
  return [
    '[自主唤醒]',
    `好感 ${String(facts.affection)}（${moodOf(facts.affection)}）；${lastSpoke}；${user}。`,
    '醒来想到什么就说一句（pet_say），想配动作就 pet_do；也可以只是安静待着（两者都不调，正文写「…」）。',
  ].join(' ')
}

export interface TouchPromptFacts {
  part: string
  /** Touches on this pet today, from the ledger's recent window. */
  touchesToday: number
  affection: number
}

export function buildTouchPrompt(facts: TouchPromptFacts): string {
  const wording = touchPartWording(facts.part) ?? '身体'
  return [
    '[被触摸]',
    `用户刚摸了你的${wording}（今天第 ${String(facts.touchesToday)} 次，好感 ${String(facts.affection)}，${moodOf(facts.affection)}）。`,
    '回应一句（pet_say）或做个反应（pet_do）。',
  ].join(' ')
}

/** The chat上行 prompt (§6 2026-10-31 revision): the user typed at the
 * pet's surface. The text rides verbatim — the pet answers through pet_say
 * (and may pet_do); it is a conversation turn, not a touch reaction. Length
 * clamps to the contract's 2000-character ceiling. */
export function buildChatPrompt(text: string): string {
  return `[用户对你说] ${text.slice(0, 2000)}`
}
