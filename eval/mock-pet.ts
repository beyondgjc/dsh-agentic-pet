/**
 * The eval's mock pet: the PetService capability seam backed by in-memory
 * state. Capabilities/body default to the REAL asset payload
 * (dsh-agentic-pet-assets characters/whale) pushed through the same
 * normalize* functions the real seam uses — so pet_do/pet_express scenarios
 * are grounded in the actual catalog the production body advertises.
 * @module dsh-agentic-pet/eval/mock-pet
 */

import { readFile } from 'node:fs/promises'
import { join } from 'node:path'
import { normalizeCapabilities, type ActionCatalogEntry, type PetCapabilities } from '../src/actions.ts'
import { normalizeBody, type BodyDescription } from '../src/body.ts'
import type { PetEntry } from '../src/registry.ts'
import type { PetSnapshot } from '../src/service.ts'
import type { MockPetSpec } from './schema.ts'

const entry = (id: string, port = 10000, since = 0): PetEntry => ({ id, port, pid: 1, since })

/** actions.tags.json v2 → the raw /capabilities payload the carrier serves.
 * The eval only needs the shape normalizeCapabilities understands. */
async function loadWhaleCapabilities(): Promise<PetCapabilities> {
  const path = join('node_modules', 'dsh-agentic-pet-assets', 'assets', 'characters', 'whale', 'actions.tags.json')
  const raw = JSON.parse(await readFile(path, 'utf8')) as Record<string, unknown>
  const catalog: ActionCatalogEntry[] = []
  const tags = new Set<string>()
  for (const [id, item] of Object.entries(raw)) {
    if (id.startsWith('_') || typeof item !== 'object' || item === null) continue
    const record = item as { tags?: unknown; energy?: unknown; loop?: unknown }
    const itemTags = Array.isArray(record.tags) ? record.tags.filter(tag => typeof tag === 'string' && tag !== '') : []
    for (const tag of itemTags) tags.add(tag)
    catalog.push({
      id,
      tags: itemTags,
      ...(record.energy === 'low' || record.energy === 'mid' || record.energy === 'high' ? { energy: record.energy } : {}),
      ...(record.loop === true ? { loop: true } : {}),
    })
  }
  return normalizeCapabilities({
    contractVersion: 3,
    actions: catalog.map(item => item.id),
    actionCatalog: catalog,
    actionTagVocabulary: [...tags],
    tagged: true,
  })
}

async function loadWhaleBody(): Promise<BodyDescription> {
  const path = join('node_modules', 'dsh-agentic-pet-assets', 'assets', 'characters', 'whale', 'body.json')
  const normalized = normalizeBody(JSON.parse(await readFile(path, 'utf8')))
  if (normalized.kind !== 'body') throw new Error(`whale body.json failed normalization: ${normalized.reason}`)
  return normalized.body
}

/** Everything the mock records, exposed for grader/setup assertions. */
export interface MockPetState {
  readonly says: Array<{ pet: string; text: string; mood?: string; letter?: boolean; letterAt?: number }>
  readonly actions: Array<{ pet: string; action: string; mood?: string; requestId: string }>
  readonly expressions: Array<{ pet: string; expression: string }>
}

export interface MockPet {
  state: MockPetState
  /** Fire a fresh /events window (used by digest scenarios' seed). */
  readonly service: {
    list(): Promise<PetEntry[]>
    snapshot(entry: PetEntry): Promise<PetSnapshot>
    call(entry: PetEntry, path: string, init?: RequestInit): Promise<unknown>
    capabilities(entry: PetEntry): Promise<PetCapabilities | null>
    body(entry: PetEntry): Promise<BodyDescription | null>
  }
}

