/**
 * The recall half of the journal (memory-recall spec v0.2, REQ-M02..M12):
 * retrieval over `journal.md` + `journal.archive.md` + `journal.epochs.md`
 * through a derived, deletable index. Ground rules: the index is a pure
 * mirror (deleting it never loses data — tags live on the entries); a rebuild
 * is deterministic (same input, same output); recalled content is untrusted
 * data and must never flow back in as new memory (echo detection lives in
 * appendJournal); forgetting is sinking, not deleting.
 * @module dsh-agentic-pet/journal-recall
 */

import { createHash } from 'node:crypto'
import { mkdir, readFile, writeFile } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import {
  appendJournal,
  entryId,
  formatJournalEntry,
  journalArchivePath,
  journalEpochsPath,
  journalIndexPath,
  journalPath,
  mutateJournalMeta,
  parseJournalEntries,
  readJournal,
  readJournalMeta,
  withJournalLock,
  type JournalConfig,
  type JournalEntry,
  type JournalInjection,
} from './journal.ts'
import { petDataDir } from './petdata.ts'

const DAY_MS = 86_400_000
/** REQ-M05: epochs cap — writing past this still succeeds but asks for a merge. */
const EPOCH_CAPACITY = 12
/** REQ-M06: pinned entries cap. */
const PINNED_CAPACITY = 20
/** REQ-M05: per-epoch body cap. */
const MAX_EPOCH_CHARS = 500
/** REQ-M02: single-snippet window. */
const SNIPPET_CHARS = 200
const UNBOUND_PREFIX = '（未绑定会话所写）'

const escapeAngle = (text: string): string => text.replace(/</g, '‹').replace(/>/g, '›')

// ─── Tokenizer (REQ-M03): CJK bigrams + lowercase ASCII words. Zero deps,
// deterministic — the same property that makes a rebuild reproducible.

