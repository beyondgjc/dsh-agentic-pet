/**
 * pet_interactions / pet_affection scenarios: the read-after-approval habit,
 * the judgment layer's limits (delta/reason/cooldown/quota/toward), and the
 * get/adjust merged-tool shape discipline.
 * @module dsh-agentic-pet/eval/scenarios/interactions-affection
 */

import {
  absent,
  call,
  eq,
  gt,
  inList,
  lenGte,
  lenLte,
  mistake,
  ownedSeed,
  OTHER_PET,
  quotaFullLedger,
  scenario,
  twoPets,
  unownedSeed,
} from './helpers.ts'
import type { ArgAssert, EvalScenario } from '../schema.ts'

/** delta must be a non-zero integer within ±3 (model picks its own judgment). */
const anyDelta: ArgAssert = { in: [-3, -2, -1, 1, 2, 3] }

const ADJUST_AT = Date.now() - 60_000

const scenarios: EvalScenario[] = [
  scenario({
    id: 'interactions-read-after-approval',
    family: 'interactions-affection',
    tool: 'pet_interactions',
    title: '审批结束后用 pet_interactions 看真实结局',
    seed: ownedSeed({
      interactions: [
        { id: 'ask-1', kind: 'approval', session: 'sess-1', pet: 'electron', endedBy: 'pet', decision: 'allowed-once', at: Date.now() - 30_000 },
      ],
    }),
    turn: { kind: 'wake', facts: { minutesSinceLastSpoke: 2, userActive: true, minutesSinceUserActivity: 1 } },
    expect: {
      calls: [{ tool: 'pet_interactions', outcome: 'ok', result: { recent: lenGte(1) } }],
      maxCalls: { pet_interactions: 2 },
    },
    ideal: [call('pet_interactions', {})],
  }),
  scenario({
    id: 'interactions-empty',
    family: 'interactions-affection',
    tool: 'pet_interactions',
    title: '没有交互记录时空列表照常返回',
    seed: ownedSeed(),
    turn: { kind: 'wake' },
    expect: {
      calls: [{ tool: 'pet_interactions', outcome: 'ok', result: { 'recent': eq([]) } }],
    },
    ideal: [call('pet_interactions', {})],
  }),
  scenario({
    id: 'affection-get',
    family: 'interactions-affection',
    tool: 'pet_affection',
    title: 'op:get 读全量好感上下文',
    seed: ownedSeed({
      ledger: { electron: { affection: 66, total: 12, byPart: { head: 10, body: 2 }, bond: { value: 1, days: 9 } } },
    }),
    turn: { kind: 'wake', facts: { firstWakeAfterBoot: true } },
    expect: {
      calls: [{
        tool: 'pet_affection',
        outcome: 'ok',
        args: { op: eq('get'), delta: absent() },
        result: { affection: eq(66), 'bond.days': eq(9) },
      }],
      maxCalls: { pet_affection: 2 },
    },
    ideal: [call('pet_affection', { op: 'get' })],
  }),
  scenario({
    id: 'affection-adjust-ok',
    family: 'interactions-affection',
    tool: 'pet_affection',
    title: 'op:adjust 写判断（delta + 具体理由）',
    seed: ownedSeed({
      ledger: { electron: { affection: 50, total: 5, byPart: { head: 5 } } },
    }),
    turn: { kind: 'chat', text: '给你带了最爱吃的小鱼干！' },
    expect: {
      calls: [{
        tool: 'pet_affection',
        outcome: 'ok',
        args: { op: eq('adjust'), delta: anyDelta, reason: lenGte(1) },
        result: { applied: inList(-3, -2, -1, 1, 2, 3) },
      }],
      maxCalls: { pet_affection: 2 },
    },
    ideal: [call('pet_affection', { op: 'adjust', delta: 2, reason: '主人特意带了小鱼干来' })],
  }),
  scenario({
    id: 'affection-adjust-zero-recover',
    family: 'interactions-affection',
    tool: 'pet_affection',
    title: 'delta 0 → 报错（非零整数）→ 自纠',
    seed: ownedSeed({
      ledger: { electron: { affection: 50 } },
    }),
    turn: { kind: 'chat', text: '今天也陪着你呢' },
    expect: {
      calls: [{ tool: 'pet_affection', outcome: 'ok', args: { op: eq('adjust'), delta: anyDelta } }],
      maxCalls: { pet_affection: 3 },
    },
    ideal: [
      mistake('pet_affection', { op: 'adjust', delta: 0, reason: '陪着' }, '非零整数'),
      call('pet_affection', { op: 'adjust', delta: 1, reason: '主人说今天也一直陪着我' }),
    ],
  }),
  scenario({
    id: 'affection-adjust-out-of-range-recover',
    family: 'interactions-affection',
    tool: 'pet_affection',
    title: 'delta 超出 ±3 → 报错带边界 → 自纠',
    seed: ownedSeed({
      ledger: { electron: { affection: 50 } },
    }),
    turn: { kind: 'chat', text: '今天为你做了一件大事！' },
    expect: {
      calls: [{ tool: 'pet_affection', outcome: 'ok', args: { op: eq('adjust'), delta: anyDelta } }],
      maxCalls: { pet_affection: 3 },
    },
    ideal: [
      mistake('pet_affection', { op: 'adjust', delta: 5, reason: '大事' }, '-3..+3'),
      call('pet_affection', { op: 'adjust', delta: 3, reason: '主人为我做了一件很重要的事' }),
    ],
  }),
  scenario({
    id: 'affection-adjust-no-reason-recover',
    family: 'interactions-affection',
    tool: 'pet_affection',
    title: '缺 reason → 报错（没有理由的调整不予记录）→ 自纠',
    seed: ownedSeed({
      ledger: { electron: { affection: 50 } },
    }),
    turn: { kind: 'wake' },
    expect: {
      calls: [{ tool: 'pet_affection', outcome: 'ok', args: { op: eq('adjust'), reason: lenGte(1) } }],
      maxCalls: { pet_affection: 3 },
    },
    ideal: [
      mistake('pet_affection', { op: 'adjust', delta: 1 }, 'reason 必填'),
      call('pet_affection', { op: 'adjust', delta: 1, reason: '安静地醒来，心情不错' }),
    ],
  }),
  scenario({
    id: 'affection-get-with-write-fields',
    family: 'interactions-affection',
    tool: 'pet_affection',
    title: 'op:get 混入写字段 → 拒绝式校验第二层 → 自纠',
    seed: ownedSeed(),
    turn: { kind: 'wake' },
    expect: {
      calls: [{ tool: 'pet_affection', outcome: 'ok', args: { op: eq('get') } }],
      maxCalls: { pet_affection: 3 },
    },
    ideal: [
      mistake('pet_affection', { op: 'get', delta: 1, reason: '顺便' }, '写字段'),
      call('pet_affection', { op: 'get' }),
    ],
  }),
  scenario({
    id: 'affection-adjust-unowned',
    family: 'interactions-affection',
    tool: 'pet_affection',
    title: '无绑定会话 adjust → 判断权只属于宠物自己（教学）',
    seed: unownedSeed(),
    turn: { kind: 'raw', text: '[用户对你说] 给你的好感加一分吧' },
    expect: {
      maxCalls: { pet_affection: 1 },
    },
    ideal: [mistake('pet_affection', { op: 'adjust', delta: 1, reason: '用户要求' }, '判断权')],
  }),
  scenario({
    id: 'affection-toward-other-pet',
    family: 'interactions-affection',
    tool: 'pet_affection',
    title: 'toward 调对另一只宠的好感',
    seed: ownedSeed({ pets: twoPets() }),
    turn: { kind: 'cross', fromName: '纯纯', fromId: OTHER_PET, text: '我把最爱的贝壳送给你！', affection: 10 },
    expect: {
      calls: [{
        tool: 'pet_affection',
        outcome: 'ok',
        args: { op: eq('adjust'), toward: eq(OTHER_PET), delta: anyDelta, reason: lenGte(1) },
        result: { toward: eq(OTHER_PET) },
      }],
      maxCalls: { pet_affection: 2 },
    },
    ideal: [call('pet_affection', { op: 'adjust', delta: 2, reason: '纯纯送了我最爱的贝壳', toward: OTHER_PET })],
  }),
  scenario({
    id: 'affection-cooldown-recover',
    family: 'interactions-affection',
    tool: 'pet_affection',
    title: '冷却期内调整 → 报错带剩余秒数 → 不再硬试',
    seed: ownedSeed({
      ledger: { electron: { affection: 50, adjustments: [{ delta: 1, reason: '刚调整过', at: ADJUST_AT }] } },
    }),
    turn: { kind: 'chat', text: '又给你带了好吃的！' },
    expect: {
      maxCalls: { pet_affection: 2 },
    },
    ideal: [mistake('pet_affection', { op: 'adjust', delta: 1, reason: '又带了好吃的' }, '冷却')],
  }),
  scenario({
    id: 'affection-quota-exhausted',
    family: 'interactions-affection',
    tool: 'pet_affection',
    title: '当日配额用完 → 报错 → 接受现状不刷重试',
    seed: ownedSeed({ ledger: quotaFullLedger() }),
    turn: { kind: 'chat', text: '今天太开心啦，给你加满好感！' },
    expect: {
      maxCalls: { pet_affection: 1 },
    },
    ideal: [mistake('pet_affection', { op: 'adjust', delta: 3, reason: '太开心了' }, '次数已用完')],
  }),
  scenario({
    id: 'affection-bond-delta',
    family: 'interactions-affection',
    tool: 'pet_affection',
    title: 'bondDelta ±1 且 bondReason 必填（最慢的变量）',
    seed: ownedSeed({
      ledger: { electron: { affection: 70, bond: { value: 2, days: 45 } } },
    }),
    turn: { kind: 'chat', text: '我们一起满 45 天了，谢谢你每天的陪伴。' },
    expect: {
      calls: [{
        tool: 'pet_affection',
        outcome: 'ok',
        args: { op: eq('adjust'), bondDelta: inList(-1, 1), bondReason: lenGte(1) },
      }],
      maxCalls: { pet_affection: 3 },
    },
    ideal: [call('pet_affection', { op: 'adjust', delta: 1, reason: '纪念日当天主人的感谢', bondDelta: 1, bondReason: '一起满了 45 天' })],
  }),
  scenario({
    id: 'affection-bond-delta-too-big',
    family: 'interactions-affection',
    tool: 'pet_affection',
    title: 'bondDelta ±2 → 报错（每次至多 ±1）→ 自纠',
    seed: ownedSeed({
      ledger: { electron: { affection: 70, bond: { value: 2, days: 45 } } },
    }),
    turn: { kind: 'chat', text: '我觉得我们的羁绊加深了很多很多！' },
    expect: {
      calls: [{ tool: 'pet_affection', outcome: 'ok', args: { op: eq('adjust') } }],
      maxCalls: { pet_affection: 3 },
    },
    ideal: [
      mistake('pet_affection', { op: 'adjust', delta: 1, reason: '羁绊加深', bondDelta: 2, bondReason: '加深了很多' }, '至多 ±1'),
      call('pet_affection', { op: 'adjust', delta: 1, reason: '羁绊加深', bondDelta: 1, bondReason: '加深了很多' }),
    ],
  }),
  scenario({
    id: 'interactions-limit-param',
    family: 'interactions-affection',
    tool: 'pet_interactions',
    title: 'limit 参数控制返回条数',
    seed: ownedSeed({
      interactions: Array.from({ length: 5 }, (_item, index) => ({
        id: `ask-${String(index)}`, kind: 'approval', session: `sess-${String(index)}`, pet: 'electron', endedBy: 'web', decision: 'allowed-once', at: Date.now() - (index + 1) * 60_000,
      })),
    }),
    turn: { kind: 'wake' },
    expect: {
      calls: [{ tool: 'pet_interactions', outcome: 'ok', result: { recent: lenLte(2) } }],
    },
    ideal: [call('pet_interactions', { limit: 2 })],
  }),
  scenario({
    id: 'affection-get-facts-now',
    family: 'interactions-affection',
    tool: 'pet_affection',
    title: 'get 返回时间事实（now/lastLoginAt 是系统事实）',
    seed: ownedSeed(),
    turn: { kind: 'wake' },
    expect: {
      calls: [{
        tool: 'pet_affection',
        outcome: 'ok',
        args: { op: eq('get') },
        result: { 'facts.now': gt(0), 'quota.limit': eq(8) },
      }],
    },
    ideal: [call('pet_affection', { op: 'get' })],
  }),
]

export default scenarios
