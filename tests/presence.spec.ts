import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { buildWakePrompt } from '../src/inner-voice.ts'
import {
  diffPresence,
  EMPTY_PRESENCE_COUNTS,
  formatPresenceLine,
  hasPresence,
  normalizePresenceCounts,
  readPresenceConfig,
} from '../src/presence.ts'

const homes: string[] = []

const makeHome = async (): Promise<string> => {
  const home = await mkdtemp(join(tmpdir(), 'pet-presence-'))
  homes.push(home)
  return home
}

afterEach(async () => {
  await Promise.all(homes.splice(0).map(home => rm(home, { recursive: true, force: true })))
})

describe('presence counters', () => {
  it('normalizes malformed counts to non-negative integers', () => {
    expect(normalizePresenceCounts({ wakeCount: 2.9, speakCount: -1, actionCount: '3' }))
      .toEqual({ wakeCount: 2, speakCount: 0, actionCount: 0, selfWakeCount: 0 })
  })

  it('diffs without going negative', () => {
    expect(diffPresence(
      { wakeCount: 5, speakCount: 3, actionCount: 2, selfWakeCount: 1 },
      { wakeCount: 2, speakCount: 4, actionCount: 0, selfWakeCount: 0 },
    )).toEqual({ wakeCount: 3, speakCount: 0, actionCount: 2, selfWakeCount: 1 })
  })

  it('only reports a summary when something happened or a plan is pending', () => {
    expect(hasPresence({ ...EMPTY_PRESENCE_COUNTS, plansPending: 0 })).toBe(false)
    expect(hasPresence({ ...EMPTY_PRESENCE_COUNTS, plansPending: 1 })).toBe(true)
    expect(hasPresence({ ...EMPTY_PRESENCE_COUNTS, actionCount: 1, plansPending: 0 })).toBe(true)
  })

  it('formats one compact line with counts and plans', () => {
    const line = formatPresenceLine({
      wakeCount: 4,
      speakCount: 2,
      actionCount: 1,
      selfWakeCount: 3,
      plansPending: 2,
    })
    expect(line).toContain('醒过 4 次')
    expect(line).toContain('自主唤醒 3 次')
    expect(line).toContain('说过 2 句')
    expect(line).toContain('做过 1 个动作')
    expect(line).toContain('2 个自己安排的计划')
  })
})

describe('presence config', () => {
  it('defaults off', async () => {
    const home = await makeHome()
    expect(await readPresenceConfig(home)).toEqual({ enabled: false })
  })

  it('reads the explicit toggle', async () => {
    const home = await makeHome()
    await mkdir(join(home, 'whale598'), { recursive: true })
    await writeFile(join(home, 'whale598', 'pet-settings.json'), JSON.stringify({
      presenceSummary: { enabled: true },
    }), 'utf8')
    expect(await readPresenceConfig(home)).toEqual({ enabled: true })
  })
})

describe('wake prompt presence block', () => {
  it('injects the compact away summary', () => {
    const prompt = buildWakePrompt({
      affection: 0,
      bondValue: 0,
      bondTier: '陌生',
      bondDays: 0,
      minutesSinceLastSpoke: undefined,
      minutesSinceUserActivity: undefined,
      userActive: true,
      presence: {
        wakeCount: 2,
        speakCount: 1,
        actionCount: 1,
        selfWakeCount: 1,
        plansPending: 0,
      },
    })
    expect(prompt).toContain('[你不在的时候]')
    expect(prompt).toContain('醒过 2 次')
  })
})
