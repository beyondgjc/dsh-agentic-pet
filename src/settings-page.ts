/**

 * The settings page's host half: local HTTP routes backing the desktop

 * sidebar "桌宠" page (the client half lives in ./client/pet-settings.js and

 * registers through the web GUI's slot system, per the dsh-qqbot precedent).

 * Settings persist in their own JSON file in the dsh home — the platform

 * settings service derives namespaces from profile entry config schemas,

 * which this bundle does not declare; a file keeps the surface honest.

 * Routes use the raw handler form (resource routes postdate rc.3) behind a

 * same-origin loopback fence, one registration per path with internal method

 * dispatch — the webserver throws on duplicate path registration.

 * @module dsh-agentic-pet/settings-page

 */



import { spawn } from 'node:child_process'

import { existsSync } from 'node:fs'

import { rm } from 'node:fs/promises'

import type { IncomingMessage, ServerResponse } from 'node:http'

import { join } from 'node:path'

import type { Context } from '@deepseek-ai/cordis'

import {

  isPetPreset,

  patchTouchesElectronBinding,

  type AgentPresetFace,

  type SessionHeaderInfo,

  type SessionPersistenceFace,

  type SessionProjectionCacheFace,

  type SessionStoreFace,

} from './binding.ts'

import type { SummonOutcome } from './carrier-summon.ts'
import { voiceBindingSnapshot, type PetDriverControl } from './driver.ts'

import { readElectronRuntimeStatus } from './electron-runtime-status.ts'

import { DEFAULT_PERSONA, MAX_PERSONA_CHARS } from './persona.ts'
import { PET_PRESET_IDS } from './binding.ts'

import { parseClock } from './rhythm.ts'

import type { PetService } from './service.ts'



/** The proactivity switches. `enabled`/`cooldownMinutes`/

 * `idleThresholdMinutes` are the upcoming v1 speech scheduler's; the

 * `idleAnimation` pair is consumed TODAY by the renderer's idle theater

 * (riding to the pet on /state pushes). */

interface ProactivitySettings {

  enabled?: boolean

  cooldownMinutes?: number

  idleThresholdMinutes?: number

  idleAnimation?: boolean

  idleAnimationGapMinutes?: number

}



/** The inner voice (docs/inner-voice.md §9): the self-initiated expression

 * loop's config. The driver re-reads pet-settings.json fresh on every wake/

 * touch decision, so a saved patch takes effect without any push. */

interface InnerVoiceSettings {

  enabled?: boolean

  preset?: string

  wakeIntervalMinutes?: number

  speakProbability?: number

  touchReplyProbability?: number

  touchReplyCooldownSeconds?: number

  /** 自主唤醒（pet_schedule_wake 计划）到点遇用户忙的策略：

   * 'fire' = 到点必醒（默认）；'defer' = 忙时顺延下一拍重试。 */

  selfWakeBusyPolicy?: 'defer' | 'fire'

  /** 宠物间消息（pet_say audience 指向另一只宠）的投递方式：

   * 'queue' = 收件箱 + 下次唤醒报数（默认）；'immediate' = 立即唤醒目标。 */

  petToPetDelivery?: 'immediate' | 'queue'

  /** 宠物间定向消息的分档限频上限（滑动窗口分钟数固定 5/10/30/60）：

   * 任一档超了即拒。缺省 5/8/10/15。 */

  petMessageLimits?: { minutes5?: number; minutes10?: number; minutes30?: number; minutes60?: number }

  boundSessions?: Record<string, string>

  /** Per-pet preset overrides (petId → preset id, multi-pet): absent keys
   * follow the global `preset`. */
  presets?: Record<string, string>

}



/** Debug switches read by the carrier at startup (CDP needs a restart). */

interface DebugSettings {

  cdp?: boolean

}



/** Say-side TTS (BreezeBlue): consumed by the carrier's /say pipeline, which

 * re-reads pet-settings.json with an mtime cache — a saved switch reaches the

 * pet on its next utterance, no push and no restart. The key lives in the

 * same local settings file as the rest of the dsh home's machine-local

 * secrets; the voices proxy route below is the only code that forwards it

 * onward (the settings page's browser cannot reach api.breeze.blue: CORS). */

interface TtsSettings {

  enabled?: boolean

  apiKey?: string

  voiceId?: string

  modelId?: string

  languageCode?: string

  /** 0.5–2.0 */

  speed?: number

  /** 0.01–2.0 */

  volume?: number

  /** Per-pet voice identity (multi-instance): `voices[petId]` pins that
   * pet's voiceId/speed/volume; every other field stays shared. Each carrier
   * instance resolves its own entry (apps/pet tts.ts resolvePetTts) — unset
   * fields fall through to the shared defaults above. */

  voices?: Record<string, PetVoiceOverride>

}

/** One pet's voice override. An empty-string voiceId means "not set" (the
 * clear-on-empty semantics), never "mute". */

interface PetVoiceOverride {

  voiceId?: string

  /** 0.5–2.0 */

  speed?: number

  /** 0.01–2.0 */

  volume?: number

}



interface QuietSettings {

  from?: string

  to?: string

  allowTouchReply?: boolean

}



interface RhythmSettings {

  quiet?: QuietSettings | null

}



