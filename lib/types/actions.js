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
    const catalogRaw = Array.isArray(record.actionCatalog) ? record.actionCatalog : [];
    const actionCatalog = [];
    for (const item of catalogRaw) {
        if (typeof item !== 'object' || item === null)
            continue;
        const entry = item;
        if (typeof entry.id !== 'string' || entry.id === '')
            continue;
        const tags = Array.isArray(entry.tags)
            ? entry.tags.filter((tag) => typeof tag === 'string' && tag !== '')
            : [];
        const energy = entry.energy === 'low' || entry.energy === 'mid' || entry.energy === 'high'
            ? entry.energy
            : undefined;
        const durationHintMs = typeof entry.durationHintMs === 'number' && Number.isFinite(entry.durationHintMs)
            ? entry.durationHintMs
            : undefined;
        const textInFrame = typeof entry.textInFrame === 'boolean' ? entry.textInFrame : undefined;
        actionCatalog.push({
            id: entry.id,
            tags,
            ...(energy === undefined ? {} : { energy }),
            ...(durationHintMs === undefined ? {} : { durationHintMs }),
            ...(textInFrame === undefined ? {} : { textInFrame }),
        });
    }
    const suppliedVocabulary = Array.isArray(record.actionTagVocabulary)
        ? record.actionTagVocabulary.filter((tag) => typeof tag === 'string' && tag !== '')
        : [];
    const actionTagVocabulary = suppliedVocabulary.length > 0
        ? [...new Set(suppliedVocabulary)]
        : [...new Set(actionCatalog.flatMap(entry => [...entry.tags]))];
    return {
        contractVersion,
        actions: actions.length > 0 ? actions : null,
        actionCatalog: actionCatalog.length > 0 ? actionCatalog : null,
        actionTagVocabulary,
        tagged: actionCatalog.some(entry => entry.tags.length > 0),
    };
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
/** Resolve a tag against the CURRENT body's own catalog. Multiple matches are
 * a random draw (celebrate is never a tag candidate). No cross-body tag
 * vocabulary is consulted. */
export function resolveTagRequest(tag, capabilities) {
    const catalog = capabilities?.actionCatalog ?? [];
    const matches = catalog.filter(entry => entry.tags.includes(tag));
    if (matches.length === 0) {
        return {
            kind: 'unknown',
            availableTags: capabilities?.actionTagVocabulary ?? [],
            availableActions: capabilities?.actions ?? ['celebrate'],
        };
    }
    const nonCelebrate = matches.filter(entry => entry.id !== 'celebrate');
    const pool = nonCelebrate.length > 0 ? nonCelebrate : matches;
    const pick = pool[Math.floor(Math.random() * pool.length)] ?? matches[0];
    return {
        kind: 'ok',
        action: pick?.id ?? 'celebrate',
        candidates: matches.map(entry => entry.id),
    };
}
/** Tag menu for errors: an empty vocabulary names the fallback explicitly. */
export function formatAvailableTags(tags, cap = 24) {
    if (tags.length === 0)
        return '（该身体未提供语义标签；请改用 action id 或 celebrate）';
    const shown = tags.slice(0, cap).join('、');
    const rest = tags.length - Math.min(cap, tags.length);
    return rest > 0
        ? `${shown} …(+${String(rest)} more — pet_state {actions:true} lists all)`
        : shown;
}
//# sourceMappingURL=actions.js.map