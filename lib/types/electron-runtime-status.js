/**
 * Persisted state of the Electron runtime bootstrap, shared by the installer
 * path (writer) and the settings page (reader). The settings page is the only
 * user-visible surface while the first install downloads ~158 MB, so this
 * file is deliberately plain JSON in the pet home rather than process state.
 * @module dsh-agentic-pet/electron-runtime-status
 */
import { mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
export function electronRuntimeStatusPath(home) {
    return join(home, 'whale598', 'electron-runtime.json');
}
export function readElectronRuntimeStatus(home) {
    try {
        const parsed = JSON.parse(readFileSync(electronRuntimeStatusPath(home), 'utf8'));
        if (typeof parsed !== 'object' || parsed === null)
            return undefined;
        const status = parsed;
        return typeof status.state === 'string' ? status : undefined;
    }
    catch {
        return undefined;
    }
}
export function writeElectronRuntimeStatus(home, status) {
    try {
        const path = electronRuntimeStatusPath(home);
        mkdirSync(dirname(path), { recursive: true });
        const tmp = `${path}.${String(process.pid)}.tmp`;
        writeFileSync(tmp, `${JSON.stringify(status)}\n`, 'utf8');
        renameSync(tmp, path);
    }
    catch {
        // Diagnostics only: a failed status write must never block an install.
    }
}
//# sourceMappingURL=electron-runtime-status.js.map