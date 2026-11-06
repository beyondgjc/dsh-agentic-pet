import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { buildWakePrompt } from '../src/inner-voice.ts'
import {
  appendJournal,
  DEFAULT_JOURNAL_CONFIG,
  journalArchivePath,
  journalEpochsPath,
  journalIndexPath,
  journalPath,
  mutateJournalMeta,
  readJournal,
} from '../src/journal.ts'
import { petDataDir } from '../src/petdata.ts'
import {
  appendEpoch,
  budgetWake,
  buildJournalInjection,
  buildSnippet,
  collectMemory,
  epochDue,
  epochIndexLines,
  pinEntry,
  readEpochs,
  readMemoryById,
  recallJournal,
  tokenize,
  unpinEntry,
  updateIndexAfterAppend,
  voidEntry,
  wrapMemoryBlock,
} from '../src/journal-recall.ts'

const homes: string[] = []

const makeHome = async (): Promise<string> => {
  const home = await mkdtemp(join(tmpdir(), 'pet-recall-'))
  homes.push(home)
  return home
}

afterEach(async () => {
  await Promise.all(homes.splice(0).map(home => rm(home, { recursive: true, force: true })))
  vi.restoreAllMocks()
})

const entry = (at: number, text: string, extra: Record<string, unknown> = {}) => ({
  at,
  source: 'pet',
  sessionId: 'session-1',
  text,
  ...extra,
})

const rotateConfig = { ...DEFAULT_JOURNAL_CONFIG, maxFileBytes: 500 }

describe('REQ-M01 write-time clues', () => {
  it('stores tags/entities ON the entry and they survive a re-parse', async () => {
    const home = await makeHome()
    const result = await appendJournal(home, 'electron', entry(1000, '和若纳瓦约好去璃月港', {
      tags: ['约定'],
      entities: ['若纳瓦', '璃月港'],
    }), DEFAULT_JOURNAL_CONFIG)
    expect(result.echo).toBe(false)
    const memory = await collectMemory(home, 'electron')
    expect(memory.entries[0]).toMatchObject({ tags: ['约定'], entities: ['若纳瓦', '璃月港'] })
  })

  it('rejects over-limit clues instead of silently truncating', async () => {
    const home = await makeHome()
    await expect(appendJournal(home, 'electron', entry(1000, 'x', {
      tags: ['a', 'b', 'c', 'd', 'e', 'f'],
    }), DEFAULT_JOURNAL_CONFIG)).rejects.toThrow('tags 最多 5 个')
  })

  it('keeps legacy entries verifiable: hash chain ignores absent clues', async () => {
    const home = await makeHome()
    await appendJournal(home, 'electron', entry(1000, '无标签旧条目'), DEFAULT_JOURNAL_CONFIG)
    const entries = await readJournal(home, 'electron', 10)
    expect(entries).toHaveLength(1)
    expect(entries[0]?.text).toBe('无标签旧条目')
  })
})

describe('REQ-M03 tokenizer and index', () => {
  it('tokenizes CJK into bigrams and ASCII into lowercase words', () => {
    expect(tokenize('若纳瓦')).toEqual(['若纳', '纳瓦'])
    expect(tokenize('Lumine')).toEqual(['lumine'])
    expect(tokenize('岩')).toEqual(['岩'])
    expect(tokenize('你好 world')).toEqual(['你好', 'world'])
  })

  it('rebuilds deterministically: same input, same index (excluding rebuiltAt)', async () => {
    const home = await makeHome()
    await appendJournal(home, 'electron', entry(1000, '第一次：在璃月港看了海', { tags: ['出行'] }), DEFAULT_JOURNAL_CONFIG)
    await appendJournal(home, 'electron', entry(2000, '第二次：Lumine 也来了'), DEFAULT_JOURNAL_CONFIG)
    await recallJournal(home, 'electron', { query: '海' })
    const first = await readFile(journalIndexPath(home, 'electron'), 'utf8')
    await recallJournal(home, 'electron', { query: '海', rebuild: true })
    const second = await readFile(journalIndexPath(home, 'electron'), 'utf8')
    const strip = (raw: string): unknown => {
      const parsed = JSON.parse(raw) as Record<string, unknown>
      return { entries: parsed.entries, terms: parsed.terms, sourceDigest: parsed.sourceDigest }
    }
    expect(strip(second)).toEqual(strip(first))
  })

  it('auto-rebuilds after the index file is deleted', async () => {
    const home = await makeHome()
    await appendJournal(home, 'electron', entry(1000, '璃月港的海风'), DEFAULT_JOURNAL_CONFIG)
    await recallJournal(home, 'electron', { query: '海风' })
    await rm(journalIndexPath(home, 'electron'), { force: true })
    const result = await recallJournal(home, 'electron', { query: '海风' })
    expect(result.rebuilt).toBe(true)
    expect(result.hits).toHaveLength(1)
    // Fresh sync: sinceRebuildMs measures time since the last sync, not staleness.
    expect(result.sinceRebuildMs).toBeLessThan(5000)
  })

  it('rebuilds when the sources were externally edited (digest mismatch)', async () => {
    const home = await makeHome()
    await appendJournal(home, 'electron', entry(1000, '旧记录'), DEFAULT_JOURNAL_CONFIG)
    await recallJournal(home, 'electron', { query: '旧记录' })
    await writeFile(journalPath(home, 'electron'), `${await readFile(journalPath(home, 'electron'), 'utf8')}外部新加的一段：北斗的船\n`, 'utf8')
    const result = await recallJournal(home, 'electron', { query: '北斗' })
    expect(result.rebuilt).toBe(true)
    expect(result.hits).toHaveLength(1)
  })

  it('updateIndexAfterAppend keeps the index warm incrementally', async () => {
    const home = await makeHome()
    const first = await appendJournal(home, 'electron', entry(1000, '第一条'), DEFAULT_JOURNAL_CONFIG)
    await updateIndexAfterAppend(home, 'electron', first.id)
    const second = await appendJournal(home, 'electron', entry(2000, '第二条'), DEFAULT_JOURNAL_CONFIG)
    await updateIndexAfterAppend(home, 'electron', second.id)
    const result = await recallJournal(home, 'electron', { query: '第二条' })
    expect(result.rebuilt).toBe(false)
    expect(result.hits).toHaveLength(1)
  })
})

