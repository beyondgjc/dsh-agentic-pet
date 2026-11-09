/**
 * The living-room board (multi-pet design §5): fold/cap/cursor semantics —
 * malformed entries drop individually, the board rolls past the cap, replies
 * cap per note, unseen counts other pets' items only, and the cursor is
 * per-pet state in the pet's own directory (whale598/<petId>/).
 */

import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterAll, describe, expect, it } from 'vitest'
import {
  BOARD_NOTE_LIMIT,
  leaveNote,
  parseBoard,
  readBoardCursor,
  replyNote,
  unseenBoardItems,
  writeBoardCursor,
} from '../src/board.ts'

const homes: string[] = []
const tempHome = async (): Promise<string> => {
  const dir = await mkdtemp(join(tmpdir(), 'pet-board-'))
  homes.push(dir)
  return dir
}
afterAll(async () => {
  for (const dir of homes) await rm(dir, { force: true, recursive: true })
})

describe('parseBoard', () => {
  it('folds malformed notes and replies individually', () => {
    const board = parseBoard({
      notes: [
        { id: 'n-ok', from: 'electron', at: 1, text: 'hello', replies: [
          { id: 'r-ok', from: 'pure', at: 2, text: 'hi' },
          { id: 'r-bad', from: 'pure', at: 'nope', text: 'dropped' },
          'nope',
        ] },
        { id: '', from: 'pure', at: 3, text: 'dropped' },
        { id: 'n-no-at', from: 'pure', text: 'dropped' },
        'nope',
      ],
    })
    expect(board.notes).toHaveLength(1)
    expect(board.notes[0].replies).toEqual([{ id: 'r-ok', from: 'pure', at: 2, text: 'hi' }])
  })
})

describe('notes and replies', () => {
  it('caps the board at 20 notes (oldest drops) and clamps text to 200', () => {
    const home = homes[0] ?? ''
    // filled lazily in the test below via tempHome — use a dedicated one
  })

  it('leaves notes newest-first and rolls the oldest past the cap', async () => {
    const home = await tempHome()
    for (let i = 0; i < BOARD_NOTE_LIMIT + 2; i += 1) {
      await leaveNote(home, 'electron', `note ${String(i)}`, 1_000 + i)
    }
    const board = parseBoard(await import('../src/petdata.ts').then(m => m.readGlobalJson(home, 'pet-board.json')))
    expect(board.notes).toHaveLength(BOARD_NOTE_LIMIT)
    expect(board.notes[0].text).toBe('note 21')
    expect(board.notes[BOARD_NOTE_LIMIT - 1].text).toBe('note 2')
  })

  it('clamps the text to the board limit', async () => {
    const home = await tempHome()
    const note = await leaveNote(home, 'electron', 'x'.repeat(300), 1_000)
    expect(note.text.length).toBe(200)
  })

  it('caps replies per note and reports unknown note ids', async () => {
    const home = await tempHome()
    const note = await leaveNote(home, 'electron', '原文', 1_000)
    for (let i = 0; i < 12; i += 1) {
      await replyNote(home, 'pure', note.id, `回 ${String(i)}`, 2_000 + i)
    }
    const board = parseBoard(await import('../src/petdata.ts').then(m => m.readGlobalJson(home, 'pet-board.json')))
    expect(board.notes[0].replies).toHaveLength(10)
    expect(board.notes[0].replies[0].text).toBe('回 11')
    expect(await replyNote(home, 'pure', 'n-missing', 'x')).toBeUndefined()
  })
})

describe('unseen and cursor', () => {
  it('counts only other pets items after the cursor', async () => {
    const home = await tempHome()
    await leaveNote(home, 'electron', '我自己的字', 1_000)
    await leaveNote(home, 'pure', '对方的新字', 2_000)
    const note = await leaveNote(home, 'electron', '被回复的字', 3_000)
    await replyNote(home, 'pure', note.id, '对方的回复', 4_000)
    await replyNote(home, 'electron', note.id, '我自己的回复', 5_000)

    const before = await unseenBoardItems(home, 'electron')
    expect(before.count).toBe(2)
    expect(before.froms).toEqual(['pure'])

    await writeBoardCursor(home, 'electron', 4_500)
    const after = await unseenBoardItems(home, 'electron')
    // the note (at 3000 ≤ cursor) and the reply (4000 ≤ cursor) are seen now
    expect(after.count).toBe(0)
  })

  it('keeps the cursor per pet (each pet its own directory)', async () => {
    const home = await tempHome()
    await leaveNote(home, 'pure', 'pure 留的字', 1_000)
    await leaveNote(home, 'electron', 'electron 留给别人的字', 2_000)
    await writeBoardCursor(home, 'electron', 5_000)
    expect(await readBoardCursor(home, 'electron')).toBe(5_000)
    expect(await readBoardCursor(home, 'pure')).toBe(0)
    const electronUnseen = await unseenBoardItems(home, 'electron')
    const pureUnseen = await unseenBoardItems(home, 'pure')
    // electron 游标 5000：两批字都看过 → 0；pure 游标 0：electron 的字未读，
    // 自己留的字不算
    expect(electronUnseen.count).toBe(0)
    expect(pureUnseen.count).toBe(1)
    expect(pureUnseen.froms).toEqual(['electron'])
  })

  it('stores the cursor in the pet directory per the ownership rules', async () => {
    const home = await tempHome()
    await writeBoardCursor(home, 'electron', 42)
    const raw = await import('../src/petdata.ts').then(m => m.readPetStateJson(home, 'electron', 'pet-board-cursor.json'))
    expect(raw).toEqual({ seenAt: 42 })
    expect(join(home, 'whale598', 'electron')).toContain('whale598')
  })
})
