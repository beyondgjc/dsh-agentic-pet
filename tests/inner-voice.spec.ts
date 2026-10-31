/**
 * Pure-function coverage for the inner voice (docs/inner-voice.md): the
 * settings parse (defaults + clamps — the driver re-reads fresh on every
 * trigger, so mistyped files must fold, not throw), the durable petId→
 * sessionId store round-trip, and the wake/touch prompt builders (the log's
 * durable trigger marker lives in the leading tag).
 */

import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterAll, describe, expect, it } from 'vitest'
import {
  buildChatPrompt,
  buildTouchPrompt,
  buildWakePrompt,
  loadInnerVoiceStore,
  mintVoiceSessionId,
  moodOf,
  readInnerVoiceConfig,
  saveInnerVoiceStore,
  touchPartWording,
  voiceSessionIdFor,
} from '../src/inner-voice.ts'

const dirs: string[] = []

afterAll(async () => {
  for (const dir of dirs) await rm(dir, { recursive: true, force: true })
})

async function tempHome(): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), 'inner-voice-'))
  dirs.push(dir)
  return dir
}

describe('readInnerVoiceConfig', () => {
  it('returns defaults when the settings file is missing or broken', async () => {
    const home = await tempHome()
    expect(await readInnerVoiceConfig(home)).toEqual({
      enabled: true,
      preset: 'pet-inner-voice',
      wakeIntervalMinutes: 2,
      speakProbability: 0.5,
      touchReplyProbability: 0.3,
      touchReplyCooldownSeconds: 30,
      boundSessions: {},
    })
    await writeFile(join(home, 'pet-settings.json'), '{not json', 'utf8')
    expect((await readInnerVoiceConfig(home)).enabled).toBe(true)
  })

  it('keeps a well-formed section verbatim', async () => {
    const home = await tempHome()
    await writeFile(join(home, 'pet-settings.json'), JSON.stringify({
      innerVoice: {
        enabled: false,
        preset: 'pet',
        wakeIntervalMinutes: 15,
        speakProbability: 0.9,
        touchReplyProbability: 0,
        touchReplyCooldownSeconds: 45,
        boundSessions: { electron: 'whale598-electron', bad: 7, '': 'no-key' },
      },
    }), 'utf8')
    expect(await readInnerVoiceConfig(home)).toEqual({
      enabled: false,
      preset: 'pet',
      wakeIntervalMinutes: 15,
      speakProbability: 0.9,
      touchReplyProbability: 0,
      touchReplyCooldownSeconds: 45,
      boundSessions: { electron: 'whale598-electron' },
    })
  })

  it('clamps out-of-range numbers and folds mistyped ones', async () => {
    const home = await tempHome()
    await writeFile(join(home, 'pet-settings.json'), JSON.stringify({
      innerVoice: {
        wakeIntervalMinutes: 999,
        speakProbability: 2,
        touchReplyProbability: -1,
        touchReplyCooldownSeconds: 'five',
        preset: 42,
      },
    }), 'utf8')
    const config = await readInnerVoiceConfig(home)
    expect(config.wakeIntervalMinutes).toBe(60)
    expect(config.speakProbability).toBe(1)
    expect(config.touchReplyProbability).toBe(0)
    expect(config.touchReplyCooldownSeconds).toBe(30)
    expect(config.preset).toBe('pet-inner-voice')
  })

  it('folds the legacy minute cooldown key into seconds (x60), seconds key wins once saved', async () => {
    const home = await tempHome()
    await writeFile(join(home, 'pet-settings.json'), JSON.stringify({
      innerVoice: { touchReplyCooldownMinutes: 5 },
    }), 'utf8')
    expect((await readInnerVoiceConfig(home)).touchReplyCooldownSeconds).toBe(300)
    await writeFile(join(home, 'pet-settings.json'), JSON.stringify({
      innerVoice: { touchReplyCooldownMinutes: 5, touchReplyCooldownSeconds: 0 },
    }), 'utf8')
    expect((await readInnerVoiceConfig(home)).touchReplyCooldownSeconds).toBe(0)
  })
})