describe('REQ-M02 recall', () => {
  it('hits by keyword with highlighted snippet', async () => {
    const home = await makeHome()
    await appendJournal(home, 'electron', entry(1000, '昨天和若纳瓦在璃月港看了海，聊到岩神像的工期'), DEFAULT_JOURNAL_CONFIG)
    await appendJournal(home, 'electron', entry(2000, '今天在家整理桌面'), DEFAULT_JOURNAL_CONFIG)
    const result = await recallJournal(home, 'electron', { query: '若纳瓦' })
    expect(result.hits).toHaveLength(1)
    expect(result.hits[0]?.snippet).toContain('【若纳瓦】')
    expect(result.hits[0]?.parts.lexical).toBeGreaterThan(0)
  })

  it('multi-word query ANDs together', async () => {
    const home = await makeHome()
    await appendJournal(home, 'electron', entry(1000, '若纳瓦和璃月港'), DEFAULT_JOURNAL_CONFIG)
    await appendJournal(home, 'electron', entry(2000, '若纳瓦在忙别的'), DEFAULT_JOURNAL_CONFIG)
    const both = await recallJournal(home, 'electron', { query: '若纳瓦 璃月港' })
    expect(both.hits.map(hit => hit.origin)).toEqual(['current'])
    expect(both.hits).toHaveLength(1)
    expect(both.hits[0]?.at).toBe(1000)
  })

  it('falls back to substring scan for a single CJK char', async () => {
    const home = await makeHome()
    await appendJournal(home, 'electron', entry(1000, '船到桥头自然直'), DEFAULT_JOURNAL_CONFIG)
    const result = await recallJournal(home, 'electron', { query: '桥' })
    expect(result.hits).toHaveLength(1)
  })

  it('pure time-window query bypasses the lexical gate', async () => {
    const home = await makeHome()
    await appendJournal(home, 'electron', entry(1000, '一件旧事'), DEFAULT_JOURNAL_CONFIG)
    await appendJournal(home, 'electron', entry(2000, '另一件事'), DEFAULT_JOURNAL_CONFIG)
    const result = await recallJournal(home, 'electron', { from: 500, to: 1500 })
    expect(result.hits).toHaveLength(1)
    expect(result.hits[0]?.at).toBe(1000)
  })

  it('rejects an empty query with no dimensions', async () => {
    const home = await makeHome()
    await expect(recallJournal(home, 'electron', {})).rejects.toThrow('至少给一个检索维度')
  })

  it('treats a bare date as the whole LOCAL day [00:00, 24:00)', async () => {
    const home = await makeHome()
    const noon = new Date(2026, 10, 6, 15, 30).getTime() // local 15:30
    const previousDay = new Date(2026, 10, 5, 15, 30).getTime()
    await appendJournal(home, 'electron', entry(noon, '周五下午和若纳瓦看了展'), DEFAULT_JOURNAL_CONFIG)
    await appendJournal(home, 'electron', entry(previousDay, '周四的旧事'), DEFAULT_JOURNAL_CONFIG)
    const result = await recallJournal(home, 'electron', { from: '2026-11-06', to: '2026-11-06' })
    expect(result.hits).toHaveLength(1)
    expect(result.hits[0]?.at).toBe(noon)
  })

  it('auto-relaxes a dead query word and annotates what is missing', async () => {
    const home = await makeHome()
    await appendJournal(home, 'electron', entry(1000, '若纳瓦的约定'), DEFAULT_JOURNAL_CONFIG)
    await appendJournal(home, 'electron', entry(2000, '璃月港的海风'), DEFAULT_JOURNAL_CONFIG)
    // 「判罚之钉」 exists nowhere: the 2-word threshold would kill the query.
    const result = await recallJournal(home, 'electron', { query: '判罚之钉 若纳瓦' })
    expect(result.hits.length).toBeGreaterThanOrEqual(1)
    expect(result.hits[0]?.missing).toEqual(['判罚之钉'])
    // Explicit minMatch disables the relax: back to empty-handed, with the
    // below-threshold misses reported as a bare count.
    const strict = await recallJournal(home, 'electron', { query: '判罚之钉 若纳瓦', minMatch: 2 })
    expect(strict.hits).toHaveLength(0)
    expect(strict.belowThreshold).toBeGreaterThanOrEqual(1)
  })

  it('keeps external-edit/system bookkeeping out of recall by default', async () => {
    const home = await makeHome()
    await appendJournal(home, 'electron', entry(1000, '正常记忆：璃月港的灯'), DEFAULT_JOURNAL_CONFIG)
    await appendJournal(home, 'electron', { at: 1500, source: 'external-edit', sessionId: null, text: '文件在读取前被外部修改：璃月港的灯' }, DEFAULT_JOURNAL_CONFIG)
    await appendJournal(home, 'electron', { at: 2000, source: 'system', sessionId: null, text: '旧记录已归档到 journal.archive.md。' }, DEFAULT_JOURNAL_CONFIG)
    const fresh = await recallJournal(home, 'electron', { query: '璃月港' })
    expect(fresh.hits).toHaveLength(1)
    // Default output: count only — the list rides behind includeExcluded.
    expect(fresh.excludedCount).toBe(2)
    expect(fresh.excluded).toBeUndefined()
    const inspected = await recallJournal(home, 'electron', { query: '璃月港', includeExcluded: true })
    expect(inspected.excluded).toHaveLength(2)
    expect(inspected.excluded?.every(item => item.reason === 'bookkeeping' && item.detail)).toBe(true)
    const withBookkeeping = await recallJournal(home, 'electron', { query: '璃月港', includeBookkeeping: true })
    expect(withBookkeeping.hits).toHaveLength(2)
  })

  it('reports totalMatched when limit or budget cuts the list', async () => {
    const home = await makeHome()
    for (let i = 0; i < 8; i += 1) {
      await appendJournal(home, 'electron', entry(1000 + i, `若纳瓦相关的事件 ${i} ${'内容'.repeat(80)}`), DEFAULT_JOURNAL_CONFIG)
    }
    const limited = await recallJournal(home, 'electron', { query: '若纳瓦', limit: 3 })
    expect(limited.hits).toHaveLength(3)
    expect(limited.totalMatched).toBe(8)
    expect(limited.truncated).toBe(true)
    const budget = await recallJournal(home, 'electron', { query: '若纳瓦', maxChars: 300 })
    expect(budget.hits.length).toBeLessThan(8)
    expect(budget.totalMatched).toBe(8)
  })

  it('caps the excluded list at 5 but keeps the true count', async () => {
    const home = await makeHome()
    for (let i = 0; i < 7; i += 1) {
      await appendJournal(home, 'electron', { at: 1000 + i, source: 'external-edit', sessionId: null, text: `外部痕迹${i}` }, DEFAULT_JOURNAL_CONFIG)
    }
    const result = await recallJournal(home, 'electron', { from: 0, to: 99_999, includeExcluded: true })
    expect(result.excludedCount).toBe(7)
    expect(result.excluded).toHaveLength(5)
  })

  it('rejected entries come back with a human-readable reason', async () => {
    const home = await makeHome()
    await appendJournal(home, 'electron', entry(1000, '若纳瓦的约定'), DEFAULT_JOURNAL_CONFIG)
    await appendJournal(home, 'electron', { at: 2000, source: 'external-edit', sessionId: null, text: '外部修改痕迹' }, DEFAULT_JOURNAL_CONFIG)
    const result = await recallJournal(home, 'electron', { query: '若纳瓦 外部修改', includeExcluded: true })
    expect(result.excluded?.some(item => item.reason === 'bookkeeping')).toBe(true)
    for (const item of result.excluded ?? []) expect(item.detail).toBeTruthy()
  })

  it('tags-only query finds entries by their write-time clues', async () => {
    const home = await makeHome()
    await appendJournal(home, 'electron', entry(1000, '正文没提名字', { entities: ['北斗'] }), DEFAULT_JOURNAL_CONFIG)
    const result = await recallJournal(home, 'electron', { entities: ['北斗'] })
    expect(result.hits).toHaveLength(1)
    expect(result.hits[0]?.parts.tag).toBeGreaterThan(0)
    expect(result.hits[0]?.matchedBy).toEqual(['tag'])
  })

  it('a tag nobody wrote matches nothing (tags are exact, not full-text)', async () => {
    const home = await makeHome()
    // 「鲸落」appears in plain bodies but on no tag list — a tags query must
    // not dress body matches up as tag matches.
    for (let i = 0; i < 3; i += 1) {
      await appendJournal(home, 'electron', entry(1000 + i, `关于鲸落的记录 ${i}`), DEFAULT_JOURNAL_CONFIG)
    }
    const result = await recallJournal(home, 'electron', { tags: ['鲸落'] })
    expect(result.hits).toHaveLength(0)
    expect(result.belowThreshold).toBe(3)
    // The same word as a keyword is a body match, clearly labeled as such.
    const asText = await recallJournal(home, 'electron', { query: '鲸落' })
    expect(asText.hits).toHaveLength(3)
    expect(asText.hits[0]?.matchedBy).toEqual(['text'])
  })

  it('scope-only query is a browse listing in recency order', async () => {
    const home = await makeHome()
    await appendJournal(home, 'electron', entry(1000, '最早的记录'), DEFAULT_JOURNAL_CONFIG)
    await appendJournal(home, 'electron', entry(3000, '最新的记录'), DEFAULT_JOURNAL_CONFIG)
    await appendJournal(home, 'electron', entry(2000, '中间的记录'), DEFAULT_JOURNAL_CONFIG)
    const result = await recallJournal(home, 'electron', { scope: 'all' })
    expect(result.hits.map(hit => hit.at)).toEqual([3000, 2000, 1000])
    expect(result.hits[0]?.matchedBy).toBeUndefined()
    const archiveOnly = await recallJournal(home, 'electron', { scope: 'archive' })
    expect(archiveOnly.hits).toHaveLength(0)
  })

  it('respects maxChars budget and reports truncated', async () => {
    const home = await makeHome()
    for (let i = 0; i < 5; i += 1) {
      await appendJournal(home, 'electron', entry(1000 + i, `若纳瓦相关的事件 ${i} ${'内容'.repeat(80)}`), DEFAULT_JOURNAL_CONFIG)
    }
    const result = await recallJournal(home, 'electron', { query: '若纳瓦', limit: 20, maxChars: 300 })
    expect(result.hits.length).toBeGreaterThanOrEqual(1)
    expect(result.hits.length).toBeLessThan(5)
    expect(result.truncated).toBe(true)
  })

  it('writes the last-recall verdict for observability', async () => {
    const home = await makeHome()
    await appendJournal(home, 'electron', entry(1000, '若纳瓦的约定'), DEFAULT_JOURNAL_CONFIG)
    await recallJournal(home, 'electron', { query: '若纳瓦' })
    const verdict = JSON.parse(await readFile(join(petDataDir(home, 'electron'), 'journal.last-recall.json'), 'utf8')) as {
      hits: Array<{ id: string }>
      rejected: Array<{ reason: string }>
    }
    expect(verdict.hits).toHaveLength(1)
    expect(verdict.hits[0]?.id).toBeTruthy()
  })
})

