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
  buildCrossPetPrompt,
  buildGreetPrompt,
  buildTouchPrompt,
  buildWakePrompt,
  cancelPlans,
  loadInnerVoiceStore,
  loadPetMessages,
  loadWakePlans,
  mintVoiceSessionId,
  missedPlans,
  moodOf,
  queuePetMessage,
  readInnerVoiceConfig,
  saveInnerVoiceStore,
  savePetMessages,
  saveWakePlans,
  takeDuePlans,
  takeNearDuePlan,
  takePetMessages,
  touchPartWording,
  upsertPlan,
  voiceSessionIdFor,
  type PetMessage,
  type WakePlan,
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
      preset: 'whale598',
      wakeIntervalMinutes: 2,
      speakProbability: 0.5,
      touchReplyProbability: 0.3,
      touchReplyCooldownSeconds: 30,
      selfWakeBusyPolicy: 'fire',
      petToPetDelivery: 'queue',
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
        preset: 'whale598-standard',
        wakeIntervalMinutes: 15,
        speakProbability: 0.9,
        touchReplyProbability: 0,
        touchReplyCooldownSeconds: 45,
        selfWakeBusyPolicy: 'defer',
        petToPetDelivery: 'immediate',
        boundSessions: { electron: 'whale598-electron', bad: 7, '': 'no-key' },
      },
    }), 'utf8')
    expect(await readInnerVoiceConfig(home)).toEqual({
      enabled: false,
      preset: 'whale598-standard',
      wakeIntervalMinutes: 15,
      speakProbability: 0.9,
      touchReplyProbability: 0,
      touchReplyCooldownSeconds: 45,
      selfWakeBusyPolicy: 'defer',
      petToPetDelivery: 'immediate',
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
        selfWakeBusyPolicy: 'next-week',
        petToPetDelivery: 'carrier-pigeon',
        preset: 42,
      },
    }), 'utf8')
    const config = await readInnerVoiceConfig(home)
    expect(config.wakeIntervalMinutes).toBe(60)
    expect(config.speakProbability).toBe(1)
    expect(config.touchReplyProbability).toBe(0)
    expect(config.touchReplyCooldownSeconds).toBe(30)
    // 忙时策略只收白名单两个值，其余折叠默认 'fire'（到点必醒）。
    expect(config.selfWakeBusyPolicy).toBe('fire')
    // 宠物间消息投递方式只收白名单两值，其余折叠默认 'queue'（排队等醒）。
    expect(config.petToPetDelivery).toBe('queue')
    expect(config.preset).toBe('whale598')
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
  it('round-trips petId → sessionId entries (saved under whale598/)', async () => {
    const home = await tempHome()
    expect(await loadInnerVoiceStore(home)).toEqual({ sessions: {}, generations: {} })
    const store = { sessions: { electron: { sessionId: 'whale598-electron-g0', createdAt: 12 } }, generations: { electron: 3 } }
    await saveInnerVoiceStore(home, store)
    // New layout: the store lives under whale598/ (the legacy root copy is
    // only a read fallback until the first save moves it).
    expect(JSON.parse(await readFile(join(home, 'whale598', 'pet-inner-voice.json'), 'utf8'))).toEqual(store)
    expect(await loadInnerVoiceStore(home)).toEqual(store)
    // Legacy root copy (pre-consolidation) still answers when the new
    // file is absent — the lazy-migration contract.
    await rm(join(home, 'whale598', 'pet-inner-voice.json'), { force: true })
    await writeFile(join(home, 'pet-inner-voice.json'), JSON.stringify(store), 'utf8')
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
    const prompt = buildWakePrompt({
      affection: 66, minutesSinceLastSpoke: undefined, minutesSinceUserActivity: undefined, userActive: false,
    })
    // 世界时钟 is the environment's tick — the old [自主唤醒] tag now names
    // the model's OWN schedule (pet_schedule_wake).
    expect(prompt.startsWith('[世界时钟]')).toBe(true)
    expect(prompt).toContain('第一次醒来')
    expect(prompt).toContain('好感 66')
    const again = buildWakePrompt({
      affection: 66, minutesSinceLastSpoke: 30, minutesSinceUserActivity: 2, userActive: true,
    })
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

describe('self wake plans (自主作息)', () => {
  const plan = (id: string, at: number, intent = `intent-${id}`): WakePlan => ({ id, at, intent, createdAt: 1_000 })

  it('round-trips the plan store (saved under whale598/) and folds malformed entries', async () => {
    const home = await tempHome()
    expect(await loadWakePlans(home)).toEqual({})
    const plans = { electron: [plan('tea', 5_000)], pure: [plan('walk', 6_000, '出去走走')] }
    await saveWakePlans(home, plans)
    expect(JSON.parse(await readFile(join(home, 'whale598', 'pet-wake-plans.json'), 'utf8'))).toEqual({ plans })
    expect(await loadWakePlans(home)).toEqual(plans)
    // Malformed plans fold out; empty lists and empty pet ids drop.
    await writeFile(join(home, 'whale598', 'pet-wake-plans.json'), JSON.stringify({
      plans: {
        electron: [
          plan('ok', 1),
          { id: 'no-at', intent: 'x', createdAt: 1 },
          { id: '', at: 1, intent: 'x', createdAt: 1 },
          'nope',
        ],
        '': [plan('ghost', 1)],
        pure: [],
      },
    }), 'utf8')
    expect(await loadWakePlans(home)).toEqual({ electron: [plan('ok', 1)] })
  })

  it('upserts by id (re-schedule = 改时间) and cancels by id or all', () => {
    const list = [plan('a', 1), plan('b', 2)]
    const upserted = upsertPlan(list, plan('a', 9, '新打算'))
    expect(upserted.map(p => [p.id, p.at, p.intent])).toEqual([['a', 9, '新打算'], ['b', 2, 'intent-b']])
    expect(upsertPlan(list, plan('c', 3)).map(p => p.id)).toEqual(['c', 'a', 'b'])
    const one = cancelPlans(list, 'a')
    expect(one.removed.map(p => p.id)).toEqual(['a'])
    expect(one.next.map(p => p.id)).toEqual(['b'])
    const all = cancelPlans(list)
    expect(all.removed.map(p => p.id)).toEqual(['a', 'b'])
    expect(all.next).toEqual([])
    expect(cancelPlans(list, 'ghost').removed).toEqual([])
  })

  it('consumes only DUE plans (at <= now); future plans survive interruption', () => {
    const list = [plan('past', 900), plan('now', 1_000), plan('future', 1_100)]
    const taken = takeDuePlans(list, 1_000)
    expect(taken.due.map(p => p.id)).toEqual(['past', 'now'])
    expect(taken.next.map(p => p.id)).toEqual(['future'])
  })

  it('merges a plan inside the ±60s window, leaves outside plans alone', () => {
    const list = [plan('near', 1_000 + 30_000), plan('far', 1_000 + 120_000)]
    const near = takeNearDuePlan(list, 1_000)
    expect(near.plan?.id).toBe('near')
    expect(near.next.map(p => p.id)).toEqual(['far'])
    const none = takeNearDuePlan(list, 1_000, 10_000)
    expect(none.plan).toBeUndefined()
    expect(none.next).toBe(list)
  })

  it('counts plans that went stale before boot as missed (catch-up merge)', () => {
    const due = [plan('a', 500), plan('b', 1_500), plan('c', 2_000)]
    expect(missedPlans(due, 1_000).map(p => p.id)).toEqual(['a'])
    expect(missedPlans(due, 0)).toEqual([])
  })

  it('builds the wake prompt per source tag with intents, missed count, overdue and pending plans', () => {
    // self: the original intent rides verbatim — 到点记得自己当初想干嘛
    const self = buildWakePrompt({
      affection: 66, minutesSinceLastSpoke: 30, minutesSinceUserActivity: 2, userActive: true,
      source: 'self', dueIntents: ['想看看用户写完没'],
    })
    expect(self.startsWith('[自主唤醒]')).toBe(true)
    expect(self).toContain('你当初的打算：「想看看用户写完没」')
    expect(self).toContain('上次开口是 30 分钟前')
    // merged: both clocks due in the same sweep tick
    const merged = buildWakePrompt({
      affection: 66, minutesSinceLastSpoke: 5, minutesSinceUserActivity: undefined, userActive: false,
      source: 'world+self', dueIntents: ['a'],
    })
    expect(merged.startsWith('[世界时钟+自主唤醒]')).toBe(true)
    // catch-up: plans that went stale offline are named as missed, one wake
    const missed = buildWakePrompt({
      affection: 10, minutesSinceLastSpoke: undefined, minutesSinceUserActivity: undefined, userActive: false,
      source: 'self', dueIntents: ['x', 'y'], missedCount: 2,
    })
    expect(missed).toContain('错过了 2 个已到期计划')
    // overdue: pet_schedule_wake received a past timestamp — one catch-up
    const overdue = buildWakePrompt({
      affection: 10, minutesSinceLastSpoke: undefined, minutesSinceUserActivity: undefined, userActive: false,
      source: 'self', dueIntents: ['晚了'], overdue: true,
    })
    expect(overdue).toContain('时间就已过了，现在是补醒')
    // pending plans ride along with local-clock times (world clock wakes too)
    const at = new Date(2026, 0, 1, 14, 5).getTime()
    const pending = buildWakePrompt({
      affection: 10, minutesSinceLastSpoke: undefined, minutesSinceUserActivity: undefined, userActive: false,
      pendingPlans: [{ at, intent: '去看看' }],
    })
    expect(pending).toContain('你还有 1 个待执行计划')
    expect(pending).toContain('14:05「去看看」')
  })

  it('merges user turns with a due plan under the [用户+自主唤醒] tag', () => {
    const chat = buildChatPrompt('你好呀', { at: 3_600_000, intent: '遛弯' })
    expect(chat.startsWith('[用户+自主唤醒]')).toBe(true)
    expect(chat).toContain('遛弯')
    expect(chat).toContain('[用户对你说] 你好呀')
    const touch = buildTouchPrompt({ part: 'head', touchesToday: 1, affection: 9, mergedPlan: { at: 3_600_000, intent: '遛弯' } })
    expect(touch.startsWith('[用户+自主唤醒]')).toBe(true)
    expect(touch).toContain('遛弯')
    const plain = buildTouchPrompt({ part: 'body', touchesToday: 1, affection: 9 })
    expect(plain.startsWith('[被触摸]')).toBe(true)
  })
})

describe('pet-to-pet messaging (宠物间消息)', () => {
  const message = (from: string, text: string, at = 1_000): PetMessage => ({ from, text, at })

  it('round-trips the inbox store and folds malformed entries', async () => {
    const home = await tempHome()
    expect(await loadPetMessages(home)).toEqual({})
    const messages = { electron: [message('pure', '一起玩吗')], pure: [message('electron', '好呀', 2)] }
    await savePetMessages(home, messages)
    expect(JSON.parse(await readFile(join(home, 'whale598', 'pet-messages.json'), 'utf8'))).toEqual({ messages })
    expect(await loadPetMessages(home)).toEqual(messages)
    // Malformed entries fold; empty lists and empty pet ids drop.
    await writeFile(join(home, 'whale598', 'pet-messages.json'), JSON.stringify({
      messages: {
        electron: [message('ok', 'hi'), { from: 'no-text', at: 1 }, 'nope'],
        '': [message('ghost', 'x')],
        pure: [],
      },
    }), 'utf8')
    expect(await loadPetMessages(home)).toEqual({ electron: [message('ok', 'hi')] })
  })

  it('caps the inbox at 20 (oldest dropped) and consumes whole on take', () => {
    let list: PetMessage[] = []
    for (let i = 0; i < 25; i += 1) list = queuePetMessage(list, message('pure', `m${String(i)}`, i))
    expect(list).toHaveLength(20)
    expect(list[0].text).toBe('m5') // the oldest five dropped
    const taken = takePetMessages(list)
    expect(taken.taken).toHaveLength(20)
    expect(taken.next).toEqual([])
  })

  it('builds the cross-pet prompt with the sender tag and the reply path', () => {
    const prompt = buildCrossPetPrompt({ fromName: '鲸鱼娘', fromId: 'electron', text: '一起玩吗', affection: 20 })
    expect(prompt.startsWith('[来自另外桌宠 鲸鱼娘]')).toBe(true)
    expect(prompt).toContain('一起玩吗')
    expect(prompt).toContain('你對 鲸鱼娘 的好感 20')
    expect(prompt).toContain('audience="electron"')
    // 携文钳到 200（与气泡硬顶同源）
    const long = buildCrossPetPrompt({ fromName: 'a', fromId: 'a', text: 'x'.repeat(300), affection: 0 })
    expect(long).toContain('x'.repeat(200))
    expect(long).not.toContain('x'.repeat(201))
  })

  it('announces unread counts on the wake prompt without carrying full text', () => {
    const prompt = buildWakePrompt({
      affection: 10, minutesSinceLastSpoke: undefined, minutesSinceUserActivity: undefined, userActive: false,
      unread: [{ fromName: '鲸鱼娘', count: 2 }],
    })
    expect(prompt).toContain('你有 2 条未读消息（来自 鲸鱼娘×2）')
    expect(prompt).toContain('pet_inbox')
    expect(prompt).not.toContain('一起玩吗') // 全文只在 pet_inbox 里
  })
})

describe('greet prompt (启动问好)', () => {
  it('carries the pet\'s name (custom or built-in) as the self-introduction anchor', () => {
    const prompt = buildGreetPrompt({ affection: 2, bondValue: 0, bondDays: 3, bondTier: '陌生', name: '鲸鱼娘' })
    expect(prompt.startsWith('[启动问好]')).toBe(true)
    expect(prompt).toContain('你的名字是「鲸鱼娘」')
    expect(prompt).toContain('好感 2')
    expect(prompt).toContain('一起过了 3 天')
  })
})
