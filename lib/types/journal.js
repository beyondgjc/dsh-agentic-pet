/**
 * The pet's continuity journal: one human-readable markdown file per pet.
 * Entries carry a machine marker (timestamp/source/session) plus a human
 * heading. Writes are append-only; the only rewrite is bounded rotation into
 * `journal.archive.md`. The settings page's direct file edits are detected
 * through a sidecar digest and leave an `external-edit` trace.
 * @module dsh-agentic-pet/journal
 */
import { createHash } from 'node:crypto';
import { appendFile, mkdir, readFile, stat, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { petDataDir, readGlobalJson } from "./petdata.js";
export const DEFAULT_JOURNAL_CONFIG = {
    enabled: true,
    injectRecent: 3,
    maxEntryChars: 120,
    maxFileBytes: 256 * 1024,
    allowUnboundAppend: false,
    injectMaxChars: 0,
    injectPinned: false,
    injectPinnedMax: 2,
    injectEpochLines: 4,
    injectEpochFallback: true,
};
const MAX_ENTRY_CHARS = 2000;
export function journalPath(home, petId) {
    return join(petDataDir(home, petId), 'journal.md');
}
export function journalArchivePath(home, petId) {
    return join(petDataDir(home, petId), 'journal.archive.md');
}
export function journalMetaPath(home, petId) {
    return join(petDataDir(home, petId), 'journal.meta.json');
}
/** REQ-M05: the pet's own stage summaries live OUTSIDE the main chain, in
 * their own file. Same marker format, `source: "epoch"`. */
export function journalEpochsPath(home, petId) {
    return join(petDataDir(home, petId), 'journal.epochs.md');
}
/** REQ-M03: the derived retrieval index (pure mirror — safe to delete). */
export function journalIndexPath(home, petId) {
    return join(petDataDir(home, petId), 'journal.index.json');
}
function clamp(value, fallback, min, max) {
    return typeof value === 'number' && Number.isFinite(value)
        ? Math.min(max, Math.max(min, Math.round(value)))
        : fallback;
}
export async function readJournalConfig(home) {
    try {
        const raw = await readGlobalJson(home, 'pet-settings.json');
        const journal = raw.journal;
        if (typeof journal !== 'object' || journal === null)
            return { ...DEFAULT_JOURNAL_CONFIG };
        const record = journal;
        return {
            enabled: record.enabled !== false,
            injectRecent: clamp(record.injectRecent, DEFAULT_JOURNAL_CONFIG.injectRecent, 1, 20),
            maxEntryChars: clamp(record.maxEntryChars, DEFAULT_JOURNAL_CONFIG.maxEntryChars, 40, 1000),
            maxFileBytes: clamp(record.maxFileBytes, DEFAULT_JOURNAL_CONFIG.maxFileBytes, 4096, 4 * 1024 * 1024),
            allowUnboundAppend: record.allowUnboundAppend === true,
            injectMaxChars: clamp(record.injectMaxChars, DEFAULT_JOURNAL_CONFIG.injectMaxChars, 0, 100_000),
            injectPinned: record.injectPinned === true,
            injectPinnedMax: clamp(record.injectPinnedMax, DEFAULT_JOURNAL_CONFIG.injectPinnedMax, 1, 10),
            injectEpochLines: clamp(record.injectEpochLines, DEFAULT_JOURNAL_CONFIG.injectEpochLines, 0, 12),
            injectEpochFallback: record.injectEpochFallback !== false,
        };
    }
    catch {
        return { ...DEFAULT_JOURNAL_CONFIG };
    }
}
const localStamp = (at) => {
    const d = new Date(at);
    const p = (n) => String(n).padStart(2, '0');
    return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())} ${p(d.getHours())}:${p(d.getMinutes())}`;
};
export const journalSourceLabel = (source) => {
    switch (source) {
        case 'user': return '用户';
        case 'system': return '系统';
        case 'imported': return '导入';
        case 'external-edit': return '外部编辑';
        case 'wake': return '醒来';
        case 'touch': return '被摸';
        case 'chat': return '对话';
        case 'pet': return '自述';
        case 'unbound': return '未绑定会话';
        case 'epoch': return '阶段摘要';
        default: return source;
    }
};
export function formatJournalEntry(entry) {
    const meta = JSON.stringify({
        at: entry.at,
        source: entry.source,
        sessionId: entry.sessionId,
        ...(entry.tags === undefined ? {} : { tags: entry.tags }),
        ...(entry.entities === undefined ? {} : { entities: entry.entities }),
        ...(entry.echo === undefined ? {} : { echo: entry.echo }),
        ...(entry.voids === undefined ? {} : { voids: entry.voids }),
        ...(entry.window === undefined ? {} : { window: entry.window }),
        ...(entry.prev === undefined ? {} : { prev: entry.prev }),
        ...(entry.hash === undefined ? {} : { hash: entry.hash }),
    });
    return `<!-- journal ${meta} -->\n## ${localStamp(entry.at)} · ${journalSourceLabel(entry.source)}\n\n${entry.text.trim()}\n\n`;
}
/** Chain link for an entry body. The text is part of the hash, so editing a
 * body without recomputing every later link is detectable. Tags/entities are
 * entry content and ride in the hash — but ONLY when present, so legacy
 * entries (no tags) verify against the exact same input as before. */
