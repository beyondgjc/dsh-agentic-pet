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
import { type JournalConfig, type JournalEntry, type JournalInjection } from './journal.ts';
/** Terms for indexing: every CJK bigram (single-char runs keep a unigram)
 * plus every ASCII word. Query side uses the same function. */
export declare function tokenize(text: string): string[];
export type MemoryOrigin = 'current' | 'archive' | 'epochs';
export interface MemoryEntry {
    id: string;
    at: number;
    source: string;
    sessionId: string | null;
    text: string;
    tags: string[];
    entities: string[];
    echo: boolean;
    pinned: boolean;
    voided: boolean;
    voidedAt?: number;
    voidReason?: string;
    origin: MemoryOrigin;
    hash?: string;
    /** Adjacent ids within the entry's own file (REQ-M10 read-by-id). */
    prevId?: string;
    nextId?: string;
}
export interface CollectedMemory {
    entries: MemoryEntry[];
    /** digest of the three source files — the index staleness check. */
    sourceDigest: string;
    pinnedIds: string[];
}
/** Read the three files once; everything else derives from this. Entries are
 * deduped by id with priority current > archive > epochs — after a rotate the
 * newest entries exist in both L1 and L2, and the current copy wins (§3
 * 同一性). Tombstones are collected from ALL copies, dupes included. */
export declare function collectMemory(home: string, petId: string): Promise<CollectedMemory>;
/** REQ-M03 incremental path: called by the tool layer right after a plain
 * append (no rotate). Reuses the persisted term map and appends one entry —
 * falls back to a full rebuild whenever the persisted state has drifted. */
export declare function updateIndexAfterAppend(home: string, petId: string, appendedId: string): Promise<void>;
export interface ScoreParts {
    lexical: number;
    recency: number;
    tag: number;
    kind: number;
    total: number;
}
export interface RecallParams {
    query?: string;
    tags?: string[];
    entities?: string[];
    from?: string | number;
    to?: string | number;
    scope?: 'current' | 'archive' | 'all';
    limit?: number;
    maxChars?: number;
    includeVoided?: boolean;
    /** Default: strict AND, auto-relaxed step by step when it comes back
     * empty (partial hits are annotated with `missing`). Explicit values
     * disable the auto-relax. */
    minMatch?: number;
    /** External-edit traces / system notes are bookkeeping, not memories —
     * excluded by default. */
    includeBookkeeping?: boolean;
    /** The excluded list is summarized as `excludedCount` by default; pass
     * this to see the actual entries (≤5, with reasons). */
    includeExcluded?: boolean;
    rebuild?: boolean;
}
export interface RecallHit {
    id: string;
    at: number;
    source: string;
    sessionId: string | null;
    origin: MemoryOrigin;
    snippet: string;
    score: number;
    voided: boolean;
    voidedAt?: number;
    voidReason?: string;
    echo: boolean;
    /** Query words this hit does NOT contain (present on partial matches). */
    missing?: string[];
    /** How this hit matched: `tag` = the entry really carries the queried
     * tag/entity (fact); `text` = keyword hit in the body (match, not a tag).
     * Absent in browse mode. */
    matchedBy?: Array<'tag' | 'text'>;
    parts: ScoreParts;
}
export interface RejectedEntry {
    id: string;
    reason: 'voided' | 'echo' | 'bookkeeping' | 'min-match' | 'budget';
    detail?: string;
    score: number;
}
export interface RecallResult {
    hits: RecallHit[];
    /** Candidates that passed the relevance gate — `totalMatched - hits.length`
     * is exactly how many did not make the cut (limit/budget). */
    totalMatched: number;
    truncated: boolean;
    /** Time since the index was last synced (rebuilt or incrementally
     * updated). It does NOT measure staleness: every recall first verifies
     * the index against the source digest and rebuilds on mismatch, so
     * results are never behind the content. */
    sinceRebuildMs: number;
    rebuilt: boolean;
    /** Safety/bookkeeping exclusions (voided/echo/bookkeeping), ≤5 — only
     * present when the caller asked for `includeExcluded`. */
    excluded?: RejectedEntry[];
    excludedCount: number;
    /** Entries below the word-match threshold — count only, no entries. */
    belowThreshold: number;
}
export declare function recallJournal(home: string, petId: string, params: RecallParams): Promise<RecallResult>;
/** REQ-M09: every recalled fragment crosses the prompt boundary wrapped as
 * data, with provenance on the wrapper itself. */
