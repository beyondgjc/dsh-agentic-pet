/**
 * Persisted state of the Electron runtime bootstrap, shared by the installer
 * path (writer) and the settings page (reader). The settings page is the only
 * user-visible surface while the first install downloads ~158 MB, so this
 * file is deliberately plain JSON in the pet home rather than process state.
 * @module dsh-agentic-pet/electron-runtime-status
 */
export type ElectronRuntimeState = 'preparing' | 'downloading' | 'ready' | 'failed' | 'busy' | 'unavailable';
export interface ElectronRuntimeStatus {
    state: ElectronRuntimeState;
    updatedAt: number;
    startedAt?: number;
    finishedAt?: number;
    attempt?: number;
    source?: 'npmmirror' | 'github' | 'explicit';
    error?: string;
}
export declare function electronRuntimeStatusPath(home: string): string;
export declare function readElectronRuntimeStatus(home: string): ElectronRuntimeStatus | undefined;
export declare function writeElectronRuntimeStatus(home: string, status: ElectronRuntimeStatus): void;
