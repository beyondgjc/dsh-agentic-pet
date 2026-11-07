import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { isQuietAt, parseClock, readIdleBias } from '../src/rhythm.ts'

const homes: string[] = []
const makeHome = async (): Promise<string> => {
  const home = await mkdtemp(join(tmpdir(), 'pet-rhythm-'))
  homes.push(home)
  return home
}
afterEach(async () => {
  await Promise.all(homes.splice(0).map(home => rm(home, { recursive: true, force: true })))
})

const at = (hour: number, minute: number): Date => new Date(2026, 10, 5, hour, minute)

describe('parseClock', () => {
  it('parses HH:mm and H:mm', () => {
    expect(parseClock('00:00')).toBe(0)
    expect(parseClock('01:00')).toBe(60)
    expect(parseClock('9:05')).toBe(545)
    expect(parseClock('23:59')).toBe(1439)
  })

  it('rejects malformed or out-of-range values', () => {
    expect(parseClock('24:00')).toBeUndefined()
    expect(parseClock('12:60')).toBeUndefined()
    expect(parseClock('1:2')).toBeUndefined()
    expect(parseClock('')).toBeUndefined()
    expect(parseClock(undefined)).toBeUndefined()
  })
})

describe('isQuietAt', () => {
  const quiet = { from: '01:00', to: '09:00', allowTouchReply: true }

  it('uses a half-open [from, to) window', () => {
    expect(isQuietAt(at(0, 59), quiet)).toBe(false)
    expect(isQuietAt(at(1, 0), quiet)).toBe(true)
    expect(isQuietAt(at(8, 59), quiet)).toBe(true)
    expect(isQuietAt(at(9, 0), quiet)).toBe(false)
    expect(isQuietAt(at(12, 0), quiet)).toBe(false)
  })

  it('supports cross-midnight windows', () => {
    const night = { from: '22:00', to: '06:00', allowTouchReply: true }
    expect(isQuietAt(at(22, 0), night)).toBe(true)
    expect(isQuietAt(at(23, 59), night)).toBe(true)
    expect(isQuietAt(at(0, 0), night)).toBe(true)
    expect(isQuietAt(at(5, 59), night)).toBe(true)
    expect(isQuietAt(at(6, 0), night)).toBe(false)
    expect(isQuietAt(at(12, 0), night)).toBe(false)
  })

  it('treats absent/null/equal/invalid windows as not quiet', () => {
    expect(isQuietAt(at(3, 0), undefined)).toBe(false)
    expect(isQuietAt(at(3, 0), null)).toBe(false)
    expect(isQuietAt(at(3, 0), { from: '03:00', to: '03:00', allowTouchReply: true })).toBe(false)
    expect(isQuietAt(at(3, 0), { from: 'bad', to: '09:00', allowTouchReply: true })).toBe(false)
  })
})

describe('readIdleBias（B06 时辰偏置，Phase 3）', () => {
  it('returns the default table when pet-settings has no rhythm.idleBias', async () => {
    const home = await makeHome()
    const bias = await readIdleBias(home)
    expect(bias).toEqual({
      hours: [1, 6],
      weights: { 疲惫: 1.5, 待机: 1.5, 放松: 1.5, 运动: 0.5, 娱乐: 0.5, 才艺: 0.5 },
    })
  })

  it('honors an explicit override and an explicit null (off)', async () => {
    const home = await makeHome()
    await mkdir(join(home, 'whale598'), { recursive: true })
    const settings = join(home, 'whale598', 'pet-settings.json')
    await writeFile(settings, JSON.stringify({
      rhythm: { idleBias: { hours: [22, 2], weights: { 工作: 0.2 } } },
    }), 'utf8')
    expect(await readIdleBias(home)).toEqual({ hours: [22, 2], weights: { 工作: 0.2 } })
    await writeFile(settings, JSON.stringify({ rhythm: { idleBias: null } }), 'utf8')
    expect(await readIdleBias(home)).toBeUndefined()
  })

  it('falls back to the default table on malformed config', async () => {
    const home = await makeHome()
    await mkdir(join(home, 'whale598'), { recursive: true })
    await writeFile(join(home, 'whale598', 'pet-settings.json'), JSON.stringify({
      rhythm: { idleBias: { hours: [25], weights: 'x' } },
    }), 'utf8')
    const bias = await readIdleBias(home)
    expect(bias?.hours).toEqual([1, 6])
  })
})