export function hashJournalEntry(prev, entry) {
    const clueTags = entry.tags === undefined ? '' : `\n${JSON.stringify(entry.tags)}`;
    const clueEntities = entry.entities === undefined ? '' : `\n${JSON.stringify(entry.entities)}`;
    return createHash('sha256')
        .update(`${prev}\n${entry.at}\n${entry.source}\n${entry.sessionId ?? ''}${clueTags}${clueEntities}\n${entry.text.trim()}`)
        .digest('hex');
}
function chainEntry(entry, prev) {
    const hash = hashJournalEntry(prev, entry);
    return { ...entry, prev, hash };
}
const markerPattern = /<!--\s*journal\s+(\{.*?\})\s*-->/g;
function parseMarker(record) {
    if (typeof record !== 'object' || record === null)
        return undefined;
    const r = record;
    if (typeof r.at !== 'number' || !Number.isFinite(r.at))
        return undefined;
    if (typeof r.source !== 'string' || r.source === '')
        return undefined;
    return {
        at: r.at,
        source: r.source,
        sessionId: typeof r.sessionId === 'string' ? r.sessionId : null,
        text: '',
        ...(Array.isArray(r.tags)
            ? { tags: r.tags.filter((tag) => typeof tag === 'string') }
            : {}),
        ...(Array.isArray(r.entities)
            ? { entities: r.entities.filter((item) => typeof item === 'string') }
            : {}),
        ...(r.echo === true ? { echo: true } : {}),
        ...(typeof r.voids === 'object' && r.voids !== null
            && typeof r.voids.id === 'string'
            ? { voids: { id: r.voids.id, reason: typeof r.voids.reason === 'string' ? r.voids.reason : '' } }
            : {}),
        ...(typeof r.window === 'object' && r.window !== null
            && typeof r.window.from === 'number'
            && typeof r.window.to === 'number'
            ? { window: { from: r.window.from, to: r.window.to } }
            : {}),
        ...(typeof r.prev === 'string' ? { prev: r.prev } : {}),
        ...(typeof r.hash === 'string' ? { hash: r.hash } : {}),
    };
}
/** Hand-written text: split on ATX headings; a file without headings is ONE
 * entry (not silently dropped). `fallbackAt` is the file mtime when known. */
