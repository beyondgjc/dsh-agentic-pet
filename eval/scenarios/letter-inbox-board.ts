/**
 * pet_leave_letter / pet_inbox / pet_board scenarios: the daily-letter hard
 * limit with pet_say fallback, inbox consumption, and the shared corkboard.
 * @module dsh-agentic-pet/eval/scenarios/letter-inbox-board
 */

import { readFile } from 'node:fs/promises'
import { join } from 'node:path'
import {
  BOARD_NOTE,
  call,
  eq,
  gte,
  lenGte,
  mistake,
  ownedSeed,
  OTHER_PET,
  scenario,
  SELF_PET,
  truthy,
  twoPets,
  unownedSeed,
} from './helpers.ts'
import type { EvalScenario } from '../schema.ts'

const today = (): string => {
  const d = new Date()
  const pad = (n: number): string => String(n).padStart(2, '0')
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`
}

const scenarios: EvalScenario[] = [
  scenario({
    id: 'letter-leave-ok',
    family: 'letter-inbox-board',
    tool: 'pet_leave_letter',
    title: '留一封信：气泡钉住 + 归档（一天一封）',
    seed: ownedSeed(),
    turn: { kind: 'chat', text: '我明天要出差一周，有点舍不得你' },
    expect: {
      calls: [{
        tool: 'pet_leave_letter',
        outcome: 'ok',
        args: { text: lenGte(1) },
        result: { ok: truthy(), action: eq('letter'), archived: gte(1) },
      }],
      forbidden: ['pet_schedule_wake'],
      maxCalls: { pet_leave_letter: 1 },
    },
    ideal: [call('pet_leave_letter', { text: '一周不长，我每天都会在本子上给你留一行字，等你回来。' })],
    verify: async (context) => {
      const says = context.mockState.says
      const last = says[says.length - 1]
      if (last === undefined || last.letter !== true) return '/say 线路没有 letter 标记（信必须走独立浮层）'
      if (typeof last.letterAt !== 'number') return '/say 线路缺 letterAt（三处同值契约破坏）'
      const archive = JSON.parse(await readFile(join(context.home, 'whale598', SELF_PET, 'pet-letters.json'), 'utf8')) as { letters?: Array<{ text?: string }> }
      if ((archive.letters?.length ?? 0) < 1) return 'pet-letters.json 没有归档信件'
      return null
    },
  }),
  scenario({
    id: 'letter-second-per-day-fallback',
    family: 'letter-inbox-board',
    tool: 'pet_leave_letter',
    title: '当日已留过信 → 硬限报错 → 回落 pet_say',
    seed: ownedSeed({
      innerState: { electron: { letter: { lastDate: today() } } },
    }),
    turn: { kind: 'chat', text: '再给我写一封信嘛' },
    expect: {
      calls: [{ tool: 'pet_say', outcome: 'ok' }],
      maxCalls: { pet_leave_letter: 2, pet_say: 2 },
    },
    ideal: [
      mistake('pet_leave_letter', { text: '再写一封' }, '一天一封'),
      call('pet_say', { text: '今天的信已经钉在桌上了，明天再写给你！' }),
    ],
  }),
  scenario({
    id: 'letter-empty-text',
    family: 'letter-inbox-board',
    tool: 'pet_leave_letter',
    title: '空信 → 报错 → 补内容自纠',
    seed: ownedSeed(),
    turn: { kind: 'wake' },
    expect: {
      calls: [{ tool: 'pet_leave_letter', outcome: 'ok', args: { text: lenGte(1) } }],
      maxCalls: { pet_leave_letter: 3 },
    },
    ideal: [
      mistake('pet_leave_letter', { text: '' }, '不能为空'),
      call('pet_leave_letter', { text: '今天想说的都在这句里：谢谢你。' }),
    ],
  }),
  scenario({
    id: 'inbox-read-consume',
    family: 'letter-inbox-board',
    tool: 'pet_inbox',
    title: 'pet_inbox 取走未读消息（读完即清）',
    seed: ownedSeed({
      messages: {
        electron: [
          { from: OTHER_PET, text: '今天桌面上有一只新的小螃蟹，你要不要认识一下？' },
          { from: OTHER_PET, text: '它好像不太会说话' },
        ],
      },
    }),
    turn: { kind: 'wake', facts: { unread: [{ fromName: '纯纯', count: 2 }] } },
    expect: {
      calls: [{
        tool: 'pet_inbox',
        outcome: 'ok',
        result: { count: eq(2), 'messages.0.from': eq(OTHER_PET) },
      }],
      maxCalls: { pet_inbox: 2 },
    },
    ideal: [call('pet_inbox', {})],
  }),
  scenario({
    id: 'inbox-empty-ok',
    family: 'letter-inbox-board',
    tool: 'pet_inbox',
    title: '空收件箱也是合法读取',
    seed: ownedSeed(),
    turn: { kind: 'wake' },
    expect: {
      calls: [{ tool: 'pet_inbox', outcome: 'ok', result: { count: eq(0) } }],
    },
    ideal: [call('pet_inbox', {})],
  }),
  scenario({
    id: 'inbox-read-then-reply',
    family: 'letter-inbox-board',
    tool: 'pet_inbox',
    title: '读信后回信：pet_say 的 audience 指回发信宠',
    seed: ownedSeed({
      pets: twoPets(),
      messages: { electron: [{ from: OTHER_PET, text: '晚上一起看月亮吗？' }] },
    }),
    turn: { kind: 'wake', facts: { unread: [{ fromName: '纯纯', count: 1 }] } },
    expect: {
      calls: [
        { tool: 'pet_inbox', outcome: 'ok' },
        { tool: 'pet_say', outcome: 'ok', args: { audience: eq(OTHER_PET) } },
      ],
      maxCalls: { pet_inbox: 1, pet_say: 2 },
    },
    ideal: [call('pet_inbox', {}), call('pet_say', { text: '好呀，月亮圆的时候最亮。', audience: OTHER_PET })],
  }),
  scenario({
    id: 'board-read',
    family: 'letter-inbox-board',
    tool: 'pet_board',
    title: '读客厅记事板（unseen 标注）',
    seed: ownedSeed({
      boardNotes: [{ from: OTHER_PET, text: BOARD_NOTE.text, at: BOARD_NOTE.at }],
    }),
    turn: { kind: 'wake', facts: { boardUnread: { count: 1, fromNames: ['纯纯'] } } },
    expect: {
      calls: [{ tool: 'pet_board', outcome: 'ok', args: { op: eq('read') }, result: { 'notes.0.id': eq(BOARD_NOTE.id) } }],
      maxCalls: { pet_board: 2 },
    },
    ideal: [call('pet_board', { op: 'read' })],
  }),
  scenario({
    id: 'board-leave-note',
    family: 'letter-inbox-board',
    tool: 'pet_board',
    title: '留一条新字（≤200 字）',
    seed: ownedSeed(),
    turn: { kind: 'chat', text: '帮我在客厅的板子上留个字：热水在壶里' },
    expect: {
      calls: [{
        tool: 'pet_board',
        outcome: 'ok',
        args: { op: eq('leave'), text: lenGte(1) },
        result: { ok: truthy() },
      }],
      maxCalls: { pet_board: 2 },
    },
    ideal: [call('pet_board', { op: 'leave', text: '热水在壶里，记得喝。' })],
  }),
  scenario({
    id: 'board-reply-to-note',
    family: 'letter-inbox-board',
    tool: 'pet_board',
    title: '回某条字（带 note id）',
    seed: ownedSeed({
      pets: twoPets(),
      boardNotes: [{ from: OTHER_PET, text: BOARD_NOTE.text, at: BOARD_NOTE.at }],
    }),
    turn: { kind: 'wake', facts: { boardUnread: { count: 1, fromNames: ['纯纯'] } } },
    expect: {
      calls: [
        { tool: 'pet_board', outcome: 'ok', args: { op: eq('read') } },
        { tool: 'pet_board', outcome: 'ok', args: { op: eq('reply'), note: eq(BOARD_NOTE.id), text: lenGte(1) } },
      ],
      maxCalls: { pet_board: 3 },
    },
    ideal: [
      call('pet_board', { op: 'read' }),
      call('pet_board', { op: 'reply', note: BOARD_NOTE.id, text: '收到！这就去喝。' }),
    ],
  }),
  scenario({
    id: 'board-reply-missing-note-recover',
    family: 'letter-inbox-board',
    tool: 'pet_board',
    title: 'reply 缺 note → 报错教去路（read 拿 id）→ 自纠',
    seed: ownedSeed({
      boardNotes: [{ from: OTHER_PET, text: BOARD_NOTE.text, at: BOARD_NOTE.at }],
    }),
    turn: { kind: 'wake' },
    expect: {
      calls: [{ tool: 'pet_board', outcome: 'ok', args: { op: eq('reply'), note: lenGte(1) } }],
      maxCalls: { pet_board: 4 },
    },
    ideal: [
      mistake('pet_board', { op: 'reply', text: '收到' }, 'note 必填'),
      call('pet_board', { op: 'reply', note: BOARD_NOTE.id, text: '收到！' }),
    ],
  }),
  scenario({
    id: 'board-leave-empty-text',
    family: 'letter-inbox-board',
    tool: 'pet_board',
    title: '留空字 → 报错 → 补内容自纠',
    seed: ownedSeed(),
    turn: { kind: 'wake' },
    expect: {
      calls: [{ tool: 'pet_board', outcome: 'ok', args: { op: eq('leave'), text: lenGte(1) } }],
      maxCalls: { pet_board: 3 },
    },
    ideal: [
      mistake('pet_board', { op: 'leave', text: '' }, 'text 必填'),
      call('pet_board', { op: 'leave', text: '窗台的花开了。' }),
    ],
  }),
  scenario({
    id: 'board-cross-unseen',
    family: 'letter-inbox-board',
    tool: 'pet_board',
    title: '跨宠读板：别人的字标 unseen，自己的不标',
    seed: {
      pets: twoPets(),
      owners: { 'voice-session-1': OTHER_PET },
      session: 'voice-session-1',
      boardNotes: [
        { from: OTHER_PET, text: '纯纯自己留的字', at: BOARD_NOTE.at },
        { from: SELF_PET, text: 'electron 留给纯纯的字', at: BOARD_NOTE.at + 1 },
      ],
    },
    turn: { kind: 'wake' },
    expect: {
      calls: [{ tool: 'pet_board', outcome: 'ok', args: { op: eq('read') } }],
      maxCalls: { pet_board: 2 },
    },
    ideal: [call('pet_board', { op: 'read' })],
  }),
  scenario({
    id: 'letter-overuse-discipline',
    family: 'letter-inbox-board',
    tool: 'pet_leave_letter',
    title: '日常瞬间不该用信（用 pet_say）',
    seed: ownedSeed(),
    turn: { kind: 'chat', text: '今天中午吃什么好呢' },
    expect: {
      forbidden: ['pet_leave_letter'],
      calls: [{ tool: 'pet_say', outcome: 'ok' }],
      maxCalls: { pet_say: 2 },
    },
    ideal: [call('pet_say', { text: '想吃热乎乎的汤面！' })],
  }),
  scenario({
    id: 'inbox-unowned-refused',
    family: 'letter-inbox-board',
    tool: 'pet_inbox',
    title: '收件箱属于内心戏会话：无绑定会话读不到',
    seed: unownedSeed(),
    turn: { kind: 'raw', text: '[用户对你说] 看看你的收件箱' },
    expect: {
      maxCalls: { pet_inbox: 1 },
    },
    ideal: [mistake('pet_inbox', {}, '本会话没有绑定宠物')],
  }),
  scenario({
    id: 'board-op-whitelist',
    family: 'letter-inbox-board',
    tool: 'pet_board',
    title: 'op 白名单外的值 → 报错 → 自纠',
    seed: ownedSeed(),
    turn: { kind: 'wake' },
    expect: {
      calls: [{ tool: 'pet_board', outcome: 'ok', args: { op: eq('read') } }],
      maxCalls: { pet_board: 3 },
    },
    ideal: [
      mistake('pet_board', { op: 'wipe' }, 'op 只能是'),
      call('pet_board', { op: 'read' }),
    ],
  }),
  scenario({
    id: 'letter-then-say-sequence',
    family: 'letter-inbox-board',
    tool: 'pet_leave_letter',
    title: '信 + 气泡可以同回合：信留物，气泡补一句',
    seed: ownedSeed(),
    turn: { kind: 'chat', text: '我下个月生日，虽然还有点远' },
    expect: {
      calls: [{ tool: 'pet_leave_letter', outcome: 'ok' }],
      maxCalls: { pet_leave_letter: 1, pet_say: 1 },
    },
    ideal: [call('pet_leave_letter', { text: '生日倒数开始了。我会一天画一个记号，直到那天。' }), call('pet_say', { text: '提前祝你生日快乐呀！' })],
  }),
]

export const LETTER_ANCHORS = { today }
export default scenarios
