/**
 * Say-side TTS (BreezeBlue): speech synthesis as the /say bubble's companion.
 * The control plane hands every spoken text here after the bubble is
 * forwarded; synthesis runs out-of-band so the fire-and-forget semantics and
 * the HTTP budget of /say are untouched — any failure (no key, rate limit,
 * network) degrades to visual-only and never surfaces to the driver.
 *
 * Configuration lives in the shared pet-settings.json (`tts` section, written
 * by the plugin's settings page) and is read lazily per utterance with an
 * mtime cache: a saved switch reaches the pet without any push or restart.
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
}

interface SayTtsDeps {
  /** The dsh home holding pet-settings.json (whale598/ first, legacy root
   * fallback — same dual-path rule as the driver's petdata). */
  home: string
  window: BrowserWindow
  log?: (line: string) => void
}

export interface SayTts {
  /** Hand one spoken text to the pipeline. Fire-and-forget: returns
   * immediately, never throws, and a newer call always wins — the older
   * fetch is aborted so the pet's voice follows the bubble. */
  speak(text: string): void
}

/** The BreezeBlue TTS endpoint (convert, synchronous mp3). */
const TTS_URL = 'https://api.breeze.blue/v1/text-to-speech'
/** Bounded wait for one synthesis round trip; the bubble shows regardless. */
const REQUEST_TIMEOUT_MS = 20_000
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
  return config
}

export function createSayTts(deps: SayTtsDeps): SayTts {
  const log = deps.log ?? ((line: string): void => { console.log(`[pet-tts] ${line}`) })
  const home = deps.home

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
      const config = normalizeTts(parsed?.tts)
      cache = { ...newest, config }
      // One line per config CHANGE (never the key itself): the observable
      // trace for "why is she silent" without a log per utterance.
      const echo = `config from ${newest.path}: enabled=${String(config.enabled === true)}`
        + ` key=${config.apiKey ? 'set' : 'unset'} voice=${config.voiceId ?? '-'}`
        + ` model=${config.modelId ?? 'auto'} speed=${String(config.speed ?? 1)} volume=${String(config.volume ?? 1)}`
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
  // One utterance in flight: a newer speak() aborts the older fetch, so the
  // voice always tracks the newest bubble (the bubble itself overwrites, and
  // the renderer drops audio whose text no longer matches).
  let generation = 0
  let inflight: AbortController | undefined
  let lastSpoken: { text: string; at: number } | undefined
  let mutedUntil = 0

  const speak = (text: string): void => {
    generation += 1
    const gen = generation
    inflight?.abort()
    inflight = undefined
    const trimmed = text.trim()
    if (trimmed === '') return
    const config = loadConfig()
    if (config.enabled !== true) return
    if (!config.apiKey || !config.voiceId) return
    if (Date.now() < mutedUntil) return
    if (lastSpoken !== undefined && lastSpoken.text === trimmed && Date.now() - lastSpoken.at < DEDUPE_MS) return
    lastSpoken = { text: trimmed, at: Date.now() }
    void synthesize(trimmed, config, gen)
  }

  const synthesize = async (text: string, config: TtsConfig, gen: number): Promise<void> => {
    const abort = new AbortController()
    inflight = abort
    try {
      const url = new URL(`${TTS_URL}/${encodeURIComponent(config.voiceId ?? '')}`)
      url.searchParams.set('output_format', 'mp3')
      const body: Record<string, unknown> = { text }
      if (config.modelId !== undefined) body.model_id = config.modelId
      if (config.languageCode !== undefined) body.language_code = config.languageCode
      const voiceSettings: Record<string, number> = {}
      if (config.speed !== undefined && config.speed !== 1) voiceSettings.speed = config.speed
      if (config.volume !== undefined && config.volume !== 1) voiceSettings.volume = config.volume
      if (Object.keys(voiceSettings).length > 0) body.voice_settings = voiceSettings
      const response = await fetch(url, {
        method: 'POST',
        headers: { 'xi-api-key': config.apiKey ?? '', 'content-type': 'application/json' },
        body: JSON.stringify(body),
        signal: AbortSignal.any([abort.signal, AbortSignal.timeout(REQUEST_TIMEOUT_MS)]),
      })
      if (gen !== generation) return
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
      if (gen !== generation) return
      if (audio.length === 0) throw new Error('empty audio response')
      if (audio.length > MAX_AUDIO_BYTES) throw new Error(`audio too large (${String(audio.length)} bytes)`)
      if (deps.window.isDestroyed() || deps.window.webContents.isDestroyed()) return
      deps.window.webContents.send('pet:tts-play', { text, audio })
    } catch (error: unknown) {
      // Superseded by a newer utterance (our own abort): silence is correct.
      if (abort.signal.aborted) return
      if (gen !== generation) return
      log(`say TTS failed: ${error instanceof Error ? error.message : String(error)}`)
    } finally {
      if (inflight === abort) inflight = undefined
    }
  }

  return { speak }
}
