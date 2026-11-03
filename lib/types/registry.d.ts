/**
 * The pet registry: a directory of per-pet control manifests. Each pet
 * implementation owns its own file under whale598/pet-http.d/ (named by its
 * pet id) and re-asserts it on a cadence; entries whose publisher pid is dead
 * expire by omission. The driver reads the whole table and routes per the
 * multi-pet design: a session's state rides its bound pet when that pet is
 * alive and broadcasts to every live pet otherwise; interactions broadcast to
 * all; the default pet (earliest-booted) resolves unnamed expression targets.
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
/**
 * The default-pet order: earliest booted first (`since` ascending). A missing
 * or mistyped `since` (0) reads as "unknown boot time" and sorts LAST — it
 * must never outrank a publisher that stated its boot time. This turns the
 * multi-pet design's de-facto rule ("the default pet is the first STARTED")
 * into an actual guarantee: discovery output IS boot order, so every
 * `pets[0]` consumer (defaultPet, pet_state's defaultPet) reads the
 * same pet. Stable sort: equal `since` values keep registry listing order.
 */
export declare function bootOrder(pets: PetEntry[]): PetEntry[];
/** Every live pet in boot order. Dead-pid entries are skipped — they expire
 * by omission the next time their file is rewritten — and so are silent
 * entries (pid alive, control plane unresponsive). */
export declare function readAllPets(home: string): Promise<PetEntry[]>;
/**
 * The default pet for UNNAMED targets: the earliest-booted live entry
 * (`pets[0]` — discovery's bootOrder guarantees start order, not listing
 * accident). State routing does NOT go through here anymore: an unbound
 * (or bound-but-offline) session broadcasts its state to every live pet —
 * the driver computes that audience itself. Used by the tools'
 * resolveTarget when neither a named pet nor the owning session resolves.
 * @returns the entry, or undefined when no pet is alive.
 */
export declare function defaultPet(pets: PetEntry[]): PetEntry | undefined;
/** The pets that receive an INTERACTION (all-notify mode): every live pet,
 * the session-bound one included. The binding routes STATE — it must never
 * mute interactions: excluding the bound pet would silence the only body
 * whose bubble the user just proved they answer through, and a single-pet
 * deployment would fall back to the web card alone for the rest of the
 * session. */
export declare function notifyPets(pets: PetEntry[]): PetEntry[];
