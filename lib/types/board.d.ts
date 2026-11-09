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
export declare const BOARD_FILE = "pet-board.json";
export declare const BOARD_NOTE_LIMIT = 20;
export declare const BOARD_REPLY_LIMIT = 10;
export declare const BOARD_TEXT_LIMIT = 200;
export declare const BOARD_CURSOR_FILE = "pet-board-cursor.json";
export interface BoardReply {
    id: string;
    from: string;
    at: number;
    text: string;
}
export interface BoardNote {
    id: string;
    from: string;
    at: number;
    text: string;
    replies: BoardReply[];
}
export interface Board {
    notes: BoardNote[];
}
/** Defensive fold: malformed notes/replies drop individually, never throw. */
export declare function parseBoard(raw: Record<string, unknown>): Board;
export declare function readBoard(home: string): Promise<Board>;
export declare function writeBoard(home: string, board: Board): Promise<void>;
/** Leave one note (from = the writing pet). Newest first; the board rolls
 * past the cap (oldest notes drop — a corkboard, not an archive). */
export declare function leaveNote(home: string, petId: string, text: string, at?: number): Promise<BoardNote>;
/** Reply to one note. Returns undefined when the note id is unknown — the
 * caller turns that into a self-correcting error. */
export declare function replyNote(home: string, petId: string, noteId: string, text: string, at?: number): Promise<BoardReply | undefined>;
/** The pet's read cursor (injection = seen): an at <= cursor item never
 * re-announces. Absent file / absent field = 0 (everything announces). */
export declare function readBoardCursor(home: string, petId: string): Promise<number>;
export declare function writeBoardCursor(home: string, petId: string, seenAt: number): Promise<void>;
/** What the waking pet has not seen yet: notes and replies authored by OTHER
 * pets after the cursor. `froms` = distinct authors (the prompt announces
 * count + authors only; the text waits behind pet_board read). */
export declare function unseenBoardItems(home: string, petId: string): Promise<{
    count: number;
    froms: string[];
}>;
//# sourceMappingURL=board.d.ts.map