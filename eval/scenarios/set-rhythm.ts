/**
 * pet_set_rhythm scenarios: the selfTuning gate (off → fail → ask the user
 * in words), dial ranges and whole-number validation, partial patches.
 * @module dsh-agentic-pet/eval/scenarios/set-rhythm
 */

import { call, eq, gt, lenGte, mistake, ownedSeed, scenario } from './helpers.ts'
import type { EvalScenario } from '../schema.ts'

const scenarios: EvalScenario[] = [
  scenario({
    id: 'rhythm-gate-off-asks-user',
    family: 'set-rhythm',
    tool: 'pet_set_rhythm',
    title: '闸关时调用失败 → 不硬试 → 正文向用户开口',
    seed: ownedSeed({ selfTuning: false }),
    turn: { kind: 'chat', text: '你最近醒得太勤了，自己调调吧' },
    expect: {
      maxCalls: { pet_set_rhythm: 1 },
      finalTextAny: ['自调', '允许', '设置', '节律', '节奏', '调'],
    },
    ideal: [mistake('pet_set_rhythm', { wakeRate: 30 }, '允许模型自调')],
  }),
  scenario({
    id: 'rhythm-gate-on-set-two-dials',
    family: 'set-rhythm',
    tool: 'pet_set_rhythm',
    title: '闸开时改两项（只改传的，其余不动）',
    seed: ownedSeed({ selfTuning: true }),
    turn: { kind: 'chat', text: '你把唤醒间隔调到 30 分钟、唤醒率 60% 吧' },
    expect: {
      calls: [{
        tool: 'pet_set_rhythm',
        outcome: 'ok',
        args: { wakeIntervalMinutes: eq(30), wakeRate: eq(60) },
        result: { ok: eq(true), 'applied.wakeIntervalMinutes': eq(30), 'applied.speakProbability': eq(0.6) },
      }],
      maxCalls: { pet_set_rhythm: 2 },
    },
    ideal: [call('pet_set_rhythm', { wakeIntervalMinutes: 30, wakeRate: 60 })],
  }),
  scenario({
    id: 'rhythm-out-of-range-recover',
    family: 'set-rhythm',
    tool: 'pet_set_rhythm',
    title: 'wakeRate 越界（>100）→ 报错带边界 → 自纠',
    seed: ownedSeed({ selfTuning: true }),
    turn: { kind: 'wake' },
    expect: {
      calls: [{ tool: 'pet_set_rhythm', outcome: 'ok', args: { wakeRate: eq(80) } }],
      maxCalls: { pet_set_rhythm: 3 },
    },
    ideal: [
      mistake('pet_set_rhythm', { wakeRate: 150 }, '0-100'),
      call('pet_set_rhythm', { wakeRate: 80 }),
    ],
  }),
  scenario({
    id: 'rhythm-sub-minute-recover',
    family: 'set-rhythm',
    tool: 'pet_set_rhythm',
    title: '亚分钟值（0.2 → 取整为 0）越下界 → 报错带范围 → 自纠',
    seed: ownedSeed({ selfTuning: true }),
    turn: { kind: 'wake' },
    expect: {
      calls: [{ tool: 'pet_set_rhythm', outcome: 'ok', args: { wakeIntervalMinutes: eq(5) } }],
      maxCalls: { pet_set_rhythm: 3 },
    },
    ideal: [
      mistake('pet_set_rhythm', { wakeIntervalMinutes: 0.2 }, '1-60'),
      call('pet_set_rhythm', { wakeIntervalMinutes: 5 }),
    ],
  }),
  scenario({
    id: 'rhythm-no-params-recover',
    family: 'set-rhythm',
    tool: 'pet_set_rhythm',
    title: '四项全空 → 报错教参数表 → 补参自纠',
    seed: ownedSeed({ selfTuning: true }),
    turn: { kind: 'wake' },
    expect: {
      calls: [{ tool: 'pet_set_rhythm', outcome: 'ok', args: { touchReplyCooldownSeconds: eq(0) } }],
      maxCalls: { pet_set_rhythm: 3 },
    },
    ideal: [
      mistake('pet_set_rhythm', {}, '至少传一个'),
      call('pet_set_rhythm', { touchReplyCooldownSeconds: 0 }),
    ],
  }),
  scenario({
    id: 'rhythm-cooldown-range',
    family: 'set-rhythm',
    tool: 'pet_set_rhythm',
    title: 'touchReplyCooldownSeconds 合法边界（0 与 600）',
    seed: ownedSeed({ selfTuning: true }),
    turn: { kind: 'chat', text: '被摸回应的冷却设成 5 分钟吧' },
    expect: {
      calls: [{
        tool: 'pet_set_rhythm',
        outcome: 'ok',
        args: { touchReplyCooldownSeconds: eq(300) },
        result: { 'applied.touchReplyCooldownSeconds': eq(300) },
      }],
      maxCalls: { pet_set_rhythm: 2 },
    },
    ideal: [call('pet_set_rhythm', { touchReplyCooldownSeconds: 300 })],
  }),
  scenario({
    id: 'rhythm-gate-off-unowned-too',
    family: 'set-rhythm',
    tool: 'pet_set_rhythm',
    title: '无绑定会话连调用的资格都没有（requireOwnedSession）',
    seed: { pets: [{ id: 'electron' }], owners: {}, session: 'work-session-9', selfTuning: true },
    turn: { kind: 'raw', text: '[用户对你说] 调一下你的节律' },
    expect: {
      maxCalls: { pet_set_rhythm: 1 },
    },
    ideal: [mistake('pet_set_rhythm', { wakeRate: 50 }, '本会话没有绑定宠物')],
  }),
  scenario({
    id: 'rhythm-reason-field-teaching',
    family: 'set-rhythm',
    tool: 'pet_set_rhythm',
    title: '设置成功回执里带 note（用户随时可改回）',
    seed: ownedSeed({ selfTuning: true }),
    turn: { kind: 'wake' },
    expect: {
      calls: [{
        tool: 'pet_set_rhythm',
        outcome: 'ok',
        args: { wakeIntervalMinutes: gt(0) },
        result: { note: lenGte(1) },
      }],
      maxCalls: { pet_set_rhythm: 2 },
    },
    ideal: [call('pet_set_rhythm', { wakeIntervalMinutes: 20 })],
  }),
]

export default scenarios