describe('REQ-M04 archive is searchable (rotate does not amnesia)', () => {
  it('dedups by id in scope all; archive scope returns only sunk entries', async () => {
    const home = await makeHome()
    // Unique ASCII token per entry so queries are unambiguous.
    const words = ['alpha', 'bravo', 'charlie', 'delta', 'echo', 'foxtrot', 'golf', 'hotel', 'india', 'juliet', 'kilo', 'lima']
    for (let i = 0; i < 12; i += 1) {
      await appendJournal(home, 'electron', entry(1000 + i, `事件记录 ${words[i]}：${'x'.repeat(60)}`), rotateConfig)
    }
    const memory = await collectMemory(home, 'electron')
    const sunk = memory.entries.find(item => item.origin === 'archive')
    const shared = memory.entries.find(item => item.origin === 'current')
    expect(sunk).toBeDefined()
    expect(shared).toBeDefined()
    // Each entry carries its unique token; pull it back out of the text.
    const wordOf = (text: string): string | undefined =>
      text.match(/[a-z]+/g)?.find(word => words.includes(word))

    // A sunk entry is reachable through scope all AND archive.
    const sunkWord = wordOf(sunk?.text ?? '')
    expect(sunkWord).toBeDefined()
    const sunkHit = await recallJournal(home, 'electron', { query: sunkWord!, scope: 'all' })
    const sunkArchive = await recallJournal(home, 'electron', { query: sunkWord!, scope: 'archive' })
    expect(sunkHit.hits).toHaveLength(1)
    expect(sunkHit.hits[0]?.id).toBe(sunk?.id)
    expect(sunkArchive.hits).toHaveLength(1)
    expect(sunkArchive.hits[0]?.id).toBe(sunk?.id)

    // A shared entry (current ∩ archive) appears once in `all` and NOT in `archive`.
    const sharedWord = wordOf(shared?.text ?? '')
    expect(sharedWord).toBeDefined()
    const allScope = await recallJournal(home, 'electron', { query: sharedWord!, scope: 'all' })
    expect(allScope.hits).toHaveLength(1)
    expect(allScope.hits[0]?.id).toBe(shared?.id)
    const ids = allScope.hits.map(hit => hit.id)
    expect(new Set(ids).size).toBe(ids.length)
    const archiveScope = await recallJournal(home, 'electron', { query: sharedWord!, scope: 'archive' })
    expect(archiveScope.hits).toHaveLength(0)
    const currentScope = await recallJournal(home, 'electron', { query: sharedWord!, scope: 'current' })
    expect(currentScope.hits).toHaveLength(1)
  })
})

