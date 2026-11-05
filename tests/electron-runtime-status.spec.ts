/**
 * Status-file coverage for the settings page's first-install banner: writes
 * must be atomic enough to survive polls, and a missing/malformed file must
 * read as "no status" instead of breaking the page.
 */

import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import {
  electronRuntimeStatusPath,
  readElectronRuntimeStatus,
  writeElectronRuntimeStatus,
} from '../src/electron-runtime-status.ts'

describe('electron runtime status', () => {
  it('round-trips and overwrites the status file', () => {
    const home = mkdtempSync(join(tmpdir(), 'dsh-pet-status-'))
    try {
      writeElectronRuntimeStatus(home, { state: 'downloading', updatedAt: 1, startedAt: 1, attempt: 1, source: 'npmmirror' })
      expect(readElectronRuntimeStatus(home)).toMatchObject({ state: 'downloading', attempt: 1, source: 'npmmirror' })
      writeElectronRuntimeStatus(home, { state: 'ready', updatedAt: 2 })
      expect(readElectronRuntimeStatus(home)).toMatchObject({ state: 'ready' })
    } finally {
      rmSync(home, { recursive: true, force: true })
    }
  })

  it('returns undefined for missing and malformed files', () => {
    const home = mkdtempSync(join(tmpdir(), 'dsh-pet-status-'))
    try {
      expect(readElectronRuntimeStatus(home)).toBeUndefined()
      writeElectronRuntimeStatus(home, { state: 'ready', updatedAt: 1 })
      writeFileSync(electronRuntimeStatusPath(home), '{not json', 'utf8')
      expect(readElectronRuntimeStatus(home)).toBeUndefined()
    } finally {
      rmSync(home, { recursive: true, force: true })
    }
  })
})
