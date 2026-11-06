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
}
export interface JournalEntry {
    at: number;
    source: string;
    sessionId: string | null;
    text: string;
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
export declare function readJournalConfig(home: string): Promise<JournalConfig>;
export declare const journalSourceLabel: (source: string) => string;
export declare function formatJournalEntry(entry: JournalEntry): string;
/** Chain link for an entry body. The text is part of the hash, so editing a
 * body without recomputing every later link is detectable. */
export declare function hashJournalEntry(prev: string, entry: JournalEntry): string;
/** Markers are authoritative; a hand-written `##` file falls back to headings.
 * Content BEFORE the first marker is still parsed as imported entries — a
 * user note prepended to a marker file must not live in a blind spot. */
export declare function parseJournalEntries(raw: string, fallbackAt?: number): JournalEntry[];
export declare function readJournal(home: string, petId: string, limit?: number): Promise<JournalEntry[]>;
export declare function readJournalForInjection(home: string, petId: string, config: JournalConfig): Promise<JournalInjection[]>;
export declare function appendJournal(home: string, petId: string, entry: {
    at?: number;
    source: string;
    sessionId: string | null;
    text: string;
}, config: JournalConfig): Promise<{
    path: string;
    at: number;
    rotated: boolean;
}>;
/** One-time import of the user's hand-written notebook. The source is never
 * modified; the target is created only when absent. Returns entries imported. */
export declare function importHandwrittenJournal(home: string, petId: string, sourcePath: string): Promise<number>;