interface JournalSettings {

  enabled?: boolean

  injectRecent?: number

  maxEntryChars?: number

  maxFileBytes?: number

  allowUnboundAppend?: boolean

}



interface PresenceSettings {

  enabled?: boolean

}



interface PetSettings {

  proactivity?: ProactivitySettings

  innerVoice?: InnerVoiceSettings

  rhythm?: RhythmSettings

  journal?: JournalSettings

  presenceSummary?: PresenceSettings

  tts?: TtsSettings

  debug?: DebugSettings

  /** The user-editable character card (src/persona.ts): absent or empty
   * falls back to DEFAULT_PERSONA at prompt-assembly time. */
  persona?: string

  /** Per-preset persona slots (presetId → card): readPersonaCard resolves
   * personas.<presetId> → the global `persona` → DEFAULT_PERSONA. */
  personas?: Record<string, string>

}



const DEFAULT_SETTINGS: PetSettings = {

  proactivity: {

    enabled: false,

    cooldownMinutes: 10,

    idleThresholdMinutes: 5,

    idleAnimation: true,

    idleAnimationGapMinutes: 10,

  },

  innerVoice: {

    enabled: true,

    preset: 'whale598',

    wakeIntervalMinutes: 2,

    speakProbability: 0.5,

    touchReplyProbability: 0.3,

    touchReplyCooldownSeconds: 30,

    selfWakeBusyPolicy: 'fire',

    petToPetDelivery: 'queue',

    petMessageLimits: { minutes5: 5, minutes10: 8, minutes30: 10, minutes60: 15 },

    boundSessions: {},

  },

  rhythm: { quiet: null },

  journal: {

    enabled: true,

    injectRecent: 3,

    maxEntryChars: 120,

    maxFileBytes: 256 * 1024,

    allowUnboundAppend: false,

  },

  presenceSummary: { enabled: false },

  tts: { enabled: false },

  debug: { cdp: false },

}



/** The touch ledger the driver owns; reset writes the driver's empty shape. */

import * as petdata from './petdata.ts'



const EMPTY_LEDGER = { affection: 0, total: 0, byPart: {}, recent: [] }



/** Same-origin loopback fence (dsh-qqbot precedent): local host only, no

 * cross-site fetches, and an Origin header — when present — must be this

 * server's own host. */

function isTrusted(req: IncomingMessage): boolean {

  const host = req.headers.host

  if (typeof host !== 'string') return false

  let hostname: string

  try {

    hostname = new URL(`http://${host}`).hostname

  } catch {

    return false

  }

  if (!/^(\[::1\]|localhost|127(\.\d{1,3}){3})$/.test(hostname)) return false

  if (req.headers['sec-fetch-site'] === 'cross-site') return false

  const origin = req.headers.origin

  if (origin === undefined) return true

  try {

    return new URL(origin).host === host

  } catch {

    return false

  }

}



function writeJson(res: ServerResponse, status: number, body: unknown): void {

  res.writeHead(status, { 'content-type': 'application/json; charset=utf-8' })

  res.end(JSON.stringify(body))

}



async function readJsonBody(req: IncomingMessage): Promise<Record<string, unknown> | undefined> {

  const chunks: Buffer[] = []

  let size = 0

  for await (const chunk of req) {

    size += chunk.length

    if (size > 1024 * 1024) return undefined

    chunks.push(chunk as Buffer)

  }

  try {

    const parsed: unknown = JSON.parse(Buffer.concat(chunks).toString('utf8'))

    return typeof parsed === 'object' && parsed !== null ? parsed as Record<string, unknown> : undefined

  } catch {

    return undefined

  }

}



/** Clamp a number into [min, max]; undefined passthrough for absent input. */

function clampNumber(value: unknown, min: number, max: number): number | undefined {

  if (typeof value !== 'number' || !Number.isFinite(value)) return undefined

  return Math.min(max, Math.max(min, Math.round(value)))

}



/** Merge a patch into the settings, accepting only the known keys. Exported
 * for the persona-merge spec (tests/persona.spec.ts). */
