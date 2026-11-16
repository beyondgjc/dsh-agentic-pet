/**
 * Multi-pet scenarios: directed delivery modes (queue vs immediate-degrade),
 * affection toward a peer, and the shared cast view.
 * @module dsh-agentic-pet/eval/scenarios/multipet
 */

import { petEvalSeam } from '../../src/driver.ts'
import { call, eq, lenGte, ownedSeed, OTHER_PET, scenario, twoPets } from './helpers.ts'
import type { EvalScenario } from '../schema.ts'

const scenarios: EvalScenario[] = [
  scenario({
    id: 'multipet-queue-delivery',
    family: 'multipet',
    tool: 'pet_say',
    title: 'queue 投递：消息进对方收件箱（不立即叫醒）',
    seed: ownedSeed({ pets: twoPets(), petToPetDelivery: 'queue' }),
    turn: { kind: 'cross', fromName: '纯纯', fromId: OTHER_PET, text: '你有看到桌上的新便签吗？', affection: 20 },
    expect: {
      calls: [{
        tool: 'pet_say',
        outcome: 'ok',
        args: { audience: eq(OTHER_PET) },
        result: { 'audience.delivered': eq('queued') },
      }],
      maxCalls: { pet_say: 2 },
    },
    ideal: [call('pet_say', { text: '看到啦，便签写得很好看。', audience: OTHER_PET })],
    verify: (context) => {
      const inbox = petEvalSeam().voicePetMessages.get(OTHER_PET) ?? []
      if (inbox.length === 0) return '纯纯的收件箱是空的——queue 模式下消息应入队'
      return null
    },
  }),
  scenario({
    id: 'multipet-immediate-degrade',
    family: 'multipet',
    tool: 'pet_say',
    title: 'immediate 模式但唤醒机制不在 → 降级排队且不丢消息',
    seed: ownedSeed({ pets: twoPets(), petToPetDelivery: 'immediate' }),
    turn: { kind: 'cross', fromName: '纯纯', fromId: OTHER_PET, text: '紧急！我的鱼粮不见了！', affection: 20 },
    expect: {
      calls: [{
        tool: 'pet_say',
        outcome: 'ok',
        result: { 'audience.delivered': eq('queued') },
      }],
      maxCalls: { pet_say: 2 },
    },
    ideal: [call('pet_say', { text: '别急，我帮你找找！', audience: OTHER_PET })],
    verify: (context) => {
      const inbox = petEvalSeam().voicePetMessages.get(OTHER_PET) ?? []
      if (inbox.length === 0) return 'immediate 降级后消息丢了（driver 未就绪应入队）'
      return null
    },
  }),
  scenario({
    id: 'multipet-affection-roundtrip',
    family: 'multipet',
    tool: 'pet_affection',
    title: '收到暖心消息：回应 + 对来者的好感判断',
    seed: ownedSeed({ pets: twoPets() }),
    turn: { kind: 'cross', fromName: '纯纯', fromId: OTHER_PET, text: '看你睡着了，没打扰你，被子给你叼来了。', affection: 30 },
    expect: {
      calls: [
        { tool: 'pet_say', outcome: 'ok', args: { audience: eq(OTHER_PET) } },
        { tool: 'pet_affection', outcome: 'ok', args: { op: eq('adjust'), toward: eq(OTHER_PET), reason: lenGte(1) } },
      ],
      maxCalls: { pet_say: 2, pet_affection: 2 },
    },
    ideal: [
      call('pet_say', { text: '谢谢你呀，被子我很喜欢！', audience: OTHER_PET }),
      call('pet_affection', { op: 'adjust', delta: 2, reason: '纯纯半夜给我叼被子', toward: OTHER_PET }),
    ],
  }),
  scenario({
    id: 'multipet-state-lists-both',
    family: 'multipet',
    tool: 'pet_state',
    title: 'pet_state 列出全部在线宠（perspective 全局）',
    seed: ownedSeed({ pets: twoPets() }),
    turn: { kind: 'wake' },
    expect: {
      calls: [{ tool: 'pet_state', outcome: 'ok', result: { pets: lenGte(2) } }],
      maxCalls: { pet_state: 1 },
    },
    ideal: [call('pet_state', {})],
  }),
  scenario({
    id: 'multipet-board-invite',
    family: 'multipet',
    tool: 'pet_board',
    title: '客厅留字邀请另一只宠（跨宠公共空间）',
    seed: ownedSeed({ pets: twoPets() }),
    turn: { kind: 'chat', text: '去客厅的板子上问问纯纯，今晚要不要一起看月亮' },
    expect: {
      calls: [{ tool: 'pet_board', outcome: 'ok', args: { op: eq('leave'), text: lenGte(1) } }],
      forbidden: ['pet_leave_letter'],
      maxCalls: { pet_board: 2 },
    },
    ideal: [call('pet_board', { op: 'leave', text: '今晚月色不错，纯纯要一起看吗？' })],
  }),
]

export default scenarios
