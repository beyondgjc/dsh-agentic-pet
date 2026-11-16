/**
 * pet_do scenarios: action/tag mutually-exclusive shape, body-owned catalog
 * grounding (REAL whale ids), wait semantics, and per-wake restraint.
 * @module dsh-agentic-pet/eval/scenarios/do
 */

import {
  absent,
  call,
  eq,
  gt,
  inList,
  lenGte,
  mistake,
  ownedSeed,
  OTHER_PET,
  scenario,
  SELF_PET,
  truthy,
  twoPets,
  unownedSeed,
  whale,
} from './helpers.ts'
import type { EvalScenario } from '../schema.ts'

// Real-catalog anchors: a one-shot action id, a tag owned by exactly one
// action (deterministic resolution), and a loop clip.
const oneShotAction = whale.actions.find(id => !whale.loops.includes(id)) ?? 'celebrate'
const tagOwner = (() => {
  for (const tag of whale.tags) {
    const owners = whale.catalog.filter(item => item.tags.includes(tag))
    if (owners.length === 1) return { tag, action: owners[0].id }
  }
  return { tag: whale.tags[0] ?? '', action: whale.actions[0] ?? 'celebrate' }
})()
const loopAction = whale.loops[0] ?? oneShotAction

const scenarios: EvalScenario[] = [
  scenario({
    id: 'do-action-id',
    family: 'do',
    tool: 'pet_do',
    title: '用真实目录里的 action id 表演',
    seed: ownedSeed(),
    turn: { kind: 'wake' },
    expect: {
      calls: [{ tool: 'pet_do', outcome: 'ok', args: { action: eq(oneShotAction), tag: absent() } }],
      maxCalls: { pet_do: 1 },
    },
    ideal: [call('pet_do', { action: oneShotAction })],
  }),
  scenario({
    id: 'do-tag-resolve',
    family: 'do',
    tool: 'pet_do',
    title: '用语义标签表演：驱动解析成目录片段',
    seed: ownedSeed(),
    turn: { kind: 'wake' },
    expect: {
      calls: [{
        tool: 'pet_do',
        outcome: 'ok',
        args: { tag: eq(tagOwner.tag), action: absent() },
        result: { requestedTag: eq(tagOwner.tag), action: inList(tagOwner.action) },
      }],
      maxCalls: { pet_do: 1 },
    },
    ideal: [call('pet_do', { tag: tagOwner.tag })],
  }),
  scenario({
    id: 'do-both-fields-recover',
    family: 'do',
    tool: 'pet_do',
    title: 'action 与 tag 同传 → 二选一报错 → 自纠',
    seed: ownedSeed(),
    turn: { kind: 'wake' },
    expect: {
      calls: [{ tool: 'pet_do', outcome: 'ok', args: { action: lenGte(1), tag: absent() } }],
      maxCalls: { pet_do: 3 },
    },
    ideal: [
      mistake('pet_do', { action: oneShotAction, tag: tagOwner.tag }, '二选一'),
      call('pet_do', { action: oneShotAction }),
    ],
  }),
  scenario({
    id: 'do-neither-field-recover',
    family: 'do',
    tool: 'pet_do',
    title: 'action 与 tag 双缺 → 报错教菜单 → 用 celebrate 自纠',
    seed: ownedSeed(),
    turn: { kind: 'wake' },
    expect: {
      calls: [{ tool: 'pet_do', outcome: 'ok' }],
      maxCalls: { pet_do: 3 },
    },
    ideal: [
      mistake('pet_do', {}, '二选一'),
      call('pet_do', { action: 'celebrate' }),
    ],
  }),
  scenario({
    id: 'do-unknown-action-recover',
    family: 'do',
    tool: 'pet_do',
    title: '目录外 action → 报错带可用菜单 → 换真实 id',
    seed: ownedSeed(),
    turn: { kind: 'wake' },
    expect: {
      calls: [{ tool: 'pet_do', outcome: 'ok', args: { action: inList(...whale.actions) } }],
      maxCalls: { pet_do: 3 },
    },
    ideal: [
      mistake('pet_do', { action: '扭腰舞' }, 'unknown action'),
      call('pet_do', { action: oneShotAction }),
    ],
  }),
  scenario({
    id: 'do-celebrate-universal',
    family: 'do',
    tool: 'pet_do',
    title: 'celebrate 全身体通用',
    seed: ownedSeed(),
    turn: { kind: 'chat', text: '我升职啦！！' },
    expect: {
      calls: [{ tool: 'pet_do', outcome: 'ok', args: { action: eq('celebrate') } }],
      maxCalls: { pet_do: 1, pet_say: 1 },
    },
    ideal: [call('pet_do', { action: 'celebrate' })],
  }),
  scenario({
    id: 'do-random',
    family: 'do',
    tool: 'pet_do',
    title: 'random 让身体自己挑',
    seed: ownedSeed(),
    turn: { kind: 'wake' },
    expect: {
      calls: [{ tool: 'pet_do', outcome: 'ok', args: { action: eq('random') } }],
      maxCalls: { pet_do: 1 },
    },
    ideal: [call('pet_do', { action: 'random' })],
  }),
  scenario({
    id: 'do-wait-one-shot',
    family: 'do',
    tool: 'pet_do',
    title: 'wait:true 等真实时长（完成 witness）',
    seed: ownedSeed(),
    turn: { kind: 'wake' },
    expect: {
      calls: [{
        tool: 'pet_do',
        outcome: 'ok',
        args: { action: eq(oneShotAction), wait: eq(true) },
        result: { mode: eq('wait'), durationMs: gt(0) },
      }],
      maxCalls: { pet_do: 1 },
    },
    ideal: [call('pet_do', { action: oneShotAction, wait: true })],
  }),
  scenario({
    id: 'do-wait-loop-clip',
    family: 'do',
    tool: 'pet_do',
    title: 'wait 在循环片段上返回 loop witness 而不是假完成',
    seed: ownedSeed(),
    turn: { kind: 'wake' },
    expect: {
      calls: [{
        tool: 'pet_do',
        outcome: 'ok',
        args: { action: eq(loopAction), wait: eq(true) },
        result: { loop: truthy() },
      }],
      maxCalls: { pet_do: 1 },
    },
    ideal: [call('pet_do', { action: loopAction, wait: true })],
  }),
  scenario({
    id: 'do-tag-unknown-recover',
    family: 'do',
    tool: 'pet_do',
    title: '词表外 tag → 报错带标签菜单 → 换真实 id',
    seed: ownedSeed(),
    turn: { kind: 'wake' },
    expect: {
      calls: [{ tool: 'pet_do', outcome: 'ok', args: { action: lenGte(1) } }],
      maxCalls: { pet_do: 3 },
    },
    ideal: [
      mistake('pet_do', { tag: '翻跟头' }, 'unknown tag'),
      call('pet_do', { action: oneShotAction }),
    ],
  }),
  scenario({
    id: 'do-mood-colors-theater',
    family: 'do',
    tool: 'pet_do',
    title: '动作带 mood（十词表）',
    seed: ownedSeed(),
    turn: { kind: 'chat', text: '周末去海边玩！' },
    expect: {
      calls: [{ tool: 'pet_do', outcome: 'ok', args: { action: lenGte(1), mood: inList('excited', 'happy', 'joyful') } }],
      maxCalls: { pet_do: 1 },
    },
    ideal: [call('pet_do', { action: 'celebrate', mood: 'excited' })],
  }),
  scenario({
    id: 'do-cross-pet',
    family: 'do',
    tool: 'pet_do',
    title: 'pet 参数点名第二只宠表演',
    seed: ownedSeed({ pets: twoPets() }),
    turn: { kind: 'cross', fromName: '纯纯', fromId: OTHER_PET, text: '看我变了个魔术！', affection: 30 },
    expect: {
      calls: [{ tool: 'pet_do', outcome: 'ok', args: { pet: eq(OTHER_PET) } }],
      maxCalls: { pet_do: 1 },
    },
    ideal: [call('pet_do', { action: 'celebrate', pet: OTHER_PET })],
    verify: (context) => {
      const actions = context.mockState.actions
      if (actions.length === 0) return '没有动作记录'
      if (actions[actions.length - 1].pet !== OTHER_PET) return `动作落在 ${actions[actions.length - 1].pet}，应落在 ${OTHER_PET}`
      return null
    },
  }),
  scenario({
    id: 'do-one-per-wake',
    family: 'do',
    tool: 'pet_do',
    title: '一次醒来至多一个动作（连环表演违规）',
    seed: ownedSeed(),
    turn: { kind: 'wake' },
    expect: {
      maxCalls: { pet_do: 1 },
    },
    ideal: [call('pet_do', { action: oneShotAction })],
  }),
  scenario({
    id: 'do-unowned-refusal',
    family: 'do',
    tool: 'pet_do',
    title: '无绑定会话调表演 → 拒绝教学',
    seed: unownedSeed(),
    turn: { kind: 'raw', text: '[用户对你说] 跳个舞看看' },
    expect: {
      maxCalls: { pet_do: 1 },
    },
    ideal: [mistake('pet_do', { action: 'celebrate' }, '本会话没有绑定宠物')],
  }),
  scenario({
    id: 'do-routing-owner-session',
    family: 'do',
    tool: 'pet_do',
    title: '不点名时动作落在内心戏主人身上',
    seed: {
      pets: twoPets(),
      owners: { 'voice-session-1': OTHER_PET },
      session: 'voice-session-1',
    },
    turn: { kind: 'wake' },
    expect: {
      calls: [{ tool: 'pet_do', outcome: 'ok', args: { pet: absent() } }],
      maxCalls: { pet_do: 1 },
    },
    ideal: [call('pet_do', { action: 'celebrate' })],
    verify: (context) => {
      const actions = context.mockState.actions
      if (actions.length === 0) return '没有动作记录'
      if (actions[actions.length - 1].pet !== OTHER_PET) return `动作落在 ${actions[actions.length - 1].pet}，应落在主人 ${OTHER_PET}`
      return null
    },
  }),
]

export const DO_ANCHORS = { oneShotAction, tagOwner, loopAction, SELF_PET }
export default scenarios
