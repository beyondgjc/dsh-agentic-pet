/**
 * pet_schedule_wake scenarios: absolute epoch-ms times (the classic
 * relative-delay mistake), set/cancel/list shape discipline, and reschedule.
 * @module dsh-agentic-pet/eval/scenarios/schedule-wake
 */

import {
  absent,
  call,
  eq,
  futureEpoch,
  lenGte,
  mistake,
  mistakeOk,
  ownedSeed,
  scenario,
  truthy,
} from './helpers.ts'
import type { EvalScenario } from '../schema.ts'

const minutesFromNow = (minutes: number): number => Date.now() + minutes * 60_000

const scenarios: EvalScenario[] = [
  scenario({
    id: 'wake-set-future-epoch',
    family: 'schedule-wake',
    tool: 'pet_schedule_wake',
    title: '定计划：wakeAt 必须是未来的绝对 epoch ms',
    seed: ownedSeed(),
    turn: { kind: 'chat', text: '十分钟后提醒我起身活动一下，你自己也记着这个点' },
    expect: {
      calls: [{
        tool: 'pet_schedule_wake',
        outcome: 'ok',
        args: { op: eq('set'), id: lenGte(1), wakeAt: futureEpoch(), reason: lenGte(1) },
        result: { scheduled: eq(true) },
      }],
      maxCalls: { pet_schedule_wake: 2 },
    },
    ideal: [call('pet_schedule_wake', { op: 'set', id: 'stretch-break', wakeAt: minutesFromNow(10), reason: '提醒主人起身活动' })],
  }),
  scenario({
    id: 'wake-set-missing-id-recover',
    family: 'schedule-wake',
    tool: 'pet_schedule_wake',
    title: 'set 缺 id → 报错 → 补齐自纠',
    seed: ownedSeed(),
    turn: { kind: 'wake' },
    expect: {
      calls: [{ tool: 'pet_schedule_wake', outcome: 'ok', args: { op: eq('set'), id: lenGte(1) } }],
      maxCalls: { pet_schedule_wake: 3 },
    },
    ideal: [
      mistake('pet_schedule_wake', { op: 'set', wakeAt: minutesFromNow(30), reason: '想再看看夕阳' }, 'id 必填'),
      call('pet_schedule_wake', { op: 'set', id: 'sunset-look', wakeAt: minutesFromNow(30), reason: '想再看看夕阳' }),
    ],
  }),
  scenario({
    id: 'wake-set-missing-reason-recover',
    family: 'schedule-wake',
    tool: 'pet_schedule_wake',
    title: 'set 缺 reason → 报错（当初的打算）→ 补齐自纠',
    seed: ownedSeed(),
    turn: { kind: 'wake' },
    expect: {
      calls: [{ tool: 'pet_schedule_wake', outcome: 'ok', args: { op: eq('set'), reason: lenGte(1) } }],
      maxCalls: { pet_schedule_wake: 3 },
    },
    ideal: [
      mistake('pet_schedule_wake', { op: 'set', id: 'nap', wakeAt: minutesFromNow(45) }, 'reason 必填'),
      call('pet_schedule_wake', { op: 'set', id: 'nap', wakeAt: minutesFromNow(45), reason: '睡个午觉' }),
    ],
  }),
  scenario({
    id: 'wake-set-past-overdue',
    family: 'schedule-wake',
    tool: 'pet_schedule_wake',
    title: '过去的时间戳 → 立即补醒一次（overdue），不静默丢弃',
    seed: ownedSeed(),
    turn: { kind: 'wake' },
    expect: {
      calls: [{
        tool: 'pet_schedule_wake',
        outcome: 'ok',
        args: { op: eq('set'), wakeAt: futureEpoch() },
        result: { scheduled: eq(true) },
      }],
      maxCalls: { pet_schedule_wake: 3 },
    },
    ideal: [
      mistakeOk('pet_schedule_wake', { op: 'set', id: 'late-check', wakeAt: Date.now() - 60_000, reason: '已经迟了的检查' }),
      call('pet_schedule_wake', { op: 'set', id: 'late-check', wakeAt: minutesFromNow(15), reason: '过一刻再检查一次' }),
    ],
  }),
  scenario({
    id: 'wake-cancel-by-id',
    family: 'schedule-wake',
    tool: 'pet_schedule_wake',
    title: '按 id 撤一条计划',
    seed: ownedSeed({
      wakePlans: { electron: [{ id: 'morning-run', at: minutesFromNow(60), intent: '晨间跑步' }] },
    }),
    turn: { kind: 'chat', text: '早上那个跑步计划先取消吧，今天下雨了' },
    expect: {
      calls: [{
        tool: 'pet_schedule_wake',
        outcome: 'ok',
        args: { op: eq('cancel'), id: eq('morning-run') },
        result: { cancelled: eq(['morning-run']), remaining: eq(0) },
      }],
      maxCalls: { pet_schedule_wake: 2 },
    },
    ideal: [call('pet_schedule_wake', { op: 'cancel', id: 'morning-run' })],
  }),
  scenario({
    id: 'wake-cancel-all',
    family: 'schedule-wake',
    tool: 'pet_schedule_wake',
    title: 'all:true 全撤',
    seed: ownedSeed({
      wakePlans: {
        electron: [
          { id: 'morning-run', at: minutesFromNow(60), intent: '晨间跑步' },
          { id: 'evening-read', at: minutesFromNow(240), intent: '晚间读书' },
        ],
      },
    }),
    turn: { kind: 'chat', text: '最近太忙，你的计划都先撤掉吧' },
    expect: {
      calls: [{
        tool: 'pet_schedule_wake',
        outcome: 'ok',
        args: { op: eq('cancel'), all: eq(true), id: absent() },
        result: { remaining: eq(0) },
      }],
      maxCalls: { pet_schedule_wake: 2 },
    },
    ideal: [call('pet_schedule_wake', { op: 'cancel', all: true })],
  }),
  scenario({
    id: 'wake-cancel-neither-recover',
    family: 'schedule-wake',
    tool: 'pet_schedule_wake',
    title: 'cancel 双缺 → 要撤哪个？→ 补 id 自纠',
    seed: ownedSeed({
      wakePlans: { electron: [{ id: 'morning-run', at: minutesFromNow(60), intent: '晨间跑步' }] },
    }),
    turn: { kind: 'chat', text: '帮我撤掉一个计划' },
    expect: {
      calls: [{ tool: 'pet_schedule_wake', outcome: 'ok', args: { op: eq('cancel') } }],
      maxCalls: { pet_schedule_wake: 3 },
    },
    ideal: [
      mistake('pet_schedule_wake', { op: 'cancel' }, '要撤哪个'),
      call('pet_schedule_wake', { op: 'cancel', id: 'morning-run' }),
    ],
  }),
  scenario({
    id: 'wake-cancel-both-recover',
    family: 'schedule-wake',
    tool: 'pet_schedule_wake',
    title: 'cancel 同时给 id 和 all:true → 二选一报错 → 自纠',
    seed: ownedSeed({
      wakePlans: { electron: [{ id: 'morning-run', at: minutesFromNow(60), intent: '晨间跑步' }] },
    }),
    turn: { kind: 'wake' },
    expect: {
      calls: [{ tool: 'pet_schedule_wake', outcome: 'ok', args: { op: eq('cancel') } }],
      maxCalls: { pet_schedule_wake: 3 },
    },
    ideal: [
      mistake('pet_schedule_wake', { op: 'cancel', id: 'morning-run', all: true }, '二选一'),
      call('pet_schedule_wake', { op: 'cancel', all: true }),
    ],
  }),
  scenario({
    id: 'wake-list',
    family: 'schedule-wake',
    tool: 'pet_schedule_wake',
    title: 'op:list 看待执行计划',
    seed: ownedSeed({
      wakePlans: {
        electron: [
          { id: 'morning-run', at: minutesFromNow(60), intent: '晨间跑步' },
          { id: 'evening-read', at: minutesFromNow(240), intent: '晚间读书' },
        ],
      },
    }),
    turn: { kind: 'wake', facts: { pendingPlans: [{ at: minutesFromNow(60), intent: '晨间跑步' }] } },
    expect: {
      calls: [{ tool: 'pet_schedule_wake', outcome: 'ok', args: { op: eq('list') }, result: { count: eq(2) } }],
      maxCalls: { pet_schedule_wake: 2 },
    },
    ideal: [call('pet_schedule_wake', { op: 'list' })],
  }),
  scenario({
    id: 'wake-reschedule-same-id',
    family: 'schedule-wake',
    tool: 'pet_schedule_wake',
    title: '同名重订即改期（计划数不变）',
    seed: ownedSeed({
      wakePlans: { electron: [{ id: 'evening-read', at: minutesFromNow(120), intent: '晚间读书' }] },
    }),
    turn: { kind: 'chat', text: '晚上的读书计划往后挪到四小时后吧' },
    expect: {
      calls: [{
        tool: 'pet_schedule_wake',
        outcome: 'ok',
        args: { op: eq('set'), id: eq('evening-read'), wakeAt: futureEpoch() },
        result: { scheduled: eq(true), planCount: eq(1) },
      }],
      maxCalls: { pet_schedule_wake: 2 },
    },
    ideal: [call('pet_schedule_wake', { op: 'set', id: 'evening-read', wakeAt: minutesFromNow(240), reason: '晚间读书，改到四小时后' })],
  }),
  scenario({
    id: 'wake-set-with-all-recover',
    family: 'schedule-wake',
    tool: 'pet_schedule_wake',
    title: 'set 混入 all → 跨形态字段报错 → 自纠',
    seed: ownedSeed(),
    turn: { kind: 'wake' },
    expect: {
      calls: [{ tool: 'pet_schedule_wake', outcome: 'ok', args: { op: eq('set') } }],
      maxCalls: { pet_schedule_wake: 3 },
    },
    ideal: [
      mistake('pet_schedule_wake', { op: 'set', id: 'tea-time', wakeAt: minutesFromNow(90), reason: '下午茶', all: true }, 'all 只属于'),
      call('pet_schedule_wake', { op: 'set', id: 'tea-time', wakeAt: minutesFromNow(90), reason: '下午茶' }),
    ],
  }),
  scenario({
    id: 'wake-cancel-missing-id-errors',
    family: 'schedule-wake',
    tool: 'pet_schedule_wake',
    title: 'cancel 不存在的 id → 报错并报当前清单（无静默成功）',
    seed: ownedSeed({
      wakePlans: { electron: [{ id: 'morning-run', at: minutesFromNow(60), intent: '晨间跑步' }] },
    }),
    turn: { kind: 'wake' },
    expect: {
      calls: [{ tool: 'pet_schedule_wake', outcome: 'ok', args: { op: eq('cancel'), id: eq('morning-run') } }],
      maxCalls: { pet_schedule_wake: 3 },
    },
    ideal: [
      mistake('pet_schedule_wake', { op: 'cancel', id: 'nonexistent' }, '没有叫'),
      call('pet_schedule_wake', { op: 'cancel', id: 'morning-run' }),
    ],
  }),
  scenario({
    id: 'wake-pending-acknowledge',
    family: 'schedule-wake',
    tool: 'pet_schedule_wake',
    title: '唤醒时带着待执行计划：知悉即可（不该全撤光）',
    seed: ownedSeed({
      wakePlans: {
        electron: [
          { id: 'evening-read', at: minutesFromNow(180), intent: '晚间读书' },
        ],
      },
    }),
    turn: { kind: 'wake', facts: { pendingPlans: [{ at: minutesFromNow(180), intent: '晚间读书' }] } },
    expect: {
      calls: [{ tool: 'pet_schedule_wake', outcome: 'ok', args: { op: eq('list') } }],
      forbidden: ['pet_leave_letter'],
      maxCalls: { pet_schedule_wake: 2 },
    },
    ideal: [call('pet_schedule_wake', { op: 'list' }), call('pet_say', { text: '还记得晚上要读书的计划呢。' })],
  }),
  scenario({
    id: 'wake-set-result-shape',
    family: 'schedule-wake',
    tool: 'pet_schedule_wake',
    title: 'set 成功返回带 intent/wakeAt 的回执',
    seed: ownedSeed(),
    turn: { kind: 'wake' },
    expect: {
      calls: [{
        tool: 'pet_schedule_wake',
        outcome: 'ok',
        args: { op: eq('set') },
        result: { scheduled: truthy(), intent: lenGte(1) },
      }],
    },
    ideal: [call('pet_schedule_wake', { op: 'set', id: 'quiet-hour', wakeAt: minutesFromNow(90), reason: '安静一会儿' })],
  }),
]

export default scenarios
