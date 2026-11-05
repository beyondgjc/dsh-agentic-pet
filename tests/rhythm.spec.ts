import { describe, expect, it } from 'vitest'
import { isQuietAt, parseClock } from '../src/rhythm.ts'

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