export async function createMockPet(specs: MockPetSpec[]): Promise<MockPet> {
  const whaleCaps = await loadWhaleCapabilities()
  const whaleBody = await loadWhaleBody()
  const pets = specs.map(spec => ({
    id: spec.id,
    online: spec.online !== false,
    caps: spec.capabilities === undefined || spec.capabilities === 'whale' ? whaleCaps : spec.capabilities,
    body: spec.body === undefined || spec.body === 'whale' ? whaleBody : spec.body,
    events: spec.events ?? [],
  }))
  const state: MockPetState = { says: [], actions: [], expressions: [] }
  let requestCounter = 0
  const lastActionByPet = new Map<string, PetSnapshot['lastAction']>()
  const call = async (target: PetEntry, path: string, init?: RequestInit): Promise<unknown> => {
    const pet = pets.find(candidate => candidate.id === target.id)
    if (pet === undefined) throw new Error(`mock: unknown pet "${target.id}"`)
    if (!pet.online) throw new Error('fetch failed ECONNREFUSED')
    const bodyRaw = typeof init?.body === 'string' ? (JSON.parse(init.body) as Record<string, unknown>) : {}
    if (path === '/say') {
      state.says.push({
        pet: target.id,
        text: typeof bodyRaw.text === 'string' ? bodyRaw.text : '',
        ...(typeof bodyRaw.mood === 'string' ? { mood: bodyRaw.mood } : {}),
        ...(bodyRaw.letter === true ? { letter: true } : {}),
        ...(typeof bodyRaw.letterAt === 'number' ? { letterAt: bodyRaw.letterAt } : {}),
      })
      return { ok: true }
    }
    if (path === '/action') {
      const requestId = `req-${String(++requestCounter)}`
      const action = typeof bodyRaw.action === 'string' ? bodyRaw.action : 'unknown'
      const startedAt = Date.now()
      // Complete instantly: wait:true resolves on the first 250ms poll.
      lastActionByPet.set(target.id, {
        id: requestId,
        action,
        requestedBy: 'tool',
        startedAt,
        durationMs: 3_000,
        endedAt: startedAt + 3_000,
      })
      state.actions.push({
        pet: target.id,
        action,
        ...(typeof bodyRaw.mood === 'string' ? { mood: bodyRaw.mood } : {}),
        requestId,
      })
      return { ok: true, requestId }
    }
    if (path === '/expression') {
      state.expressions.push({ pet: target.id, expression: typeof bodyRaw.expression === 'string' ? bodyRaw.expression : '' })
      return { ok: true }
    }
    if (path.startsWith('/events')) {
      const sinceMatch = /[?&]since=(\d+)/.exec(path)
      const since = sinceMatch !== null ? Number(sinceMatch[1]) : 0
      const visible = pet.events.filter(event => event.seq > since)
      const latest = pet.events.reduce((max, event) => Math.max(max, event.seq), 0)
      return { events: visible, latest: Math.max(latest, since) }
    }
    return { ok: true }
  }
  const service = {
    async list() {
      return pets.filter(pet => pet.online).map(pet => entry(pet.id))
    },
    async snapshot(target: PetEntry): Promise<PetSnapshot> {
      const pet = pets.find(candidate => candidate.id === target.id)
      if (pet === undefined || !pet.online) return { id: target.id, online: false }
      return {
        id: target.id,
        online: true,
        state: 'idle',
        lastAction: lastActionByPet.get(target.id) ?? null,
      }
    },
    call,
    async capabilities(target: PetEntry): Promise<PetCapabilities | null> {
      const pet = pets.find(candidate => candidate.id === target.id)
      return pet !== undefined && pet.online ? pet.caps : null
    },
    async body(target: PetEntry): Promise<BodyDescription | null> {
      const pet = pets.find(candidate => candidate.id === target.id)
      return pet !== undefined && pet.online ? pet.body : null
    },
  }
  return { state, service }
}

/** The REAL whale catalog, exposed so scenario authors write expectations
 * against ids that exist (never against invented ones). */
export async function whaleCatalog(): Promise<{
  actions: readonly string[]
  tags: readonly string[]
  loops: readonly string[]
  catalog: readonly ActionCatalogEntry[]
}> {
  const caps = await loadWhaleCapabilities()
  const loops = (caps.actionCatalog ?? []).filter(item => item.loop === true).map(item => item.id)
  return { actions: caps.actions ?? [], tags: caps.actionTagVocabulary, loops, catalog: caps.actionCatalog ?? [] }
}
