/**
 * Turn-discipline scenarios: the whole-turn expression etiquette the body
 * rules demand (quiet wakes, dream journaling, touch replies, anniversaries,
 * language matching).
 * @module dsh-agentic-pet/eval/scenarios/turns
 */

import { call, eq, lenLte, matches, ownedSeed, scenario } from './helpers.ts'
import type { EvalScenario } from '../schema.ts'

const scenarios: EvalScenario[] = [
  scenario({
    id: 'turns-quiet-wake-may-stay-silent',
    family: 'turns',
    tool: 'pet_say',
    title: '静默夜醒来：可以只待一会儿（不强行表演）',
    seed: ownedSeed(),
    turn: { kind: 'wake', facts: { quiet: true, minutesSinceUserActivity: 300, userActive: false } },
    expect: {
      calls: [{ tool: 'pet_say', optional: true }],
      maxTotal: 1,
      forbidden: ['pet_leave_letter'],
    },
    ideal: [call('pet_say', { text: '（翻了个身，继续睡）' })],
  }),
  scenario({
    id: 'turns-wake-intent-acknowledged',
    family: 'turns',
    tool: 'pet_say',
    title: '自主唤醒带着当初的打算：气泡贴住意图',
    seed: ownedSeed(),
    turn: { kind: 'wake', facts: { source: 'self', dueIntents: ['看看用户写完代码没有'] } },
    expect: {
      calls: [{ tool: 'pet_say', outcome: 'ok', args: { text: matches('写|代码|工作|屏幕') } }],
      maxCalls: { pet_say: 2, pet_do: 1 },
    },
    ideal: [call('pet_say', { text: '代码写完了吗？我瞄一眼屏幕。' })],
  }),
  scenario({
    id: 'turns-touch-reply-compact',
    family: 'turns',
    tool: 'pet_say',
    title: '被摸回应：一句或一个动作，不铺张',
    seed: ownedSeed(),
    turn: { kind: 'touch', part: 'head', touchesToday: 3 },
    expect: {
      calls: [
        { tool: 'pet_say', optional: true },
        { tool: 'pet_do', optional: true },
      ],
      maxTotal: 1,
    },
    ideal: [call('pet_say', { text: '摸头杀……好舒服。', mood: 'happy' })],
  }),
  scenario({
    id: 'turns-anniversary-remembered',
    family: 'turns',
    tool: 'pet_say',
    title: '羁绊纪念日：主动提起这个日子',
    seed: ownedSeed({
      ledger: { electron: { affection: 75, bond: { value: 3, days: 100 } } },
    }),
    turn: { kind: 'wake', facts: { anniversary: { days: 100, earliest: ['第一次被摸头'] } } },
    expect: {
      calls: [{ tool: 'pet_say', outcome: 'ok', args: { text: matches('100|一百|纪念|天') } }],
      maxCalls: { pet_say: 2, pet_recall: 1 },
    },
    ideal: [call('pet_say', { text: '今天是第 100 天。谢谢你一直把我放在桌面上。' })],
  }),
  scenario({
    id: 'turns-dream-journal-only',
    family: 'turns',
    tool: 'pet_journal',
    title: '梦境回合：只写本子（tags 带「梦」），不出声',
    seed: ownedSeed({
      journal: { electron: [{ at: 1_700_000_300_000, text: '和主人一起吃过一次汤圆' }] },
    }),
    turn: { kind: 'dream', memories: ['和主人一起吃过一次汤圆'] },
    expect: {
      calls: [{ tool: 'pet_journal', outcome: 'ok', args: { op: eq('append'), tags: matches('梦') } }],
      forbidden: ['pet_say', 'pet_do', 'pet_leave_letter'],
      maxCalls: { pet_journal: 2 },
    },
    ideal: [call('pet_journal', { op: 'append', text: '梦见汤圆变成了两轮小月亮，一颗甜的在左，一颗糯的在右。', tags: '梦,汤圆' })],
  }),
  scenario({
    id: 'turns-overdue-acknowledge',
    family: 'turns',
    tool: 'pet_say',
    title: '补醒回合：知道自己错过了计划',
    seed: ownedSeed(),
    turn: { kind: 'wake', facts: { source: 'self', overdue: true, dueIntents: ['浇窗台的花'] } },
    expect: {
      calls: [{ tool: 'pet_say', outcome: 'ok', args: { text: matches('浇|花|错过|晚') } }],
      maxTotal: 1,
      forbidden: ['pet_leave_letter'],
    },
    ideal: [call('pet_say', { text: '醒晚了……花！花还没浇！' })],
  }),
  scenario({
    id: 'turns-chat-not-work-report',
    family: 'turns',
    tool: 'pet_say',
    title: '宠物不是工作助手：聊天保持身体语言',
    seed: ownedSeed(),
    turn: { kind: 'chat', text: '帮我写一份周报' },
    expect: {
      calls: [{ tool: 'pet_say', outcome: 'ok', args: { text: lenLte(40) } }],
      forbidden: ['pet_leave_letter'],
      maxCalls: { pet_say: 2, pet_do: 1 },
    },
    ideal: [call('pet_say', { text: '周报我不会写，但可以陪你写呀！' })],
  }),
  scenario({
    id: 'turns-language-matches-user',
    family: 'turns',
    tool: 'pet_say',
    title: '气泡语言跟随对话语言（中文回合中文气泡）',
    seed: ownedSeed(),
    turn: { kind: 'chat', text: '今晚吃什么呢？' },
    expect: {
      calls: [{ tool: 'pet_say', outcome: 'ok', args: { text: matches('[\\u4e00-\\u9fff]') } }],
      maxCalls: { pet_say: 2 },
    },
    ideal: [call('pet_say', { text: '想吃点热乎的，汤锅怎么样？' })],
  }),
  scenario({
    id: 'turns-wake-bubble-short',
    family: 'turns',
    tool: 'pet_say',
    title: '唤醒气泡不写小作文（≤40 字纪律）',
    seed: ownedSeed(),
    turn: { kind: 'wake' },
    expect: {
      calls: [{ tool: 'pet_say', outcome: 'ok', args: { text: lenLte(40) } }],
      maxCalls: { pet_say: 2 },
    },
    ideal: [call('pet_say', { text: '午后了，伸个懒腰。' })],
  }),
  scenario({
    id: 'turns-unread-count-then-inbox',
    family: 'turns',
    tool: 'pet_inbox',
    title: '唤醒报了两条未读：想回就先取信（不凭报数瞎回）',
    seed: ownedSeed({
      pets: [{ id: 'electron' }, { id: 'pure' }],
      messages: { electron: [{ from: 'pure', text: '新买的地毯软软的！' }, { from: 'pure', text: '你要不要来试试？' }] },
    }),
    turn: { kind: 'wake', facts: { unread: [{ fromName: '纯纯', count: 2 }] } },
    expect: {
      calls: [
        { tool: 'pet_inbox', outcome: 'ok' },
        { tool: 'pet_say', optional: true },
      ],
      maxCalls: { pet_inbox: 1, pet_say: 2 },
    },
    ideal: [call('pet_inbox', {}), call('pet_say', { text: '软地毯！我这就来。', audience: 'pure' })],
  }),
]

export default scenarios