export function mergeSettings(current: PetSettings, patch: Record<string, unknown>): PetSettings {

  const proactivity = { ...DEFAULT_SETTINGS.proactivity, ...current.proactivity }

  const innerVoice = { ...DEFAULT_SETTINGS.innerVoice, ...current.innerVoice }

  const rhythm: RhythmSettings = { quiet: null, ...current.rhythm }

  const journal: JournalSettings = { ...DEFAULT_SETTINGS.journal, ...current.journal }

  const presenceSummary: PresenceSettings = { enabled: false, ...current.presenceSummary }

  const debug = { ...DEFAULT_SETTINGS.debug, ...current.debug }

  const patchProactivity = patch.proactivity

  if (typeof patchProactivity === 'object' && patchProactivity !== null) {

    const p = patchProactivity as Record<string, unknown>

    if (typeof p.enabled === 'boolean') proactivity.enabled = p.enabled

    const cooldown = clampNumber(p.cooldownMinutes, 1, 240)

    if (cooldown !== undefined) proactivity.cooldownMinutes = cooldown

    const idle = clampNumber(p.idleThresholdMinutes, 1, 240)

    if (idle !== undefined) proactivity.idleThresholdMinutes = idle

    if (typeof p.idleAnimation === 'boolean') proactivity.idleAnimation = p.idleAnimation

    const gap = clampNumber(p.idleAnimationGapMinutes, 1, 120)

    if (gap !== undefined) proactivity.idleAnimationGapMinutes = gap

  }

  const patchInnerVoice = patch.innerVoice

  if (typeof patchInnerVoice === 'object' && patchInnerVoice !== null) {

    const v = patchInnerVoice as Record<string, unknown>

    if (typeof v.enabled === 'boolean') innerVoice.enabled = v.enabled

    if (typeof v.preset === 'string' && v.preset !== '') innerVoice.preset = v.preset

    const wake = clampNumber(v.wakeIntervalMinutes, 1, 60)

    if (wake !== undefined) innerVoice.wakeIntervalMinutes = wake

    // Probabilities stay fractional: clamp without the round() clampNumber applies.

    if (typeof v.speakProbability === 'number' && Number.isFinite(v.speakProbability)) {

      innerVoice.speakProbability = Math.min(1, Math.max(0, v.speakProbability))

    }

    if (typeof v.touchReplyProbability === 'number' && Number.isFinite(v.touchReplyProbability)) {

      innerVoice.touchReplyProbability = Math.min(1, Math.max(0, v.touchReplyProbability))

    }

    const replyCooldown = clampNumber(v.touchReplyCooldownSeconds, 0, 600)

    if (replyCooldown !== undefined) innerVoice.touchReplyCooldownSeconds = replyCooldown

    // 自主唤醒忙时策略：只收白名单里的两个值，其余折叠默认（'fire'）。

    if (v.selfWakeBusyPolicy === 'defer' || v.selfWakeBusyPolicy === 'fire') {

      innerVoice.selfWakeBusyPolicy = v.selfWakeBusyPolicy

    }

    // 宠物间消息投递方式：白名单两值，其余折叠默认（'queue'）。

    if (v.petToPetDelivery === 'immediate' || v.petToPetDelivery === 'queue') {

      innerVoice.petToPetDelivery = v.petToPetDelivery

    }

    // 宠物间定向消息分档限频上限：逐档钳 0-999，patch 缺的档位保持现值。

    const patchLimits = v.petMessageLimits as
      | { minutes5?: unknown; minutes10?: unknown; minutes30?: unknown; minutes60?: unknown }
      | undefined

    if (typeof patchLimits === 'object' && patchLimits !== null) {

      const merged = { minutes5: 5, minutes10: 8, minutes30: 10, minutes60: 15, ...innerVoice.petMessageLimits }

      const base = {

        minutes5: merged.minutes5 ?? 5,

        minutes10: merged.minutes10 ?? 8,

        minutes30: merged.minutes30 ?? 10,

        minutes60: merged.minutes60 ?? 15,

      }

      const clampLimit = (value: unknown, fallback: number): number => {

        const parsed = clampNumber(value, 0, 999)

        return parsed === undefined ? fallback : parsed

      }

      innerVoice.petMessageLimits = {

        minutes5: clampLimit(patchLimits.minutes5, base.minutes5),

        minutes10: clampLimit(patchLimits.minutes10, base.minutes10),

        minutes30: clampLimit(patchLimits.minutes30, base.minutes30),

        minutes60: clampLimit(patchLimits.minutes60, base.minutes60),

      }

    }

    // Manual binding: petId → session id, empty strings dropped; an absent

    // key in the patch leaves the stored map untouched (partial updates).

    const bound = v.boundSessions

    if (typeof bound === 'object' && bound !== null) {

      const record: Record<string, string> = {}

      for (const [petId, sessionId] of Object.entries(bound as Record<string, unknown>)) {

        if (petId !== '' && typeof sessionId === 'string' && sessionId !== '') record[petId] = sessionId

      }

      innerVoice.boundSessions = record

    }

    // Per-pet preset overrides (multi-pet): petId → preset id. Only ids the

    // host registers survive; an empty string deletes the pet's key (follow

    // the global default again); absent keys in the patch are preserved.

    const perPetPresets = v.presets

    if (typeof perPetPresets === 'object' && perPetPresets !== null) {

      const record: Record<string, string> = {}

      for (const [petId, presetId] of Object.entries(perPetPresets as Record<string, unknown>)) {

        if (petId === '' || typeof presetId !== 'string' || presetId === '') continue

        if (isPetPreset(presetId)) record[petId] = presetId

      }

      innerVoice.presets = record

    }

  }

  const patchRhythm = patch.rhythm

  if (typeof patchRhythm === 'object' && patchRhythm !== null) {

    const r = patchRhythm as Record<string, unknown>

    if (r.quiet === null) {

      rhythm.quiet = null

    } else if (typeof r.quiet === 'object' && r.quiet !== null) {

      const q = r.quiet as Record<string, unknown>

      const currentQuiet = current.rhythm?.quiet ?? undefined

      const from = typeof q.from === 'string' && parseClock(q.from) !== undefined

        ? q.from

        : (currentQuiet?.from ?? '01:00')

      const to = typeof q.to === 'string' && parseClock(q.to) !== undefined

        ? q.to

        : (currentQuiet?.to ?? '09:00')

      const allow = typeof q.allowTouchReply === 'boolean'

        ? q.allowTouchReply

        : (currentQuiet?.allowTouchReply ?? true)

      rhythm.quiet = { from, to, allowTouchReply: allow }

    }

  }

  const patchJournal = patch.journal

  if (typeof patchJournal === 'object' && patchJournal !== null) {

    const j = patchJournal as Record<string, unknown>

    if (typeof j.enabled === 'boolean') journal.enabled = j.enabled

    const inject = clampNumber(j.injectRecent, 1, 20)

    if (inject !== undefined) journal.injectRecent = inject

    const chars = clampNumber(j.maxEntryChars, 40, 1000)

    if (chars !== undefined) journal.maxEntryChars = chars

    const bytes = clampNumber(j.maxFileBytes, 4096, 4 * 1024 * 1024)

    if (bytes !== undefined) journal.maxFileBytes = bytes

    if (typeof j.allowUnboundAppend === 'boolean') journal.allowUnboundAppend = j.allowUnboundAppend

  }

  const patchPresence = patch.presenceSummary

  if (typeof patchPresence === 'object' && patchPresence !== null) {

    const p = patchPresence as Record<string, unknown>

    if (typeof p.enabled === 'boolean') presenceSummary.enabled = p.enabled

  }

  const patchDebug = patch.debug

  if (typeof patchDebug === 'object' && patchDebug !== null) {

    const d = patchDebug as Record<string, unknown>

    if (typeof d.cdp === 'boolean') debug.cdp = d.cdp

  }

  const tts = { ...current.tts }

  const patchTts = patch.tts

  if (typeof patchTts === 'object' && patchTts !== null) {

    const t = patchTts as Record<string, unknown>

    if (typeof t.enabled === 'boolean') tts.enabled = t.enabled

    // Credentials and ids: empty string clears the stored value (the carrier

    // treats absent/empty as "not configured" — the pipeline stays off).

    const setText = (key: 'apiKey' | 'voiceId' | 'modelId' | 'languageCode'): void => {

      const value = t[key]

      if (typeof value !== 'string') return

      const trimmed = value.trim()

      if (trimmed === '') Reflect.deleteProperty(tts, key)

      else tts[key] = trimmed

    }

    setText('apiKey')

    setText('voiceId')

    setText('modelId')

    setText('languageCode')

    // Fractional ranges: clamp without the round() clampNumber applies.

    if (typeof t.speed === 'number' && Number.isFinite(t.speed)) tts.speed = Math.min(2, Math.max(0.5, t.speed))

    if (typeof t.volume === 'number' && Number.isFinite(t.volume)) tts.volume = Math.min(2, Math.max(0.01, t.volume))

    // Per-pet voice overrides: merge petId key by key. Keys absent from the
    // patch survive (a one-pet save must not wipe hand-edited entries); an
    // entry whose every field clears is removed so the table never fills
    // with husks. An empty-string voiceId is clear-on-empty ("not set"),
    // never "mute" — the carrier folds it through to the shared default.

    const patchVoices = t.voices

    if (typeof patchVoices === 'object' && patchVoices !== null) {

      const merged: Record<string, PetVoiceOverride> = { ...(tts.voices ?? {}) }

      for (const [petId, rawEntry] of Object.entries(patchVoices as Record<string, unknown>)) {

        // An explicit null entry deletes that pet's override (the UI's 清除
        // button): the pet falls back to the shared defaults entirely.

        if (rawEntry === null) { Reflect.deleteProperty(merged, petId); continue }

        if (typeof rawEntry !== 'object' || rawEntry === null) continue

        const entry = rawEntry as Record<string, unknown>

        const pet: PetVoiceOverride = { ...(merged[petId] ?? {}) }

        // A null FIELD clears it (delete → fall back to the shared default):
        // under per-key merge, an absent key means "keep", so clearing needs
        // its own signal. An empty-string voiceId clears too (the text-input
        // clear-on-empty convention); speed/volume use null only.

        const overrideVoiceId = entry.voiceId

        if (overrideVoiceId === null) Reflect.deleteProperty(pet, 'voiceId')

        else if (typeof overrideVoiceId === 'string') {

          const trimmed = overrideVoiceId.trim()

          if (trimmed === '') Reflect.deleteProperty(pet, 'voiceId')

          else pet.voiceId = trimmed

        }

        if (entry.speed === null) Reflect.deleteProperty(pet, 'speed')

        else if (typeof entry.speed === 'number' && Number.isFinite(entry.speed)) pet.speed = Math.min(2, Math.max(0.5, entry.speed))

        if (entry.volume === null) Reflect.deleteProperty(pet, 'volume')

        else if (typeof entry.volume === 'number' && Number.isFinite(entry.volume)) pet.volume = Math.min(2, Math.max(0.01, entry.volume))

        if (Object.keys(pet).length === 0) Reflect.deleteProperty(merged, petId)

        else merged[petId] = pet

      }

      if (Object.keys(merged).length === 0) Reflect.deleteProperty(tts, 'voices')

      else tts.voices = merged

    }

  }

  // Persona (the user-editable character card, src/persona.ts): a string leaf
  // with the same clear-on-empty semantics as the TTS texts — an empty save
  // DELETES the key so the persona row falls back to DEFAULT_PERSONA, and a
  // hand-edited oversized card is truncated rather than trusted.

  const patchPersona = patch.persona

  let persona: string | undefined = current.persona

  if (typeof patchPersona === 'string') {

    const trimmed = patchPersona.trim()

    if (trimmed === '') persona = undefined

    else persona = trimmed.length > MAX_PERSONA_CHARS ? trimmed.slice(0, MAX_PERSONA_CHARS) : trimmed

  }

  // NOTE: display names are NOT a pet-settings.json section anymore — they

  // live in whale598/<petId>/pet-name.json (see the update handler).

  // pet-settings.json is SHARED with the carrier (its tuning/outfit/rev keys

  // live in the same file): preserve every key this page does not own, or one

  // save here silently wipes the carrier's half.

  const next = { ...current, proactivity, innerVoice, rhythm, journal, presenceSummary, tts, debug }

  // The cleared-card case must remove the key, not spread `undefined` over
  // it — `...current` already carried the stored value into `next`.

  if (persona === undefined) Reflect.deleteProperty(next, 'persona')

  else next.persona = persona

  // Per-preset persona slots (multi-pet): presetId → card, same per-entry

  // semantics as the global leaf — trim, cap, empty string deletes the slot

  // (falls back through the global card to DEFAULT_PERSONA); absent keys in

  // the patch are preserved (partial updates).

  const patchPersonas = patch.personas

  let personas: Record<string, string> | undefined = current.personas

  if (typeof patchPersonas === 'object' && patchPersonas !== null) {

    const record: Record<string, string> = { ...(personas ?? {}) }

    for (const [presetId, card] of Object.entries(patchPersonas as Record<string, unknown>)) {

      if (presetId === '') continue

      if (typeof card !== 'string') continue

      const trimmed = card.trim()

      if (trimmed === '') Reflect.deleteProperty(record, presetId)

      else record[presetId] = trimmed.length > MAX_PERSONA_CHARS ? trimmed.slice(0, MAX_PERSONA_CHARS) : trimmed

    }

    personas = record

  }

  if (personas !== undefined) next.personas = personas

  else Reflect.deleteProperty(next, 'personas')

  return next

}



