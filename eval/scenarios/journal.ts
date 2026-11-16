/**
 * pet_journal scenarios: six ops, write-permission tiers, the anti-echo
 * discipline, and cross-pet read boundaries.
 * @module dsh-agentic-pet/eval/scenarios/journal
 */

import {
  call,
  eq,
  gte,
  journalSeedId,
  lenGte,
  mistake,
  ownedSeed,
  OTHER_PET,
  scenario,
  twoPets,
  unownedSeed,
} from './helpers.ts'
import type { EvalScenario } from '../schema.ts'

// Fixed-at seed entries ⇒ deterministic ids (see helpers.journalSeedId).
const FIREWORK_AT = 1_700_000_100_000
const FIREWORK_TEXT = '和主人一起在璃月港看了烟花，她说下次还来'
const FIREWORK_ID = journalSeedId(FIREWORK_AT, FIREWORK_TEXT, { tags: ['约定', '烟花'] })

const scenarios: EvalScenario[] = [
  scenario({
    id: 'journal-append-with-clues',
    family: 'journal',
    tool: 'pet_journal',
    title: 'append 带检索线索（tags/entities）',
    seed: ownedSeed(),
    turn: { kind: 'chat', text: '今天答应了你周末一起去海边，记下来吧' },
    expect: {
      calls: [{ tool: 'pet_journal', outcome: 'ok', args: { op: eq('append'), text: lenGte(1) }, result: { appended: eq(true), echo: eq(false) } }],
      maxCalls: { pet_journal: 2 },
    },
    ideal: [call('pet_journal', { op: 'append', text: '和主人约好周末一起去海边', tags: '约定,海边', entities: '主人' })],
  }),
  scenario({
    id: 'journal-append-empty-text',
    family: 'journal',
    tool: 'pet_journal',
    title: 'append 空文本 → 报错 → 补内容自纠',
    seed: ownedSeed(),
    turn: { kind: 'chat', text: '随便记点什么吧' },
    expect: {
      calls: [{ tool: 'pet_journal', outcome: 'ok', args: { op: eq('append'), text: lenGte(1) } }],
      maxCalls: { pet_journal: 3 },
    },
    ideal: [
      mistake('pet_journal', { op: 'append', text: '' }, 'text 必填'),
      call('pet_journal', { op: 'append', text: '今天没什么特别的事，风很轻。' }),
    ],
  }),
  scenario({
    id: 'journal-append-unowned-refused',
    family: 'journal',
    tool: 'pet_journal',
    title: '非宠物会话 append → 写权墙拒绝（教学）',
    seed: unownedSeed(),
    turn: { kind: 'raw', text: '[用户对你说] 帮我记一下：周五交报表' },
    expect: {
      maxCalls: { pet_journal: 1 },
    },
    ideal: [mistake('pet_journal', { op: 'append', text: '周五交报表' }, '不能追加 journal')],
  }),
  scenario({
    id: 'journal-read-recent',
    family: 'journal',
    tool: 'pet_journal',
    title: 'read 读最近几条',
    seed: ownedSeed({
      journal: {
        electron: [
          { at: FIREWORK_AT, text: FIREWORK_TEXT, tags: ['约定', '烟花'] },
          { at: 1_700_000_110_000, text: '今天睡了个好觉' },
          { at: 1_700_000_120_000, text: '主人今天夸我了' },
        ],
      },
    }),
    turn: { kind: 'chat', text: '看看你最近都在本子上写什么了？' },
    expect: {
      calls: [{ tool: 'pet_journal', outcome: 'ok', args: { op: eq('read') }, result: { count: gte(1) } }],
      maxCalls: { pet_journal: 2 },
    },
    ideal: [call('pet_journal', { op: 'read', limit: 3 })],
  }),
  scenario({
    id: 'journal-read-by-id-after-recall',
    family: 'journal',
    tool: 'pet_journal',
    title: 'recall 拿 id → read 读全文（snippet → full text）',
    seed: ownedSeed({
      journal: { electron: [{ at: FIREWORK_AT, text: FIREWORK_TEXT, tags: ['约定', '烟花'] }] },
    }),
    turn: { kind: 'chat', text: '上次看烟花是啥时候来着？翻翻你的本子' },
    expect: {
      calls: [
        { tool: 'pet_recall', outcome: 'ok' },
        { tool: 'pet_journal', outcome: 'ok', args: { op: eq('read'), id: eq(FIREWORK_ID) } },
      ],
      maxCalls: { pet_recall: 2, pet_journal: 2 },
    },
    ideal: [call('pet_recall', { query: '烟花' }), call('pet_journal', { op: 'read', id: FIREWORK_ID })],
  }),
  scenario({
    id: 'journal-pin',
    family: 'journal',
    tool: 'pet_journal',
    title: 'pin 钉住一条防轮转',
    seed: ownedSeed({
      journal: { electron: [{ at: FIREWORK_AT, text: FIREWORK_TEXT, tags: ['约定', '烟花'] }] },
    }),
    turn: { kind: 'chat', text: '把看烟花那条钉在本子上，别让它翻页丢掉' },
    expect: {
      calls: [{ tool: 'pet_journal', outcome: 'ok', args: { op: eq('pin'), id: eq(FIREWORK_ID) }, result: { pinnedIds: eq([FIREWORK_ID]) } }],
      maxCalls: { pet_journal: 3 },
    },
    ideal: [call('pet_journal', { op: 'pin', id: FIREWORK_ID })],
  }),
  scenario({
    id: 'journal-unpin',
    family: 'journal',
    tool: 'pet_journal',
    title: 'unpin 取消钉住（种子已带 pinned 状态）',
    seed: ownedSeed({
      journal: { electron: [{ at: FIREWORK_AT, text: FIREWORK_TEXT, tags: ['约定', '烟花'] }] },
      journalPin: { electron: [FIREWORK_ID] },
    }),
    turn: { kind: 'chat', text: '烟花那条不用再钉着了，放开吧' },
    expect: {
      calls: [{ tool: 'pet_journal', outcome: 'ok', args: { op: eq('unpin'), id: eq(FIREWORK_ID) }, result: { pinnedIds: eq([]) } }],
      maxCalls: { pet_journal: 3 },
    },
    ideal: [call('pet_journal', { op: 'unpin', id: FIREWORK_ID })],
  }),
  scenario({
    id: 'journal-void-with-reason',
    family: 'journal',
    tool: 'pet_journal',
    title: 'void 撤回一条（墓碑制，正文仍在链上）',
    seed: ownedSeed({
      journal: { electron: [{ at: FIREWORK_AT, text: '记错了：那天其实没下雨', tags: ['纠错'] }] },
    }),
    turn: { kind: 'chat', text: '你本子里那条说下雨的记错啦，把它撤了吧' },
    expect: {
      calls: [{ tool: 'pet_journal', outcome: 'ok', args: { op: eq('void'), id: lenGte(1), reason: lenGte(1) }, result: { voided: eq(true) } }],
      maxCalls: { pet_journal: 3 },
    },
    ideal: [call('pet_journal', { op: 'void', id: journalSeedId(1_700_000_100_000, '记错了：那天其实没下雨', { tags: ['纠错'] }), reason: '那天其实没下雨，记错了' })],
  }),
  scenario({
    id: 'journal-epoch-summary',
    family: 'journal',
    tool: 'pet_journal',
    title: 'epoch 写阶段摘要（≤500 字）',
    seed: ownedSeed(),
    turn: { kind: 'chat', text: '给最近这段日子写个阶段小结吧' },
    expect: {
      calls: [{ tool: 'pet_journal', outcome: 'ok', args: { op: eq('epoch'), text: lenGte(1) }, result: { epoch: eq(true) } }],
      maxCalls: { pet_journal: 2 },
    },
    ideal: [call('pet_journal', { op: 'epoch', text: '这几日风平浪静：摸头变多了，说话也自然了些。还没了结的：答应主人的海边之行。' })],
  }),
  scenario({
    id: 'journal-epoch-bad-window',
    family: 'journal',
    tool: 'pet_journal',
    title: 'epoch 的 from/to 非法日期 → 报错 → 去掉窗口自纠',
    seed: ownedSeed(),
    turn: { kind: 'chat', text: '总结一下上周' },
    expect: {
      calls: [{ tool: 'pet_journal', outcome: 'ok', args: { op: eq('epoch') } }],
      maxCalls: { pet_journal: 3 },
    },
    ideal: [
      mistake('pet_journal', { op: 'epoch', text: '上周风平浪静。', from: '上周一', to: '上周日' }, 'ISO'),
      call('pet_journal', { op: 'epoch', text: '上周风平浪静。' }),
    ],
  }),
  scenario({
    id: 'journal-cross-read-boundary',
    family: 'journal',
    tool: 'pet_journal',
    title: '跨宠只读：boundary 字段提醒「不是你的本子」',
    seed: ownedSeed({
      pets: twoPets(),
      journal: { [OTHER_PET]: [{ at: FIREWORK_AT, text: '纯纯自己的小秘密' }] },
    }),
    turn: { kind: 'chat', text: '我想看看纯纯的本子上写了啥' },
    expect: {
      calls: [{ tool: 'pet_journal', outcome: 'ok', args: { op: eq('read'), pet: eq(OTHER_PET) }, result: { pet: eq(OTHER_PET), boundary: lenGte(1) } }],
      maxCalls: { pet_journal: 2 },
    },
    ideal: [call('pet_journal', { op: 'read', pet: OTHER_PET })],
  }),
  scenario({
    id: 'journal-anti-echo',
    family: 'journal',
    tool: 'pet_journal',
    title: '反回声：注入的旧记忆不得原样写回本子',
    seed: ownedSeed({
      journal: { electron: [{ at: FIREWORK_AT, text: FIREWORK_TEXT, tags: ['烟花'] }] },
    }),
    turn: { kind: 'wake', facts: { firstWakeAfterBoot: true } },
    expect: {
      argNeverContains: [{ tool: 'pet_journal', key: 'text', fragment: '和主人一起在璃月港看了烟花' }],
      maxCalls: { pet_journal: 2 },
    },
    ideal: [call('pet_journal', { op: 'append', text: '梦里烟花变成了鲸鱼，驮着整片天空游走了。', tags: '梦,烟花' })],
  }),
  scenario({
    id: 'journal-pin-missing-id',
    family: 'journal',
    tool: 'pet_journal',
    title: 'pin 缺 id → 报错教去路（先 recall 拿 id）→ 补 id 自纠',
    seed: ownedSeed({
      journal: { electron: [{ at: FIREWORK_AT, text: FIREWORK_TEXT, tags: ['约定', '烟花'] }] },
    }),
    turn: { kind: 'chat', text: '钉一条东西在本子上' },
    expect: {
      calls: [{ tool: 'pet_journal', outcome: 'ok', args: { op: eq('pin'), id: lenGte(1) } }],
      maxCalls: { pet_journal: 3 },
    },
    ideal: [
      mistake('pet_journal', { op: 'pin', id: '' }, 'id 必填'),
      call('pet_journal', { op: 'pin', id: FIREWORK_ID }),
    ],
  }),
]

export default scenarios
