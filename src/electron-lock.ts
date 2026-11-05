/**
 * Install-lock policy for the npm Electron bootstrap. The lock is a plain
 * file; liveness of the recorded owner is the primary staleness signal, so a
 * host restart during a download cannot block the next activation for a fixed
 * grace period. Time-based expiry remains only as a backstop for PID reuse,
 * malformed locks, and an owner whose event loop is stuck.
 * @module dsh-agentic-pet/electron-lock
 */

export const INSTALL_LOCK_STALE_MS = 30 * 60_000
export const INSTALL_LOCK_MALFORMED_GRACE_MS = 60_000

export interface InstallLockRecord {
  pid?: unknown
  at?: unknown
}

/** True when `pid` names a live process (EPERM means it exists but is not ours). */
export function isProcessAlive(pid: number): boolean {
  if (!Number.isInteger(pid) || pid <= 0) return false
  try {
    process.kill(pid, 0)
    return true
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === 'EPERM'
  }
}

/** Parse a lock file; `undefined` means empty/malformed. */
export function parseInstallLock(raw: string): InstallLockRecord | undefined {
  try {
    const value: unknown = JSON.parse(raw)
    return typeof value === 'object' && value !== null ? value as InstallLockRecord : undefined
  } catch {
    return undefined
  }
}

/**
 * Whether an existing lock may be taken over by a new installer.
 * A dead owner is stale immediately; a live owner keeps its lock until the
 * absolute cap (which also bounds PID-reuse false positives). A malformed
 * record gets a short grace for a concurrent writer, then goes stale.
 */
export function installLockStale(
  raw: string | undefined,
  mtimeMs: number,
  now: number,
  alive: (pid: number) => boolean = isProcessAlive,
): boolean {
  if (now - mtimeMs > INSTALL_LOCK_STALE_MS) return true
  const record = raw === undefined ? undefined : parseInstallLock(raw)
  const pid = typeof record?.pid === 'number' ? record.pid : undefined
  if (pid === undefined) return now - mtimeMs > INSTALL_LOCK_MALFORMED_GRACE_MS
  return !alive(pid)
}
