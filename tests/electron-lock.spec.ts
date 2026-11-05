/**
 * Lock-policy coverage for the Electron bootstrap: the owner PID is the
 * primary staleness signal, so these cases pin down the 0.4.9 restart
 * incident (dead owner must not block the next activation) and the remaining
 * time-based fallbacks (PID reuse, malformed locks).
 */

import { describe, expect, it } from 'vitest'
import {
  INSTALL_LOCK_MALFORMED_GRACE_MS,
  INSTALL_LOCK_STALE_MS,
  installLockStale,
  isProcessAlive,
} from '../src/electron-lock.ts'

const now = 1_800_000_000_000
const lock = (pid: unknown): string => JSON.stringify({ pid, at: now })

describe('installLockStale', () => {
  it('keeps waiting while the recorded owner is alive', () => {
    expect(installLockStale(lock(42), now - 60_000, now, () => true)).toBe(false)
  })

  it('takes over immediately when the recorded owner is dead', () => {
    expect(installLockStale(lock(42), now - 60_000, now, () => false)).toBe(true)
  })

  it('expires at the absolute cap even when the pid still answers', () => {
    expect(installLockStale(lock(42), now - INSTALL_LOCK_STALE_MS - 1, now, () => true)).toBe(true)
  })

  it('gives a concurrent writer a grace period for a malformed lock', () => {
    expect(installLockStale('{"pid":', now - 1_000, now)).toBe(false)
  })

  it('treats a malformed lock older than the grace as stale', () => {
    expect(installLockStale('', now - INSTALL_LOCK_MALFORMED_GRACE_MS - 1, now)).toBe(true)
  })

  it('treats a record without a numeric pid as malformed', () => {
    expect(installLockStale(lock('123'), now - INSTALL_LOCK_MALFORMED_GRACE_MS - 1, now)).toBe(true)
  })

  it('treats missing content as a malformed lock', () => {
    expect(installLockStale(undefined, now - INSTALL_LOCK_MALFORMED_GRACE_MS - 1, now)).toBe(true)
  })
})

describe('isProcessAlive', () => {
  it('sees the current process', () => {
    expect(isProcessAlive(process.pid)).toBe(true)
  })

  it('rejects non-positive and non-integer pids without probing', () => {
    expect(isProcessAlive(0)).toBe(false)
    expect(isProcessAlive(-1)).toBe(false)
    expect(isProcessAlive(1.5)).toBe(false)
  })
})
