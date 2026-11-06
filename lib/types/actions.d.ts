/**
 * The action-catalog contract between the pets and the driver: a pet
 * ADVERTISES what it can perform (`capabilities.actions` — its own menu,
 * derived from its own media), and the driver validates requests against
 * that menu instead of hardcoding one. Pure functions only — the seam where
 * catalog drift between pet implementations must die.
 * @module dsh-agentic-pet/actions
 */
/** One body-owned catalog entry. `tags` are THIS body's vocabulary — the
 * driver never defines a cross-body enum. */
export interface ActionCatalogEntry {
    readonly id: string;
    readonly tags: readonly string[];
    readonly energy?: 'low' | 'mid' | 'high';
    readonly durationHintMs?: number;
    readonly textInFrame?: boolean;
    /** State animation that loops; wait cannot observe a meaningful end. */
    readonly loop?: boolean;
}
/** A pet's advertised capabilities. `contractVersion: null` = a legacy
 * implementation that predates the version field (v1 semantics: seven
 * endpoints, no /world). `actions: null` = the pet publishes no catalog (a
 * legacy implementation): only the universal `celebrate` alias is then
 * available. An advertised-but-empty array is folded into null. */
export interface PetCapabilities {
    readonly contractVersion: number | null;
    readonly actions: readonly string[] | null;
    readonly actionCatalog: readonly ActionCatalogEntry[] | null;
    /** The body's own tag vocabulary, derived from its catalog when omitted. */
    readonly actionTagVocabulary: readonly string[];
    readonly tagged: boolean;
}
/** Defensive extraction from a raw /capabilities payload: implementations
 * may omit or mistype anything. */
export declare function normalizeCapabilities(raw: unknown): PetCapabilities;
export type ActionResolution = {
    kind: 'ok';
    action: string;
} | {
    kind: 'unknown';
    available: readonly string[];
};
/**
 * Resolve a pet_do request against a pet's advertised catalog.
 * - `celebrate` is the universal alias every pet must honor regardless of
 *   its catalog (driver.ts's ledger milestones depend on it).
 * - `random` means "you pick": one draw from the pet's own menu (the
 *   draw lives here, driver-side, so pets that validate /action against
 *   their vocabulary — pure does — never see a sentinel they must reject).
 * - Anything else must be IN the catalog; `null` catalog admits only
 *   celebrate.
 */
export declare function resolveActionRequest(requested: string, catalog: readonly string[] | null): ActionResolution;
/** The error-message menu: long catalogs are previewed, with a pointer to
 * pet_state {actions:true} for the full list. */
export declare function formatAvailableActions(available: readonly string[], cap?: number): string;
export type TagResolution = {
    kind: 'ok';
    action: string;
    candidates: readonly string[];
} | {
    kind: 'unknown';
    availableTags: readonly string[];
    availableActions: readonly string[];
};
/** Resolve a tag against the CURRENT body's own catalog. Multiple matches are
 * a random draw (celebrate is never a tag candidate). No cross-body tag
 * vocabulary is consulted. */
export declare function resolveTagRequest(tag: string, capabilities: PetCapabilities | null): TagResolution;
/** Tag menu for errors: an empty vocabulary names the fallback explicitly. */
export declare function formatAvailableTags(tags: readonly string[], cap?: number): string;
//# sourceMappingURL=actions.d.ts.map