export declare function wrapMemoryBlock(hit: {
    id: string;
    at: number;
    source: string;
    snippet: string;
}): string;
/** REQ-M02 snippet: ≤200 chars around the first hit, occurrences of the
 * matched word wrapped in 【】, angle brackets neutralized AFTER slicing
 * so the 【】 wrapper stays the only markup. */
export declare function buildSnippet(memory: MemoryEntry, words: string[], tags: string[], entities: string[]): string;
export declare function pinEntry(home: string, petId: string, id: string): Promise<{
    pinned: boolean;
    pinnedIds: string[];
}>;
export declare function unpinEntry(home: string, petId: string, id: string): Promise<{
    pinned: boolean;
    pinnedIds: string[];
}>;
export interface VoidResult {
    tombstoneId: string;
    targetId: string;
    at: number;
}
/** REQ-M07: voiding appends a tombstone — the target body stays in the chain,
 * only its retrievability dies. Returns the tombstone's own id. */
export declare function voidEntry(home: string, petId: string, id: string, reason: string, sessionId: string | null, config: JournalConfig): Promise<VoidResult>;
export interface EpochResult {
    id: string;
    at: number;
    warning?: string;
}
/** Append one pet-written stage summary to journal.epochs.md (outside the
 * chain). Over-capacity writes succeed but warn — the wake prompt asks for a
 * merge of the two oldest epochs; never a silent truncation. */
export declare function appendEpoch(home: string, petId: string, input: {
    text: string;
    sessionId: string | null;
    window?: {
        from: number;
        to: number;
    };
}): Promise<EpochResult>;
export declare function readEpochs(home: string, petId: string): Promise<JournalEntry[]>;
/** REQ-M05 trigger check — cheap, system-side, evaluated at every wake. */
export declare function epochDue(home: string, petId: string): Promise<{
    due: boolean;
    reason: string;
}>;
/** REQ-M05 index lines: `[MM-DD~MM-DD] 一句话(≤40)` — chronological, newest
 * last. The window derives from the previous epoch (or the journal start). */
export declare function epochIndexLines(epochs: JournalEntry[], journalStartAt: number, maxLines: number): string[];
export interface ReadByIdResult {
    entry: MemoryEntry;
    neighbors: {
        prevId?: string;
        nextId?: string;
    };
}
export declare function readMemoryById(home: string, petId: string, id: string): Promise<ReadByIdResult>;
export interface JournalWakeInjection {
    /** Rendered recent entries (0.4.9 shape — budget off or trimmed). */
    entries: JournalInjection[];
    /** REQ-M05 epoch index lines (budget on only). */
    epochLines: string[];
    /** REQ-M05 fallback: the newest epoch in full, when nothing recent. */
    epochFallback?: JournalInjection;
    /** REQ-M05 trigger verdict for the wake prompt. */
    epochDue?: {
        due: boolean;
        reason: string;
    };
}
interface WakeParts {
    pinned: JournalInjection[];
    recent: JournalInjection[];
    epochLines: string[];
    epochFallback?: JournalInjection;
}
/** Pure trimming (REQ-M08): pinned > recent > epoch lines (oldest dropped
 * first) > fallback. Text chars count toward the budget; labels ride free. */
export declare function budgetWake(parts: WakeParts, maxChars: number): WakeParts;
export declare function buildJournalInjection(home: string, petId: string, config: JournalConfig): Promise<JournalWakeInjection>;
export {};
//# sourceMappingURL=journal-recall.d.ts.map