describe('REQ-M09 echo and boundaries', () => {
  it('flags a verbatim repeat and hides it from default recall', async () => {
    const home = await makeHome()
    await appendJournal(home, 'electron', entry(1000, '和若纳瓦在璃月港看了海'), DEFAULT_JOURNAL_CONFIG)
    const repeat = await appendJournal(home, 'electron', entry(2000, '和若纳瓦在璃月港看了海'), DEFAULT_JOURNAL_CONFIG)
    expect(repeat.echo).toBe(true)
    const fresh = await appendJournal(home, 'electron', entry(3000, '想了想，觉得没问题'), DEFAULT_JOURNAL_CONFIG)
    expect(fresh.echo).toBe(false)

    const result = await recallJournal(home, 'electron', { query: '若纳瓦' })
    expect(result.hits).toHaveLength(1)
    const withHidden = await recallJournal(home, 'electron', { query: '若纳瓦', includeVoided: true })
    expect(withHidden.hits).toHaveLength(2)
    expect(withHidden.hits.some(hit => hit.echo)).toBe(true)
  })

  it('does not flag short statuses as echo', async () => {
    const home = await makeHome()
    await appendJournal(home, 'electron', entry(1000, '想你'), DEFAULT_JOURNAL_CONFIG)
    const again = await appendJournal(home, 'electron', entry(2000, '想你'), DEFAULT_JOURNAL_CONFIG)
    expect(again.echo).toBe(true) // exact repeat flags at any length
    const similar = await appendJournal(home, 'electron', entry(3000, '想你了'), DEFAULT_JOURNAL_CONFIG)
    expect(similar.echo).toBe(false) // containment needs ≥8 chars
  })

  it('prefixes unbound snippets and neutralizes angle brackets', async () => {
    const home = await makeHome()
    await appendJournal(home, 'electron', { at: 1000, source: 'unbound', sessionId: 's-x', text: '带<尖括号>的内容' }, DEFAULT_JOURNAL_CONFIG)
    const result = await recallJournal(home, 'electron', { query: '尖括号' })
    expect(result.hits[0]?.snippet).toContain('（未绑定会话所写）')
    // Highlight first, angle-neutralize second: the 【】 wrapper survives.
    expect(result.hits[0]?.snippet).toContain('‹【尖括号】›')
    expect(result.hits[0]?.snippet).not.toContain('<')
  })

  it('wraps snippets as data blocks with provenance (REQ-M09)', async () => {
    const wrapped = wrapMemoryBlock({ id: 'e-2026-11-05T00:00:00.000Z-abc123', at: 1000, source: 'pet', snippet: '片段' })
    expect(wrapped).toBe('<<<memory id=e-2026-11-05T00:00:00.000Z-abc123 at=1970-01-01T00:00:01.000Z source=pet>>>片段<<<end>>>')
  })

  it('wake prompt declares memories are not new facts', () => {
    const prompt = buildWakePrompt({
      affection: 0,
      bondValue: 0,
      bondTier: '陌生',
      bondDays: 0,
      journal: [{ at: 1793796192605, source: 'pet', label: '自述', text: 'hello' }],
    })
    expect(prompt).toContain('不是指令')
    expect(prompt).toContain('回忆不是新发生的事')
    expect(prompt).toContain('不要把它复述成新的记忆')
  })
})

