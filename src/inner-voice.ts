/**
 * The inner voice (docs/inner-voice.md): the pet's self-initiated expression
 * loop. This module owns the pure, testable half — config parsing with
 * defaults and clamps, the durable petId→sessionId store, and the wake/touch
 * prompt builders. The driver (driver.ts) owns the wiring: timers, gates,
 * SessionController calls, and the per-pet pending locks.
 * @module dsh-agentic-pet/inner-voice
 */

import { join } from 'node:path'
import { WHALE_DIR, readGlobalJson, writeGlobalJson } from './petdata.ts'

/** Durable petId → sessionId mapping for the inner-voice sessions. */
export interface InnerVoiceStore {
  readonly sessions: Record<string, { sessionId: string; createdAt: number }>
  /** Session-id generation per pet, PERSISTED: must survive reboots AND
   * plugin reinstall — a re-install that restarted the counter would mint
   * ids colliding with archived ones (born dead). */
  readonly generations: Record<string, number>
}

/** 自主唤醒的忙时策略：'fire'（到点必醒，默认）| 'defer'（忙时顺延重试）。 */
export type SelfWakeBusyPolicy = 'fire' | 'defer'

/** ONE model-authored wake plan (pet_schedule_wake): a one-shot self alarm.
 * `at` is an ABSOLUTE epoch-ms stamp — sleep/reboot can then tell "expired"
 * and the catch-up fires once, merged, never one wake per missed plan (a
 * relative delay would drift under sleep). The driver keeps a SET of these
 * per pet: the model may stack plans, and neither the world clock nor a
 * user-initiated wake ever cancels them — a plan is consumed only when DUE. */
export interface WakePlan {
  id: string
  at: number
  intent: string
  createdAt: number
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
  /** 自主唤醒（pet_schedule_wake 计划）到点遇用户主会话忙时的策略：
   * 'fire' = 到点必醒（计划是模型自己的决定，不带礼貌门）；'defer' =
   * 忙时顺延——计划放回待执行集，下一个扫描拍重试，永不丢弃。 */
  selfWakeBusyPolicy: SelfWakeBusyPolicy
  /** 宠物间消息（pet_say 的 audience 指向另一只宠）的投递方式：
   * 'queue' = 进收件箱，目标下次唤醒时 prompt 报数、pet_inbox 取文（默认，
   * 像活物不刷屏）；'immediate' = 气泡 5s 后立即唤醒目标投递。 */
  petToPetDelivery: 'immediate' | 'queue'
  /** Manually bound sessions (petId → sessionId): the user's own
   * conversations the inner voice should live in — highest priority, used
   * as-is (no creation, no rename, never auto-retired). Empty = automatic
   * management (the durable store + generation mints). */
  boundSessions: Record<string, string>
}

export const VOICE_SESSION_PREFIX = 'whale598-'

/**
 * Saved-setting migration for preset id renames: pet-settings.json holds the
 * user's 会话模式 choice by id, and a rename orphans that saved value (every
 * ensure would first try a dead id and fall back). Map the legacy ids onto
 * their successors; unknown ids pass through untouched.
 */
const LEGACY_PRESET_IDS: Record<string, string> = {
  'pet-inner-voice': 'whale598',
  'pet': 'whale598-standard',
}

function migratePreset(preset: string): string {
  return LEGACY_PRESET_IDS[preset] ?? preset
}

const clamp = (value: number, min: number, max: number): number =>
  Math.min(max, Math.max(min, value))

const finite01 = (value: unknown, fallback: number): number =>
  typeof value === 'number' && Number.isFinite(value) ? clamp(value, 0, 1) : fallback

/** Read `innerVoice` from pet-settings.json; anything missing or mistyped
 * folds to its default (defensive parse, `readAutonomy` precedent). */
