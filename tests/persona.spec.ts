/**
 * The configurable persona: the sync card reader (missing/broken/empty →
 * default, custom → verbatim, oversized → truncated, legacy location still
 * answers) and the settings-page merge's persona leaf (absent patch keeps,
 * empty clears to absent, oversize truncates). The row itself only wires the
 * reader into the prompt registry — the merge and the reader are the
 * behavior-bearing halves, both pure against a fake home.
 */

import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterAll, describe, expect, it } from 'vitest'
import { DEFAULT_PERSONA, MAX_PERSONA_CHARS, PRESET_BUILTIN_CARDS, readPersonaCard } from '../src/persona.ts'
import { mergeSettings } from '../src/settings-page.ts'

const dirs: string[] = []

afterAll(async () => {
  for (const dir of dirs) await rm(dir, { recursive: true, force: true })
})

async function tempHome(): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), 'persona-'))
  dirs.push(dir)
  return dir
}

describe('readPersonaCard', () => {
  it('answers the default card when the settings file is missing, broken, or card-less', async () => {
    const home = await tempHome()
    expect(readPersonaCard(home)).toBe(DEFAULT_PERSONA)
    await writeFile(join(home, 'pet-settings.json'), '{not json', 'utf8')
    expect(readPersonaCard(home)).toBe(DEFAULT_PERSONA)
    await writeFile(join(home, 'pet-settings.json'), JSON.stringify({ tts: { enabled: true } }), 'utf8')
    expect(readPersonaCard(home)).toBe(DEFAULT_PERSONA)
  })

  it('falls back to the default for an empty or whitespace-only card', async () => {
    const home = await tempHome()
    await writeFile(join(home, 'pet-settings.json'), JSON.stringify({ persona: '   ' }), 'utf8')
    expect(readPersonaCard(home)).toBe(DEFAULT_PERSONA)
  })

  it('passes a custom card through verbatim (trimmed)', async () => {
    const home = await tempHome()
    await writeFile(join(home, 'pet-settings.json'), JSON.stringify({ persona: ' 你是「测试猫娘」。\n' }), 'utf8')
    expect(readPersonaCard(home)).toBe('你是「测试猫娘」。')
  })

  it('truncates an oversized hand-edited card to the cap', async () => {
    const home = await tempHome()
    await writeFile(join(home, 'pet-settings.json'), JSON.stringify({ persona: '呜'.repeat(MAX_PERSONA_CHARS + 10) }), 'utf8')
    expect(readPersonaCard(home)).toBe('呜'.repeat(MAX_PERSONA_CHARS))
  })

  it('answers the legacy root copy when the whale598 one is absent', async () => {
    const home = await tempHome()
    await mkdir(join(home, 'whale598'), { recursive: true })
    await writeFile(join(home, 'pet-settings.json'), JSON.stringify({ persona: '旧位置的卡' }), 'utf8')
    expect(readPersonaCard(home)).toBe('旧位置的卡')
  })

  it('re-reads on every call: an overwrite lands without any cache to bust', async () => {
    const home = await tempHome()
    const file = join(home, 'whale598', 'pet-settings.json')
    await mkdir(join(home, 'whale598'), { recursive: true })
    await writeFile(file, JSON.stringify({ persona: '第一版' }), 'utf8')
    expect(readPersonaCard(home)).toBe('第一版')
    await writeFile(file, JSON.stringify({ persona: '第二版' }), 'utf8')
    expect(readPersonaCard(home)).toBe('第二版')
  })
})