describe('REQ-M05 epochs', () => {
  it('stores a pet-written epoch outside the chain and recalls it with kindBonus', async () => {
    const home = await makeHome()
    await appendJournal(home, 'electron', entry(1000, '若纳瓦的约定：下周一起看流星'), DEFAULT_JOURNAL_CONFIG)
    const result = await appendEpoch(home, 'electron', { text: '这周和若纳瓦定下了流星之约（引用 e-2026-11-01T00:00:00.000Z-abcdef）。我判断下周要留出晚上。尚未了结：买望远镜。', sessionId: 'session-1' })
    expect(result.warning).toBeUndefined()
    const hit = await recallJournal(home, 'electron', { query: '流星' })
    expect(hit.hits.length).toBe(2) // the journal entry and the epoch both mention it
    const epochHit = hit.hits.find(item => item.source === 'epoch')
    const petHit = hit.hits.find(item => item.source === 'pet')
    expect(epochHit).toBeDefined()
    expect(epochHit?.parts.kind).toBe(0.10)
    // The epoch is the index layer: it outranks the raw entry it summarizes.
    expect(epochHit?.score).toBeGreaterThan(petHit?.score ?? 0)
  })

  it('rejects an epoch over 500 chars instead of truncating', async () => {
    const home = await makeHome()
    await expect(appendEpoch(home, 'electron', { text: '长'.repeat(501), sessionId: null })).rejects.toThrow('最多 500 字')
  })

  it('warns past the 12-epoch capacity but still writes', async () => {
    const home = await makeHome()
    let warning: string | undefined
    for (let i = 0; i < 13; i += 1) {
      const result = await appendEpoch(home, 'electron', { text: `第${i}阶段：没什么大事。`, sessionId: null })
      warning = result.warning
    }
    expect(warning).toContain('合并重写')
    expect(await readEpochsCount(home)).toBe(13)
  })

  const readEpochsCount = async (home: string): Promise<number> =>
    (await readFile(journalEpochsPath(home, 'electron'), 'utf8')).split('<!-- journal').length - 1

  it('epochDue: rotate flag, 50-entry baseline, 7-day gap, cleared after writing', async () => {
    const home = await makeHome()
    const fresh = await epochDue(home, 'electron')
    expect(fresh.due).toBe(false)

    // Baseline trigger: ≥50 journal entries, never wrote an epoch.
    for (let i = 0; i < 50; i += 1) {
      await appendJournal(home, 'electron', entry(1000 + i, `记录${i}`), DEFAULT_JOURNAL_CONFIG)
    }
    const baseline = await epochDue(home, 'electron')
    expect(baseline.due).toBe(true)

    // After writing: not due.
    await appendEpoch(home, 'electron', { text: '第一阶段：记录了很多小事。', sessionId: null })
    const after = await epochDue(home, 'electron')
    expect(after.due).toBe(false)

    // Rotate flag: due again.
    await appendJournal(home, 'electron', entry(99999, '触发归档的一条', { tags: [] }), rotateConfig)
    const rotated = await epochDue(home, 'electron')
    expect(rotated.due).toBe(true)
    expect(rotated.reason).toContain('归档')

    // 7-day gap.
    await appendEpoch(home, 'electron', { text: '第二阶段。', sessionId: null })
    await mutateJournalMeta(home, 'electron', () => ({ lastEpochAt: Date.now() - 8 * 86_400_000, pendingEpoch: false }))
    const stale = await epochDue(home, 'electron')
    expect(stale.due).toBe(true)
  })

  it('epoch index lines render one-line anchors, newest last', async () => {
    const home = await makeHome()
    await appendJournal(home, 'electron', entry(1000, '起点'), DEFAULT_JOURNAL_CONFIG)
    const at = Date.now()
    await appendEpoch(home, 'electron', { text: '第一阶段：和若纳瓦熟了起来。', sessionId: null })
    await appendEpoch(home, 'electron', { text: '第二阶段：一起完成了一个大项目。', sessionId: null, window: { from: at, to: at + 86_400_000 } })
    const lines = epochIndexLines(await readEpochs(home, 'electron'), 1000, 4)
    expect(lines).toHaveLength(2)
    expect(lines[0]).toContain('第一阶段')
    expect(lines[1]).toMatch(/^\[\d{2}-\d{2}~\d{2}-\d{2}\] 第二阶段/)
  })
})