export async function readInnerVoiceConfig(home: string): Promise<InnerVoiceConfig> {
  try {
    const raw = await readGlobalJson(home, 'pet-settings.json') as {
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
      selfWakeBusyPolicy?: unknown
      petToPetDelivery?: unknown
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
      preset: migratePreset(
        typeof v.preset === 'string' && v.preset !== '' ? v.preset : 'whale598',
      ),
      wakeIntervalMinutes: typeof v.wakeIntervalMinutes === 'number' && Number.isFinite(v.wakeIntervalMinutes)
        ? clamp(Math.round(v.wakeIntervalMinutes), 1, 60)
        : 2,
      speakProbability: finite01(v.speakProbability, 0.5),
      touchReplyProbability: finite01(v.touchReplyProbability, 0.3),
      touchReplyCooldownSeconds: secondsRaw === undefined ? 30 : clamp(Math.round(secondsRaw), 0, 600),
      selfWakeBusyPolicy: v.selfWakeBusyPolicy === 'defer' ? 'defer' : 'fire',
      petToPetDelivery: v.petToPetDelivery === 'immediate' ? 'immediate' : 'queue',
      boundSessions,
    }
  } catch {
    return {
      enabled: true,
      preset: 'whale598',
      wakeIntervalMinutes: 2,
      speakProbability: 0.5,
      touchReplyProbability: 0.3,
      touchReplyCooldownSeconds: 30,
      selfWakeBusyPolicy: 'fire',
      petToPetDelivery: 'queue',
      boundSessions: {},
    }
  }
}

export function innerVoiceStorePath(home: string): string {
  return join(home, WHALE_DIR, 'pet-inner-voice.json')
}

// ── 自主作息（pet_schedule_wake）的持久化与纯逻辑 ─────────────────────────

export function wakePlansStorePath(home: string): string {
  return join(home, WHALE_DIR, 'pet-wake-plans.json')
}

/** Defensive extraction of one pet's plan list: only well-formed plans
 * survive (id/intent non-empty strings, at/createdAt finite numbers). */
function plansOf(raw: unknown): WakePlan[] {
  if (!Array.isArray(raw)) return []
  const out: WakePlan[] = []
  for (const item of raw) {
    if (typeof item !== 'object' || item === null) continue
    const rec = item as Record<string, unknown>
    if (typeof rec.id !== 'string' || rec.id === ''
      || typeof rec.at !== 'number' || !Number.isFinite(rec.at)
      || typeof rec.intent !== 'string' || rec.intent === ''
      || typeof rec.createdAt !== 'number' || !Number.isFinite(rec.createdAt)) continue
    out.push({ id: rec.id, at: rec.at, intent: rec.intent, createdAt: rec.createdAt })
  }
  return out
}

/** Load every pet's pending wake plans: current → legacy → {} (callers'
 * defensive checks treat {} exactly like a missing file). */
export async function loadWakePlans(home: string): Promise<Record<string, WakePlan[]>> {
  try {
    const raw = await readGlobalJson(home, 'pet-wake-plans.json') as { plans?: unknown }
    const byPet = typeof raw.plans === 'object' && raw.plans !== null ? raw.plans : {}
    const out: Record<string, WakePlan[]> = {}
    for (const [petId, list] of Object.entries(byPet as Record<string, unknown>)) {
      if (petId === '') continue
      const plans = plansOf(list)
      if (plans.length > 0) out[petId] = plans
    }
    return out
  } catch {
    return {}
  }
}

export async function saveWakePlans(home: string, plans: Record<string, WakePlan[]>): Promise<void> {
  try {
    await writeGlobalJson(home, 'pet-wake-plans.json', { plans } as unknown as Record<string, unknown>)
  } catch (error: unknown) {
    console.error(`pet-surface inner-voice: could not write the wake plans: ${error instanceof Error ? error.message : String(error)}`)
  }
}

/** Upsert by id: re-scheduling with a known id REPLACES the old plan —
 * "能定、能改、能撤" 的改。 */
export function upsertPlan(list: WakePlan[], plan: WakePlan): WakePlan[] {
  return [plan, ...list.filter(entry => entry.id !== plan.id)]
}

/** Remove one plan by id (or ALL when id is undefined). Returns the removed
 * plans so the caller can report them; an empty removal is the unknown-id
 * case the caller turns into a self-correcting error. */
export function cancelPlans(list: WakePlan[], id?: string): { next: WakePlan[]; removed: WakePlan[] } {
  if (id === undefined) return { next: [], removed: [...list] }
  return {
    next: list.filter(entry => entry.id !== id),
    removed: list.filter(entry => entry.id === id),
  }
}

/** Consume every DUE plan (at <= now): they leave the pending set for good —
 * a consumed plan must produce a wake, never a silent drop. Future plans
 * survive untouched (被打断不碰 plans). */
export function takeDuePlans(list: WakePlan[], now: number): { next: WakePlan[]; due: WakePlan[] } {
  return {
    next: list.filter(entry => entry.at > now),
    due: list.filter(entry => entry.at <= now),
  }
}