const CJK_RUN = /[\u3040-\u30ff\u3400-\u4dbf\u4e00-\u9fff\uf900-\ufaff]+/g
const CJK_CHAR = /[\u3040-\u30ff\u3400-\u4dbf\u4e00-\u9fff\uf900-\ufaff]/
const ASCII_WORD = /[0-9a-z][0-9a-z'’-]*/g
const ASCII_CHARS = /[0-9a-z'’-]/

/** Terms for indexing: every CJK bigram (single-char runs keep a unigram)
 * plus every ASCII word. Query side uses the same function. */
export function tokenize(text: string): string[] {
  const lowered = text.toLowerCase()
  const terms = new Set<string>()
  for (const run of lowered.matchAll(CJK_RUN)) {
    const chars = [...run[0]]
    if (chars.length === 1) {
      terms.add(run[0])
      continue
    }
    for (let i = 0; i + 1 < chars.length; i += 1) terms.add(chars[i]! + chars[i + 1]!)
  }
  for (const word of lowered.matchAll(ASCII_WORD)) terms.add(word[0])
  return [...terms]
}

/** Terms a query word decomposes into. CJK words → their bigrams; single
 * CJK chars → [] (they fall back to a substring scan); ASCII → [word]. */
function wordTerms(word: string): { terms: string[]; substring: boolean } {
  const lowered = word.toLowerCase()
  const chars = [...lowered]
  if (chars.length === 1) {
    return CJK_CHAR.test(lowered) ? { terms: [], substring: true } : { terms: [lowered], substring: false }
  }
  if (CJK_CHAR.test(chars[0]!)) {
    const terms: string[] = []
    for (let i = 0; i + 1 < chars.length; i += 1) terms.push(chars[i]! + chars[i + 1]!)
    return { terms, substring: false }
  }
  return ASCII_CHARS.test(lowered) ? { terms: [lowered], substring: false } : { terms: [lowered], substring: false }
}

// ─── Collected view: entries from the three files, deduped by id, annotated
// with void tombstones and pin state.

export type MemoryOrigin = 'current' | 'archive' | 'epochs'

export interface MemoryEntry {
  id: string
  at: number
  source: string
  sessionId: string | null
  text: string
  tags: string[]
  entities: string[]
  echo: boolean
  pinned: boolean
  voided: boolean
  voidedAt?: number
  voidReason?: string
  origin: MemoryOrigin
  hash?: string
  /** Adjacent ids within the entry's own file (REQ-M10 read-by-id). */
  prevId?: string
  nextId?: string
}

export interface CollectedMemory {
  entries: MemoryEntry[]
  /** digest of the three source files — the index staleness check. */
  sourceDigest: string
  pinnedIds: string[]
}

const readRaw = async (path: string): Promise<string> => readFile(path, 'utf8').catch(() => '')

const sourceDigest = (current: string, archive: string, epochs: string): string =>
  createHash('sha256')
    .update(`${current.length}\u0000${current}\u0000${archive.length}\u0000${archive}\u0000${epochs.length}\u0000${epochs}`)
    .digest('hex')

/** Read the three files once; everything else derives from this. Entries are
 * deduped by id with priority current > archive > epochs — after a rotate the
 * newest entries exist in both L1 and L2, and the current copy wins (§3
 * 同一性). Tombstones are collected from ALL copies, dupes included. */
export async function collectMemory(home: string, petId: string): Promise<CollectedMemory> {
  const [currentRaw, archiveRaw, epochsRaw, meta] = await Promise.all([
    readRaw(journalPath(home, petId)),
    readRaw(journalArchivePath(home, petId)),
    readRaw(journalEpochsPath(home, petId)),
    readJournalMeta(home, petId),
  ])
  const pinnedIds = meta?.pinnedIds ?? []
  const pinned = new Set(pinnedIds)
  const voids = new Map<string, { at: number; reason: string }>()
  const origins: Array<{ origin: MemoryOrigin; raw: string }> = [
    { origin: 'current', raw: currentRaw },
    { origin: 'archive', raw: archiveRaw },
    { origin: 'epochs', raw: epochsRaw },
  ]
  const perFileIds = new Map<MemoryOrigin, string[]>()
  const byId = new Map<string, MemoryEntry>()
  const ordered: MemoryEntry[] = []
  for (const { origin, raw } of origins) {
    const parsed = parseJournalEntries(raw)
    const ids: string[] = []
    parsed.forEach((entry, index) => {
      const id = entryId(entry, index)
      ids.push(id)
      if (entry.voids !== undefined && !voids.has(entry.voids.id)) {
        voids.set(entry.voids.id, { at: entry.at, reason: entry.voids.reason })
      }
      if (byId.has(id)) return
      const memory: MemoryEntry = {
        id,
        at: entry.at,
        source: entry.source,
        sessionId: entry.sessionId,
        text: entry.text,
        tags: entry.tags ?? [],
        entities: entry.entities ?? [],
        echo: entry.echo === true,
        pinned: pinned.has(id),
        voided: false,
        origin,
        ...(entry.hash === undefined ? {} : { hash: entry.hash }),
      }
      byId.set(id, memory)
      ordered.push(memory)
    })
    perFileIds.set(origin, ids)
  }
  // Annotate voids + neighbors (neighbors follow the entry's own file order).
  for (const memory of ordered) {
    const voided = voids.get(memory.id)
    if (voided !== undefined) {
      memory.voided = true
      memory.voidedAt = voided.at
      memory.voidReason = voided.reason
    }
    const ids = perFileIds.get(memory.origin) ?? []
    const position = ids.indexOf(memory.id)
    const prevId = position > 0 ? ids[position - 1] : undefined
    const nextId = position >= 0 && position + 1 < ids.length ? ids[position + 1] : undefined
    if (prevId !== undefined) memory.prevId = prevId
    if (nextId !== undefined) memory.nextId = nextId
  }
  return {
    entries: ordered,
    sourceDigest: sourceDigest(currentRaw, archiveRaw, epochsRaw),
    pinnedIds,
  }
}

// ─── Index (REQ-M03): derived mirror at <petDir>/journal.index.json.

interface IndexEntry {
  id: string
  at: number
  source: string
  sessionId: string | null
  hash?: string
  chars: number
  tags: string[]
  entities: string[]
  voided: boolean
  voidedAt?: number
  echo: boolean
  pinned: boolean
}

interface JournalIndex {
  version: 2
  rebuiltAt: number
  sourceDigest: string
  entries: IndexEntry[]
  terms: Record<string, string[]>
}

const INDEX_VERSION = 2

const indexEntryOf = (memory: MemoryEntry): IndexEntry => ({
  id: memory.id,
  at: memory.at,
  source: memory.source,
  sessionId: memory.sessionId,
  ...(memory.hash === undefined ? {} : { hash: memory.hash }),
  chars: memory.text.length,
  tags: memory.tags,
  entities: memory.entities,
  voided: memory.voided,
  ...(memory.voidedAt === undefined ? {} : { voidedAt: memory.voidedAt }),
  echo: memory.echo,
  pinned: memory.pinned,
})

const entrySearchTerms = (memory: MemoryEntry): string[] =>
  tokenize(`${memory.text}\n${memory.tags.join(' ')}\n${memory.entities.join(' ')}`)

/** Deterministic rebuild: entries in collection order, term keys sorted. */
function buildIndex(memory: CollectedMemory, rebuiltAt: number): JournalIndex {
  const terms = new Map<string, string[]>()
  for (const entry of memory.entries) {
    for (const term of entrySearchTerms(entry)) {
      const posting = terms.get(term)
      if (posting === undefined) terms.set(term, [entry.id])
      else if (posting.at(-1) !== entry.id) posting.push(entry.id)
    }
  }
  const sortedTerms: Record<string, string[]> = {}
  for (const key of [...terms.keys()].sort()) sortedTerms[key] = terms.get(key)!
  return {
    version: INDEX_VERSION,
    rebuiltAt,
    sourceDigest: memory.sourceDigest,
    entries: memory.entries.map(indexEntryOf),
    terms: sortedTerms,
  }
}

async function loadIndex(home: string, petId: string): Promise<JournalIndex | undefined> {
  try {
    const parsed = JSON.parse(await readFile(journalIndexPath(home, petId), 'utf8')) as JournalIndex
    if (parsed.version === INDEX_VERSION && typeof parsed.sourceDigest === 'string' && Array.isArray(parsed.entries)) return parsed
  } catch {
    // Missing/corrupt index: caller rebuilds.
  }
  return undefined
}

const persistIndex = async (home: string, petId: string, index: JournalIndex): Promise<void> => {
  await writeFile(journalIndexPath(home, petId), `${JSON.stringify(index)}\n`, 'utf8')
}

/** REQ-M03: the index is never a source of truth — a mismatched digest
 * triggers a synchronous rebuild (well under 2 s at journal scale), so a
 * stale index can never hand back entries that do not exist. */
async function ensureIndex(
  home: string,
  petId: string,
  memory: CollectedMemory,
  force: boolean,
): Promise<{ index: JournalIndex; rebuilt: boolean }> {
  if (!force) {
    const existing = await loadIndex(home, petId)
    if (existing !== undefined && existing.sourceDigest === memory.sourceDigest) {
      return { index: existing, rebuilt: false }
    }
  }
  const index = buildIndex(memory, Date.now())
  await persistIndex(home, petId, index)
  return { index, rebuilt: true }
}

/** REQ-M03 incremental path: called by the tool layer right after a plain
 * append (no rotate). Reuses the persisted term map and appends one entry —
 * falls back to a full rebuild whenever the persisted state has drifted. */
export async function updateIndexAfterAppend(home: string, petId: string, appendedId: string): Promise<void> {
  await withJournalLock(journalIndexPath(home, petId), async () => {
    const [memory, existing] = await Promise.all([collectMemory(home, petId), loadIndex(home, petId)])
    if (existing === undefined) {
      await persistIndex(home, petId, buildIndex(memory, Date.now()))
      return
    }
    const known = new Set(existing.entries.map(entry => entry.id))
    const fresh = memory.entries.filter(entry => !known.has(entry.id))
    const kept = memory.entries.length - fresh.length
    if (kept !== existing.entries.length || fresh.length !== 1 || fresh[0]?.id !== appendedId) {
      // Drift (missed appends, external edits, deletions): rebuild deterministically.
      await persistIndex(home, petId, buildIndex(memory, Date.now()))
      return
    }
    const appended = fresh[0]!
    for (const term of entrySearchTerms(appended)) {
      const posting = existing.terms[term]
      if (posting === undefined) existing.terms[term] = [appended.id]
      else if (posting.at(-1) !== appended.id) posting.push(appended.id)
    }
    existing.entries.push(indexEntryOf(appended))
    existing.rebuiltAt = Date.now()
    existing.sourceDigest = memory.sourceDigest
    await persistIndex(home, petId, existing)
  })
}

// ─── Scoring (§5.1): 0.55 lexical + 0.20 recency + 0.15 tag + 0.10 kind.

export interface ScoreParts {
  lexical: number
  recency: number
  tag: number
  kind: number
  total: number
}

interface ScoreContext {
  now: number
  wordList: Array<{ word: string; terms: string[]; substring: boolean }>
  queryClues: string[]
  df: Map<string, number>
  totalEntries: number
  corpus: MemoryEntry[]
}

const tagHits = (memory: MemoryEntry, clues: string[]): number => {
  if (clues.length === 0) return 0
  const own = new Set([...memory.tags, ...memory.entities].map(item => item.toLowerCase()))
  return clues.filter(clue => own.has(clue.toLowerCase())).length
}

const termFrequency = (text: string, term: string): number => {
  let count = 0
  let position = text.indexOf(term)
  while (position !== -1) {
    count += 1
    position = text.indexOf(term, position + term.length)
  }
  return count
}

/** df fallback for terms absent from the index (single-char substring
 * queries): count corpus entries whose text contains the term. Cached. */
function documentFrequency(term: string, context: ScoreContext): number {
  const cached = context.df.get(term)
  if (cached !== undefined) return cached
  let count = 0
  for (const entry of context.corpus) {
    if (entry.text.toLowerCase().includes(term)) count += 1
  }
  context.df.set(term, count)
  return count
}

/** Lexical: coverage-weighted idf over matched terms, normalized to 0..1.
 * A CJK/ASCII word matches when ≥1 of its terms hits (partial credit ranks
 * better matches higher); all query words are evaluated (no early exit) so
 * partial matches can be reported with the words they are missing.
 * Single CJK chars fall back to a substring scan. */
function scoreLexical(memory: MemoryEntry, context: ScoreContext): { matchedWords: number; missing: string[]; score: number } {
  if (context.wordList.length === 0) return { matchedWords: 0, missing: [], score: 0 }
  const entryTerms = new Set(tokenize(memory.text))
  const loweredText = memory.text.toLowerCase()
  let matchedSum = 0
  let totalSum = 0
  let matchedWords = 0
  const missing: string[] = []
  for (const { word, terms, substring } of context.wordList) {
    if (substring) {
      const needle = word.toLowerCase()
      if (!loweredText.includes(needle)) {
        missing.push(word)
        continue
      }
      const idf = Math.log(1 + context.totalEntries / (1 + documentFrequency(needle, context)))
      matchedSum += idf
      totalSum += idf
      matchedWords += 1
      continue
    }
    let wordHit = 0
    let wordTotal = 0
    for (const term of terms) {
      const df = documentFrequency(term, context)
      const idf = Math.log(1 + context.totalEntries / (1 + df))
      const tf = entryTerms.has(term) ? termFrequency(memory.text, term) : 0
      const weight = idf * (tf / (tf + 1))
      wordTotal += weight
      if (tf > 0) wordHit += weight
    }
    if (wordHit <= 0) {
      missing.push(word)
      continue
    }
    matchedSum += wordHit
    totalSum += wordTotal
    matchedWords += 1
  }
  return { matchedWords, missing, score: totalSum > 0 ? Math.min(1, matchedSum / totalSum) : 0 }
}

function scoreEntry(memory: MemoryEntry, context: ScoreContext): { matchedWords: number; missing: string[]; tagHitsCount: number; parts: ScoreParts } {
  const lexical = scoreLexical(memory, context)
  const tagHitsCount = tagHits(memory, context.queryClues)
  const recency = Math.exp(-Math.max(0, context.now - memory.at) / (30 * DAY_MS))
  const kind = memory.source === 'epoch' ? 0.10 : memory.pinned ? 0.08 : 0
  const parts: ScoreParts = {
    lexical: lexical.score,
    recency,
    tag: Math.min(1, tagHitsCount * 0.5),
    kind,
    total: 0,
  }
  parts.total = 0.55 * parts.lexical + 0.20 * parts.recency + 0.15 * parts.tag + 0.10 * parts.kind
  return { matchedWords: lexical.matchedWords, missing: lexical.missing, tagHitsCount, parts }
}

// ─── Recall (REQ-M02).

export interface RecallParams {
  query?: string
  tags?: string[]
  entities?: string[]
  from?: string | number
  to?: string | number
  scope?: 'current' | 'archive' | 'all'
  limit?: number
  maxChars?: number
  includeVoided?: boolean
  /** Default: strict AND, auto-relaxed step by step when it comes back
   * empty (partial hits are annotated with `missing`). Explicit values
   * disable the auto-relax. */
  minMatch?: number
  /** External-edit traces / system notes are bookkeeping, not memories —
   * excluded by default. */
  includeBookkeeping?: boolean
  /** The excluded list is summarized as `excludedCount` by default; pass
   * this to see the actual entries (≤5, with reasons). */
  includeExcluded?: boolean
  rebuild?: boolean
}

export interface RecallHit {
  id: string
  at: number
  source: string
  sessionId: string | null
  origin: MemoryOrigin
  snippet: string
  score: number
  voided: boolean
  voidedAt?: number
  voidReason?: string
  echo: boolean
  /** Query words this hit does NOT contain (present on partial matches). */
  missing?: string[]
  /** How this hit matched: `tag` = the entry really carries the queried
   * tag/entity (fact); `text` = keyword hit in the body (match, not a tag).
   * Absent in browse mode. */
  matchedBy?: Array<'tag' | 'text'>
  parts: ScoreParts
}

export interface RejectedEntry {
  id: string
  reason: 'voided' | 'echo' | 'bookkeeping' | 'min-match' | 'budget'
  detail?: string
  score: number
}

export interface RecallResult {
  hits: RecallHit[]
  /** Candidates that passed the relevance gate — `totalMatched - hits.length`
   * is exactly how many did not make the cut (limit/budget). */
  totalMatched: number
  truncated: boolean
  /** Time since the index was last synced (rebuilt or incrementally
   * updated). It does NOT measure staleness: every recall first verifies
   * the index against the source digest and rebuilds on mismatch, so
   * results are never behind the content. */
  sinceRebuildMs: number
  rebuilt: boolean
  /** Safety/bookkeeping exclusions (voided/echo/bookkeeping), ≤5 — only
   * present when the caller asked for `includeExcluded`. */
  excluded?: RejectedEntry[]
  excludedCount: number
  /** Entries below the word-match threshold — count only, no entries. */
  belowThreshold: number
}

/** Entries that are chain bookkeeping, not memories. */
const BOOKKEEPING_SOURCES = new Set(['external-edit', 'system'])

const parseTimeBound = (value: string | number | undefined, name: string, endOfDay = false): number | undefined => {
  if (value === undefined) return undefined
  if (typeof value === 'number' && Number.isFinite(value)) return value
  const raw = String(value).trim()
  // Date-only string → [00:00, 24:00) of that LOCAL day. Date.parse would
  // anchor a bare date at UTC midnight, which in UTC+8 swallows the morning.
  const dayOnly = /^(\d{4})-(\d{2})-(\d{2})$/.exec(raw)
  if (dayOnly !== null) {
    const [, year, month, day] = dayOnly
    const start = new Date(Number(year), Number(month) - 1, Number(day))
    if (Number.isNaN(start.getTime())) throw new Error(`${name} 不是可解析的日期：${raw}`)
    return endOfDay ? start.getTime() + DAY_MS - 1 : start.getTime()
  }
  const parsed = Date.parse(raw)
  if (Number.isNaN(parsed)) throw new Error(`${name} 不是可解析的日期：${raw}`)
  return parsed
}

const normalizeList = (value: string[] | undefined, name: string): string[] => {
  if (value === undefined) return []
  if (!Array.isArray(value)) throw new Error(`${name} 必须是字符串数组`)
  return [...new Set(value.map(item => String(item).trim()).filter(item => item !== ''))]
}

/** REQ-M12: the last recall's full verdict — "why did she remember this". */
async function writeLastRecall(home: string, petId: string, record: unknown): Promise<void> {
  await writeFile(join(petDataDir(home, petId), 'journal.last-recall.json'), `${JSON.stringify(record)}\n`, 'utf8')
}

export async function recallJournal(home: string, petId: string, params: RecallParams): Promise<RecallResult> {
  const scope = params.scope ?? 'all'
  const limit = typeof params.limit === 'number' && Number.isFinite(params.limit)
    ? Math.max(1, Math.min(20, Math.round(params.limit)))
    : 5
  const maxChars = typeof params.maxChars === 'number' && Number.isFinite(params.maxChars)
    ? Math.max(200, Math.round(params.maxChars))
    : 1200
  const words = (params.query ?? '').split(/\s+/).filter(Boolean)
  const queryTags = normalizeList(params.tags, 'tags')
  const queryEntities = normalizeList(params.entities, 'entities')
  const from = parseTimeBound(params.from, 'from')
  const to = parseTimeBound(params.to, 'to', true)
  // A dimension is any filter the caller actually named — scope counts, so
  // "把归档里的东西列出来看看" (scope alone) is a legal query.
  if (params.scope === undefined && words.length === 0 && queryTags.length === 0 && queryEntities.length === 0 && from === undefined && to === undefined) {
    throw new Error('至少给一个检索维度：query / tags / entities / from+to / scope')
  }
  // Browse mode: no keywords, no clues — scope and/or date window only.
  // Results are a listing (recency order), not a ranked search.
  const listMode = words.length === 0 && queryTags.length === 0 && queryEntities.length === 0

  const memory = await collectMemory(home, petId)
  const { index, rebuilt } = await ensureIndex(home, petId, memory, params.rebuild === true)
  const now = Date.now()

  const df = new Map<string, number>()
  for (const [term, posting] of Object.entries(index.terms)) df.set(term, posting.length)
  const context: ScoreContext = {
    now,
    wordList: words.map(word => ({ word, ...wordTerms(word) })),
    queryClues: [...queryTags, ...queryEntities],
    df,
    totalEntries: memory.entries.length,
    corpus: memory.entries,
  }

  const rejected: RejectedEntry[] = []
  const eligible: Array<{ memory: MemoryEntry }> = []
  for (const entry of memory.entries) {
    if (scope === 'current' && entry.origin !== 'current') continue
    if (scope === 'archive' && entry.origin !== 'archive') continue
    if (!params.includeVoided && (entry.voided || entry.echo)) {
      rejected.push({
        id: entry.id,
        reason: entry.voided ? 'voided' : 'echo',
        ...(entry.voided ? { detail: `已作废${entry.voidReason ? `（${entry.voidReason}）` : ''}` } : { detail: '与已有条目重复（回声），默认不召回' }),
        score: 0,
      })
      continue
    }
    // External-edit traces and system bookkeeping occupy slots but are not
    // memories — excluded by default, opt in with includeBookkeeping.
    if (!params.includeBookkeeping && BOOKKEEPING_SOURCES.has(entry.source)) {
      rejected.push({ id: entry.id, reason: 'bookkeeping', detail: '系统痕迹（外部编辑/归档记录），不是记忆', score: 0 })
      continue
    }
    if (from !== undefined && entry.at < from) continue
    if (to !== undefined && entry.at > to) continue
    eligible.push({ memory: entry })
  }

  const evaluate = (minMatch: number): { found: Array<{ memory: MemoryEntry; parts: ScoreParts; missing: string[]; tagHitsCount: number; matchedWords: number }>; rejectedThisLevel: RejectedEntry[] } => {
    const found: Array<{ memory: MemoryEntry; parts: ScoreParts; missing: string[]; tagHitsCount: number; matchedWords: number }> = []
    const rejectedThisLevel: RejectedEntry[] = []
    for (const { memory: entry } of eligible) {
      const { matchedWords, missing, tagHitsCount, parts } = scoreEntry(entry, context)
      // §5.1 宁可空手，不要凑数 — browse mode (scope/date listing) is the
      // exemption. A clue hit (tag/entity) stands on its own; keyword gates
      // apply otherwise. Tags-only queries REQUIRE the clue: with zero query
      // words a bare `matchedWords < minMatch` gate would pass everything,
      // passing untagged entries off as tag matches.
      if (!listMode && parts.tag === 0 && (words.length === 0 || matchedWords < minMatch)) {
        rejectedThisLevel.push({
          id: entry.id,
          reason: 'min-match',
          detail: words.length === 0
            ? '未命中任何标签/实体（tags/entities 是精确匹配，不是全文检索）'
            : `只命中 ${matchedWords}/${words.length} 个查询词（要求 ${minMatch}）`,
          score: parts.total,
        })
        continue
      }
      found.push({ memory: entry, parts, missing, tagHitsCount, matchedWords })
    }
    return { found, rejectedThisLevel }
  }

  // Standing threshold: min(2, word count) — single-word queries require
  // that word; multi-word queries require any two. Only when that comes
  // back empty-handed does it relax step by step (…→1), so a dead word like
  // 「判罚之钉」 costs the query nothing unless it truly matches nothing.
  const explicitMinMatch = typeof params.minMatch === 'number' && Number.isFinite(params.minMatch)
    ? Math.max(1, Math.min(words.length, Math.round(params.minMatch)))
    : undefined
  let attempt = evaluate(explicitMinMatch ?? Math.min(2, words.length))
  let effectiveMinMatch = explicitMinMatch ?? Math.min(2, words.length)
  if (explicitMinMatch === undefined && attempt.found.length === 0 && words.length > 1) {
    for (let level = effectiveMinMatch - 1; level >= 1; level -= 1) {
      attempt = evaluate(level)
      effectiveMinMatch = level
      if (attempt.found.length > 0) break
    }
  }
  rejected.push(...attempt.rejectedThisLevel)
  const candidates = attempt.found

  // Browse mode is a listing (newest first); keyword search stays score-ranked.
  if (listMode) {
    candidates.sort((a, b) => b.memory.at - a.memory.at || (a.memory.id < b.memory.id ? -1 : 1))
  } else {
    candidates.sort((a, b) =>
      b.parts.total - a.parts.total
      || b.memory.at - a.memory.at
      || (a.memory.id < b.memory.id ? -1 : 1),
    )
  }

  const hits: RecallHit[] = []
  let usedChars = 0
  for (const candidate of candidates) {
    if (hits.length >= limit) break
    const snippet = buildSnippet(candidate.memory, words, queryTags, queryEntities)
    // The best hit always makes it in (its snippet may be the only one);
    // the rest respect the budget — never silently dropped: truncated=true.
    if (hits.length > 0 && usedChars + snippet.length > maxChars) {
      rejected.push({ id: candidate.memory.id, reason: 'budget', detail: '超出返回字符预算被截断', score: candidate.parts.total })
      continue
    }
    usedChars += snippet.length
    // matchedBy separates fact from guess: `tag` = the entry REALLY carries
    // this tag/entity; `text` = the keyword hit in the body (a guess that
    // happens to match). Never present in browse mode.
    const matchedBy = [
      ...(candidate.tagHitsCount > 0 ? (['tag'] as const) : []),
      ...(candidate.matchedWords > 0 ? (['text'] as const) : []),
    ]
    hits.push({
      id: candidate.memory.id,
      at: candidate.memory.at,
      source: candidate.memory.source,
      sessionId: candidate.memory.sessionId,
      origin: candidate.memory.origin,
      snippet,
      score: Number(candidate.parts.total.toFixed(4)),
      voided: candidate.memory.voided,
      ...(candidate.memory.voidedAt === undefined ? {} : { voidedAt: candidate.memory.voidedAt }),
      ...(candidate.memory.voidReason === undefined ? {} : { voidReason: candidate.memory.voidReason }),
      echo: candidate.memory.echo,
      ...(candidate.missing.length > 0 ? { missing: candidate.missing } : {}),
      ...(matchedBy.length > 0 ? { matchedBy } : {}),
      parts: {
        lexical: Number(candidate.parts.lexical.toFixed(4)),
        recency: Number(candidate.parts.recency.toFixed(4)),
        tag: Number(candidate.parts.tag.toFixed(4)),
        kind: Number(candidate.parts.kind.toFixed(4)),
        total: Number(candidate.parts.total.toFixed(4)),
      },
    })
  }
  const truncated = candidates.length > hits.length
  // Tool output splits the appendix: safety/bookkeeping exclusions get names
  // and reasons (≤5); relevance misses are just a count. The FULL verdict
  // (including every min-match entry) stays in journal.last-recall.json.
  const excludedAll = rejected.filter(item => item.reason === 'voided' || item.reason === 'echo' || item.reason === 'bookkeeping')
  const belowThreshold = rejected.filter(item => item.reason === 'min-match').length

  await writeLastRecall(home, petId, {
    at: now,
    pet: petId,
    params: {
      ...(params.query === undefined ? {} : { query: params.query }),
      ...(queryTags.length === 0 ? {} : { tags: queryTags }),
      ...(queryEntities.length === 0 ? {} : { entities: queryEntities }),
      ...(from === undefined ? {} : { from }),
      ...(to === undefined ? {} : { to }),
      scope,
      limit,
      maxChars,
      minMatch: effectiveMinMatch,
      includeVoided: params.includeVoided === true,
      includeBookkeeping: params.includeBookkeeping === true,
    },
    totalMatched: candidates.length,
    hits: hits.map(hit => ({ id: hit.id, score: hit.score, parts: hit.parts, origin: hit.origin, ...(hit.missing === undefined ? {} : { missing: hit.missing }) })),
    excluded: excludedAll.slice(0, 50),
    belowThreshold,
    truncated,
  })

  return {
    hits,
    totalMatched: candidates.length,
    truncated,
    sinceRebuildMs: now - index.rebuiltAt,
    rebuilt,
    ...(params.includeExcluded === true ? { excluded: excludedAll.slice(0, 5) } : {}),
    excludedCount: excludedAll.length,
    belowThreshold,
  }
}

/** REQ-M09: every recalled fragment crosses the prompt boundary wrapped as
 * data, with provenance on the wrapper itself. */
export function wrapMemoryBlock(hit: { id: string; at: number; source: string; snippet: string }): string {
  return `<<<memory id=${hit.id} at=${new Date(hit.at).toISOString()} source=${hit.source}>>>${hit.snippet}<<<end>>>`
}

/** REQ-M02 snippet: ≤200 chars around the first hit, occurrences of the
 * matched word wrapped in 【】, angle brackets neutralized AFTER slicing
 * so the 【】 wrapper stays the only markup. */
export function buildSnippet(
  memory: MemoryEntry,
  words: string[],
  tags: string[],
  entities: string[],
): string {
  const text = memory.text
  let anchor = -1
  let anchorWord = ''
  for (const word of words) {
    const position = text.toLowerCase().indexOf(word.toLowerCase())
    if (position !== -1 && (anchor === -1 || position < anchor)) {
      anchor = position
      anchorWord = word
    }
  }
  if (anchor === -1) {
    for (const clue of [...tags, ...entities]) {
      const position = text.toLowerCase().indexOf(clue.toLowerCase())
      if (position !== -1 && (anchor === -1 || position < anchor)) {
        anchor = position
        anchorWord = clue
      }
    }
  }
  if (anchor === -1) anchor = 0
  const start = Math.max(0, anchor - 60)
  const raw = text.slice(start, start + SNIPPET_CHARS)
  const highlighted = anchorWord === ''
    ? raw
    : raw.replace(new RegExp(anchorWord.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), 'gi'), match => `【${match}】`)
  const prefix = start > 0 ? '…' : ''
  const suffix = start + SNIPPET_CHARS < text.length ? '…' : ''
  const body = `${prefix}${highlighted}${suffix}`
  return memory.source === 'unbound' ? `${UNBOUND_PREFIX}${escapeAngle(body)}` : escapeAngle(body)
}

// ─── Lifecycle ops (REQ-M06 pin / REQ-M07 void / REQ-M05 epoch).

const findMemoryEntry = async (home: string, petId: string, id: string): Promise<MemoryEntry> => {
  const memory = await collectMemory(home, petId)
  const found = memory.entries.find(entry => entry.id === id)
  if (found === undefined) {
    throw new Error(`找不到条目 ${id}（先用 pet_recall 拿 id；imported 旧条目没有稳定 id，不能 pin/void）`)
  }
  return found
}

export async function pinEntry(home: string, petId: string, id: string): Promise<{ pinned: boolean; pinnedIds: string[] }> {
  const memory = await collectMemory(home, petId)
  const target = memory.entries.find(entry => entry.id === id)
  if (target === undefined) throw new Error(`找不到条目 ${id}，无法 pin`)
  if (memory.pinnedIds.includes(id)) return { pinned: true, pinnedIds: memory.pinnedIds }
  if (memory.pinnedIds.length >= PINNED_CAPACITY) {
    throw new Error(`pin 上限 ${PINNED_CAPACITY} 条已满，先 unpin 一条再试`)
  }
  const meta = await mutateJournalMeta(home, petId, current => ({
    pinnedIds: [...(current?.pinnedIds ?? []), id],
  }))
  return { pinned: true, pinnedIds: meta.pinnedIds ?? [id] }
}

export async function unpinEntry(home: string, petId: string, id: string): Promise<{ pinned: boolean; pinnedIds: string[] }> {
  const meta = await mutateJournalMeta(home, petId, current => ({
    pinnedIds: (current?.pinnedIds ?? []).filter(entry => entry !== id),
  }))
  return { pinned: false, pinnedIds: meta.pinnedIds ?? [] }
}

export interface VoidResult {
  tombstoneId: string
  targetId: string
  at: number
}

/** REQ-M07: voiding appends a tombstone — the target body stays in the chain,
 * only its retrievability dies. Returns the tombstone's own id. */
export async function voidEntry(
  home: string,
  petId: string,
  id: string,
  reason: string,
  sessionId: string | null,
  config: JournalConfig,
): Promise<VoidResult> {
  const target = await findMemoryEntry(home, petId, id)
  if (target.voided) throw new Error(`条目 ${id} 已经作废过（${target.voidReason ?? '无原因'}）`)
  const trimmed = reason.trim()
  if (trimmed === '') throw new Error('void 需要一个 reason：为什么作废？')
  const result = await appendJournal(home, petId, {
    source: 'system',
    sessionId,
    text: `已作废 ${id}：${trimmed}`,
    voids: { id, reason: trimmed },
  }, config)
  return { tombstoneId: result.id, targetId: id, at: result.at }
}

// ─── Epochs (REQ-M05).

export interface EpochResult {
  id: string
  at: number
  warning?: string
}

/** Append one pet-written stage summary to journal.epochs.md (outside the
 * chain). Over-capacity writes succeed but warn — the wake prompt asks for a
 * merge of the two oldest epochs; never a silent truncation. */
export async function appendEpoch(
  home: string,
  petId: string,
  input: { text: string; sessionId: string | null; window?: { from: number; to: number } },
): Promise<EpochResult> {
  const body = input.text.trim()
  if (body === '') throw new Error('epoch 内容不能为空')
  if (body.length > MAX_EPOCH_CHARS) {
    throw new Error(`epoch 最多 ${MAX_EPOCH_CHARS} 字（当前 ${body.length} 字）——写得更浓缩些，细节留给条目本身`)
  }
  const path = journalEpochsPath(home, petId)
  return withJournalLock(path, async () => {
    await mkdir(dirname(path), { recursive: true })
    const existing = parseJournalEntries(await readRaw(path))
    const at = Date.now()
    const entry: JournalEntry = {
      at,
      source: 'epoch',
      sessionId: input.sessionId,
      text: body,
      ...(input.window === undefined ? {} : { window: input.window }),
    }
    await writeFile(path, `${await readRaw(path)}${formatJournalEntry(entry)}`, 'utf8')
    // Bookkeeping: last epoch time + the journal-entry count it covered.
    const memory = await collectMemory(home, petId)
    const journalCount = memory.entries.filter(item => item.origin !== 'epochs').length
    await mutateJournalMeta(home, petId, () => ({
      lastEpochAt: at,
      epochBaseCount: journalCount,
      pendingEpoch: false,
    }))
    return {
      id: entryId(entry),
      at,
      ...(existing.length + 1 > EPOCH_CAPACITY
        ? { warning: `epochs 已有 ${existing.length + 1} 条（上限 ${EPOCH_CAPACITY}）：下次写 epoch 前先把最老的相邻两条合并重写` }
        : {}),
    }
  })
}

export async function readEpochs(home: string, petId: string): Promise<JournalEntry[]> {
  return parseJournalEntries(await readRaw(journalEpochsPath(home, petId)))
}

/** REQ-M05 trigger check — cheap, system-side, evaluated at every wake. */
export async function epochDue(home: string, petId: string): Promise<{ due: boolean; reason: string }> {
  const [memory, meta] = await Promise.all([collectMemory(home, petId), readJournalMeta(home, petId)])
  const journalCount = memory.entries.filter(entry => entry.origin !== 'epochs').length
  const lastEpochAt = meta?.lastEpochAt
  if (meta?.pendingEpoch === true) return { due: true, reason: 'journal 刚归档过一轮' }
  if (lastEpochAt === undefined) {
    if (journalCount >= 50) return { due: true, reason: `已经积累了 ${journalCount} 条记录，还没写过第一阶段摘要` }
    return { due: false, reason: '' }
  }
  const days = (Date.now() - lastEpochAt) / DAY_MS
  if (days > 7) return { due: true, reason: `距上一次阶段摘要已经 ${Math.floor(days)} 天` }
  const added = journalCount - (meta?.epochBaseCount ?? 0)
  if (added >= 50) return { due: true, reason: `上一次阶段摘要后又新增了 ${added} 条记录` }
  return { due: false, reason: '' }
}

/** REQ-M05 index lines: `[MM-DD~MM-DD] 一句话(≤40)` — chronological, newest
 * last. The window derives from the previous epoch (or the journal start). */
export function epochIndexLines(epochs: JournalEntry[], journalStartAt: number, maxLines: number): string[] {
  if (maxLines <= 0 || epochs.length === 0) return []
  const sorted = [...epochs].sort((a, b) => a.at - b.at)
  const lines = sorted.map((epoch, index) => {
    const from = epoch.window?.from ?? (index === 0 ? journalStartAt : sorted[index - 1]?.at ?? epoch.at)
    const to = epoch.window?.to ?? epoch.at
    const title = epoch.text.split('\n')[0]?.trim() ?? ''
    return `[${stampDay(from)}~${stampDay(to)}] ${title.slice(0, 40)}`
  })
  return lines.slice(-maxLines)
}

const stampDay = (at: number): string => {
  const d = new Date(at)
  const p = (n: number): string => String(n).padStart(2, '0')
  return `${p(d.getMonth() + 1)}-${p(d.getDate())}`
}

// ─── REQ-M10: read one full entry by id (snippet → full text).

export interface ReadByIdResult {
  entry: MemoryEntry
  neighbors: { prevId?: string; nextId?: string }
}

export async function readMemoryById(home: string, petId: string, id: string): Promise<ReadByIdResult> {
  const target = await findMemoryEntry(home, petId, id)
  return {
    entry: target,
    neighbors: {
      ...(target.prevId === undefined ? {} : { prevId: target.prevId }),
      ...(target.nextId === undefined ? {} : { nextId: target.nextId }),
    },
  }
}

// ─── REQ-M08: the wake injection — budgeted, priority-trimmed.

export interface JournalWakeInjection {
  /** Rendered recent entries (0.4.9 shape — budget off or trimmed). */
  entries: JournalInjection[]
  /** REQ-M05 epoch index lines (budget on only). */
  epochLines: string[]
  /** REQ-M05 fallback: the newest epoch in full, when nothing recent. */
  epochFallback?: JournalInjection
  /** REQ-M05 trigger verdict for the wake prompt. */
  epochDue?: { due: boolean; reason: string }
}

const renderInjection = (entry: JournalEntry, config: JournalConfig, labelOverride?: string): JournalInjection => ({
  at: entry.at,
  source: entry.source,
  label: labelOverride ?? journalSourceLabelOf(entry.source),
  text: escapeAngle(`${entry.source === 'unbound' ? UNBOUND_PREFIX : ''}${entry.text.slice(0, config.maxEntryChars)}`),
})

const journalSourceLabelOf = (source: string): string => {
  switch (source) {
    case 'user': return '用户'
    case 'system': return '系统'
    case 'imported': return '导入'
    case 'external-edit': return '外部编辑'
    case 'wake': return '醒来'
    case 'touch': return '被摸'
    case 'chat': return '对话'
    case 'pet': return '自述'
    case 'unbound': return '未绑定会话'
    case 'epoch': return '阶段摘要'
    default: return source
  }
}

interface WakeParts {
  pinned: JournalInjection[]
  recent: JournalInjection[]
  epochLines: string[]
  epochFallback?: JournalInjection
}

/** Pure trimming (REQ-M08): pinned > recent > epoch lines (oldest dropped
 * first) > fallback. Text chars count toward the budget; labels ride free. */
export function budgetWake(parts: WakeParts, maxChars: number): WakeParts {
  if (maxChars <= 0) return { pinned: [], recent: parts.recent, epochLines: [] }
  let budget = maxChars
  const pinned: JournalInjection[] = []
  for (const entry of parts.pinned) {
    if (budget - entry.text.length < 0) break
    budget -= entry.text.length
    pinned.push(entry)
  }
  const recent: JournalInjection[] = []
  for (const entry of parts.recent) {
    if (budget - entry.text.length < 0) break
    budget -= entry.text.length
    recent.push(entry)
  }
  const epochLines: string[] = []
  for (const line of [...parts.epochLines].reverse()) {
    if (budget - line.length < 0) break
    budget -= line.length
    epochLines.unshift(line)
  }
  const epochFallback = parts.epochFallback !== undefined && budget - parts.epochFallback.text.length >= 0
    ? parts.epochFallback
    : undefined
  return {
    pinned,
    recent,
    epochLines,
    ...(epochFallback === undefined ? {} : { epochFallback }),
  }
}

export async function buildJournalInjection(
  home: string,
  petId: string,
  config: JournalConfig,
): Promise<JournalWakeInjection> {
  const budgetOn = config.injectMaxChars > 0
  // Bookkeeping traces (external-edit / system notes) are not memories and
  // must not spend the recent window: read deeper, then filter.
  const deeper = await readJournal(home, petId, 20)
  const recent = deeper.filter(entry => !BOOKKEEPING_SOURCES.has(entry.source)).slice(-config.injectRecent)
  const [meta, due, epochs] = await Promise.all([
    readJournalMeta(home, petId),
    epochDue(home, petId),
    readEpochs(home, petId),
  ])
  const dueOut = due.due ? { due: true, reason: due.reason } : undefined

  // 0.4.9 behavior: fixed recent window, no pinned, no epoch lines.
  if (!budgetOn) {
    return {
      entries: recent.map(entry => renderInjection(entry, config)),
      epochLines: [],
      ...(dueOut === undefined ? {} : { epochDue: dueOut }),
    }
  }

  const memory = await collectMemory(home, petId)
  const byId = new Map(memory.entries.map(entry => [entry.id, entry]))

  // Pinned: rotate through the pin list so a long list still gets air time.
  const pinnedList = memory.pinnedIds
    .map(id => byId.get(id))
    .filter((entry): entry is MemoryEntry => entry !== undefined && !entry.voided)
  const take = Math.min(config.injectPinnedMax, pinnedList.length)
  const cursor = meta?.pinCursor ?? 0
  const rotated: MemoryEntry[] = []
  for (let i = 0; i < take; i += 1) rotated.push(pinnedList[(cursor + i) % pinnedList.length]!)
  if (pinnedList.length > take) {
    await mutateJournalMeta(home, petId, () => ({ pinCursor: (cursor + take) % pinnedList.length }))
  }

  const rotatedIds = new Set(rotated.map(entry => entry.id))
  const pinnedOut = rotated.map(entry => renderInjection(entry, config, `钉住 · ${journalSourceLabelOf(entry.source)}`))
  const recentOut = recent
    .filter(entry => entry.hash === undefined || !rotatedIds.has(entryId(entry)))
    .map(entry => renderInjection(entry, config))

  const nonEpoch = memory.entries.filter(entry => entry.origin !== 'epochs')
  const journalStartAt = nonEpoch.reduce((min, entry) => Math.min(min, entry.at), Number.MAX_SAFE_INTEGER)
  const parts: WakeParts = {
    pinned: pinnedOut,
    recent: recentOut,
    epochLines: epochIndexLines(epochs, journalStartAt === Number.MAX_SAFE_INTEGER ? Date.now() : journalStartAt, config.injectEpochLines),
    ...(recent.length === 0 && config.injectEpochFallback && epochs.length > 0
      ? { epochFallback: renderInjection([...epochs].sort((a, b) => a.at - b.at).at(-1)!, config, '阶段摘要') }
      : {}),
  }
  const budgeted = budgetWake(parts, config.injectMaxChars)
  return {
    entries: [...budgeted.pinned, ...budgeted.recent],
    epochLines: budgeted.epochLines,
    ...(budgeted.epochFallback === undefined ? {} : { epochFallback: budgeted.epochFallback }),
    ...(dueOut === undefined ? {} : { epochDue: dueOut }),
  }
}