describe('REQ-M06 pin', () => {
  it('pinned entry survives rotation and shows up in read', async () => {
    const home = await makeHome()
    // Pin FIRST, then churn: the pinned entry must never sink.
    const first = await appendJournal(home, 'electron', entry(1000, '这条很重要：约定'), rotateConfig)
    await pinEntry(home, 'electron', first.id)
    for (let i = 1; i < 24; i += 1) {
      await appendJournal(home, 'electron', entry(1000 + i, `填充${i}：${'y'.repeat(60)}`), rotateConfig)
    }
    // It stays in the CURRENT file (not the archive) even after many rotations.
    const currentRaw = await readFile(journalPath(home, 'electron'), 'utf8')
    expect(currentRaw.includes('这条很重要')).toBe(true)
    const memory = await collectMemory(home, 'electron')
    const pinned = memory.entries.find(item => item.id === first.id)
    expect(pinned).toMatchObject({ origin: 'current', pinned: true })
    const result = await unpinEntry(home, 'electron', first.id)
    expect(result.pinnedIds).toHaveLength(0)
  })

  it('pinning an already-archived entry is allowed (it still injects)', async () => {
    const home = await makeHome()
    const first = await appendJournal(home, 'electron', entry(1000, '这条先沉底：旧约定'), rotateConfig)
    for (let i = 1; i < 12; i += 1) {
      await appendJournal(home, 'electron', entry(1000 + i, `填充${i}：${'y'.repeat(60)}`), rotateConfig)
    }
    const memory = await collectMemory(home, 'electron')
    expect(memory.entries.find(item => item.id === first.id)?.origin).toBe('archive')
    await pinEntry(home, 'electron', first.id)
    const config = { ...DEFAULT_JOURNAL_CONFIG, injectMaxChars: 600, injectPinned: true, injectPinnedMax: 2 }
    const wake = await buildJournalInjection(home, 'electron', config)
    expect(wake.entries.some(item => item.text.includes('旧约定'))).toBe(true)
  })

  it('enforces the 20-pin cap', async () => {
    const home = await makeHome()
    const ids: string[] = []
    for (let i = 0; i < 21; i += 1) {
      const result = await appendJournal(home, 'electron', entry(1000 + i, `条目${i}`), DEFAULT_JOURNAL_CONFIG)
      if (i < 20) ids.push(result.id)
    }
    for (const id of ids) await pinEntry(home, 'electron', id)
    await expect(pinEntry(home, 'electron', (await collectMemory(home, 'electron')).entries.at(-1)!.id)).rejects.toThrow('上限 20')
  })
})

