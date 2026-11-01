/**
 * The per-pet data store: everything the DRIVER persists about a pet lives
 * under `~/.dsh/whale598/<petId>/` — affection ledger, display name, event
 * history, tool-call history. One directory per pet, small files, single
 * writer (the driver), JSONL for append-only streams with bounded retention.
 *
 * Legacy layouts (`pet-affection.d/<id>.json`, the single legacy electron
 * book, names inside pet-settings.json) are READ as fallbacks and migrate to
 * the new layout on the next write — lazy migration, no data-loss window.
 * @module dsh-agentic-pet/petdata
 */
/** The consolidated per-pet data root under the dsh home. */
export declare const WHALE_DIR = "whale598";
export declare function petDataDir(home: string, petId: string): string;
/** New-layout path first; legacy layouts as read fallbacks (per-pet legacy
 * dir → the single legacy electron book). The ledger SHAPE is the driver's
 * (TouchLedger); this module only owns paths and raw IO. */
export declare function affectionPaths(home: string, petId: string): {
    current: string;
    legacy: string[];
};
/** Read the affection ledger raw: the current file wins; legacy files answer
 * only while the current one is absent (first write migrates the full
 * ledger). Returns null when no layout holds data. */
export declare function readAffectionRaw(home: string, petId: string): Promise<Record<string, unknown> | null>;
export declare function writeAffectionRaw(home: string, petId: string, ledger: Record<string, unknown>): Promise<void>;
export declare function petNameFile(home: string, petId: string): string;
/** The user's custom display name: new-layout file → legacy
 * pet-settings.json `names` map → undefined (caller applies the built-in
 * default). */
export declare function readPetName(home: string, petId: string): Promise<string | undefined>;
/** Persist a custom name; `null` reverts to the built-in default (drops the
 * override file). Also strips the petId key from the legacy pet-settings
 * names map so the old layout cannot resurrect a cleared name. */
export declare function writePetName(home: string, petId: string, name: string | null): Promise<void>;
export declare function eventsFile(home: string, petId: string): string;
export declare function toolCallsFile(home: string, petId: string): string;
/** Append one record; bounded retention trims the file when it outgrows the
 * cap (best-effort — a failed trim never loses the append). */
export declare function appendJsonl(file: string, entry: Record<string, unknown>): Promise<void>;
/** The last `limit` records (oldest last); malformed lines degrade to
 * `{raw}` instead of dropping the file. */
export declare function readJsonl(file: string, limit: number): Promise<Array<Record<string, unknown>>>;
//# sourceMappingURL=petdata.d.ts.map