/** The ±60s merge window: a plan due around NOW folds into a user-initiated
 * turn instead of firing its own wake a minute later (同一分钟不醒两次). */
export function takeNearDuePlan(list: WakePlan[], now: number, windowMs = 60_000): { next: WakePlan[]; plan: WakePlan | undefined } {
  const plan = list.find(entry => Math.abs(entry.at - now) <= windowMs)
  if (plan === undefined) return { next: list, plan: undefined }
  return { next: list.filter(entry => entry !== plan), plan }
}

/** Plans among `due` that went stale BEFORE the driver came up (at < bootAt):
 * the catch-up wake says 「错过了 N 个计划」 and lists them together instead
 * of bombing one wake per missed plan. */
export function missedPlans(due: WakePlan[], bootAt: number): WakePlan[] {
  return due.filter(entry => entry.at < bootAt)
}

// ── 宠物间消息收件箱（pet_say audience → 另一只宠，排队投递侧） ────────────

/** One queued pet-to-pet message. Bubbles are on the user's desktop — this
 * is表演, not a private channel. */
export interface PetMessage {
  from: string
  text: string
  at: number
}

export const PET_MESSAGES_CAP = 20

export function petMessagesStorePath(home: string): string {
  return join(home, WHALE_DIR, 'pet-messages.json')
}

function messagesOf(raw: unknown): PetMessage[] {
  if (!Array.isArray(raw)) return []
  const out: PetMessage[] = []
  for (const item of raw) {
    if (typeof item !== 'object' || item === null) continue
    const rec = item as Record<string, unknown>
    if (typeof rec.from !== 'string' || rec.from === ''
      || typeof rec.text !== 'string' || rec.text === ''
      || typeof rec.at !== 'number' || !Number.isFinite(rec.at)) continue
    out.push({ from: rec.from, text: rec.text, at: rec.at })
  }
  return out
}

/** Load every pet's unread inbox: current → legacy → {} (defensive like the
 * other stores). */
export async function loadPetMessages(home: string): Promise<Record<string, PetMessage[]>> {
  try {
    const raw = await readGlobalJson(home, 'pet-messages.json') as { messages?: unknown }
    const byPet = typeof raw.messages === 'object' && raw.messages !== null ? raw.messages : {}
    const out: Record<string, PetMessage[]> = {}
    for (const [petId, list] of Object.entries(byPet as Record<string, unknown>)) {
      if (petId === '') continue
      const messages = messagesOf(list)
      if (messages.length > 0) out[petId] = messages
    }
    return out
  } catch {
    return {}
  }
}

export async function savePetMessages(home: string, messages: Record<string, PetMessage[]>): Promise<void> {
  try {
    await writeGlobalJson(home, 'pet-messages.json', { messages } as unknown as Record<string, unknown>)
  } catch (error: unknown) {
    console.error(`pet-surface inner-voice: could not write pet messages: ${error instanceof Error ? error.message : String(error)}`)
  }
}

/** Append one message to a pet's inbox, oldest dropped past the cap (a
 * neglected inbox cannot grow without bound). */
export function queuePetMessage(list: PetMessage[], message: PetMessage): PetMessage[] {
  return [...list, message].slice(-PET_MESSAGES_CAP)
}

/** Consume the WHOLE inbox (pet_inbox 取文即清空; the wake prompt only
 * announces counts). Returns the taken messages and the emptied tail. */
export function takePetMessages(list: PetMessage[]): { taken: PetMessage[]; next: PetMessage[] } {
  return { taken: [...list], next: [] }
}

/** The immediate-delivery prompt (petToPetDelivery='immediate'): the target
 * is woken right away with the sender's name and id — the id because the
 * reply path is pet_say audience="<fromId>". The target's current affection
 * toward the sender rides along so the reply carries history, not a blank
 * slate. Responding or ignoring is the target's own call, exactly like any
 * other wake. */
