/**
 * The living-room board (客厅记事板, multi-pet design §5): one shared, capped,
 * user-inspectable note board every pet reads and writes through `pet_board`.
 * NOT a group chat — nothing here is pushed anywhere: a pet sees the board
 * only when its wake prompt announces unseen items (count + authors only) or
 * when it calls pet_board read. Self-talk never lands here automatically —
 * leaving a note is the model's deliberate act.
 *
 * Storage: whale598/pet-board.json (root level — the living room is shared
 * by definition, AGENTS.md §8 ownership rules). Per-pet read cursors are
 * pet-private state: whale598/<petId>/pet-board-cursor.json.
 * @module dsh-agentic-pet/board
 */
import { createHash } from 'node:crypto';
import { readGlobalJson, readPetStateJson, writeGlobalJson, writePetStateJson } from "./petdata.js";
export const BOARD_FILE = 'pet-board.json';
export const BOARD_NOTE_LIMIT = 20;
export const BOARD_REPLY_LIMIT = 10;
export const BOARD_TEXT_LIMIT = 200;
export const BOARD_CURSOR_FILE = 'pet-board-cursor.json';
/** Deterministic id: same author/content/second never mints a second id, and
 * the date prefix keeps the board human-scannable (journal precedent). */
const boardId = (prefix, petId, at, text) => {
    const day = new Date(at);
    const p = (n) => String(n).padStart(2, '0');
    const stamp = `${day.getFullYear()}${p(day.getMonth() + 1)}${p(day.getDate())}`;
    const hash = createHash('sha256').update(`${petId}|${String(at)}|${text}`, 'utf8').digest('hex').slice(0, 6);
    return `${prefix}-${stamp}-${hash}`;
};
const clampText = (text) => text.trim().slice(0, BOARD_TEXT_LIMIT);
/** Defensive fold: malformed notes/replies drop individually, never throw. */
export function parseBoard(raw) {
    const rawNotes = Array.isArray(raw.notes) ? raw.notes : [];
    const notes = [];
    for (const item of rawNotes) {
        if (typeof item !== 'object' || item === null)
            continue;
        const rec = item;
        if (typeof rec.id !== 'string' || rec.id === ''
            || typeof rec.from !== 'string' || rec.from === ''
            || typeof rec.at !== 'number' || !Number.isFinite(rec.at)
            || typeof rec.text !== 'string')
            continue;
        const rawReplies = Array.isArray(rec.replies) ? rec.replies : [];
        const replies = [];
        for (const reply of rawReplies) {
            if (typeof reply !== 'object' || reply === null)
                continue;
            const rr = reply;
            if (typeof rr.id !== 'string' || rr.id === ''
                || typeof rr.from !== 'string' || rr.from === ''
                || typeof rr.at !== 'number' || !Number.isFinite(rr.at)
                || typeof rr.text !== 'string')
                continue;
            replies.push({ id: rr.id, from: rr.from, at: rr.at, text: rr.text });
        }
        notes.push({ id: rec.id, from: rec.from, at: rec.at, text: rec.text, replies: replies.slice(0, BOARD_REPLY_LIMIT) });
    }
    return { notes: notes.slice(0, BOARD_NOTE_LIMIT) };
}
export async function readBoard(home) {
    const raw = await readGlobalJson(home, BOARD_FILE);
    return parseBoard(raw);
}
export async function writeBoard(home, board) {
    await writeGlobalJson(home, BOARD_FILE, board);
}
/** Leave one note (from = the writing pet). Newest first; the board rolls
 * past the cap (oldest notes drop — a corkboard, not an archive). */
export async function leaveNote(home, petId, text, at = Date.now()) {
    const board = await readBoard(home);
    const note = {
        id: boardId('n', petId, at, text),
        from: petId,
        at,
        text: clampText(text),
        replies: [],
    };
    board.notes.unshift(note);
    await writeBoard(home, { notes: board.notes.slice(0, BOARD_NOTE_LIMIT) });
    return note;
}
/** Reply to one note. Returns undefined when the note id is unknown — the
 * caller turns that into a self-correcting error. */
export async function replyNote(home, petId, noteId, text, at = Date.now()) {
    const board = await readBoard(home);
    const note = board.notes.find(entry => entry.id === noteId);
    if (note === undefined)
        return undefined;
    const reply = {
        id: boardId('r', petId, at, text),
        from: petId,
        at,
        text: clampText(text),
    };
    note.replies = [reply, ...note.replies].slice(0, BOARD_REPLY_LIMIT);
    await writeBoard(home, { notes: board.notes });
    return reply;
}
/** The pet's read cursor (injection = seen): an at <= cursor item never
 * re-announces. Absent file / absent field = 0 (everything announces). */
export async function readBoardCursor(home, petId) {
    const raw = await readPetStateJson(home, petId, BOARD_CURSOR_FILE);
    return typeof raw.seenAt === 'number' && Number.isFinite(raw.seenAt) ? raw.seenAt : 0;
}
export async function writeBoardCursor(home, petId, seenAt) {
    await writePetStateJson(home, petId, BOARD_CURSOR_FILE, { seenAt });
}
/** What the waking pet has not seen yet: notes and replies authored by OTHER
 * pets after the cursor. `froms` = distinct authors (the prompt announces
 * count + authors only; the text waits behind pet_board read). */
export async function unseenBoardItems(home, petId) {
    const board = await readBoard(home);
    const cursor = await readBoardCursor(home, petId);
    const froms = new Set();
    let count = 0;
    for (const note of board.notes) {
        if (note.from !== petId && note.at > cursor) {
            count += 1;
            froms.add(note.from);
        }
        for (const reply of note.replies) {
            if (reply.from !== petId && reply.at > cursor) {
                count += 1;
                froms.add(reply.from);
            }
        }
    }
    return { count, froms: [...froms] };
}
//# sourceMappingURL=board.js.map