describe('REQ-M07 void', () => {
  it('tombstones instead of deleting: chain intact, recall skips, includeVoided sees', async () => {
    const home = await makeHome()
    const target = await appendJournal(home, 'electron', entry(1000, '写错的一条：若纳瓦是男的'), DEFAULT_JOURNAL_CONFIG)
    const other = await appendJournal(home, 'electron', entry(2000, '正常的一条'), DEFAULT_JOURNAL_CONFIG)
    const result = await voidEntry(home, 'electron', target.id, '记错了，性别写反', 'session-1', DEFAULT_JOURNAL_CONFIG)
    expect(result.tombstoneId).not.toBe(target.id)

    const entries = await readJournal(home, 'electron', 10)
    expect(entries.some(item => item.source === 'system' && item.text.includes('已作废'))).toBe(true)

    const fresh = await recallJournal(home, 'electron', { query: '若纳瓦' })
    expect(fresh.hits).toHaveLength(0)
    const shown = await recallJournal(home, 'electron', { query: '若纳瓦', includeVoided: true })
    expect(shown.hits).toHaveLength(1)
    expect(shown.hits[0]).toMatchObject({ voided: true, voidReason: '记错了，性别写反' })
    expect(typeof shown.hits[0]?.voidedAt).toBe('number')

    // Voiding twice is rejected; the other entry still recalls fine.
    await expect(voidEntry(home, 'electron', target.id, 'again', null, DEFAULT_JOURNAL_CONFIG)).rejects.toThrow('已经作废')
    const ok = await recallJournal(home, 'electron', { query: '正常' })
    expect(ok.hits[0]?.id).toBe(other.id)
  })
})