export function buildCrossPetPrompt(facts: { fromName: string; fromId: string; text: string; affection: number }): string {
  return [
    `[来自另外桌宠 ${facts.fromName}]`,
    `${facts.text.slice(0, 200)}`,
    `（你對 ${facts.fromName} 的好感 ${String(facts.affection)}，${moodOf(facts.affection)}）想回应就 pet_say 带 audience="${facts.fromId}"（同样 ≤40 字，气泡上会有 to 前缀）；不想理就安静待着。`,
  ].join(' ')
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
  // readGlobalJson: whale598/ → legacy root → {} (the lazy-migration
  // contract — the legacy root copy answers until the first save).
  try {
    const raw = await readGlobalJson(home, 'pet-inner-voice.json') as {
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
    await writeGlobalJson(home, 'pet-inner-voice.json', store as unknown as Record<string, unknown>)
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
  bondValue: number
  bondDays: number
  bondTier: string
  /** 用户起的名字（未起则内置默认）：自我介绍的依据，改名后第一天尤其重要。 */
  name: string
}

/** The boot-greeting prompt: fired once per dsh start when the pet first
 * comes online — before the random-wake cadence takes over. Always speaks
 * (no probability gate on this one); the time context rides the preset. */
export function buildGreetPrompt(facts: GreetPromptFacts): string {
  return [
    '[启动问好]',
    `你的名字是「${facts.name}」。`,
    `用户刚打开 DeepSeek，你的世界刚亮起来（好感 ${String(facts.affection)}，${moodOf(facts.affection)}；羁绊 ${facts.bondTier}，一起过了 ${String(facts.bondDays)} 天）。`,
    '主动打个招呼（pet_say）——按当下的时辰自然问好，一两句就好，别问问题等回答。',
  ].join(' ')
}

/** B 层 · 羁绊档位：days-with-interaction → tier name. Only grows, never
 * decays; the names are the display contract (settings page keeps its own
 * copy of the thresholds). */
export const BOND_TIERS: Array<{ since: number; name: string }> = [
  { since: 0, name: '陌生' },
  { since: 5, name: '认识' },
  { since: 15, name: '熟了' },
  { since: 40, name: '亲近' },
  { since: 90, name: '离不开' },
  { since: 180, name: '只有你' },
]

export function bondTier(days: number): string {
  let tier = BOND_TIERS[0]?.name ?? '陌生'
  for (const t of BOND_TIERS) if (days >= t.since) tier = t.name
  return tier
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
  bondValue: number
  bondTier: string
  bondDays: number
  /** Minutes since this pet last spoke on its own; undefined = first wake. */
  minutesSinceLastSpoke: number | undefined
  /** Minutes since the bound session last showed activity; undefined = none recorded. */
  minutesSinceUserActivity: number | undefined
  userActive: boolean
  /** 唤醒源：'world' = 世界时钟（环境节拍，程序周期）；'self' = 模型自己定的
   * 计划到点；'world+self' = 两者同拍合并。缺省按 'world'（旧调用点）。 */
  source?: 'world' | 'self' | 'world+self'
  /** 本次已消费的到期计划 intent（self / world+self 时非空）。 */
  dueIntents?: Array<string>
  /** 到期计划中离线期间错过的条数（补醒时 >0 → 「错过了 N 个计划」）。 */
  missedCount?: number
  /** 计划定下时就已经过期（pet_schedule_wake 收到过去的时间戳，立即补醒一次）。 */
  overdue?: boolean
  /** 未到期的待执行计划（最近 ≤5 条）：世界时钟唤醒也告知模型自己的作息，
   * 继续、改时间或取消由模型决定。 */
  pendingPlans?: Array<{ at: number; intent: string }>
  /** 收件箱未读（按来源宠聚合）：prompt 只报数不携全文——想看就调
   * pet_inbox，读不读由她决定（宠物间消息的排队投递侧）。 */
  unread?: Array<{ fromName: string; count: number }>
}

/** Local HH:mm for plan times: the model's clock talk is the USER's wall
 * clock (logStamp precedent), and plans are compared against it. */
export const wakePlanClock = (at: number): string => {
  const d = new Date(at)
  const p = (n: number): string => String(n).padStart(2, '0')
  return `${p(d.getHours())}:${p(d.getMinutes())}`
}

/** The wake prompt. Time context is injected by the preset's time-context
 * row; the leading tag doubles as the durable trigger marker in the log —
 * and now names the SOURCE: [世界时钟] (the environment's tick), [自主唤醒]
 * (the model's own schedule, with the original intent), or the merged form. */
export function buildWakePrompt(facts: WakePromptFacts): string {
  const lastSpoke = facts.minutesSinceLastSpoke === undefined
    ? '这是你今天第一次醒来'
    : `你上次开口是 ${String(facts.minutesSinceLastSpoke)} 分钟前`
  const user = facts.userActive
    ? `用户最近正在会话中工作（${String(facts.minutesSinceUserActivity ?? 0)} 分钟内有动静）`
    : '用户最近没有活动'
  const ledgerLine = `好感 ${String(facts.affection)}（${moodOf(facts.affection)}）；羁绊 ${facts.bondTier}（一起过了 ${String(facts.bondDays)} 天）；${lastSpoke}；${user}。`
  const source = facts.source ?? 'world'
  const lines: string[] = []
  if (source === 'world') {
    lines.push('[世界时钟]', `环境节拍到了。${ledgerLine}`)
  } else {
    const due = facts.dueIntents ?? []
    const reason = source === 'self'
      ? '这是你自己定下的唤醒计划到点了'
      : '世界时钟与你定下的计划同时到点，合并成这一次醒来'
    const missed = facts.missedCount ?? 0
    const missedLine = missed > 0 ? `你离线期间错过了 ${String(missed)} 个已到期计划，和这次的一并处理；` : ''
    const overdueLine = facts.overdue === true ? '（注意：这个计划定下时时间就已过了，现在是补醒）' : ''
    lines.push(
      source === 'self' ? '[自主唤醒]' : '[世界时钟+自主唤醒]',
      `${reason}${overdueLine}。${missedLine}你当初的打算：${due.map(intent => `「${intent}」`).join('、')}。${ledgerLine}`,
    )
  }
  const pending = facts.pendingPlans ?? []
  if (pending.length > 0) {
    lines.push(
      `你还有 ${String(pending.length)} 个待执行计划：${pending.map(plan => `${wakePlanClock(plan.at)}「${plan.intent}」`).join('；')}。`
      + '继续等待、改时间或取消由你决定（pet_schedule_wake 同名覆盖即改期，pet_cancel_wake 撤销）。',
    )
  }
  const unread = facts.unread ?? []
  const unreadTotal = unread.reduce((sum, entry) => sum + entry.count, 0)
  if (unreadTotal > 0) {
    lines.push(
      `你有 ${String(unreadTotal)} 条未读消息（来自${unread.map(entry => ` ${entry.fromName}×${String(entry.count)}`).join('、')}），想看就调 pet_inbox，不理也行。`,
    )
  }
  lines.push('醒来想到什么就说一句（pet_say），想配动作就 pet_do；也可以只是安静待着（两者都不调，正文写「…」）。')
  return lines.join(' ')
}

/** A self-scheduled plan folded into a USER-initiated turn (chat 上行 / touch
 * 回应)：the plan sat within the ±60s merge window, so both wake in one —
 * the tag names the union ([用户+自主唤醒]) and the intent rides along. */
export interface MergedWakePlan {
  at: number
  intent: string
}

export interface TouchPromptFacts {
  part: string
  /** Touches on this pet today, from the ledger's recent window. */
  touchesToday: number
  affection: number
  /** ±60s 内到期的自主计划：合并进这次回应，计划标记为已消费。 */
  mergedPlan?: MergedWakePlan
}

export function buildTouchPrompt(facts: TouchPromptFacts): string {
  const wording = touchPartWording(facts.part) ?? '身体'
  const merged = facts.mergedPlan === undefined
    ? ''
    : `你定的计划「${facts.mergedPlan.intent}」也正好到点，这次一并处理；`
  return [
    facts.mergedPlan === undefined ? '[被触摸]' : '[用户+自主唤醒]',
    `用户刚摸了你的${wording}（今天第 ${String(facts.touchesToday)} 次，好感 ${String(facts.affection)}，${moodOf(facts.affection)}）。${merged}`,
    '回应一句（pet_say）或做个反应（pet_do）。',
  ].join(' ')
}

/** The chat上行 prompt (§6 2026-10-31 revision): the user typed at the
 * pet's surface. The text rides verbatim — the pet answers through pet_say
 * (and may pet_do); it is a conversation turn, not a touch reaction. Length
 * clamps to the contract's 2000-character ceiling. A plan inside the ±60s
 * merge window folds in: the tag becomes the union and the intent rides. */
export function buildChatPrompt(text: string, mergedPlan?: MergedWakePlan): string {
  const merged = mergedPlan === undefined
    ? ''
    : `[用户+自主唤醒] 用户正在跟你说话，恰好也到了你定的计划点（${wakePlanClock(mergedPlan.at)}「${mergedPlan.intent}」），合并成这一次醒来。\n`
  return `${merged}[用户对你说] ${text.slice(0, 2000)}`
}
