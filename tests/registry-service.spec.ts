/**
 * Pure-function coverage for the pet capability seam: registry routing
 * (bootOrder/defaultPet/notifyPets) and the service's /status field-matrix
 * normalization (normalizeStatus). These are the seams where multi-pet
 * drift hides — every implementation difference must die inside
 * normalizeStatus and never reach a consumer.
 */

import { describe, expect, it } from 'vitest'
import { bootOrder, defaultPet, notifyPets, type PetEntry } from '../src/registry.ts'
import { normalizeStatus } from '../src/service.ts'

const entry = (id: string, port = 10000, since = 0): PetEntry => ({ id, port, pid: 1, since })

describe('registry defaultPet (unnamed expression targets)', () => {
  it('resolves the earliest-booted live pet (discovery delivers boot order)', () => {
    // The composed pipeline is the guarantee: readAllPets sorts via bootOrder,
    // so any pets[0] consumer sees the first STARTED pet.
    const pets = [entry('electron', 10000, 3_000), entry('pure', 10001, 1_000)]
    expect(defaultPet(bootOrder(pets))?.id).toBe('pure')
  })

  it('returns undefined when nothing is live', () => {
    expect(defaultPet([])).toBeUndefined()
  })
})

describe('registry bootOrder (the default-pet rule is a discovery guarantee)', () => {
  it('orders by since ascending — the default pet is the first STARTED, not the first file', () => {
    const pets = [entry('electron', 10000, 3_000), entry('pure', 10001, 1_000), entry('fish', 10002, 2_000)]
    expect(bootOrder(pets).map(pet => pet.id)).toEqual(['pure', 'fish', 'electron'])
  })

  it('an unknown since (0) never outranks a stated boot time', () => {
    const pets = [entry('electron', 10000, 0), entry('pure', 10001, 1_000)]
    expect(bootOrder(pets).map(pet => pet.id)).toEqual(['pure', 'electron'])
  })

  it('is stable for equal since values and does not mutate the input', () => {
    const pets = [entry('electron', 10000, 5_000), entry('pure', 10001, 5_000)]
    const snapshot = pets.map(pet => pet.id)
    expect(bootOrder(pets).map(pet => pet.id)).toEqual(snapshot)
    expect(pets.map(pet => pet.id)).toEqual(snapshot)
  })
})

describe('registry notifyPets (all-notify interactions)', () => {
  it('delivers to every live pet, the session-bound one included', () => {
    const pets = [entry('electron'), entry('pure')]
    expect(notifyPets(pets).map(pet => pet.id)).toEqual(['electron', 'pure'])
  })

  it('reaches the single pet in single-pet deployments (binding never mutes)', () => {
    const pets = [entry('electron')]
    expect(notifyPets(pets).map(pet => pet.id)).toEqual(['electron'])
  })
})

describe('service normalizeStatus (the /status field matrix)', () => {
  it('normalizes a v4 payload: location + three-state world + the single witness', () => {
    const snap = normalizeStatus('electron', {
      state: 'idle',
      animation: '待机呼吸休闲.webm',
      bubble: false,
      lastAction: {
        id: 'req-1', action: 'celebrate', requestedBy: 'tool',
        startedAt: 1000, durationMs: null, endedAt: null,
      },
      interaction: false,
      visible: true,
      location: { x: 100, y: 200, width: 460, height: 560 },
      world: { x: 0, y: 0, width: 1920, height: 1040 },
      pid: 1,
    }, true)
    expect(snap).toMatchObject({
      id: 'electron',
      online: true,
      state: 'idle',
      lastAction: {
        id: 'req-1', action: 'celebrate', requestedBy: 'tool',
        startedAt: 1000, durationMs: null, endedAt: null,
      },
      bubble: false,
      interaction: false,
      location: { x: 100, y: 200, width: 460, height: 560 },
      world: { x: 0, y: 0, width: 1920, height: 1040 },
      pid: 1,
    })
  })

  it('folds a legacy `window` into `location` (the v2 gray window)', () => {
    const snap = normalizeStatus('pure', {
      state: 'idle',
      window: { x: 120, y: 120, width: 900, height: 560 },
      pid: 2,
    }, true)
    expect(snap.location).toEqual({ x: 120, y: 120, width: 900, height: 560 })
  })

  it('keeps the world three states distinct: absent = unsupported, null = unset', () => {
    const unsupported = normalizeStatus('fish', { state: 'idle' }, true)
    expect(unsupported.world).toBeUndefined()
    const unset = normalizeStatus('electron', { state: 'idle', world: null }, true)
    expect(unset.world).toBeNull()
    const set = normalizeStatus('electron', { state: 'idle', world: { x: 0, y: 0, width: 100, height: 100 } }, true)
    expect(set.world).toEqual({ x: 0, y: 0, width: 100, height: 100 })
    // a mistyped world object degrades to "unset", never to a half-rect
    const mistyped = normalizeStatus('electron', { state: 'idle', world: { x: 'a', width: 3 } }, true)
    expect(mistyped.world).toBeNull()
  })

  it('maps the legacy lastAction triple onto the v3 single object', () => {
    const snap = normalizeStatus('electron', {
      lastAction: 'celebrate',
      lastActionAt: 1793118339000,
      lastActionDone: { action: 'celebrate.webm', durationMs: 10_042, at: 1793118339345, requestedBy: 'tool', requestId: 'req-9' },
    }, true)
    expect(snap.lastAction).toEqual({
      id: 'req-9',
      action: 'celebrate.webm',
      requestedBy: 'tool',
      startedAt: 1793118339000,
      durationMs: 10_042,
      endedAt: 1793118339345,
    })
    // no record anywhere normalizes to null (the constant-output rule)
    const empty = normalizeStatus('electron', {
      lastAction: null, lastActionAt: null, lastActionDone: null,
    }, true)
    expect(empty.lastAction).toBeNull()
    // a record without a requestId (pet-local action) still maps, id null
    const local = normalizeStatus('pure', {
      lastActionAt: 1793118339000,
      lastActionDone: { action: 'idle.webm', durationMs: null, at: 1793118339000 },
    }, true)
    expect(local.lastAction).toMatchObject({ id: null, requestedBy: null, durationMs: null })
  })

  it('reports an unreachable pet as offline without throwing', () => {
    const snap = normalizeStatus('pure', {}, false)
    // lastAction stays the constant null even on a bare payload
    expect(snap).toEqual({ id: 'pure', online: false, lastAction: null })
  })

  it('defends against mistyped fields (the wire is not trusted)', () => {
    const snap = normalizeStatus('pure', {
      state: 42,
      animation: true,
      visible: 'yes',
      interaction: 0,
      bubble: 'true',
      lastAction: 7,
      lastActionAt: 'now',
      lastActionDone: 'nope',
      location: { x: 'a', y: 1, width: 3, height: 4 },
      window: 'not-a-rect',
      pid: '1',
    }, true)
    expect(snap.state).toBeUndefined()
    expect(snap.animation).toBeUndefined()
    expect(snap.visible).toBeUndefined()
    expect(snap.interaction).toBeUndefined()
    expect(snap.bubble).toBeUndefined()
    // a non-object lastAction is not a record: null (no record), not undefined
    expect(snap.lastAction).toBeNull()
    expect(snap.location).toBeUndefined()
    expect(snap.pid).toBeUndefined()
  })
})