describe('per-preset persona slots (multi-pet)', () => {
  it('resolves personas.<key> → global persona → default, per key', async () => {
    const home = await tempHome()
    await mkdir(join(home, 'whale598'), { recursive: true })
    await writeFile(join(home, 'whale598', 'pet-settings.json'), JSON.stringify({
      persona: '全局卡',
      personas: { 'whale598-custom-1': '自定义1 的卡' },
    }), 'utf8')
    // an overridden slot answers its own card…
    expect(readPersonaCard(home, 'whale598-custom-1')).toBe('自定义1 的卡')
    // …an unedited slot falls back to the global card (the seed effect)…
    expect(readPersonaCard(home, 'whale598-standard')).toBe('全局卡')
    // …and a preset on a settings file without any card answers ITS OWN
    // built-in card（鲸鱼娘/病娇/小满——对齐 dsh-persona-presets 的
    // preset-cards 架构：清槽回落该槽预制人设，而非人人一张通用默认）。
    await writeFile(join(home, 'whale598', 'pet-settings.json'), JSON.stringify({
      personas: { 'whale598-custom-1': '自定义1 的卡' },
    }), 'utf8')
    expect(readPersonaCard(home, 'whale598-custom-1')).toBe('自定义1 的卡')
    expect(readPersonaCard(home, 'whale598-standard')).toBe(PRESET_BUILTIN_CARDS['whale598-standard'])
    expect(readPersonaCard(home, 'whale598')).toBe(PRESET_BUILTIN_CARDS['whale598'])
    expect(readPersonaCard(home, 'whale598-custom-2')).toBe(PRESET_BUILTIN_CARDS['whale598-custom-2'])
    // unknown key (no built-in card for it) still answers the generic default
    expect(readPersonaCard(home, 'unknown-preset')).toBe(DEFAULT_PERSONA)
  })

  it('mergeSettings: personas map — partial update, clear-on-empty, trim/cap, non-string ignored', () => {
    const current = {
      personas: { 'whale598-custom-1': '已有的卡', 'whale598-custom-2': '会被清掉' },
      persona: '全局卡',
    }
    const next = mergeSettings(current, {
      personas: {
        'whale598-custom-1': '  新卡  ',
        'whale598-custom-2': '',
        'whale598-standard': 'x'.repeat(MAX_PERSONA_CHARS + 5),
        'whale598': 7,
      },
    })
    // edited slot: trimmed; cleared slot: key deleted; oversize: capped;
    // non-string: ignored (kept absent); untouched slot: preserved
    expect(next.personas).toEqual({
      'whale598-custom-1': '新卡',
      'whale598-standard': 'x'.repeat(MAX_PERSONA_CHARS),
    })
    // the patch did not touch the global card — it stays
    expect(next.persona).toBe('全局卡')
  })

  it('mergeSettings: personas absent from the patch keeps the stored map', () => {
    const current = { personas: { 'whale598-custom-1': '卡' } }
    const next = mergeSettings(current, { proactivity: {} })
    expect(next.personas).toEqual({ 'whale598-custom-1': '卡' })
  })

  it('mergeSettings: innerVoice.selfTuning — strict boolean, absent patch keeps stored value', () => {
    const saved = mergeSettings({}, { innerVoice: { selfTuning: true } })
    expect(saved.innerVoice?.selfTuning).toBe(true)
    // 非布尔折叠：闸门只认 true/false，其余不动现值。
    const junk = mergeSettings({ innerVoice: { selfTuning: true } }, { innerVoice: { selfTuning: 'on' } })
    expect(junk.innerVoice?.selfTuning).toBe(true)
    const untouched = mergeSettings({ innerVoice: { selfTuning: true } }, { innerVoice: { wakeIntervalMinutes: 7 } })
    expect(untouched.innerVoice?.selfTuning).toBe(true)
    const off = mergeSettings({}, { innerVoice: { selfTuning: false } })
    expect(off.innerVoice?.selfTuning).toBe(false)
  })
})

describe('DEFAULT_PERSONA', () => {
  it('keeps the shipped identity sentence and stays interpolation-free', () => {
    expect(DEFAULT_PERSONA).toContain('鲸鱼娘')
    expect(DEFAULT_PERSONA).not.toContain('{{')
  })
})

describe('mergeSettings persona leaf', () => {
  it('keeps the stored card when the patch does not mention persona', () => {
    const current = mergeSettings({ persona: '已有设定' }, {})
    expect(current.persona).toBe('已有设定')
  })

  it('deletes the key on an empty or whitespace patch (cleared = default)', () => {
    const cleared = mergeSettings({ persona: '已有设定' }, { persona: '' })
    expect('persona' in cleared).toBe(false)
    const blanked = mergeSettings({ persona: '已有设定' }, { persona: '   \n ' })
    expect('persona' in blanked).toBe(false)
  })

  it('stores a trimmed custom card and truncates past the cap', () => {
    const saved = mergeSettings({}, { persona: ' 新设定 \n' })
    expect(saved.persona).toBe('新设定')
    const capped = mergeSettings({}, { persona: '呜'.repeat(MAX_PERSONA_CHARS + 10) })
    expect(capped.persona).toBe('呜'.repeat(MAX_PERSONA_CHARS))
  })

  it('ignores non-string patches and preserves the carrier-shared keys', () => {
    const current = mergeSettings({ persona: '保留', tts: { enabled: true } }, { persona: 42 })
    expect(current.persona).toBe('保留')
    expect(current.tts?.enabled).toBe(true)
  })
})
