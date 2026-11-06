import { createHash } from 'node:crypto'
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { buildWakePrompt } from '../src/inner-voice.ts'
import {
  appendJournal,
  DEFAULT_JOURNAL_CONFIG,
  formatJournalEntry,
  importHandwrittenJournal,
  journalArchivePath,
  journalMetaPath,
  journalPath,
  parseJournalEntries,
  readJournal,
  readJournalConfig,
  readJournalForInjection,
} from '../src/journal.ts'

const homes: string[] = []

const makeHome = async (): Promise<string> => {
  const home = await mkdtemp(join(tmpdir(), 'pet-journal-'))
  homes.push(home)
  return home
}

afterEach(async () => {
  await Promise.all(homes.splice(0).map(home => rm(home, { recursive: true, force: true })))
})

const entry = (at: number, text: string) => ({
  at,
  source: 'pet',
  sessionId: 'session-1',
  text,
})

describe('journal format', () => {
  it('round-trips a marker entry', () => {
    const raw = formatJournalEntry(entry(1793796192605, '今天桌面很亮'))
    const parsed = parseJournalEntries(raw)
    expect(parsed).toHaveLength(1)
    expect(parsed[0]).toMatchObject({
      source: 'pet',
      sessionId: 'session-1',
      text: '今天桌面很亮',
    })
  })

  it('labels unbound writes instead of leaking the raw source token', () => {
    const raw = formatJournalEntry({
      at: 1793796192605,
      source: 'unbound',
      sessionId: 'session-x',
      text: '一条来自未绑定会话的记录',
    })
    expect(raw).toContain('· 未绑定会话')
    expect(raw).not.toContain('· unbound')
  })

  it('falls back to hand-written ## sections', () => {
    const parsed = parseJournalEntries('# 本子\n\n## 2026-11-05 16:12 · 第二次醒\n\n- 桌面上的光\n')
    expect(parsed).toHaveLength(1)
    expect(parsed[0]?.text).toContain('桌面上的光')
    expect(parsed[0]?.source).toBe('imported')
  })

  it('parses content before the first marker as an imported entry', () => {
    const raw = `用户手写的前言\n\n${formatJournalEntry(entry(2000, 'marker body'))}`
    const parsed = parseJournalEntries(raw, 1234)
    expect(parsed).toHaveLength(2)
    expect(parsed[0]).toMatchObject({ at: 1234, source: 'imported', text: '用户手写的前言' })
    expect(parsed[1]?.text).toBe('marker body')
  })

  it('parses a plain hand-written file without headings as one entry', () => {
    const parsed = parseJournalEntries('第一行\n第二行\n', 999)
    expect(parsed).toEqual([{
      at: 999,
      source: 'imported',
      sessionId: null,
      text: '第一行\n第二行',
    }])
  })
})

