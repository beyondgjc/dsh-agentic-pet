/**
 * Install-lock policy for the npm Electron bootstrap. The lock is a plain
 * file; liveness of the recorded owner is the primary staleness signal, so a
 * host restart during a download cannot block the next activation for a fixed
 * grace period. Time-based expiry remains only as a backstop for PID reuse,
 * malformed locks, and an owner whose event loop is stuck.
 * @module dsh-agentic-pet/electron-lock
 */
export declare const INSTALL_LOCK_STALE_MS: number;
export declare const INSTALL_LOCK_MALFORMED_GRACE_MS = 60000;
export interface InstallLockRecord {
    pid?: unknown;
    at?: unknown;
}
/** True when `pid` names a live process (EPERM means it exists but is not ours). */
export declare function isProcessAlive(pid: number): boolean;
/** Parse a lock file; `undefined` means empty/malformed. */
export declare function parseInstallLock(raw: string): InstallLockRecord | undefined;
/**
 * Whether an existing lock may be taken over by a new installer.
 * A dead owner is stale immediately; a live owner keeps its lock until the
 * absolute cap (which also bounds PID-reuse false positives). A malformed
 * record gets a short grace for a concurrent writer, then goes stale.
 */
export declare function installLockStale(raw: string | undefined, mtimeMs: number, now: number, alive?: (pid: number) => boolean): boolean;
//# sourceMappingURL=electron-lock.d.ts.map