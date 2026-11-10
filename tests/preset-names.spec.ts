/**
 * Preset slot display names (人设取名, pet-settings.json `presetNames`): the
 * merge's per-entry semantics — trim, cap 60, empty clears the slot back to
 * the built-in label, absent keys preserved, non-strings ignored. Display
 * fallback lives client-side (presetNameOf); the wire keeps raw preset ids.
 */

import { describe, expect, it } from 'vitest'
import { mergeSettings } from '../src/settings-page.ts'

describe('mergeSettings presetNames (人设取名)', () => {
  it('sets, trims and caps slot names', () => {
    const next = mergeSettings({}, {
      presetNames: {
        'whale598-custom-1': '  小蝶  ',
        'whale598-custom-2': 'x'.repeat(80),
      },
    })
    expect(next.presetNames).toEqual({
      'whale598-custom-1': '小蝶',
      'whale598-custom-2': 'x'.repeat(60),
    })
  })

  it('empty string clears the slot back to the built-in label; absent keys preserved', () => {
    const current = { presetNames: { 'whale598-custom-1': '小蝶', 'whale598-custom-2': '阿豚' } }
    const next = mergeSettings(current, { presetNames: { 'whale598-custom-2': '', 'whale598': '精简版' } })
    expect(next.presetNames).toEqual({ 'whale598-custom-1': '小蝶', 'whale598': '精简版' })
  })

  it('a patch without presetNames keeps the stored map; non-strings ignored', () => {
    const current = { presetNames: { 'whale598-custom-1': '小蝶' } }
    expect(mergeSettings(current, { proactivity: {} }).presetNames).toEqual({ 'whale598-custom-1': '小蝶' })
    const next = mergeSettings(current, { presetNames: { 'whale598-standard': 7 } })
    expect(next.presetNames).toEqual({ 'whale598-custom-1': '小蝶' })
  })
})