function openPathInFileManager(path: string): void {

  if (process.platform === 'win32') {

    spawn('explorer.exe', [path], { detached: true, stdio: 'ignore' }).unref()

    return

  }

  const command = process.platform === 'darwin' ? 'open' : 'xdg-open'

  spawn(command, [path], { detached: true, stdio: 'ignore' }).unref()

}



/**

 * Register the settings page's routes. One registration per exact path with

 * internal method dispatch; every handler runs behind the fence.

 * @param ctx - plugin context inside the runtime.

 * @param home - the dsh home holding the settings/ledger/manifest files.

 */

/** The multi-instance face (multi-pet design §4): per-pet summon/dismiss
 * backed by the plugin's spawn machinery. petId 'new' allocates the next
 * free instance id; the primary summons through the plain summon face. */
export interface InstanceControl {
  summonInstance(petId?: string): Promise<SummonOutcome & { petId?: string }>
  dismissInstance(petId: string): Promise<{ ok: boolean; reason?: string }>
}

export function installSettingsPage(

  ctx: Context,

  home: string,

  pet: PetService,

  control?: PetDriverControl,

  summon?: () => SummonOutcome,

  instances?: InstanceControl,

): void {

  // Pet visibility flows through the capability seam: discovery, liveness,

  // and the /status field matrix are the service's job — this page only

  // renders.

  // pet-settings.json / pet-window.json moved under whale598/ — reads fall

  // back to the legacy root copies (petdata), writes go to the new layout.

  const windowPath = petdata.globalFilePath(home, 'pet-window.json')



  /** Summarize EVERY live pet (id, online flag, normalized /status). */

  const petStatus = async (): Promise<{ pets: Array<Record<string, unknown>> }> => {

    const pets = await Promise.all((await pet.list()).map(entry => pet.snapshot(entry)))

    return {

      pets: pets.map(({ id, online, ...rest }) => ({ id, online, ...rest })),

    }

  }



  const readSettings = async (): Promise<PetSettings> => {

    // readGlobalJson: whale598/ → legacy root → {} (mergeSettings folds defaults)

    const parsed = await petdata.readGlobalJson(home, 'pet-settings.json') as PetSettings

    return mergeSettings(parsed, {})

  }



  /** Live header first, persisted header second. `checked:false` means the

   * host exposed neither source — never turn that into a "missing session".

   * `currentPreset` comes from the preset registry / projection cache, NOT

   * from the immutable creation-time header field. */

  const findSessionHeader = async (

    sessionId: string,

  ): Promise<{

    header: SessionHeaderInfo | undefined

    checked: boolean

    currentPreset: string | undefined

  }> => {

    const getService = (name: string): unknown => (ctx as { get(name: string): unknown }).get(name)

    const sessions = getService('sessions') as SessionStoreFace | undefined

    const agentPresets = getService('agentPresets') as AgentPresetFace | undefined

    const live = sessions?.get(sessionId)

    if (live?.header !== undefined) {

      let currentPreset: string | undefined

      try {

        const preset = agentPresets?.presetForSession(live)

        if (typeof preset === 'string' && preset !== '') currentPreset = preset

      } catch {

        // Unknown preset is not an error.

      }

      return { header: live.header, checked: true, currentPreset }

    }

    const persistence = getService('sessionPersistence') as SessionPersistenceFace | undefined

    if (persistence === undefined) {

      return { header: undefined, checked: sessions !== undefined, currentPreset: undefined }

    }

    try {

      const snapshots = await persistence.list()

      const header = snapshots.find(snapshot => snapshot.header?.id === sessionId)?.header

      let currentPreset: string | undefined

      if (header !== undefined) {

        const cache = getService('sessionProjectionCache') as SessionProjectionCacheFace | undefined

        try {

          const preset = cache?.cachedSnapshot(header)?.values?.agentPreset

          if (typeof preset === 'string' && preset !== '') currentPreset = preset

        } catch {

          // Unknown preset is not an error.

        }

      }

      return { header, checked: true, currentPreset }

    } catch {

      return { header: undefined, checked: false, currentPreset: undefined }

    }

  }



  const routeByPath = new Map<string, Map<string, (req: IncomingMessage, res: ServerResponse) => Promise<void>>>()

  const route = (

    method: 'GET' | 'POST',

    path: string,

    handler: (req: IncomingMessage, res: ServerResponse) => Promise<void>,

  ): void => {

    let handlers = routeByPath.get(path)

    if (handlers === undefined) {

      handlers = new Map()

      routeByPath.set(path, handlers)

      ctx.effect(() => ctx.webServer.register({

        kind: 'exact',

        path,

        handler: async (req: unknown, res: unknown) => {

          const httpReq = req as IncomingMessage

          const httpRes = res as ServerResponse

          if (!isTrusted(httpReq)) {

            writeJson(httpRes, 403, { error: 'refused: same-origin loopback only' })

            return

          }

          const registered = handlers?.get(String(httpReq.method ?? '').toUpperCase())

          if (registered === undefined) {

            writeJson(httpRes, 405, { error: 'method not allowed' })

            return

          }

          try {

            await registered(httpReq, httpRes)

          } catch (error: unknown) {

            writeJson(httpRes, 500, { error: error instanceof Error ? error.message : String(error) })

          }

        },

      } as Parameters<typeof ctx.webServer.register>[0]), `pet-surface: settings ${path}`)

    }

    handlers.set(method, handler)

  }



  route('GET', '/api/pet-settings/binding-status', async (_req, res) => {

    writeJson(res, 200, { status: voiceBindingSnapshot() })

  })



  route('POST', '/api/pet-settings/binding-test', async (req, res) => {

    if (control === undefined) {

      writeJson(res, 503, { error: 'driver control unavailable' })

      return

    }

    const body = await readJsonBody(req)

    const petId = typeof body?.petId === 'string' && body.petId !== '' ? body.petId : 'electron'

    const result = await control.testBinding(petId)

    writeJson(res, 200, result)

  })



  route('GET', '/api/pet-settings/read', async (_req, res) => {

    const [settings, status] = await Promise.all([

      readSettings(),

      petStatus(),

    ])

    // Window positions are per-pet state (whale598/<petId>/pet-window.json —
    // the carrier writes its own file under DSH_PET_ID). The legacy
    // windowPosition field stays for response compat: the electron pet's
    // position, via the readPetStateJson fallback chain.

    const windowPositions: Record<string, unknown> = {}

    for (const id of new Set([...await petdata.existingPetIds(home), 'electron'])) {

      const raw = await petdata.readPetStateJson(home, id, 'pet-window.json')

      if (Object.keys(raw).length > 0) windowPositions[id] = raw

    }

    const windowPosition = (windowPositions['electron'] ?? null) as Record<string, unknown> | null

    // Per-pet affection books: the registry's pet ids plus the legacy single

    // book (folded under 'electron' for pre-registry history).

    const affection: Record<string, unknown> = {}

    const bookIds = new Set(status.pets.map(pet => String(pet.id)))

    bookIds.add('electron')

    for (const id of bookIds) {

      const book = await petdata.readAffectionRaw(home, id)

      if (book !== null) affection[id] = book

    }

    // Display names: composed from the per-pet store (legacy fallbacks

    // inside petdata), so the client keeps its `settings.names` map shape.

    const names: Record<string, string> = {}

    for (const id of bookIds) {

      const label = await petdata.readPetName(home, id)

      if (label !== undefined) names[id] = label

    }

    const composed = { ...settings, names }

    // 三期 touch totals: per-pet touch facts aggregated from the events

    // stream (tool calls live in the session transcripts, not here).

    const touchTotals: Record<string, { total: number; byPart: Record<string, number> }> = {}

    for (const id of bookIds) {

      const events = await petdata.readJsonl(petdata.eventsFile(home, id), 600)

      const totals = { total: 0, byPart: {} as Record<string, number> }

      for (const event of events) {

        if (event.type !== 'touch') continue

        const part = typeof event.part === 'string' ? event.part : 'miss'

        totals.total += 1

        totals.byPart[part] = (totals.byPart[part] ?? 0) + 1

      }

      if (totals.total > 0) touchTotals[id] = totals

    }

    // The persona card (src/persona.ts): current value plus the default and
    // cap so the client can placeholder and count without hardcoding the
    // row's constants.

    const persona = {

      value: typeof settings.persona === 'string' ? settings.persona : '',

      default: DEFAULT_PERSONA,

      maxLength: MAX_PERSONA_CHARS,

    }

    // Per-preset persona slots (multi-pet): one entry per registered pet
    // preset, each resolved through the row's fallback chain
    // (personas.<key> → global persona → DEFAULT_PERSONA). `inherited`
    // tells the client the slot shows a card it does not own — editing
    // materializes it onto the slot.

    const slots = typeof settings.personas === 'object' && settings.personas !== null

      ? settings.personas as Record<string, unknown>

      : {}

    const personas: Record<string, { value: string; default: string; maxLength: number; inherited: boolean }> = {}

    for (const presetId of PET_PRESET_IDS) {

      if (presetId === 'pet-inner-voice' || presetId === 'pet') continue // legacy ids, not real slots

      const own = typeof slots[presetId] === 'string' ? (slots[presetId] as string).trim() : ''

      const global = typeof settings.persona === 'string' ? settings.persona.trim() : ''

      const value = own !== '' ? own : global !== '' ? global : DEFAULT_PERSONA

      personas[presetId] = {

        value,

        default: DEFAULT_PERSONA,

        maxLength: MAX_PERSONA_CHARS,

        inherited: own === '',

      }

    }

    writeJson(res, 200, { settings: composed, affection, windowPosition, windowPositions, pets: status.pets, touchTotals, persona, personas })

  })



  route('GET', '/api/pet-settings/electron-runtime', async (_req, res) => {

    writeJson(res, 200, { ok: true, runtime: readElectronRuntimeStatus(home) ?? null })

  })



  route('POST', '/api/pet-settings/summon', async (_req, res) => {

    // The summon card's back end. Liveness first: the card hides client-side

    // when a pet is up, this guards the double click (and the page-stale race).

    // Otherwise the pure plan decides — spawn now, or kick the electron

    // installer — and the carrier's single-instance lock keeps a lost race

    // harmless.

    const status = await petStatus()

    if (status.pets.some(entry => entry.online === true)) {

      writeJson(res, 200, { ok: true, started: false, reason: 'already-running' } satisfies SummonOutcome)

      return

    }

    const outcome = summon === undefined

      ? { ok: false, started: false, reason: 'unsupported' }

      : summon()

    writeJson(res, 200, outcome)

  })



  route('POST', '/api/pet-settings/instance/summon', async (req, res) => {

    // Per-pet summon (multi-pet design §4): petId 'new' allocates the next

    // free electron-N instance; a named extra id summons that instance; the

    // primary rides the plain summon face. Admission (cap/duplicate) is the

    // instance layer's job.

    if (instances === undefined) {

      writeJson(res, 200, { ok: false, started: false, reason: 'unsupported' })

      return

    }

    const body = await readJsonBody(req)

    const petId = typeof body?.petId === 'string' && body.petId !== '' ? body.petId : undefined

    const outcome = await instances.summonInstance(petId)

    writeJson(res, 200, outcome)

  })



  route('POST', '/api/pet-settings/instance/dismiss', async (req, res) => {

    // 送走: kill the instance and drop it from the desired set. The primary

    // refuses (it IS this bundle's carrier).

    if (instances === undefined) {

      writeJson(res, 200, { ok: false, reason: 'unsupported' })

      return

    }

    const body = await readJsonBody(req)

    const petId = typeof body?.petId === 'string' ? body.petId : ''

    const outcome = await instances.dismissInstance(petId)

    writeJson(res, 200, outcome)

  })



  route('POST', '/api/pet-settings/update', async (req, res) => {

    const body = await readJsonBody(req)

    const patch = body === undefined ? undefined : body.patch

    if (typeof patch !== 'object' || patch === null) {

      writeJson(res, 400, { error: 'body must be {patch:{...}}' })

      return

    }

    // names moved OUT of pet-settings.json into whale598/<petId>/pet-name.json:

    // the patch's names map writes per-pet files (missing key = revert to the

    // built-in default) and is stripped from the settings file entirely.

    const patchNames = (patch as Record<string, unknown>).names

    if (typeof patchNames === 'object' && patchNames !== null) {

      for (const [petId, label] of Object.entries(patchNames as Record<string, unknown>)) {

        await petdata.writePetName(home, petId, typeof label === 'string' && label.trim() !== '' ? label : null)

      }

      delete (patch as Record<string, unknown>).names

    }

    const current = await readSettings()

    const next = mergeSettings(current, patch as Record<string, unknown>)

    // Binding validation is patch-aware: only a save that actually edits the

    // electron binding is hard-blocked. An EXISTING binding that later became

    // non-pet (the user switched modes, or hand-edited JSON) must not turn

    // every unrelated settings save into a 400 — that reads as "settings page

    // broken". Existing invalid bindings degrade to a warning.

    const warnings: string[] = []

    const patchTouchesBinding = patchTouchesElectronBinding(patch as Record<string, unknown>)

    const bound = next.innerVoice?.boundSessions?.electron

    if (typeof bound === 'string' && bound !== '') {

      const found = await findSessionHeader(bound)

      if (found.checked && found.header === undefined) {

        warnings.push(`会话 ${bound} 不存在`)

      } else {

        if (found.currentPreset !== undefined && !isPetPreset(found.currentPreset)) {

          if (patchTouchesBinding) {

            writeJson(res, 400, {

              error: `这个会话的当前模式是「${found.currentPreset}」，没有 pet_say/pet_do。`

                + '请改用宠物模式（「精简（仅表达）」或「普通（含工作工具）」）的会话，'

                + '或新建一个宠物模式会话后再绑定。',

            })

            return

          }

          warnings.push('当前已保存的绑定会话不是宠物模式；本次保存已生效，但绑定不会有气泡回应。')

        }

        if (found.currentPreset === undefined && found.header !== undefined) {

          warnings.push('无法确认这个会话的当前模式；如果它不是宠物模式，绑定后不会有气泡回应。')

        }

      }

    }

    await petdata.writeGlobalJson(home, 'pet-settings.json', next as Record<string, unknown>)

    // The driver re-pushes the autonomy payload to the pets on this event —

    // a changed switch reaches the renderer without waiting for the next

    // session state transition.

    ctx.emit('pet-settings/changed')

    writeJson(res, 200, { ok: true, settings: next, warnings })

  })



  route('POST', '/api/pet-settings/reset-affection', async (_req, res) => {

    await petdata.writeAffectionRaw(home, 'electron', EMPTY_LEDGER)

    writeJson(res, 200, { ok: true, affection: EMPTY_LEDGER })

  })



  route('POST', '/api/pet-settings/reset-position', async (_req, res) => {

    // Per-pet files first (whale598/<petId>/pet-window.json), then the two

    // legacy layers (whale598 root, ~/.dsh root).

    for (const id of await petdata.existingPetIds(home)) {

      await rm(petdata.petStatePaths(home, id, 'pet-window.json').current, { force: true })

    }

    for (const p of [windowPath, join(home, 'pet-window.json')]) await rm(p, { force: true })

    writeJson(res, 200, { ok: true })

  })



  route('POST', '/api/pet-settings/open-logs', async (_req, res) => {

    const logsDir = join(home, 'logs')

    const target = existsSync(logsDir) ? logsDir : home

    openPathInFileManager(target)

    writeJson(res, 200, { ok: true, opened: target })

  })



  route('GET', '/api/pet-settings/tts/voices', async (req, res) => {

    // The BreezeBlue voices search, proxied with the stored key: the settings

    // page's browser cannot call api.breeze.blue itself (CORS), and the key

    // never leaves this loopback process. A trimmed voice list is all the

    // picker needs (voice_id/name/language/gender/tone/accent/preview_url).

    const settings = await readSettings()

    const apiKey = typeof settings.tts?.apiKey === 'string' ? settings.tts.apiKey : ''

    if (apiKey === '') {

      writeJson(res, 400, { error: '尚未配置 BreezeBlue API key' })

      return

    }

    const url = new URL(req.url ?? '/', 'http://127.0.0.1')

    const params = new URLSearchParams()

    for (const key of ['search', 'language_code', 'gender', 'accent']) {

      const value = url.searchParams.get(key)

      if (value !== null && value !== '') params.set(key, value)

    }

    const rawPageSize = url.searchParams.get('page_size')

    const pageSize = rawPageSize !== null ? clampNumber(Number(rawPageSize), 1, 100) : undefined

    params.set('page_size', String(pageSize ?? 30))

    try {

      const response = await fetch(`https://api.breeze.blue/v1/voices?${params.toString()}`, {

        headers: { 'xi-api-key': apiKey },

        signal: AbortSignal.timeout(10_000),

      })

      if (!response.ok) {

        const detail = await response.text().catch(() => '')

        // 401 is the "wrong key" case by far the most likely: name the fix,

        // not just the wire fact (a key copied from another service reads

        // identically to a revoked one here).

        const message = response.status === 401

          ? 'BreezeBlue 拒绝了这个 key（401）：请到 breezeblue.ai 的 Developer Console 复制 brz_ 开头的 API key'

          : `BreezeBlue HTTP ${String(response.status)}${detail ? `: ${detail.slice(0, 200)}` : ''}`

        writeJson(res, 502, { error: message })

        return

      }

      const raw = await response.json() as { voices?: unknown; total?: unknown }

      const voices = (Array.isArray(raw.voices) ? raw.voices : []).map((entry) => {

        const voice = entry as Record<string, unknown>

        const str = (key: string): string | null => typeof voice[key] === 'string' ? voice[key] as string : null

        return {

          voice_id: str('voice_id') ?? '',

          name: str('name') ?? '',

          language_code: str('language_code'),

          gender: str('gender'),

          tone: Array.isArray(voice.tone) ? voice.tone.filter((item): item is string => typeof item === 'string').slice(0, 3) : [],

          accent: str('accent'),

          preview_url: str('preview_url'),

        }

      }).filter(voice => voice.voice_id !== '')

      writeJson(res, 200, { voices, total: typeof raw.total === 'number' ? raw.total : voices.length })

    } catch (error: unknown) {

      writeJson(res, 502, { error: `声音列表请求失败: ${error instanceof Error ? error.message : String(error)}` })

    }

  })

}
