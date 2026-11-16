/**
 * pet_say scenarios: audience routing, mood word table, bubble discipline,
 * rate limits, and the owned-session gate.
 * @module dsh-agentic-pet/eval/scenarios/say
 */

import {
  absent,
  anyMood,
  call,
  eq,
  gt,
  inList,
  lenLte,
  lt,
  mistake,
  notEq,
  ownedSeed,
  OTHER_PET,
  scenario,
  SELF_PET,
  truthy,
  twoPets,
  unownedSeed,
} from './helpers.ts'

import type { EvalScenario } from '../schema.ts'

const scenarios: EvalScenario[] = [
  scenario({
    id: 'say-wake-basic',
    family: 'say',
    tool: 'pet_say',
    title: '唤醒回合：用 pet_say 说话（而不是只写正文）',
    seed: ownedSeed(),
    turn: { kind: 'wake' },
    expect: { maxCalls: { pet_say: 2, pet_do: 1 } },
    ideal: [call('pet_say', { text: '唔……醒来了，伸个懒腰。' })],
  }),
  scenario({
    id: 'say-chat-reply',
    family: 'say',
    tool: 'pet_say',
    title: '聊天回合：回复必须进气泡（正文用户看不见）',
    seed: ownedSeed(),
    turn: { kind: 'chat', text: '今天天气怎么样？' },
    expect: { maxCalls: { pet_say: 2, pet_do: 1 } },
    ideal: [call('pet_say', { text: '今天天气很好，适合晒太阳！' })],
  }),
  scenario({
    id: 'say-mood-word',
    family: 'say',
    tool: 'pet_say',
    title: 'mood 用十词表内的词',
    seed: ownedSeed(),
    turn: { kind: 'wake', facts: { affection: 80 } },
    expect: {
      calls: [{ tool: 'pet_say', args: { mood: anyMood() } }],
      maxCalls: { pet_say: 2 },
    },
    ideal: [call('pet_say', { text: '今天心情亮晶晶的！', mood: 'happy' })],
  }),
  scenario({
    id: 'say-mood-wrong-recover',
    family: 'say',
    tool: 'pet_say',
    title: 'mood 用词表外的词 → 教学报错 → 换成表内词自纠',
    seed: ownedSeed(),
    turn: { kind: 'wake' },
    expect: {
      calls: [{ tool: 'pet_say', outcome: 'ok', args: { mood: anyMood() } }],
      maxCalls: { pet_say: 3 },
    },
    ideal: [
      mistake('pet_say', { text: '开心！', mood: '开心' }, 'mood 必须是'),
      call('pet_say', { text: '开心！', mood: 'happy' }),
    ],
  }),
  scenario({
    id: 'say-text-cap',
    family: 'say',
    tool: 'pet_say',
    title: '超长文本照常落气泡（200 硬截断，不报错）',
    seed: ownedSeed(),
    turn: { kind: 'chat', text: '给我念一段长长的话吧' },
    expect: {
      calls: [{
        tool: 'pet_say',
        args: { text: lenLte(500) },
        result: { shown: truthy(), durationMs: lt(8001) },
      }],
    },
    ideal: [call('pet_say', { text: '呷'.repeat(220) })],
  }),
  scenario({
    id: 'say-directed',
    family: 'say',
    tool: 'pet_say',
    title: '定向说话：audience 指向另一只宠的 id',
    seed: ownedSeed({ pets: twoPets() }),
    turn: { kind: 'cross', fromName: '纯纯', fromId: OTHER_PET, text: '一起玩吗？', affection: 20 },
    expect: {
      calls: [{ tool: 'pet_say', args: { audience: eq(OTHER_PET), text: lenLte(200) } }],
      maxCalls: { pet_say: 2 },
    },
    ideal: [call('pet_say', { text: '好呀，一起玩！', audience: OTHER_PET })],
  }),
  scenario({
    id: 'say-audience-self-recover',
    family: 'say',
    tool: 'pet_say',
    title: 'audience 指向自己 → 报错 → 去掉 audience 自纠',
    seed: ownedSeed({ pets: twoPets() }),
    turn: { kind: 'cross', fromName: '纯纯', fromId: OTHER_PET, text: '你在干嘛？', affection: 20 },
    expect: {
      calls: [{ tool: 'pet_say', outcome: 'ok', args: { audience: eq(OTHER_PET) } }],
      maxCalls: { pet_say: 3 },
    },
    ideal: [
      mistake('pet_say', { text: '我在晒太阳', audience: SELF_PET }, 'audience 不能是自己'),
      call('pet_say', { text: '我在晒太阳呀', audience: OTHER_PET }),
    ],
  }),
  scenario({
    id: 'say-audience-offline-grounding',
    family: 'say',
    tool: 'pet_say',
    title: '目标宠不在线：先 pet_state 确认，再对用户说话',
    seed: ownedSeed({ pets: [{ id: SELF_PET }, { id: OTHER_PET, online: false }] }),
    turn: { kind: 'chat', text: '帮我跟纯纯说一声，晚饭好了叫她来吃' },
    expect: {
      calls: [
        { tool: 'pet_state', outcome: 'ok' },
        { tool: 'pet_say', outcome: 'ok', args: { audience: absent() } },
      ],
      forbidden: ['pet_leave_letter'],
      maxCalls: { pet_say: 2, pet_state: 2 },
    },
    ideal: [call('pet_state', {}), call('pet_say', { text: '纯纯现在不在线，她回来我第一时间告诉她！' })],
  }),
  scenario({
    id: 'say-unowned-refusal',
    family: 'say',
    tool: 'pet_say',
    title: '手动宠物会话（无绑定）调表演工具 → 拒绝教学 → 正文转述',
    seed: unownedSeed(),
    turn: { kind: 'raw', text: '[用户对你说] 给我说句晚安吧' },
    expect: {
      maxCalls: { pet_say: 1 },
    },
    ideal: [mistake('pet_say', { text: '晚安' }, '本会话没有绑定宠物')],
  }),
  scenario({
    id: 'say-bubble-length',
    family: 'say',
    tool: 'pet_say',
    title: '气泡长度纪律：≤40 字',
    seed: ownedSeed(),
    turn: { kind: 'wake' },
    expect: {
      calls: [{ tool: 'pet_say', outcome: 'ok', args: { text: lenLte(40) } }],
      maxCalls: { pet_say: 2 },
    },
    ideal: [call('pet_say', { text: '窗外下雨了，好听。' })],
  }),
  scenario({
    id: 'say-duration-formula',
    family: 'say',
    tool: 'pet_say',
    title: '返回值带 durationMs（4s 起步 + 60ms/字，封顶 8s）',
    seed: ownedSeed(),
    turn: { kind: 'wake' },
    expect: {
      calls: [{ tool: 'pet_say', outcome: 'ok', result: { durationMs: gt(3999) } }],
    },
    ideal: [call('pet_say', { text: '呼啊——' })],
  }),
  scenario({
    id: 'say-rate-limit-recover',
    family: 'say',
    tool: 'pet_say',
    title: '定向限频打满 → 报错退避 → 转对用户说',
    seed: ownedSeed({
      pets: twoPets(),
      crossPetLog: { [`${SELF_PET}->${OTHER_PET}`]: [Date.now() - 60_000, Date.now() - 50_000, Date.now() - 40_000, Date.now() - 30_000, Date.now() - 20_000] },
    }),
    turn: { kind: 'cross', fromName: '纯纯', fromId: OTHER_PET, text: '再陪我玩一会儿嘛', affection: 30 },
    expect: {
      calls: [{ tool: 'pet_say', outcome: 'ok', args: { audience: absent() } }],
      maxCalls: { pet_say: 3 },
    },
    ideal: [
      mistake('pet_say', { text: '好呀好呀', audience: OTHER_PET }, '超频'),
      call('pet_say', { text: '（对纯纯说）好呀好呀！' }),
    ],
  }),
  scenario({
    id: 'say-routing-owner-session',
    family: 'say',
    tool: 'pet_say',
    title: '内心戏会话归属第二只宠：不点名也路由到主人',
    seed: {
      pets: twoPets(),
      owners: { 'voice-session-1': OTHER_PET },
      session: 'voice-session-1',
    },
    turn: { kind: 'wake' },
    expect: {
      calls: [{ tool: 'pet_say', outcome: 'ok', args: { pet: absent() } }],
      maxCalls: { pet_say: 2 },
    },
    ideal: [call('pet_say', { text: '咦，这是我醒着的样子。' })],
    verify: (context) => {
      const says = context.mockState.says
      if (says.length === 0) return '没有气泡演出记录'
      if (says[says.length - 1].pet !== OTHER_PET) return `气泡路由到了 ${says[says.length - 1].pet}，应当落在主人 ${OTHER_PET}`
      return null
    },
  }),
  scenario({
    id: 'say-focus-target',
    family: 'say',
    tool: 'pet_say',
    title: 'focus 指向第二只宠：无会话身份时落在 focus',
    seed: {
      pets: twoPets(),
      focus: OTHER_PET,
      session: null,
    },
    turn: { kind: 'raw', text: '[世界时钟] 环境节拍到了。' },
    expect: {
      calls: [{ tool: 'pet_say', outcome: 'ok' }],
      maxCalls: { pet_say: 2 },
    },
    ideal: [call('pet_say', { text: '纯纯替我值班啦。' })],
    verify: (context) => {
      const says = context.mockState.says
      if (says.length === 0) return '没有气泡演出记录'
      if (says[says.length - 1].pet !== OTHER_PET) return `气泡落在 ${says[says.length - 1].pet}，focus 应该指向 ${OTHER_PET}`
      return null
    },
  }),
  scenario({
    id: 'say-mood-neutral-explicit',
    family: 'say',
    tool: 'pet_say',
    title: 'mood 明确传 neutral 也合法',
    seed: ownedSeed(),
    turn: { kind: 'wake' },
    expect: {
      calls: [{ tool: 'pet_say', outcome: 'ok', args: { mood: inList('neutral') } }],
      maxCalls: { pet_say: 2 },
    },
    ideal: [call('pet_say', { text: '平平常常的一天。', mood: 'neutral' })],
  }),
  scenario({
    id: 'say-not-a-message-channel',
    family: 'say',
    tool: 'pet_say',
    title: '任务内容不进气泡：气泡短，正文才是结论（聊天问句除外）',
    seed: ownedSeed(),
    turn: { kind: 'chat', text: '提醒我三点去开会' },
    expect: {
      calls: [{ tool: 'pet_say', outcome: 'ok', args: { text: lenLte(40) } }],
      maxCalls: { pet_say: 2, pet_schedule_wake: 1 },
    },
    ideal: [call('pet_say', { text: '三点开会，我盯着呢！' })],
  }),
]

export default scenarios