describe('inner-voice store', () => {
  it('round-trips petId → sessionId entries', async () => {
    const home = await tempHome()
    expect(await loadInnerVoiceStore(home)).toEqual({ sessions: {}, generations: {} })
    const store = { sessions: { electron: { sessionId: 'whale598-electron-g0', createdAt: 12 } }, generations: { electron: 3 } }
    await saveInnerVoiceStore(home, store)
    expect(JSON.parse(await readFile(join(home, 'pet-inner-voice.json'), 'utf8'))).toEqual(store)
    expect(await loadInnerVoiceStore(home)).toEqual(store)
  })

  it('folds malformed entries instead of throwing', async () => {
    const home = await tempHome()
    await writeFile(join(home, 'pet-inner-voice.json'), JSON.stringify({
      sessions: { electron: { sessionId: 'whale598-electron-g0' }, pure: { sessionId: 7 }, ghost: 'nope' },
      generations: { electron: 'five', pure: 2.9, '': 1, ok: 4 },
    }), 'utf8')
    expect(await loadInnerVoiceStore(home)).toEqual({
      sessions: { electron: { sessionId: 'whale598-electron-g0', createdAt: 0 } },
      generations: { pure: 2, ok: 4 },
    })
  })
})

describe('prompts and helpers', () => {
  it('mints stable voice session ids', () => {
    expect(voiceSessionIdFor('electron')).toBe('whale598-electron')  // base form (mint appends -gN)
  })

  it('mints -g0 in the uniform format and skips ids the archive set holds', () => {
    // The field spiral of 2026-10-31: a restart resets the in-memory
    // generation while the archive set still holds every retired id — the
    // naive mint collided with an archived ancestor (born dead: the gate
    // silently blocks its turns). The mint walks past the whole archived
    // run and reports the advanced generation for persistence. Uniform
    // format (user decision): gen0 is -g0, never a bare base id.
    const archived = new Set(['whale598-electron-g0', 'whale598-electron-g1', 'whale598-electron-g2'])
    const first = mintVoiceSessionId('electron', 0, id => archived.has(id))
    expect(first).toEqual({ sessionId: 'whale598-electron-g3', generation: 3, hops: 3 })
    // A clean archive set keeps the id the caller asked for (still -g0).
    const clean = mintVoiceSessionId('electron', 0, () => false)
    expect(clean).toEqual({ sessionId: 'whale598-electron-g0', generation: 0, hops: 0 })
    // An already-advanced generation only skips what it lands on.
    const next = mintVoiceSessionId('electron', 3, id => archived.has(id))
    expect(next).toEqual({ sessionId: 'whale598-electron-g3', generation: 3, hops: 0 })
  })

  it('caps the mint hop walk and reports the cap as the generation', () => {
    // A pathological archive set must not spin forever: past the cap the
    // mint gives up and returns the last tried id.
    const everything = new Set<string>()
    for (let g = 0; g < 600; g += 1) everything.add(`whale598-fish-g${String(g)}`)
    const capped = mintVoiceSessionId('fish', 0, id => everything.has(id))
    expect(capped.hops).toBe(500)
    expect(capped.generation).toBe(500)
    expect(capped.sessionId).toBe('whale598-fish-g500')
  })

  it('maps touch parts to wording and rejects unknown ones', () => {
    expect(touchPartWording('head')).toBe('头')
    expect(touchPartWording('body')).toBe('身体')
    expect(touchPartWording('unknown')).toBeUndefined()
  })

  it('keeps one mood vocabulary', () => {
    expect(moodOf(85)).toBe('happy')
    expect(moodOf(50)).toBe('content')
    expect(moodOf(10)).toBe('neutral')
  })

  it('builds the wake prompt with the durable trigger tag and first-wake branch', () => {
    const prompt = buildWakePrompt({ affection: 66, minutesSinceLastSpoke: undefined, minutesSinceUserActivity: undefined, userActive: false })
    expect(prompt.startsWith('[自主唤醒]')).toBe(true)
    expect(prompt).toContain('第一次醒来')
    expect(prompt).toContain('好感 66')
    const again = buildWakePrompt({ affection: 66, minutesSinceLastSpoke: 30, minutesSinceUserActivity: 2, userActive: true })
    expect(again).toContain('上次开口是 30 分钟前')
    expect(again).toContain('正在会话中工作')
  })

  it('builds the touch prompt with part wording and touch count', () => {
    const prompt = buildTouchPrompt({ part: 'head', touchesToday: 3, affection: 42 })
    expect(prompt.startsWith('[被触摸]')).toBe(true)
    expect(prompt).toContain('摸了你的头')
    expect(prompt).toContain('今天第 3 次')
  })

  it('builds the chat prompt with the trigger tag and the contract length clamp', () => {
    const prompt = buildChatPrompt('今天天气怎么样？')
    expect(prompt.startsWith('[用户对你说]')).toBe(true)
    expect(prompt).toContain('今天天气怎么样？')
    // the contract's 2000-character ceiling clamps before the tag
    const long = buildChatPrompt('a'.repeat(2500))
    expect(long).toBe(`[用户对你说] ${'a'.repeat(2000)}`)
  })
})
