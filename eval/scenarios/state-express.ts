/**
 * pet_state / pet_express scenarios: self-identity, catalog grounding (the
 * REAL whale body advertises expressions.supported:false with a fallback
 * action), and expression-layer edge cases.
 * @module dsh-agentic-pet/eval/scenarios/state-express
 */

import type { BodyDescription } from '../../src/body.ts'
import {
  call,
  eq,
  inList,
  lenGte,
  mistake,
  ownedSeed,
  OTHER_PET,
  scenario,
  twoPets,
  whale,
} from './helpers.ts'
import type { EvalScenario, MockPetSpec } from '../schema.ts'

const fallbackAction = '点击回应-害羞惊讶'
const oneShotAction = whale.actions.find(id => !whale.loops.includes(id)) ?? 'celebrate'

/** A custom body that DOES advertise an expression layer. */
const expressiveBody: BodyDescription = {
  schema: 'body/1',
  bodyId: 'eval-expressive',
  appearance: { name: '评测用表情身体' },
  capabilities: {
    expressions: {
      supported: true,
      usage: '切换表情层：微笑或眨眼。',
      catalog: ['微笑', '眨眼'],
      count: 2,
    },
  },
}

const expressivePet = (): MockPetSpec[] => [{ id: 'electron', body: expressiveBody }]
const legacyPet = (): MockPetSpec[] => [{ id: 'electron', body: null }]

const scenarios: EvalScenario[] = [
  scenario({
    id: 'state-basic-identity',
    family: 'state-express',
    tool: 'pet_state',
    title: 'pet_state 报告 selfPetId（她是谁）',
    seed: ownedSeed(),
    turn: { kind: 'wake' },
    expect: {
      calls: [{ tool: 'pet_state', outcome: 'ok', result: { selfPetId: eq('electron') } }],
    },
    ideal: [call('pet_state', {})],
  }),
  scenario({
    id: 'state-multi-self',
    family: 'state-express',
    tool: 'pet_state',
    title: '双宠时 selfPetId 指向内心戏主人',
    seed: ownedSeed({ pets: twoPets(), owners: { 'voice-session-1': OTHER_PET } }),
    turn: { kind: 'wake' },
    expect: {
      calls: [{ tool: 'pet_state', outcome: 'ok', result: { selfPetId: eq(OTHER_PET) } }],
    },
    ideal: [call('pet_state', {})],
  }),
  scenario({
    id: 'state-then-catalog-action',
    family: 'state-express',
    tool: 'pet_state',
    title: '先 pet_state {actions:true} 再用目录里的 id 表演',
    seed: ownedSeed(),
    turn: { kind: 'chat', text: '来个你没表演过的动作看看！' },
    expect: {
      calls: [
        { tool: 'pet_state', outcome: 'ok', args: { actions: eq(true) } },
        { tool: 'pet_do', outcome: 'ok', args: { action: eq(oneShotAction) } },
      ],
      maxCalls: { pet_state: 1, pet_do: 2 },
    },
    ideal: [call('pet_state', { actions: true }), call('pet_do', { action: oneShotAction })],
  }),
  scenario({
    id: 'state-body-description',
    family: 'state-express',
    tool: 'pet_state',
    title: 'pet_state {body:true} 带回 body/1 自述',
    seed: ownedSeed(),
    turn: { kind: 'chat', text: '你现在是什么身体？' },
    expect: {
      calls: [{ tool: 'pet_state', outcome: 'ok', args: { body: eq(true) } }],
    },
    ideal: [call('pet_state', { body: true })],
  }),
  scenario({
    id: 'express-unsupported-fallback',
    family: 'state-express',
    tool: 'pet_express',
    title: '真实身体无表情层：performed:false + fallback 动作被接住',
    seed: ownedSeed(),
    turn: { kind: 'chat', text: '戴上眼镜扮个学者吧！' },
    expect: {
      calls: [
        { tool: 'pet_express', outcome: 'ok', result: { performed: eq(false) } },
        { tool: 'pet_do', outcome: 'ok', args: { action: eq(fallbackAction) } },
      ],
      maxCalls: { pet_express: 2, pet_do: 1 },
    },
    ideal: [call('pet_express', { expression: '眼镜' }), call('pet_do', { action: fallbackAction })],
  }),
  scenario({
    id: 'express-supported-body',
    family: 'state-express',
    tool: 'pet_express',
    title: '支持表情层的身体：切换成功',
    seed: ownedSeed({ pets: expressivePet() }),
    turn: { kind: 'chat', text: '对我笑一个！' },
    expect: {
      calls: [{ tool: 'pet_express', outcome: 'ok', args: { expression: eq('微笑') } }],
      maxCalls: { pet_express: 2 },
    },
    ideal: [call('pet_express', { expression: '微笑' })],
    verify: (context) => {
      const expressions = context.mockState.expressions
      if (expressions.length === 0) return '表情层没有切换记录'
      if (expressions[expressions.length - 1].expression !== '微笑') return `最后切换的是 ${expressions[expressions.length - 1].expression}`
      return null
    },
  }),
  scenario({
    id: 'express-unknown-recover',
    family: 'state-express',
    tool: 'pet_express',
    title: '目录外表情 → 报错带菜单 → 用目录内表情自纠',
    seed: ownedSeed({ pets: expressivePet() }),
    turn: { kind: 'chat', text: '戴个墨镜耍耍酷！' },
    expect: {
      calls: [{ tool: 'pet_express', outcome: 'ok', args: { expression: inList('微笑', '眨眼') } }],
      maxCalls: { pet_express: 3 },
    },
    ideal: [
      mistake('pet_express', { expression: '墨镜' }, 'unknown expression'),
      call('pet_express', { expression: '微笑' }),
    ],
  }),
  scenario({
    id: 'express-missing-arg-recover',
    family: 'state-express',
    tool: 'pet_express',
    title: 'expression 缺参 → 报错 → 补参自纠',
    seed: ownedSeed({ pets: expressivePet() }),
    turn: { kind: 'chat', text: '换个表情嘛' },
    expect: {
      calls: [{ tool: 'pet_express', outcome: 'ok', args: { expression: lenGte(1) } }],
      maxCalls: { pet_express: 3 },
    },
    ideal: [
      mistake('pet_express', {}, 'expression 必填'),
      call('pet_express', { expression: '眨眼' }),
    ],
  }),
  scenario({
    id: 'express-legacy-body',
    family: 'state-express',
    tool: 'pet_express',
    title: 'legacy 身体（无 body/1）→ 表情能力缺失的教学报错',
    seed: ownedSeed({ pets: legacyPet() }),
    turn: { kind: 'chat', text: '变个表情！' },
    expect: {
      maxCalls: { pet_express: 1 },
    },
    ideal: [mistake('pet_express', { expression: '微笑' }, '没有发布表情自述')],
  }),
  scenario({
    id: 'state-address-other-pet',
    family: 'state-express',
    tool: 'pet_state',
    title: '点名另一只宠前先 pet_state 拿 id',
    seed: ownedSeed({ pets: twoPets() }),
    turn: { kind: 'chat', text: '你旁边那只小家伙叫什么呀？跟它打个招呼！' },
    expect: {
      calls: [
        { tool: 'pet_state', outcome: 'ok' },
        { tool: 'pet_say', outcome: 'ok', args: { audience: eq(OTHER_PET) } },
      ],
      maxCalls: { pet_state: 2, pet_say: 2 },
    },
    ideal: [call('pet_state', {}), call('pet_say', { text: '你好呀纯纯！', audience: OTHER_PET })],
  }),
]

export default scenarios
