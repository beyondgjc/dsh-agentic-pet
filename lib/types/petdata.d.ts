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
/** Append one record; bounded retention trims the file when it outgrows the
 * cap (best-effort — a failed trim never loses the append). */
export declare function appendJsonl(file: string, entry: Record<string, unknown>): Promise<void>;
/** The last `limit` records (oldest last); malformed lines degrade to
 * `{raw}` instead of dropping the file. */
export declare function readJsonl(file: string, limit: number): Promise<Array<Record<string, unknown>>>;
export declare const GLOBAL_STATE_FILES: string[];
export declare function globalPaths(home: string, name: string): {
    current: string;
    legacy: string;
};
export declare function globalFilePath(home: string, name: string): string;
/** Rename legacy → current for every global file that hasn't moved yet.
 * Best-effort: a failed rename leaves the legacy copy in place and the read
 * fallback still answers. Called once at driver install. */
export declare function migrateGlobals(home: string): Promise<void>;
/** Read a global state file: current → legacy → {} (callers' defensive
 * field checks treat {} exactly like a missing file). */
export declare function readGlobalJson(home: string, name: string): Promise<Record<string, unknown>>;
/** Write a global state file (current location only; pretty-printed — these
 * files are user-inspectable and hand-editable). */
export declare function writeGlobalJson(home: string, name: string, obj: Record<string, unknown>): Promise<void>;
export declare function petStatePaths(home: string, petId: string, name: string): {
    current: string;
    legacy: string[];
};
/** Read a per-pet state file: pet file → whale598 root → ~/.dsh root → {}
 * (callers' defensive field checks treat {} exactly like a missing file). */
export declare function readPetStateJson(home: string, petId: string, name: string): Promise<Record<string, unknown>>;
/** Write a per-pet state file (pretty-printed, same user-inspectable
 * contract as the globals). */
export declare function writePetStateJson(home: string, petId: string, name: string, obj: Record<string, unknown>): Promise<void>;
/** PetIds with a data directory on disk — the sweep basis for per-pet
 * migrations and merged loads. Registry-only pets (live, never persisted)
 * are absent; callers union their own id sources on top. */
export declare function existingPetIds(home: string): Promise<string[]>;
/** Read a root-level global that is a bare JSON array: whale598 root →
 * ~/.dsh root → [] (the interaction ledger's shape — readGlobalJson's object
 * check happens to admit arrays, but the array contract deserves its own
 * helper). */
export declare function readGlobalArrayJson(home: string, name: string): Promise<unknown[]>;
/** One-time split of a petId-keyed root file into per-pet state files: each
 * pet's slice is written (an existing pet file always wins — the split never
 * overwrites), then the root copy is renamed to `<name>.bak-migrated-<date>`
 * so the root stays clean without losing the original. Best-effort
 * throughout; `extract` returns undefined for petIds with no slice. */
export declare function migrateGlobalSplits(home: string, name: string, extract: (global: Record<string, unknown>, petId: string) => Record<string, unknown> | undefined): Promise<void>;
//# sourceMappingURL=petdata.d.ts.map