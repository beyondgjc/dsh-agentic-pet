/**
 * Per-pet TTS voice: the settings-page merge's `tts.voices` table
 * (per-petId deep merge, null entry deletes, null/empty fields clear,
 * clamps, untouched keys survive) — the carrier side resolves the same
 * table in apps/pet tts.ts resolvePetTts, which folds unknown shapes to the
 * shared defaults and is covered there by the monorepo build plus
 * real-machine acceptance (the carrier package has no unit-test infra).
 */

import { describe, expect, it } from 'vitest'
import { mergeSettings } from '../src/settings-page.ts'

type Settings = Record<string, unknown>

const ttsOf = (merged: Settings): Record<string, unknown> => (merged.tts ?? {}) as Record<string, unknown>

describe('mergeSettings tts.voices (per-pet voice overrides)', () => {
  it('starts from nothing: no patch leaves no table', () => {
    const merged = mergeSettings({}, {})
    expect(ttsOf(merged).voices).toBeUndefined()
  })

  it('adds one pet entry and keeps other sections intact', () => {
    const merged = mergeSettings(
      { tts: { enabled: true, apiKey: 'brz_k' } },
      { tts: { voices: { 'electron-1': { voiceId: 'pet-voice', speed: 0.9 } } } },
    )
    const tts = ttsOf(merged)
    expect(tts.enabled).toBe(true)
    expect(tts.apiKey).toBe('brz_k')
    expect(tts.voices).toEqual({ 'electron-1': { voiceId: 'pet-voice', speed: 0.9 } })
  })

  it('the global voice default is retired: legacy keys fold out on every save', () => {
    const merged = mergeSettings(
      { tts: { enabled: true, apiKey: 'brz_k', voiceId: 'legacy-global', speed: 1.4, volume: 0.8 } },
      {},
    )
    const tts = ttsOf(merged)
    expect(tts.voiceId).toBeUndefined()
    expect(tts.speed).toBeUndefined()
    expect(tts.volume).toBeUndefined()
    expect(tts.enabled).toBe(true)
    expect(tts.apiKey).toBe('brz_k')
  })

  it('a patch carrying the retired global keys is ignored too', () => {
    const merged = mergeSettings({}, {
      tts: { voiceId: 'sneaked-in', speed: 2, volume: 2, voices: { electron: { voiceId: 'real' } } },
    } as never)
    const tts = ttsOf(merged)
    expect(tts.voiceId).toBeUndefined()
    expect(tts.speed).toBeUndefined()
    expect(tts.volume).toBeUndefined()
    expect(tts.voices).toEqual({ electron: { voiceId: 'real' } })
  })

  it('deep-merges per petId: a second save on one pet keeps the other pet', () => {
    const current = {
      tts: { voiceId: 'global', voices: { electron: { voiceId: 'a' }, 'electron-1': { voiceId: 'b', volume: 1.5 } } },
    }
    const merged = mergeSettings(current, { tts: { voices: { electron: { speed: 1.5 } } } })
    expect(ttsOf(merged).voices).toEqual({
      electron: { voiceId: 'a', speed: 1.5 },
      'electron-1': { voiceId: 'b', volume: 1.5 },
    })
  })

  it('overrides a field on re-save and clamps speed/volume', () => {
    const current = { tts: { voices: { 'electron-1': { voiceId: 'old', speed: 0.5 } } } }
    const merged = mergeSettings(current, { tts: { voices: { 'electron-1': { speed: 99, volume: 0.001 } } } })
    expect(ttsOf(merged).voices).toEqual({ 'electron-1': { voiceId: 'old', speed: 2, volume: 0.01 } })
  })

  it('empty-string voiceId clears the field, not the whole entry', () => {
    const current = { tts: { voices: { 'electron-1': { voiceId: 'x', speed: 1.5 } } } }
    const merged = mergeSettings(current, { tts: { voices: { 'electron-1': { voiceId: '' } } } })
    expect(ttsOf(merged).voices).toEqual({ 'electron-1': { speed: 1.5 } })
  })

  it('null voiceId clears the field too', () => {
    const current = { tts: { voices: { 'electron-1': { voiceId: 'x', volume: 1.5 } } } }
    const merged = mergeSettings(current, { tts: { voices: { 'electron-1': { voiceId: null } } } })
    expect(ttsOf(merged).voices).toEqual({ 'electron-1': { volume: 1.5 } })
  })

  it('null speed clears it; an entry whose every field clears is removed (no husks)', () => {
    const current = { tts: { voices: { 'electron-1': { speed: 1.5 } } } }
    const merged = mergeSettings(current, { tts: { voices: { 'electron-1': { speed: null } } } })
    expect(ttsOf(merged).voices).toBeUndefined()
    const partial = mergeSettings(
      { tts: { voices: { 'electron-1': { voiceId: 'x', speed: 1.5 } } } },
      { tts: { voices: { 'electron-1': { speed: null } } } },
    )
    expect(ttsOf(partial).voices).toEqual({ 'electron-1': { voiceId: 'x' } })
  })

  it('null volume clears it', () => {
    const current = { tts: { voices: { 'electron-1': { voiceId: 'x', volume: 1.5 } } } }
    const merged = mergeSettings(current, { tts: { voices: { 'electron-1': { volume: null } } } })
    expect(ttsOf(merged).voices).toEqual({ 'electron-1': { voiceId: 'x' } })
  })

  it('a null entry deletes that pet override entirely', () => {
    const current = { tts: { voiceId: 'global', voices: { electron: { voiceId: 'a' }, 'electron-1': { voiceId: 'b' } } } }
    const merged = mergeSettings(current, { tts: { voices: { 'electron-1': null } } })
    expect(ttsOf(merged).voices).toEqual({ electron: { voiceId: 'a' } })
  })

  it('deleting the last entry removes the table', () => {
    const current = { tts: { voices: { 'electron-1': { voiceId: 'b' } } } }
    const merged = mergeSettings(current, { tts: { voices: { 'electron-1': null } } })
    expect(ttsOf(merged).voices).toBeUndefined()
  })

  it('malformed entries fold away and keep the table untouched', () => {
    const current = { tts: { voices: { electron: { voiceId: 'a' } } } }
    const merged = mergeSettings(current, { tts: { voices: { junk: 'not-an-object', alsoJunk: 42 } } })
    expect(ttsOf(merged).voices).toEqual({ electron: { voiceId: 'a' } })
  })

  it('a non-object patch voices leaves the stored table as-is', () => {
    const current = { tts: { voices: { electron: { voiceId: 'a' } } } }
    const merged = mergeSettings(current, { tts: { voices: 'garbage' as unknown as Record<string, never> } })
    expect(ttsOf(merged).voices).toEqual({ electron: { voiceId: 'a' } })
  })
})
