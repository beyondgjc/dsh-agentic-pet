/**
 * Pure-function coverage for the pet capability seam: registry routing
 * (routePet/notifyPets) and the service's /status field-matrix
 * normalization (normalizeStatus). These are the seams where multi-pet
 * drift hides — every implementation difference must die inside
 * normalizeStatus and never reach a consumer.
 */

import { describe, expect, it } from 'vitest'
import { notifyPets, routePet, type PetEntry } from '../src/registry.ts'
import { normalizeStatus } from '../src/service.ts'

const entry = (id: string, port = 10000, since = 0): PetEntry => ({ id, port, pid: 1, since })

describe('registry routePet', () => {
  it('prefers the bound pet when it is in the live list', () => {
    const pets = [entry('electron'), entry('pure')]
    expect(routePet(pets, 'pure')?.id).toBe('pure')
  })

  it('falls back to the default pet (first live entry) when the bound id is absent', () => {
    const pets = [entry('electron'), entry('pure')]
    expect(routePet(pets, 'missing')?.id).toBe('electron')
    expect(routePet(pets, undefined)?.id).toBe('electron')
  })

  it('returns undefined when nothing is live', () => {
    expect(routePet([], undefined)).toBeUndefined()
    expect(routePet([], 'electron')).toBeUndefined()
  })

  it('keeps registry order as the default-pet rule (first live entry)', () => {
    const pets = [entry('pure'), entry('electron')]
    expect(routePet(pets, undefined)?.id).toBe('pure')
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
  it('normalizes an electron-shaped payload, preserving constant-null fields', () => {
    const snap = normalizeStatus('electron', {
      state: 'idle',
      animation: '待机呼吸休闲.webm',
      bubble: false,
      lastAction: null,
      lastActionAt: null,
      lastActionDone: null,
      interaction: false,
      visible: true,
      window: { x: 100, y: 200, width: 460, height: 560 },
      pid: 1,
    }, true)
    expect(snap).toMatchObject({
      id: 'electron',
      online: true,
      state: 'idle',
      // null must survive: a conditionally-absent field is a serialization
      // footgun — consumers test `=== null` for "no action yet".
      lastAction: null,
      lastActionAt: null,
      lastActionDone: null,
      bubble: false,
      interaction: false,
      pid: 1,
    })
  })

  it('normalizes a pure-shaped payload without electron-only fields', () => {
    const snap = normalizeStatus('pure', {
      state: 'idle',
      animation: '待机呼吸休闲.webm',
      interaction: false,
      visible: true,
      window: { x: 120, y: 120, width: 900, height: 560 },
      pid: 2,
    }, true)
    expect(snap.online).toBe(true)
    expect(snap.state).toBe('idle')
    expect(snap.interaction).toBe(false)
    // electron-only extras are absent, never fabricated:
    expect(snap.bubble).toBeUndefined()
    expect(snap.lastAction).toBeUndefined()
    expect(snap.lastActionDone).toBeUndefined()
  })

  it('reports an unreachable pet as offline without throwing', () => {
    const snap = normalizeStatus('pure', {}, false)
    expect(snap).toEqual({ id: 'pure', online: false })
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
      window: { x: 'a', y: 1, width: 3, height: 4 },
      pid: '1',
    }, true)
    expect(snap.state).toBeUndefined()
    expect(snap.animation).toBeUndefined()
    expect(snap.visible).toBeUndefined()
    expect(snap.interaction).toBeUndefined()
    expect(snap.bubble).toBeUndefined()
    expect(snap.lastAction).toBeUndefined()
    expect(snap.lastActionAt).toBeUndefined()
    expect(snap.lastActionDone).toBeUndefined()
    expect(snap.window).toBeUndefined()
    expect(snap.pid).toBeUndefined()
  })

  it('keeps a well-formed lastActionDone completion record', () => {
    const snap = normalizeStatus('electron', {
      lastActionDone: { action: 'celebrate.webm', durationMs: 10_042, at: 1793118339345 },
    }, true)
    expect(snap.lastActionDone).toEqual({ action: 'celebrate.webm', durationMs: 10_042, at: 1793118339345 })
  })
})