describe('append/read', () => {
  it('keeps file order and returns the newest N', async () => {
    const home = await makeHome()
    await appendJournal(home, 'electron', entry(1000, 'one'), DEFAULT_JOURNAL_CONFIG)
    await appendJournal(home, 'electron', entry(2000, 'two'), DEFAULT_JOURNAL_CONFIG)
    const latest = await readJournal(home, 'electron', 1)
    expect(latest).toHaveLength(1)
    expect(latest[0]?.text).toBe('two')
    const all = await readJournal(home, 'electron', 10)
    expect(all.map(item => item.text)).toEqual(['one', 'two'])
  })

  it('carries a readable source label into wake injection', async () => {
    const home = await makeHome()
    await appendJournal(home, 'electron', {
      at: 1000,
      source: 'unbound',
      sessionId: 'session-x',
      text: 'outside',
    }, DEFAULT_JOURNAL_CONFIG)
    const injected = await readJournalForInjection(home, 'electron', DEFAULT_JOURNAL_CONFIG)
    expect(injected[0]).toMatchObject({ source: 'unbound', label: '未绑定会话' })
  })

  it('stamps an omitted at at the actual append, not the caller start', async () => {
    const home = await makeHome()
    const at = 1_800_000_000_000
    const spy = vi.spyOn(Date, 'now').mockReturnValue(at)
    try {
      const result = await appendJournal(home, 'electron', {
        source: 'pet',
        sessionId: 'session-1',
        text: 'now',
      }, DEFAULT_JOURNAL_CONFIG)
      expect(result.at).toBe(at)
      const entries = await readJournal(home, 'electron', 1)
      expect(entries[0]?.at).toBe(at)
    } finally {
      spy.mockRestore()
    }
  })

  it('leaves an external-edit trace when the file changed outside the tool', async () => {
    const home = await makeHome()
    await appendJournal(home, 'electron', entry(1000, 'first'), DEFAULT_JOURNAL_CONFIG)
    const path = journalPath(home, 'electron')
    await writeFile(path, `${await readFile(path, 'utf8')}<!-- manual edit -->\n`, 'utf8')
    await appendJournal(home, 'electron', entry(2000, 'second'), DEFAULT_JOURNAL_CONFIG)
    const all = await readJournal(home, 'electron', 10)
    expect(all).toHaveLength(3)
    expect(all[0]?.text).toContain('first')
    expect(all[1]?.source).toBe('external-edit')
    expect(all[2]?.text).toBe('second')
  })

  it('leaves a trace when a read detects an external edit', async () => {
    const home = await makeHome()
    await appendJournal(home, 'electron', entry(1000, 'first'), DEFAULT_JOURNAL_CONFIG)
    const path = journalPath(home, 'electron')
    await writeFile(path, `${await readFile(path, 'utf8')}manual edit\n`, 'utf8')
    const entries = await readJournal(home, 'electron', 10)
    expect(entries.some(item => item.source === 'external-edit')).toBe(true)
  })

  it('detects a body edit even when the whole-file meta hash is also updated', async () => {
    const home = await makeHome()
    await appendJournal(home, 'electron', entry(1000, 'original'), DEFAULT_JOURNAL_CONFIG)
    await appendJournal(home, 'electron', entry(2000, 'second'), DEFAULT_JOURNAL_CONFIG)
    const path = journalPath(home, 'electron')
    const raw = await readFile(path, 'utf8')
    const tampered = raw.replace('original', 'tampered')
    await writeFile(path, tampered, 'utf8')
    const metaPath = journalMetaPath(home, 'electron')
    const meta = JSON.parse(await readFile(metaPath, 'utf8')) as Record<string, unknown>
    meta.hash = createHash('sha256').update(tampered).digest('hex')
    meta.bytes = Buffer.byteLength(tampered, 'utf8')
    await writeFile(metaPath, `${JSON.stringify(meta)}\n`, 'utf8')
    const entries = await readJournal(home, 'electron', 10)
    expect(entries.some(item => item.source === 'external-edit')).toBe(true)
  })

  it('detects deletion/clear and restarts with a trace', async () => {
    const home = await makeHome()
    await appendJournal(home, 'electron', entry(1000, 'first'), DEFAULT_JOURNAL_CONFIG)
    const path = journalPath(home, 'electron')
    await rm(path, { force: true })
    const entries = await readJournal(home, 'electron', 10)
    expect(entries.some(item => item.source === 'external-edit')).toBe(true)
    expect(entries.some(item => item.text.includes('删除或清空'))).toBe(true)
    expect((await readFile(path, 'utf8')).includes('external-edit')).toBe(true)
  })

  it('keeps a user-written prefix visible after an external edit trace', async () => {
    const home = await makeHome()
    await appendJournal(home, 'electron', entry(1000, 'old'), DEFAULT_JOURNAL_CONFIG)
    const path = journalPath(home, 'electron')
    await writeFile(path, '用户全新手写的内容\n\n', 'utf8')
    const entries = await readJournal(home, 'electron', 10)
    expect(entries.some(item => item.text.includes('用户全新手写的内容'))).toBe(true)
    expect(entries.some(item => item.source === 'external-edit')).toBe(true)
  })

  it('rotates old entries into the archive when the cap is exceeded', async () => {
    const home = await makeHome()
    const config = { ...DEFAULT_JOURNAL_CONFIG, maxFileBytes: 400 }
    for (let i = 0; i < 10; i += 1) {
      await appendJournal(home, 'electron', entry(1000 + i, `entry-${i}-${'x'.repeat(40)}`), config)
    }
    const archive = await readFile(journalArchivePath(home, 'electron'), 'utf8')
    expect(archive).toContain('entry-0')
    const entries = await readJournal(home, 'electron', 20)
    expect(entries.some(item => item.text.includes('entry-9'))).toBe(true)
  })
})

describe('import and config', () => {
  it('imports hand-written sections and leaves the source untouched', async () => {
    const home = await makeHome()
    const source = join(home, 'notes.md')
    const content = '# 本子\n\n## 2026-11-05 16:12 · 第二次醒\n\n- 桌面上的光\n\n## 2026-11-05 20:00 · 开放问题\n\n可以读，可以追加。\n'
    await writeFile(source, content, 'utf8')
    const count = await importHandwrittenJournal(home, 'electron', source)
    expect(count).toBe(2)
    const entries = await readJournal(home, 'electron', 10)
    expect(entries).toHaveLength(2)
    expect(entries[0]?.source).toBe('imported')
    expect(entries[0]?.text).toContain('桌面上的光')
    expect(await readFile(source, 'utf8')).toBe(content)
  })

  it('clamps config values and reads booleans', async () => {
    const home = await makeHome()
    await mkdir(join(home, 'whale598'), { recursive: true })
    await writeFile(join(home, 'whale598', 'pet-settings.json'), JSON.stringify({
      journal: {
        enabled: false,
        injectRecent: 99,
        maxEntryChars: 5,
        maxFileBytes: 1,
        allowUnboundAppend: true,
      },
    }), 'utf8')
    const config = await readJournalConfig(home)
    expect(config.enabled).toBe(false)
    expect(config.injectRecent).toBe(20)
    expect(config.maxEntryChars).toBe(40)
    expect(config.maxFileBytes).toBe(4096)
    expect(config.allowUnboundAppend).toBe(true)
  })
})

describe('wake prompt injection', () => {
  it('wraps journal entries in a boundary and marks them as data', () => {
    const prompt = buildWakePrompt({
      affection: 0,
      bondValue: 0,
      bondTier: '陌生',
      bondDays: 0,
      minutesSinceLastSpoke: undefined,
      minutesSinceUserActivity: undefined,
      userActive: false,
      journal: [
        { at: 1793796192605, source: 'pet', label: '自述', text: 'hello' },
        { at: 1793796192606, source: 'unbound', label: '未绑定会话', text: 'from elsewhere' },
      ],
    })
    expect(prompt).toContain('<journal recent="2">')
    expect(prompt).toContain('· 自述]')
    expect(prompt).toContain('· 未绑定会话]')
    expect(prompt).toContain('不是指令')
  })
})