function parseHeadingSections(raw, fallbackAt) {
    const sections = raw.split(/^##\s+/m).slice(1);
    if (sections.length === 0) {
        const text = raw.trim();
        return text === '' ? [] : [{ at: fallbackAt, source: 'imported', sessionId: null, text }];
    }
    return sections.map((section) => {
        const newline = section.indexOf('\n');
        const heading = newline === -1 ? section.trim() : section.slice(0, newline).trim();
        const body = newline === -1 ? '' : section.slice(newline + 1).trim();
        const date = /(\d{4}-\d{2}-\d{2})(?:\s+(\d{2}:\d{2}))?/.exec(heading);
        let at = fallbackAt;
        if (date !== null) {
            const parsed = new Date(`${date[1]}T${date[2] ?? '12:00'}:00`);
            if (!Number.isNaN(parsed.getTime()))
                at = parsed.getTime();
        }
        return { at, source: 'imported', sessionId: null, text: `${heading}\n${body}`.trim() };
    }).filter(entry => entry.text !== '');
}
/** Markers are authoritative; a hand-written `##` file falls back to headings.
 * Content BEFORE the first marker is still parsed as imported entries — a
 * user note prepended to a marker file must not live in a blind spot. */
export function parseJournalEntries(raw, fallbackAt = 0) {
    const matches = [];
    markerPattern.lastIndex = 0;
    let match;
    while ((match = markerPattern.exec(raw)) !== null) {
        matches.push({ start: match.index, end: match.index + match[0].length, json: match[1] ?? '' });
    }
    if (matches.length > 0) {
        const first = matches[0];
        const prefix = first === undefined ? '' : raw.slice(0, first.start);
        const entries = [...parseHeadingSections(prefix, fallbackAt)];
        for (let i = 0; i < matches.length; i += 1) {
            const current = matches[i];
            if (current === undefined)
                continue;
            let parsed;
            try {
                parsed = JSON.parse(current.json);
            }
            catch {
                continue;
            }
            const entry = parseMarker(parsed);
            if (entry === undefined)
                continue;
            const next = matches[i + 1];
            const body = raw.slice(current.end, next?.start ?? raw.length);
            entry.text = body.replace(/^\s*##[^\n]*\n?/, '').trim();
            entries.push(entry);
        }
        return entries;
    }
    return parseHeadingSections(raw, fallbackAt);
}
async function appendTrace(home, petId, text) {
    const path = journalPath(home, petId);
    const raw = await readFile(path, 'utf8').catch(() => '');
    const entries = parseJournalEntries(raw);
    const prev = entries.at(-1)?.hash ?? 'genesis';
    const trace = chainEntry({ at: Date.now(), source: 'external-edit', sessionId: null, text }, prev);
    await appendFile(path, formatJournalEntry(trace), 'utf8');
    await writeMeta(home, petId, await readFile(path, 'utf8'));
    return trace.hash ?? prev;
}
/** Detect edits made outside `appendJournal` (a manual editor, or a session
 * using generic file tools), including deletion/truncation. A trace entry is
 * a chain reset point: entries before it are not re-verified. */
async function ensureExternalEditTrace(home, petId) {
    const path = journalPath(home, petId);
    const raw = await readFile(path, 'utf8').catch(() => '');
    const meta = await readMeta(home, petId);
    if (raw.trim() === '') {
        if (meta !== undefined && meta.bytes > 0) {
            await appendTrace(home, petId, '文件被外部删除或清空，已记录并重新开始。');
        }
        else if (meta === undefined) {
            await writeMeta(home, petId, raw);
        }
        return;
    }
    if (meta === undefined) {
        await writeMeta(home, petId, raw);
        return;
    }
    if (meta.hash === digest(raw))
        return;
    await appendTrace(home, petId, '文件在本次读取前被外部修改过。');
}
/** Verify the current chain segment (after the last trace). Legacy entries
 * without hashes are ignored; a length/lastHash/link mismatch is tampering. */
function verifyChain(entries, meta) {
    if (meta === undefined || meta.lastHash === undefined)
        return true;
    let lastTrace = -1;
    for (let i = 0; i < entries.length; i += 1) {
        if (entries[i]?.source === 'external-edit')
            lastTrace = i;
    }
    const segment = entries.slice(lastTrace === -1 ? 0 : lastTrace);
    const chained = segment.filter(entry => entry.hash !== undefined);
    if (chained.length !== (meta.chainLength ?? 0))
        return false;
    if (chained.at(-1)?.hash !== meta.lastHash)
        return false;
    for (let i = 0; i < chained.length; i += 1) {
        const entry = chained[i];
        if (entry === undefined || entry.prev === undefined || entry.hash === undefined)
            return false;
        if (entry.hash !== hashJournalEntry(entry.prev, entry))
            return false;
        if (i > 0 && entry.prev !== chained[i - 1]?.hash)
            return false;
    }
    return true;
}
export async function readJournal(home, petId, limit = 3) {
    const path = journalPath(home, petId);
    return withJournalLock(path, async () => {
        await ensureExternalEditTrace(home, petId);
        try {
            let raw = await readFile(path, 'utf8');
            const fallbackAt = await stat(path).then(info => info.mtimeMs).catch(() => 0);
            let entries = parseJournalEntries(raw, fallbackAt);
            const meta = await readMeta(home, petId);
            if (!verifyChain(entries, meta)) {
                await appendTrace(home, petId, '检测到 journal 链断裂或被删改，已记录。');
                raw = await readFile(path, 'utf8');
                entries = parseJournalEntries(raw, fallbackAt);
            }
            return entries.slice(-Math.max(1, Math.min(20, limit)));
        }
        catch {
            return [];
        }
    });
}
export async function readJournalForInjection(home, petId, config) {
    const entries = await readJournal(home, petId, config.injectRecent);
    return entries.map(entry => ({
        at: entry.at,
        source: entry.source,
        label: journalSourceLabel(entry.source),
        text: entry.text.slice(0, config.maxEntryChars).replace(/</g, '‹').replace(/>/g, '›'),
    }));
}
const queues = new Map();
/** Serialize writes per file inside this process. `appendFile` keeps the
 * cross-process write itself atomic. Side files (epochs, index) share the
 * journal's lock namespace through their own paths. */
export function withJournalLock(key, fn) {
    const previous = queues.get(key) ?? Promise.resolve();
    const run = previous.then(fn, fn);
    queues.set(key, run.then(() => undefined, () => undefined));
    return run;
}
const digest = (raw) => createHash('sha256').update(raw).digest('hex');
export async function readJournalMeta(home, petId) {
    return readMeta(home, petId);
}
/** Bookkeeping mutation (pin list, epoch triggers) — runs inside the journal
 * lock so it can never interleave with a concurrent append. */
export async function mutateJournalMeta(home, petId, compute) {
    const path = journalPath(home, petId);
    return withJournalLock(path, async () => {
        const raw = await readFile(path, 'utf8').catch(() => '');
        const current = await readMeta(home, petId);
        return writeMeta(home, petId, raw, compute(current));
    });
}
async function readMeta(home, petId) {
    try {
        const parsed = JSON.parse(await readFile(journalMetaPath(home, petId), 'utf8'));
        if (typeof parsed.hash === 'string' && typeof parsed.bytes === 'number')
            return parsed;
    }
    catch {
        // No meta yet.
    }
    return undefined;
}
async function writeMeta(home, petId, raw, extras = {}) {
    const entries = parseJournalEntries(raw);
    // A trace entry is a reset point: entries before the last trace are known
    // compromised and are not re-verified; the chain segment starts there.
    let lastTrace = -1;
    for (let i = 0; i < entries.length; i += 1) {
        if (entries[i]?.source === 'external-edit')
            lastTrace = i;
    }
    const segment = entries.slice(lastTrace === -1 ? 0 : lastTrace);
    const chained = segment.filter(entry => entry.hash !== undefined);
    const lastHash = chained.at(-1)?.hash;
    const previous = await readMeta(home, petId);
    // Bookkeeping that lives outside the chain (pin list, epoch triggers)
    // survives rewrites unless explicitly overridden via `extras`.
    const carriedOver = previous === undefined ? {} : {
        ...(previous.pinnedIds === undefined ? {} : { pinnedIds: previous.pinnedIds }),
        ...(previous.pinCursor === undefined ? {} : { pinCursor: previous.pinCursor }),
        ...(previous.lastEpochAt === undefined ? {} : { lastEpochAt: previous.lastEpochAt }),
        ...(previous.epochBaseCount === undefined ? {} : { epochBaseCount: previous.epochBaseCount }),
        // pendingEpoch must survive plain appends — only an epoch write clears it.
        ...(previous.pendingEpoch === undefined ? {} : { pendingEpoch: previous.pendingEpoch }),
    };
    const meta = {
        ...carriedOver,
        ...extras,
        bytes: Buffer.byteLength(raw, 'utf8'),
        hash: digest(raw),
        updatedAt: Date.now(),
        ...(lastHash === undefined ? {} : { lastHash }),
        chainLength: chained.length,
    };
    await writeFile(journalMetaPath(home, petId), `${JSON.stringify(meta)}\n`, 'utf8');
    return meta;
}
/** Stable id for an entry (REQ-M03): derived from `at` + hash prefix, so a
 * rebuild reproduces it exactly. Hash-less (imported) entries fall back to a
 * position-stable `imp<N>` suffix — they cannot be pinned but stay addressable. */
export function entryId(entry, ordinal = 0) {
    const iso = new Date(entry.at).toISOString();
    return entry.hash === undefined ? `e-${iso}-imp${ordinal}` : `e-${iso}-${entry.hash.slice(0, 6)}`;
}
async function rotate(home, petId) {
    const path = journalPath(home, petId);
    const raw = await readFile(path, 'utf8').catch(() => '');
    if (raw === '')
        return;
    const fallbackAt = await stat(path).then(info => info.mtimeMs).catch(() => 0);
    const entries = parseJournalEntries(raw, fallbackAt);
    const archive = journalArchivePath(home, petId);
    await appendFile(archive, raw.endsWith('\n') ? raw : `${raw}\n`, 'utf8');
    const note = (prev) => chainEntry({
        at: Date.now(),
        source: 'system',
        sessionId: null,
        text: '旧记录已归档到 journal.archive.md。',
    }, prev);
    const meta = await readMeta(home, petId);
    const pinned = new Set(meta?.pinnedIds ?? []);
    const isPinned = (entry, index) => entry.hash !== undefined && pinned.has(entryId(entry, index));
    // Archive keeps the complete raw file; the current file keeps the newest
    // entries plus a pointer note, so wake injection stays cheap. Pinned
    // entries (REQ-M06) never sink: they ride along in file order.
    if (entries.length <= 1) {
        const sole = entries[0];
        const kept = sole !== undefined && isPinned(sole, 0) ? [sole] : [];
        await writeFile(path, [...kept, note(kept.at(-1)?.hash ?? sole?.hash ?? 'genesis')].map(formatJournalEntry).join(''), 'utf8');
        return;
    }
    const windowStart = entries.length - Math.min(20, entries.length - 1);
    const keep = entries.filter((entry, index) => isPinned(entry, index) || index >= windowStart);
    const rebuilt = [...keep, note(keep.at(-1)?.hash ?? 'genesis')].map(formatJournalEntry).join('');
    await writeFile(path, rebuilt, 'utf8');
}
export async function appendJournal(home, petId, entry, config) {
    const text = entry.text.trim().slice(0, MAX_ENTRY_CHARS);
    if (text === '')
        throw new Error('journal 追加内容不能为空');
    const tags = normalizeClues(entry.tags, 5, 'tags');
    const entities = normalizeClues(entry.entities, 8, 'entities');
    const path = journalPath(home, petId);
    return withJournalLock(path, async () => {
        await mkdir(dirname(path), { recursive: true });
        const existing = await readFile(path, 'utf8').catch(() => '');
        const meta = await readMeta(home, petId);
        const existingEntries = parseJournalEntries(existing);
        // REQ-M09 anti-echo: compare against every body that already exists
        // (current file, archive, epochs). Exact repeats flag at any length;
        // containment needs ≥8 chars so two-letter statuses don't flag everything.
        // Mechanical tombstones never echo-check.
        const echo = entry.voids === undefined
            ? isEcho(text, [
                ...existingEntries.map(item => item.text),
                ...await readSideTexts(home, petId),
            ])
            : false;
        let prev = existingEntries.at(-1)?.hash ?? 'genesis';
        const chunks = [];
        if (existing.trim() !== '' && meta !== undefined && meta.hash !== digest(existing)) {
            const trace = chainEntry({
                at: Date.now(),
                source: 'external-edit',
                sessionId: null,
                text: '文件在本次追加前被外部修改过。',
            }, prev);
            chunks.push(formatJournalEntry(trace));
            prev = trace.hash ?? prev;
        }
        // Stamp inside the lock: a queued append must record when it actually
        // wrote, not when its tool call started.
        const at = entry.at ?? Date.now();
        const nextEntry = chainEntry({
            at,
            source: entry.source,
            sessionId: entry.sessionId,
            text,
            ...(tags === undefined ? {} : { tags }),
            ...(entities === undefined ? {} : { entities }),
            ...(echo ? { echo: true } : {}),
            ...(entry.voids === undefined ? {} : { voids: entry.voids }),
        }, prev);
        chunks.push(formatJournalEntry(nextEntry));
        await appendFile(path, chunks.join(''), 'utf8');
        let current = await readFile(path, 'utf8');
        let rotated = false;
        if (Buffer.byteLength(current, 'utf8') > config.maxFileBytes) {
            await rotate(home, petId);
            current = await readFile(path, 'utf8');
            rotated = true;
        }
        // Rotate marks that the pet owes one epoch (REQ-M05) — the wake path reads it.
        await writeMeta(home, petId, current, rotated ? { pendingEpoch: true } : {});
        return { path, at, rotated, id: entryId(nextEntry), echo };
    });
}
const normalizeClues = (value, max, name) => {
    if (value === undefined)
        return undefined;
    if (!Array.isArray(value))
        throw new Error(`${name} 必须是字符串数组`);
    const cleaned = [...new Set(value.map(item => String(item).trim()).filter(item => item !== ''))];
    if (cleaned.length > max)
        throw new Error(`${name} 最多 ${max} 个（收到 ${cleaned.length} 个）`);
    return cleaned.length === 0 ? undefined : cleaned;
};
/** REQ-M09: verbatim repeats flag at any length; containment flags when the
 * shorter body is ≥8 chars (short statuses like 「想你」 must not flag). */
export const isEcho = (text, existing) => {
    const needle = text.trim();
    if (needle === '')
        return false;
    return existing.some((body) => {
        const hay = body.trim();
        if (hay === '')
            return false;
        if (hay === needle)
            return true;
        const shorter = hay.length < needle.length ? hay : needle;
        if (shorter.length < 8)
            return false;
        return hay.includes(needle) || needle.includes(hay);
    });
};
/** Bodies of the side files (archive + epochs) for echo comparison. */
async function readSideTexts(home, petId) {
    const parts = await Promise.all([
        readFile(journalArchivePath(home, petId), 'utf8').catch(() => ''),
        readFile(journalEpochsPath(home, petId), 'utf8').catch(() => ''),
    ]);
    return parts.flatMap(raw => parseJournalEntries(raw).map(entry => entry.text));
}
/** One-time import of the user's hand-written notebook. The source is never
 * modified; the target is created only when absent. Returns entries imported. */
export async function importHandwrittenJournal(home, petId, sourcePath) {
    const target = journalPath(home, petId);
    try {
        await readFile(target, 'utf8');
        return 0; // already imported / in use
    }
    catch {
        // Absent: import below.
    }
    let raw;
    let mtime = Date.now();
    try {
        raw = await readFile(sourcePath, 'utf8');
        mtime = (await stat(sourcePath)).mtimeMs;
    }
    catch {
        return 0;
    }
    const entries = parseHeadingSections(raw, mtime);
    if (entries.length === 0)
        return 0;
    await mkdir(dirname(target), { recursive: true });
    let prev = 'genesis';
    const chained = entries.map((item) => {
        const next = chainEntry(item, prev);
        prev = next.hash ?? prev;
        return next;
    });
    const content = chained.map(formatJournalEntry).join('');
    await writeFile(target, content, 'utf8');
    await writeMeta(home, petId, content);
    return entries.length;
}
//# sourceMappingURL=journal.js.map