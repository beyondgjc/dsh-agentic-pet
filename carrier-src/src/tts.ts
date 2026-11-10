/**
 * Say-side TTS (BreezeBlue): speech synthesis as the /say bubble's voice.
 * The control plane hands every spoken text here; this module owns the
 * DELIVERY to the page — when synthesis is configured it holds the bubble
 * until the mp3 lands (bounded by `holdMs`, default 3s) and forwards text +
 * audio as ONE message, so the pet's mouth and voice start together. A
 * timeout or failure shows the bubble alone and discards the late audio:
 * the complaint to avoid is a voice trailing seconds behind its text. With
 * synthesis off, delivery is the immediate bubble — yesterday's behavior.
 *
 * Any failure (no key, rate limit, network) degrades to visual-only and
 * never surfaces to the driver: the /say HTTP response keeps its
 * fire-and-forget budget, the delivery race runs entirely out-of-band.
 *
 * Configuration lives in the shared pet-settings.json (`tts` section, written
 * by the plugin's settings page) and is read lazily per utterance with an
 * mtime cache: a saved switch reaches the pet without any push or restart.
 * Voice identity is per pet: `tts.voices[petId]` may pin its own voiceId,
 * speed and volume (the settings page writes one table, every carrier
 * instance resolves its own entry); unset fields fall through to the shared
 * defaults, so single-pet setups behave exactly as before.
 *
 * The wire surface is a bare fetch against the BreezeBlue REST endpoint (no
 * SDK — the carrier carries none): POST /v1/text-to-speech/{voice_id} with
 * the `xi-api-key` header answers the mp3 bytes directly.
 */

import { statSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import type { BrowserWindow } from 'electron'

/** The `tts` section of pet-settings.json. Absent/disabled/degenerate → the
 * pipeline stays silent (visual-only bubbles, yesterday's behavior). */
export interface TtsConfig {
  enabled?: boolean
  apiKey?: string
  voiceId?: string
  modelId?: string
  languageCode?: string
  /** 0.5–2.0, 1 = default. */
  speed?: number
  /** 0.01–2.0, 1 = default. */
  volume?: number
  /** How long the bubble may wait for the audio before going out alone
   * (0–8000, default 3000). 0 = never hold (bubble immediate, voice off). */
  holdMs?: number
}

interface SayTtsDeps {
  /** The dsh home holding pet-settings.json (whale598/ first, legacy root
   * fallback — same dual-path rule as the driver's petdata). */
  home: string
  /** This carrier instance's pet id (DSH_PET_ID): the key this instance
   * resolves its voice override with from the shared `tts.voices` table. */
  petId: string
  window: BrowserWindow
  /** The one delivery channel to the page: the bubble, optionally with its
   * voice. Main process owns the wire shape; this module owns the timing. */
  deliver: (text: string, audio?: Uint8Array<ArrayBuffer>) => void
  log?: (line: string) => void
}

export interface SayTts {
  /** Forward one /say text to the page. Fire-and-forget: returns
   * immediately, never throws, and a newer call always wins — the older
   * delivery is abandoned (the newest say owns the bubble and the voice). */
  deliver(text: string): void
}

/** The BreezeBlue TTS endpoint (convert, synchronous mp3). */
const TTS_URL = 'https://api.breeze.blue/v1/text-to-speech'
/** Bounded wait for one synthesis round trip; the bubble shows regardless. */
const REQUEST_TIMEOUT_MS = 20_000
/** The bubble's default patience for its voice: the mp3 lands earlier →
 * bubble + voice go out together at once (this hold is a TIMEOUT ceiling,
 * never a fixed wait); later → the bubble goes alone and the audio is
 * discarded, so a voice never trails its text. */
const DEFAULT_HOLD_MS = 5_000
/** A 200-char mp3 is at most ~1.5MB; anything larger is not a say track. */
const MAX_AUDIO_BYTES = 8_000_000
/** Repeating the identical text within this window re-shows the bubble but
 * does not re-speak (model double-calls should not double-talk). */
const DEDUPE_MS = 3_000
/** After a 429, stay silent until the (capped) Retry-After lapses. */
const RATE_LIMIT_CAP_S = 300

/** Defensive extraction of the settings section: unknown shapes degrade to
 * "unset" and the pipeline treats the feature as off. */
function normalizeTts(raw: unknown): TtsConfig {
  if (typeof raw !== 'object' || raw === null) return {}
  const record = raw as Record<string, unknown>
  const config: TtsConfig = {}
  if (typeof record.enabled === 'boolean') config.enabled = record.enabled
  if (typeof record.apiKey === 'string') config.apiKey = record.apiKey
  if (typeof record.voiceId === 'string') config.voiceId = record.voiceId
  if (typeof record.modelId === 'string' && record.modelId !== '') config.modelId = record.modelId
  if (typeof record.languageCode === 'string' && record.languageCode !== '') config.languageCode = record.languageCode
  if (typeof record.speed === 'number' && Number.isFinite(record.speed)) {
    config.speed = Math.min(2, Math.max(0.5, record.speed))
  }
  if (typeof record.volume === 'number' && Number.isFinite(record.volume)) {
    config.volume = Math.min(2, Math.max(0.01, record.volume))
  }
  if (typeof record.holdMs === 'number' && Number.isFinite(record.holdMs)) {
    config.holdMs = Math.min(8000, Math.max(0, Math.round(record.holdMs)))
  }
  return config
}

/** Resolve the section for one pet: the shared defaults with this pet's
 * `voices[petId]` entry overlaid field-by-field (voiceId / speed / volume
 * only — key, model, enabled and hold are account- or timing-level and stay
 * shared). Unknown shapes fold away, so a malformed override simply falls
 * through to the global defaults. An empty-string voiceId is "not set" (the
 * settings page's clear-on-empty), never "mute". */
export function resolvePetTts(raw: unknown, petId: string): TtsConfig {
  const config = normalizeTts(raw)
  if (typeof raw !== 'object' || raw === null) return config
  const voices = (raw as Record<string, unknown>).voices
  if (typeof voices !== 'object' || voices === null) return config
  const override = (voices as Record<string, unknown>)[petId]
  if (typeof override !== 'object' || override === null) return config
  const record = override as Record<string, unknown>
  if (typeof record.voiceId === 'string' && record.voiceId !== '') config.voiceId = record.voiceId
  if (typeof record.speed === 'number' && Number.isFinite(record.speed)) {
    config.speed = Math.min(2, Math.max(0.5, record.speed))
  }
  if (typeof record.volume === 'number' && Number.isFinite(record.volume)) {
    config.volume = Math.min(2, Math.max(0.01, record.volume))
  }
  return config
}

export function createSayTts(deps: SayTtsDeps): SayTts {
  const log = deps.log ?? ((line: string): void => { console.log(`[pet-tts] ${line}`) })
  const home = deps.home
  const petId = deps.petId

  // ── config: mtime-cached dual-path read ───────────────────────────────────
  // whale598/ first, legacy root fallback — the newest of whichever exist.
  // One stat pair per utterance; the file is re-read only when an mtime
  // moves, so a settings save lands on the very next say without any push.
  let cache: { path: string; mtimeMs: number; config: TtsConfig } | undefined
  let lastConfigEcho = ''

  const loadConfig = (): TtsConfig => {
    let newest: { path: string; mtimeMs: number } | undefined
    for (const path of [join(home, 'whale598', 'pet-settings.json'), join(home, 'pet-settings.json')]) {
      try {
        const stat = statSync(path)
        if (newest === undefined || stat.mtimeMs > newest.mtimeMs) newest = { path, mtimeMs: stat.mtimeMs }
      } catch { /* absent: try the next path */ }
    }
    if (newest === undefined) return {}
    if (cache !== undefined && cache.path === newest.path && cache.mtimeMs === newest.mtimeMs) return cache.config
    try {
      const parsed = JSON.parse(readFileSync(newest.path, 'utf8')) as { tts?: unknown }
      const config = resolvePetTts(parsed?.tts, petId)
      cache = { ...newest, config }
      // One line per config CHANGE (never the key itself): the observable
      // trace for "why is she silent" without a log per utterance. voice /
      // speed / volume are the values AS RESOLVED for this pet (override
      // applied) — a per-pet override change produces its own echo line.
      const echo = `config from ${newest.path} (pet=${petId}): enabled=${String(config.enabled === true)}`
        + ` key=${config.apiKey ? 'set' : 'unset'} voice=${config.voiceId ?? '-'}`
        + ` model=${config.modelId ?? 'auto'} speed=${String(config.speed ?? 1)} volume=${String(config.volume ?? 1)}`
        + ` hold=${String(config.holdMs ?? DEFAULT_HOLD_MS)}ms`
      if (echo !== lastConfigEcho) {
        lastConfigEcho = echo
        log(echo)
      }
      return config
    } catch (error: unknown) {
      log(`pet-settings.json unreadable, TTS stays off: ${error instanceof Error ? error.message : String(error)}`)
      return {}
    }
  }

  // ── the single voice slot ─────────────────────────────────────────────────
  // One delivery in flight: a newer deliver() abandons the older one (abort
  // the fetch, disarm its hold), so bubble and voice always track the newest
  // say. `settled` makes each delivery one-shot: whoever lands first — audio,
  // error, or the hold timer — delivers and disarms the others.
  let generation = 0
  let inflight: AbortController | undefined
  let lastSpoken: { text: string; at: number } | undefined
  let mutedUntil = 0

  const deliver = (text: string): void => {
    generation += 1
    const gen = generation
    inflight?.abort()
    inflight = undefined
    const trimmed = text.trim()
    if (trimmed === '') return
    const config = loadConfig()
    const speakable = config.enabled === true
      && config.apiKey !== undefined && config.apiKey !== ''
      && config.voiceId !== undefined && config.voiceId !== ''
      && Date.now() >= mutedUntil
    const dup = lastSpoken !== undefined
      && lastSpoken.text === trimmed && Date.now() - lastSpoken.at < DEDUPE_MS
    if (!speakable || dup) {
      deps.deliver(trimmed)
      return
    }
    lastSpoken = { text: trimmed, at: Date.now() }
    holdAndDeliver(trimmed, config, gen)
  }

  /** Race the synthesis against the bubble's patience; the first to land
   * delivers (audio or alone) and the loser is discarded, never late. */
  const holdAndDeliver = (text: string, config: TtsConfig, gen: number): void => {
    const abort = new AbortController()
    inflight = abort
    const holdMs = config.holdMs ?? DEFAULT_HOLD_MS
    let settled = false
    const finish = (audio?: Uint8Array<ArrayBuffer>): void => {
      if (settled) return
      settled = true
      clearTimeout(timer)
      if (inflight === abort) inflight = undefined
      if (gen === generation) deps.deliver(text, audio)
    }
    const timer = setTimeout(() => finish(), holdMs)
    void synthesize(text, config, abort).then(
      (audio) => { finish(audio) },
      (error: unknown) => {
        // Superseded (our own abort): the newer delivery already owns the
        // stage — stay silent. A real failure: deliver the bubble NOW
        // instead of making it wait out the hold.
        if (!abort.signal.aborted) {
          log(`say TTS failed: ${error instanceof Error ? error.message : String(error)}`)
        }
        finish()
      },
    )
  }

  const synthesize = (text: string, config: TtsConfig, abort: AbortController): Promise<Uint8Array<ArrayBuffer>> => {
    const url = new URL(`${TTS_URL}/${encodeURIComponent(config.voiceId ?? '')}`)
    url.searchParams.set('output_format', 'mp3')
    const body: Record<string, unknown> = { text }
    if (config.modelId !== undefined) body.model_id = config.modelId
    if (config.languageCode !== undefined) body.language_code = config.languageCode
    const voiceSettings: Record<string, number> = {}
    if (config.speed !== undefined && config.speed !== 1) voiceSettings.speed = config.speed
    if (config.volume !== undefined && config.volume !== 1) voiceSettings.volume = config.volume
    if (Object.keys(voiceSettings).length > 0) body.voice_settings = voiceSettings
    return fetch(url, {
      method: 'POST',
      headers: { 'xi-api-key': config.apiKey ?? '', 'content-type': 'application/json' },
      body: JSON.stringify(body),
      signal: AbortSignal.any([abort.signal, AbortSignal.timeout(REQUEST_TIMEOUT_MS)]),
    }).then(async (response): Promise<Uint8Array<ArrayBuffer>> => {
      if (!response.ok) {
        const detail = await response.text().catch(() => '')
        if (response.status === 429) {
          const retryAfter = Number(response.headers.get('retry-after'))
          const seconds = Number.isFinite(retryAfter) ? Math.min(RATE_LIMIT_CAP_S, Math.max(0, retryAfter)) : 60
          mutedUntil = Date.now() + seconds * 1000
        }
        throw new Error(`BreezeBlue HTTP ${String(response.status)}${detail ? `: ${detail.slice(0, 200)}` : ''}`)
      }
      const audio = new Uint8Array(await response.arrayBuffer())
      if (audio.length === 0) throw new Error('empty audio response')
      if (audio.length > MAX_AUDIO_BYTES) throw new Error(`audio too large (${String(audio.length)} bytes)`)
      return audio
    })
  }

  return { deliver }
}
