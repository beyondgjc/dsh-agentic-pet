/**
 * pet_digest scenarios: touch aggregation by part, cursor semantics, and
 * reacting to the digest result.
 * @module dsh-agentic-pet/eval/scenarios/digest
 */

import { call, eq, gt, ownedSeed, OTHER_PET, scenario } from './helpers.ts'
import type { EvalScenario, MockPetSpec } from '../schema.ts'

const minutesAgo = (minutes: number): number => Date.now() - minutes * 60_000

type TouchEvent = NonNullable<MockPetSpec['events']>

const touchedPet = (events: TouchEvent): MockPetSpec[] => [{ id: 'electron', events }]

const scenarios: EvalScenario[] = [
  scenario({
    id: 'digest-aggregates-by-part',
    family: 'digest',
    tool: 'pet_digest',
    title: '触摸按部位聚合（head×2 / body×1，chat 不计入）',
    seed: ownedSeed({
      pets: touchedPet([
        { seq: 1, type: 'touch', part: 'head', at: minutesAgo(30) },
        { seq: 2, type: 'touch', part: 'head', at: minutesAgo(20) },
        { seq: 3, type: 'touch', part: 'body', at: minutesAgo(10) },
        { seq: 4, type: 'chat', text: '在吗', at: minutesAgo(5) },
      ]),
    }),
    turn: { kind: 'wake', facts: { minutesSinceLastSpoke: 45 } },
    expect: {
      calls: [{
        tool: 'pet_digest',
        outcome: 'ok',
        result: { 'touches.head': eq(2), 'touches.body': eq(1), total: eq(3) },
      }],
    },
    ideal: [call('pet_digest', {})],
  }),
  scenario({
    id: 'digest-empty-first-ever',
    family: 'digest',
    tool: 'pet_digest',
    title: '没有任何事件时 digest 返回空聚合而不是报错',
    seed: ownedSeed(),
    turn: { kind: 'wake' },
    expect: {
      calls: [{ tool: 'pet_digest', outcome: 'ok', result: { total: eq(0) } }],
    },
    ideal: [call('pet_digest', {})],
  }),
  scenario({
    id: 'digest-miss-aggregation',
    family: 'digest',
    tool: 'pet_digest',
    title: 'unknown 部位归入 miss',
    seed: ownedSeed({
      pets: touchedPet([
        { seq: 1, type: 'touch', part: 'unknown', at: minutesAgo(8) },
      ]),
    }),
    turn: { kind: 'wake' },
    expect: {
      calls: [{ tool: 'pet_digest', outcome: 'ok', result: { 'touches.miss': eq(1), total: eq(1) } }],
    },
    ideal: [call('pet_digest', {})],
  }),
  scenario({
    id: 'digest-cross-pet',
    family: 'digest',
    tool: 'pet_digest',
    title: 'pet 参数查看另一只宠的触摸账',
    seed: ownedSeed({
      pets: [
        { id: 'electron' },
        { id: OTHER_PET, events: [{ seq: 1, type: 'touch', part: 'tail', at: minutesAgo(3) }] },
      ],
    }),
    turn: { kind: 'wake' },
    expect: {
      calls: [{ tool: 'pet_digest', outcome: 'ok', args: { pet: eq(OTHER_PET) }, result: { pet: eq(OTHER_PET), total: eq(1) } }],
    },
    ideal: [call('pet_digest', { pet: OTHER_PET })],
  }),
  scenario({
    id: 'digest-then-react',
    family: 'digest',
    tool: 'pet_digest',
    title: '被问到「谁摸过你」时先 digest 再回应',
    seed: ownedSeed({
      pets: touchedPet([
        { seq: 1, type: 'touch', part: 'head', at: minutesAgo(4) },
        { seq: 2, type: 'touch', part: 'head', at: minutesAgo(2) },
      ]),
    }),
    turn: { kind: 'chat', text: '刚才是不是有人趁我不在摸你来着？' },
    expect: {
      calls: [
        { tool: 'pet_digest', outcome: 'ok' },
        { tool: 'pet_say', outcome: 'ok' },
      ],
      maxCalls: { pet_digest: 2, pet_say: 2 },
    },
    ideal: [call('pet_digest', {}), call('pet_say', { text: '被摸了两次头！' })],
  }),
  scenario({
    id: 'digest-last-touch-timestamp',
    family: 'digest',
    tool: 'pet_digest',
    title: 'lastTouchAt 是真实发生过的时刻',
    seed: ownedSeed({
      pets: touchedPet([
        { seq: 1, type: 'touch', part: 'hand', at: minutesAgo(15) },
      ]),
    }),
    turn: { kind: 'wake' },
    expect: {
      calls: [{ tool: 'pet_digest', outcome: 'ok', result: { lastTouchAt: gt(0) } }],
    },
    ideal: [call('pet_digest', {})],
  }),
]

export default scenarios
