/**
 * The pet's continuity journal: one human-readable markdown file per pet.
 * Entries carry a machine marker (timestamp/source/session) plus a human
 * heading. Writes are append-only; the only rewrite is bounded rotation into
 * `journal.archive.md`. The settings page's direct file edits are detected
 * through a sidecar digest and leave an `external-edit` trace.
 * @module dsh-agentic-pet/journal
 */
export interface JournalConfig {
    enabled: boolean;
    injectRecent: number;
    maxEntryChars: number;
    maxFileBytes: number;
    allowUnboundAppend: boolean;
    /** REQ-M08: total wake-injection char budget (pinned+recent+epoch lines).
     * 0 = budget off — behavior identical to 0.4.9 (count-based only). */
    injectMaxChars: number;
    /** REQ-M06: pinned entries join the wake injection (budgeted). */
    injectPinned: boolean;
    /** REQ-M06: at most this many pinned entries are injected per wake. */
    injectPinnedMax: number;
    /** REQ-M05: epoch index lines (`[起~止] 一句话`) per wake injection. */
    injectEpochLines: number;
    /** REQ-M05: inject the newest epoch in full when the current file has no
     * recent entries. */
    injectEpochFallback: boolean;
}
export interface JournalEntry {
    at: number;
    source: string;
    sessionId: string | null;
    text: string;
    /** Write-time retrieval clues (REQ-M01): ≤5 tags, ≤8 entities. Part of the
     * entry itself — the index only mirrors them, so a rebuild recovers them. */
    tags?: string[];
    entities?: string[];
    /** REQ-M09 anti-echo: this entry's body repeats (equals / is contained in /
     * contains) an existing entry's body. Kept in the chain, excluded from
     * recall and injection by default. */
    echo?: boolean;
    /** REQ-M07 tombstone: voids the entry with this id. `reason` rides along. */
    voids?: {
        id: string;
        reason: string;
    };
    /** REQ-M05 epoch only: the range this summary covers (ms epochs). */
    window?: {
        from: number;
        to: number;
    };
    /** Hash chain: previous entry's hash ('genesis' for the first chained entry). */
    prev?: string;
    /** sha256(prev + canonical entry). Present on entries written by this module. */
    hash?: string;
}
export interface JournalInjection {
    at: number;
    source: string;
    /** Human-readable source for the wake prompt (unbound writes included). */
    label: string;
    text: string;
}
export declare const DEFAULT_JOURNAL_CONFIG: JournalConfig;
export declare function journalPath(home: string, petId: string): string;
export declare function journalArchivePath(home: string, petId: string): string;
export declare function journalMetaPath(home: string, petId: string): string;
/** REQ-M05: the pet's own stage summaries live OUTSIDE the main chain, in
 * their own file. Same marker format, `source: "epoch"`. */
export declare function journalEpochsPath(home: string, petId: string): string;
/** REQ-M03: the derived retrieval index (pure mirror — safe to delete). */
export declare function journalIndexPath(home: string, petId: string): string;
export declare function readJournalConfig(home: string): Promise<JournalConfig>;
export declare const journalSourceLabel: (source: string) => string;
export declare function formatJournalEntry(entry: JournalEntry): string;
/** Chain link for an entry body. The text is part of the hash, so editing a
 * body without recomputing every later link is detectable. Tags/entities are
 * entry content and ride in the hash — but ONLY when present, so legacy
 * entries (no tags) verify against the exact same input as before. */
export declare function hashJournalEntry(prev: string, entry: JournalEntry): string;
/** Markers are authoritative; a hand-written `##` file falls back to headings.
 * Content BEFORE the first marker is still parsed as imported entries — a
 * user note prepended to a marker file must not live in a blind spot. */
export declare function parseJournalEntries(raw: string, fallbackAt?: number): JournalEntry[];
export declare function readJournal(home: string, petId: string, limit?: number): Promise<JournalEntry[]>;
export declare function readJournalForInjection(home: string, petId: string, config: JournalConfig): Promise<JournalInjection[]>;
/** Serialize writes per file inside this process. `appendFile` keeps the
 * cross-process write itself atomic. Side files (epochs, index) share the
 * journal's lock namespace through their own paths. */
export declare function withJournalLock<T>(key: string, fn: () => Promise<T>): Promise<T>;
interface JournalMeta {
    bytes: number;
    hash: string;
    updatedAt: number;
    /** Last chained entry hash in the current segment (after the last trace). */
    lastHash?: string;
    /** Number of chained entries in the current segment. */
    chainLength?: number;
    /** REQ-M06: ids of pinned entries (out-of-band — entries are immutable). */
    pinnedIds?: string[];
    /** REQ-M06: rotation cursor for injecting pinned entries. */
    pinCursor?: number;
    /** REQ-M05: rotate happened; the pet owes one epoch at the next wake. */
    pendingEpoch?: boolean;
    /** REQ-M05: epoch bookkeeping — when the last epoch was written and how
     * many journal entries existed then (for the ≥50-new-entries trigger). */
    lastEpochAt?: number;
    epochBaseCount?: number;
}
export declare function readJournalMeta(home: string, petId: string): Promise<JournalMeta | undefined>;
/** Bookkeeping mutation (pin list, epoch triggers) — runs inside the journal
 * lock so it can never interleave with a concurrent append. */
export declare function mutateJournalMeta(home: string, petId: string, compute: (meta: JournalMeta | undefined) => Partial<JournalMeta>): Promise<JournalMeta>;
export type { JournalMeta };
/** Stable id for an entry (REQ-M03): derived from `at` + hash prefix, so a
 * rebuild reproduces it exactly. Hash-less (imported) entries fall back to a
 * position-stable `imp<N>` suffix — they cannot be pinned but stay addressable. */
export declare function entryId(entry: JournalEntry, ordinal?: number): string;
export interface AppendJournalResult {
    path: string;
    at: number;
    rotated: boolean;
    /** Stable id of the entry just appended (for recall / pin / void). */
    id: string;
    /** REQ-M09: true when the body repeats an existing entry (echo). */
    echo: boolean;
}
export declare function appendJournal(home: string, petId: string, entry: {
    at?: number;
    source: string;
    sessionId: string | null;
    text: string;
    tags?: string[];
    entities?: string[];
    /** REQ-M07 tombstone: marks the referenced entry as voided. */
    voids?: {
        id: string;
        reason: string;
    };
}, config: JournalConfig): Promise<AppendJournalResult>;
/** REQ-M09: verbatim repeats flag at any length; containment flags when the
 * shorter body is ≥8 chars (short statuses like 「想你」 must not flag). */
export declare const isEcho: (text: string, existing: string[]) => boolean;
/** One-time import of the user's hand-written notebook. The source is never
 * modified; the target is created only when absent. Returns entries imported. */
export declare function importHandwrittenJournal(home: string, petId: string, sourcePath: string): Promise<number>;
//# sourceMappingURL=journal.d.ts.map