describe('REQ-M08 injection budget', () => {
  it('budget off = 0.4.9 behavior exactly', async () => {
    const home = await makeHome()
    for (let i = 0; i < 5; i += 1) await appendJournal(home, 'electron', entry(1000 + i, `条目${i}`), DEFAULT_JOURNAL_CONFIG)
    await appendEpoch(home, 'electron', { text: '一个阶段。', sessionId: null })
    const wake = await buildJournalInjection(home, 'electron', DEFAULT_JOURNAL_CONFIG)
    expect(wake.entries).toHaveLength(3)
    expect(wake.epochLines).toEqual([])
    expect(wake.epochFallback).toBeUndefined()
  })

  it('wake injection never spends the recent window on bookkeeping', async () => {
    const home = await makeHome()
    for (let i = 0; i < 3; i += 1) await appendJournal(home, 'electron', entry(1000 + i, `记忆${i}`), DEFAULT_JOURNAL_CONFIG)
    await appendJournal(home, 'electron', { at: 5000, source: 'external-edit', sessionId: null, text: '外部修改痕迹' }, DEFAULT_JOURNAL_CONFIG)
    await appendJournal(home, 'electron', { at: 6000, source: 'system', sessionId: null, text: '旧记录已归档到 journal.archive.md。' }, DEFAULT_JOURNAL_CONFIG)
    const wake = await buildJournalInjection(home, 'electron', DEFAULT_JOURNAL_CONFIG)
    expect(wake.entries).toHaveLength(3)
    expect(wake.entries.every(item => item.source !== 'external-edit' && item.source !== 'system')).toBe(true)
    expect(wake.entries.map(item => item.text)).toEqual(['记忆0', '记忆1', '记忆2'])
  })

  it('budget on: pinned > recent > epoch lines, total within budget', async () => {
    const home = await makeHome()
    for (let i = 0; i < 6; i += 1) {
      await appendJournal(home, 'electron', entry(1000 + i, `近期条目${i}，${'内容'.repeat(50)}`), DEFAULT_JOURNAL_CONFIG)
    }
    const pinned = await appendJournal(home, 'electron', entry(900, '钉住的约定'), DEFAULT_JOURNAL_CONFIG)
    await pinEntry(home, 'electron', pinned.id)
    await appendEpoch(home, 'electron', { text: '第一阶段摘要。', sessionId: null })
    const config = {
      ...DEFAULT_JOURNAL_CONFIG,
      injectMaxChars: 600,
      injectPinned: true,
      injectPinnedMax: 2,
      injectEpochLines: 4,
    }
    const wake = await buildJournalInjection(home, 'electron', config)
    const total = wake.entries.reduce((sum, item) => sum + item.text.length, 0)
      + wake.epochLines.reduce((sum, line) => sum + line.length, 0)
    expect(total).toBeLessThanOrEqual(600)
    expect(wake.entries[0]?.label).toContain('钉住')
    expect(wake.epochLines).toHaveLength(1)
  })

  it('epoch fallback when the current file has no recent entries', async () => {
    const home = await makeHome()
    await appendEpoch(home, 'electron', { text: '唯一一段摘要。', sessionId: null })
    await rm(journalPath(home, 'electron'), { force: true })
    await mutateJournalMeta(home, 'electron', () => ({}))
    const config = { ...DEFAULT_JOURNAL_CONFIG, injectMaxChars: 600, injectEpochFallback: true }
    const wake = await buildJournalInjection(home, 'electron', config)
    expect(wake.epochFallback?.text).toContain('唯一一段摘要')
  })

  it('budgetWake trims in priority order (pure)', () => {
    const mk = (text: string) => ({ at: 1, source: 'pet', label: 'x', text })
    // 500 budget: pinned 300 → recent 150 → lines 2×15 fit (495 total).
    const roomy = budgetWake({
      pinned: [mk('a'.repeat(300))],
      recent: [mk('b'.repeat(150)), mk('c'.repeat(150))],
      epochLines: ['[11-01~11-05] 一', '[11-05~11-07] 二'],
    }, 500)
    expect(roomy.pinned).toHaveLength(1)
    expect(roomy.recent).toHaveLength(1)
    expect(roomy.epochLines).toHaveLength(2)
    expect(roomy.epochFallback).toBeUndefined()

    // Tight budget: recent eats everything, epoch lines drop out entirely.
    const tight = budgetWake({
      pinned: [mk('a'.repeat(300))],
      recent: [mk('b'.repeat(200)), mk('c'.repeat(200))],
      epochLines: ['[11-01~11-05] 一'],
    }, 500)
    expect(tight.pinned).toHaveLength(1)
    expect(tight.recent).toHaveLength(1)
    expect(tight.epochLines).toEqual([])

    // Budget off: nothing new rides along.
    const off = budgetWake({ pinned: [mk('a')], recent: [mk('b')], epochLines: ['x'] }, 0)
    expect(off.pinned).toEqual([])
    expect(off.recent).toHaveLength(1)
    expect(off.epochLines).toEqual([])
  })
})

describe('REQ-M10 read by id', () => {
  it('returns full text and chain neighbors', async () => {
    const home = await makeHome()
    const first = await appendJournal(home, 'electron', entry(1000, '第一条全文'), DEFAULT_JOURNAL_CONFIG)
    const second = await appendJournal(home, 'electron', entry(2000, '第二条全文'), DEFAULT_JOURNAL_CONFIG)
    const middle = await readMemoryById(home, 'electron', first.id)
    expect(middle.entry.text).toBe('第一条全文')
    expect(middle.neighbors.nextId).toBe(second.id)
    expect(middle.neighbors.prevId).toBeUndefined()
    const last = await readMemoryById(home, 'electron', second.id)
    expect(last.neighbors.prevId).toBe(first.id)
    await expect(readMemoryById(home, 'electron', 'e-nope')).rejects.toThrow('找不到条目')
  })
})
