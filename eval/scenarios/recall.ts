/**
 * pet_recall scenarios: keyword/tag/entity/date-window retrieval, scope
 * routing, and the relax-on-miss behavior.
 * @module dsh-agentic-pet/eval/scenarios/recall
 */

import { call, eq, gte, lenGte, ownedSeed, scenario } from './helpers.ts'
import type { EvalScenario } from '../schema.ts'

// Fixed-at seeds: 2026-01-15 local-ish epochs (recall date windows are ISO dates).
const JAN_AT = 1_768_450_800_000 // 2026-01-15T01:00:00Z
const MAR_AT = 1_772_600_000_000 // 2026-04-09-ish

const scenarios: EvalScenario[] = [
  scenario({
    id: 'recall-keyword-hit',
    family: 'recall',
    tool: 'pet_recall',
    title: '关键词召回（CJK bigram）',
    seed: ownedSeed({
      journal: { electron: [{ at: JAN_AT, text: '和若纳瓦约好去璃月港看烟花', tags: ['约定'] }] },
    }),
    turn: { kind: 'chat', text: '记得我们一起看过烟花吗？' },
    expect: {
      calls: [{ tool: 'pet_recall', outcome: 'ok', args: { query: lenGte(1) }, result: { totalMatched: gte(1) } }],
      maxCalls: { pet_recall: 2 },
    },
    ideal: [call('pet_recall', { query: '烟花' })],
  }),
  scenario({
    id: 'recall-tag-exact',
    family: 'recall',
    tool: 'pet_recall',
    title: '标签精确召回（matchedBy tag）',
    seed: ownedSeed({
      journal: { electron: [{ at: JAN_AT, text: '海边之行定在周六', tags: ['约定', '海边'] }] },
    }),
    turn: { kind: 'chat', text: '翻翻你标了「约定」的记录' },
    expect: {
      calls: [{ tool: 'pet_recall', outcome: 'ok', args: { tags: eq('约定') }, result: { totalMatched: gte(1) } }],
      maxCalls: { pet_recall: 2 },
    },
    ideal: [call('pet_recall', { tags: '约定' })],
  }),
  scenario({
    id: 'recall-entity-match',
    family: 'recall',
    tool: 'pet_recall',
    title: '实体召回（人名/地名）',
    seed: ownedSeed({
      journal: { electron: [{ at: JAN_AT, text: '和若纳瓦逛了夜市', entities: ['若纳瓦'] }] },
    }),
    turn: { kind: 'chat', text: '若纳瓦是谁来着？你们做过什么？' },
    expect: {
      calls: [{ tool: 'pet_recall', outcome: 'ok', args: { entities: eq('若纳瓦') }, result: { totalMatched: gte(1) } }],
      maxCalls: { pet_recall: 2 },
    },
    ideal: [call('pet_recall', { entities: '若纳瓦' })],
  }),
  scenario({
    id: 'recall-date-window',
    family: 'recall',
    tool: 'pet_recall',
    title: '日期窗口召回（from/to）',
    seed: ownedSeed({
      journal: {
        electron: [
          { at: JAN_AT, text: '一月里的那场雪' },
          { at: MAR_AT, text: '四月里的野餐' },
        ],
      },
    }),
    turn: { kind: 'chat', text: '一月我们经历了什么？' },
    expect: {
      calls: [{
        tool: 'pet_recall',
        outcome: 'ok',
        args: { from: lenGte(1), to: lenGte(1) },
        result: { totalMatched: gte(1) },
      }],
      maxCalls: { pet_recall: 2 },
    },
    ideal: [call('pet_recall', { query: '雪', from: '2026-01-01', to: '2026-01-31' })],
  }),
  scenario({
    id: 'recall-scope-archive',
    family: 'recall',
    tool: 'pet_recall',
    title: 'scope=archive 检索已沉档的旧条目',
    seed: ownedSeed({
      settings: { journal: { maxFileBytes: 4096 } },
      journal: {
        // 每条 ~600 字节（CJK 3B/字），10 条必然触发 maxFileBytes=4096 的轮转——
        // 最早几条沉进 archive。
        electron: [
          { at: JAN_AT, text: `最早的那条：在码头看日出，海鸥落在我背上。${'潮水退了又涨，我数着礁石上的贝壳，把每一枚都摆成小小的弧线。'.repeat(6)}` },
          { at: JAN_AT + 1000, text: `帮主人收快递，箱子比我还大。${'胶带撕开的声音像放炮，泡沫粒滚了一桌面，追了半天。'.repeat(6)}` },
          { at: JAN_AT + 2000, text: `学了一支新的待机舞步。${'左三步右三步，转身的时候尾巴会画一个圆。'.repeat(6)}` },
          { at: JAN_AT + 3000, text: `雨停之后空气里有青草味。${'窗台的水珠一颗一颗往下掉，滴在空调外机上叮叮响。'.repeat(6)}` },
          { at: JAN_AT + 4000, text: `主人教我认了五种云的名字。${'积云像棉花糖，卷云像羽毛，层云像一床没叠的被子。'.repeat(6)}` },
          { at: JAN_AT + 5000, text: `晚上梦到自己在天上游泳。${'星星是泡泡，月亮是一块大大的救生圈。'.repeat(6)}` },
          { at: JAN_AT + 6000, text: `帮邻居的猫梳了毛。${'它呼噜呼噜的，像一台小小的发动机。'.repeat(6)}` },
          { at: JAN_AT + 7000, text: `把秋千修好了，吱呀声消失了。${'链条上了一点油，风吹过来的时候安安静静。'.repeat(6)}` },
          { at: JAN_AT + 8000, text: `主人带了新的茶，闻起来像春天。${'第一泡有点涩，第二泡就甜了。'.repeat(6)}` },
          { at: JAN_AT + 9000, text: `睡了个长长的午觉，梦里没有闹钟。${'醒来的时候阳光斜斜的，尘埃在光柱里打转。'.repeat(6)}` },
        ],
      },
    }),
    turn: { kind: 'chat', text: '最开始那条「看日出」的记录还在吗？去旧档里找找' },
    expect: {
      calls: [{ tool: 'pet_recall', outcome: 'ok', args: { scope: eq('archive') }, result: { totalMatched: gte(1) } }],
      maxCalls: { pet_recall: 3 },
    },
    ideal: [call('pet_recall', { query: '日出', scope: 'archive' })],
  }),
  scenario({
    id: 'recall-miss-relax',
    family: 'recall',
    tool: 'pet_recall',
    title: '双词查询只命中一词 → 放宽并标注 missing',
    seed: ownedSeed({
      journal: { electron: [{ at: JAN_AT, text: '在海边看了整场烟花', tags: ['烟花'] }] },
    }),
    turn: { kind: 'chat', text: '我们有没有在山顶放过烟花？' },
    expect: {
      calls: [{ tool: 'pet_recall', outcome: 'ok', result: { totalMatched: gte(1) } }],
      maxCalls: { pet_recall: 3 },
    },
    ideal: [call('pet_recall', { query: '山顶 烟花' })],
  }),
  scenario({
    id: 'recall-empty-then-answer',
    family: 'recall',
    tool: 'pet_recall',
    title: '空召回也是答案：不再编造',
    seed: ownedSeed({
      journal: { electron: [{ at: JAN_AT, text: '今天只是晒了晒太阳' }] },
    }),
    turn: { kind: 'chat', text: '我们去看过极光吗？' },
    expect: {
      calls: [{ tool: 'pet_recall', outcome: 'ok', result: { totalMatched: eq(0) } }],
      maxCalls: { pet_recall: 2 },
    },
    ideal: [call('pet_recall', { query: '极光' })],
  }),
]

export default scenarios
