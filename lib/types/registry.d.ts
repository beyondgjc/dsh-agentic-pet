/**
 * The pet registry: a directory of per-pet control manifests, replacing the
 * last-writer-wins single files whose races caused repeated swap incidents
 * (a dying carrier's late write burying a live pet's registration). Each pet
 * implementation owns its own file under whale598/pet-http.d/ (legacy
 * pet-http.d/ still scanned) and re-asserts it on a
 * cadence; entries whose publisher pid is dead expire by omission. The
 * driver reads the whole table and routes per the multi-pet design: the
 * session's bound pet if alive, else the default pet (first alive entry),
 * plus an all-notify broadcast mode for interactions.
 * @module dsh-agentic-pet/registry
 */
/** One pet's published control facts. */
export interface PetEntry {
    /** Stable pet id — also the registry file stem (e.g. 'electron', 'pure'). */
    readonly id: string;
    readonly port: number;
    readonly pid: number;
    /** When this exact publisher booted; a stale file from a previous
     * generation of the same pet is superseded by pid identity. */
    readonly since: number;
}
/**
 * A live pet is one whose control plane ANSWERS, not merely one whose pid
 * exists — and not merely one whose port accepts TCP: a frozen pet (stuck
 * Qt/Electron event loop) keeps its listening socket open in the kernel, so
 * TCP connect succeeds while HTTP never responds. Two layers, each with its
 * own budget: a 200ms TCP pre-check fails fast on unreachable ports (a
 * firewall dropping SYN would otherwise eat the whole HTTP budget), then the
 * HTTP probe catches the frozen-but-listening zombies.
 */
export declare function probeControlPlane(port: number): Promise<boolean>;
/** Read every live entry in the registry. Dead-pid entries are skipped —
 * they expire by omission the next time their file is rewritten — and so are
 * silent entries (pid alive, control plane unresponsive). */
export declare function readLivePets(home: string): Promise<PetEntry[]>;
/** Every live pet: registry entries plus legacy single-file manifests folded
 * under their pet ids (registry entries win on id collision). */
export declare function readAllPets(home: string): Promise<PetEntry[]>;
/**
 * Resolve the pet that should carry STATE for the given session, per the
 * multi-pet design: the session's bound pet when alive, else the default pet
 * (the first live entry — de facto "first started"). Single-pet deployments
 * degenerate correctly: one live entry is both bound and default.
 * @returns the entry, or undefined when no pet is alive.
 */
export declare function routePet(pets: PetEntry[], boundPetId: string | undefined): PetEntry | undefined;
/** The pets that receive an INTERACTION (all-notify mode): every live pet,
 * the session-bound one included. The binding routes STATE — it must never
 * mute interactions: excluding the bound pet would silence the only body
 * whose bubble the user just proved they answer through, and a single-pet
 * deployment would fall back to the web card alone for the rest of the
 * session. */
export declare function notifyPets(pets: PetEntry[]): PetEntry[];
//# sourceMappingURL=registry.d.ts.map