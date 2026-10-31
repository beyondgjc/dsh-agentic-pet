/**
 * The action-catalog contract between the pets and the driver: a pet
 * ADVERTISES what it can perform (`capabilities.actions` — its own menu,
 * derived from its own media), and the driver validates requests against
 * that menu instead of hardcoding one. Pure functions only — the seam where
 * catalog drift between pet implementations must die.
 * @module dsh-agentic-pet/actions
 */
/** Defensive extraction from a raw /capabilities payload: implementations
 * may omit or mistype anything. */
export function normalizeCapabilities(raw) {
    const record = typeof raw === 'object' && raw !== null ? raw : {};
    const actions = Array.isArray(record.actions)
        ? record.actions.filter((entry) => typeof entry === 'string')
        : [];
    const contractVersion = typeof record.contractVersion === 'number' ? record.contractVersion : null;
    return { contractVersion, actions: actions.length > 0 ? actions : null };
}
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
export function resolveActionRequest(requested, catalog) {
    if (requested === 'celebrate')
        return { kind: 'ok', action: 'celebrate' };
    if (requested === 'random') {
        const pool = catalog === null ? [] : catalog.filter(entry => entry !== 'celebrate');
        const menu = pool.length > 0 ? pool : ['celebrate'];
        const pick = menu[Math.floor(Math.random() * menu.length)];
        return pick === undefined ? { kind: 'ok', action: 'celebrate' } : { kind: 'ok', action: pick };
    }
    if (catalog !== null && catalog.includes(requested))
        return { kind: 'ok', action: requested };
    return { kind: 'unknown', available: catalog ?? ['celebrate'] };
}
/** The error-message menu: long catalogs are previewed, with a pointer to
 * pet_state {actions:true} for the full list. */
export function formatAvailableActions(available, cap = 24) {
    const shown = available.slice(0, cap).join('、');
    const rest = available.length - Math.min(cap, available.length);
    return rest > 0
        ? `${shown} …(+${String(rest)} more — pet_state {actions:true} lists all)`
        : shown;
}
//# sourceMappingURL=actions.js.map