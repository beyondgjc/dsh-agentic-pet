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
  readonly id: string
  readonly tags: readonly string[]
  readonly energy?: 'low' | 'mid' | 'high'
  readonly durationHintMs?: number
  readonly textInFrame?: boolean
  /** State animation that loops; wait cannot observe a meaningful end. */
  readonly loop?: boolean
}

/** A pet's advertised capabilities. `contractVersion: null` = a legacy
 * implementation that predates the version field (v1 semantics: seven
 * endpoints, no /world). `actions: null` = the pet publishes no catalog (a
 * legacy implementation): only the universal `celebrate` alias is then
 * available. An advertised-but-empty array is folded into null. */
export interface PetCapabilities {
  readonly contractVersion: number | null
  readonly actions: readonly string[] | null
  readonly actionCatalog: readonly ActionCatalogEntry[] | null
  /** The body's own tag vocabulary, derived from its catalog when omitted. */
  readonly actionTagVocabulary: readonly string[]
  readonly tagged: boolean
}

/** Defensive extraction from a raw /capabilities payload: implementations
 * may omit or mistype anything. */
export function normalizeCapabilities(raw: unknown): PetCapabilities {
  const record = typeof raw === 'object' && raw !== null ? raw as Record<string, unknown> : {}
  const actions = Array.isArray(record.actions)
    ? record.actions.filter((entry): entry is string => typeof entry === 'string')
    : []
  const contractVersion = typeof record.contractVersion === 'number' ? record.contractVersion : null
  const catalogRaw = Array.isArray(record.actionCatalog) ? record.actionCatalog : []
  const actionCatalog: ActionCatalogEntry[] = []
  for (const item of catalogRaw) {
    if (typeof item !== 'object' || item === null) continue
    const entry = item as Record<string, unknown>
    if (typeof entry.id !== 'string' || entry.id === '') continue
    const tags = Array.isArray(entry.tags)
      ? entry.tags.filter((tag): tag is string => typeof tag === 'string' && tag !== '')
      : []
    const energy = entry.energy === 'low' || entry.energy === 'mid' || entry.energy === 'high'
      ? entry.energy
      : undefined
    const durationHintMs = typeof entry.durationHintMs === 'number' && Number.isFinite(entry.durationHintMs)
      ? entry.durationHintMs
      : undefined
    const textInFrame = typeof entry.textInFrame === 'boolean' ? entry.textInFrame : undefined
    const loop = entry.loop === true ? true : undefined
    actionCatalog.push({
      id: entry.id,
      tags,
      ...(energy === undefined ? {} : { energy }),
      ...(durationHintMs === undefined ? {} : { durationHintMs }),
      ...(textInFrame === undefined ? {} : { textInFrame }),
      ...(loop === undefined ? {} : { loop }),
    })
  }
  const suppliedVocabulary = Array.isArray(record.actionTagVocabulary)
    ? record.actionTagVocabulary.filter((tag): tag is string => typeof tag === 'string' && tag !== '')
    : []
  const actionTagVocabulary = suppliedVocabulary.length > 0
    ? [...new Set(suppliedVocabulary)]
    : [...new Set(actionCatalog.flatMap(entry => [...entry.tags]))]
  return {
    contractVersion,
    actions: actions.length > 0 ? actions : null,
    actionCatalog: actionCatalog.length > 0 ? actionCatalog : null,
    actionTagVocabulary,
    tagged: actionCatalog.some(entry => entry.tags.length > 0),
  }
}

export type ActionResolution =
  | { kind: 'ok'; action: string }
  | { kind: 'unknown'; available: readonly string[] }

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
export function resolveActionRequest(requested: string, catalog: readonly string[] | null): ActionResolution {
  if (requested === 'celebrate') return { kind: 'ok', action: 'celebrate' }
  if (requested === 'random') {
    const pool = catalog === null ? [] : catalog.filter(entry => entry !== 'celebrate')
    const menu = pool.length > 0 ? pool : ['celebrate']
    const pick = menu[Math.floor(Math.random() * menu.length)]
    return pick === undefined ? { kind: 'ok', action: 'celebrate' } : { kind: 'ok', action: pick }
  }
  if (catalog !== null && catalog.includes(requested)) return { kind: 'ok', action: requested }
  return { kind: 'unknown', available: catalog ?? ['celebrate'] }
}

/** The error-message menu: long catalogs are previewed, with a pointer to
 * pet_state {actions:true} for the full list. */
export function formatAvailableActions(available: readonly string[], cap = 24): string {
  const shown = available.slice(0, cap).join('、')
  const rest = available.length - Math.min(cap, available.length)
  return rest > 0
    ? `${shown} …(+${String(rest)} more — pet_state {actions:true} lists all)`
    : shown
}

export type TagResolution =
  | { kind: 'ok'; action: string; candidates: readonly string[] }
  | { kind: 'unknown'; availableTags: readonly string[]; availableActions: readonly string[] }

/** Resolve a tag against the CURRENT body's own catalog. Multiple matches are
 * a random draw (celebrate is never a tag candidate). No cross-body tag
 * vocabulary is consulted. */
export function resolveTagRequest(tag: string, capabilities: PetCapabilities | null): TagResolution {
  const catalog = capabilities?.actionCatalog ?? []
  const matches = catalog.filter(entry => entry.tags.includes(tag))
  if (matches.length === 0) {
    return {
      kind: 'unknown',
      availableTags: capabilities?.actionTagVocabulary ?? [],
      availableActions: capabilities?.actions ?? ['celebrate'],
    }
  }
  const nonCelebrate = matches.filter(entry => entry.id !== 'celebrate')
  const pool = nonCelebrate.length > 0 ? nonCelebrate : matches
  const pick = pool[Math.floor(Math.random() * pool.length)] ?? matches[0]
  return {
    kind: 'ok',
    action: pick?.id ?? 'celebrate',
    candidates: matches.map(entry => entry.id),
  }
}

/** Tag menu for errors: an empty vocabulary names the fallback explicitly. */
export function formatAvailableTags(tags: readonly string[], cap = 24): string {
  if (tags.length === 0) return '（该身体未提供语义标签；请改用 action id 或 celebrate）'
  const shown = tags.slice(0, cap).join('、')
  const rest = tags.length - Math.min(cap, tags.length)
  return rest > 0
    ? `${shown} …(+${String(rest)} more — pet_state {actions:true} lists all)`
    : shown
}
