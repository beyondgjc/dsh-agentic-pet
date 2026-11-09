/**
 * whale598 layout rules (AGENTS.md §8「whale598 文件归属规则」), enforced as
 * tests: the petId-keyed root files split into per-pet state files (slices
 * written, root copies renamed to .bak-migrated-<date>), the read chain
 * answers pet file → whale598 root → ~/.dsh root, and — the guard that keeps
 * the root from re-degrading — no petId-keyed state file may remain at the
 * whale598 root once the splits have run.
 */

import { mkdir, mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterAll, describe, expect, it } from 'vitest'
import {
  existingPetIds,
  migrateGlobalSplits,
  petStatePaths,
  readGlobalArrayJson,
  readPetStateJson,
} from '../src/petdata.ts'

const homes: string[] = []
const tempHome = async (): Promise<string> => {
  const dir = await mkdtemp(join(tmpdir(), 'petdata-layout-'))
  homes.push(dir)
  return dir
}
afterAll(async () => {
  for (const dir of homes) await rm(dir, { force: true, recursive: true })
})

describe('whale598 layout rules', () => {
  it('splits a petId-keyed root file into per-pet slices and renames the root copy', async () => {
    const home = await tempHome()
    await mkdir(join(home, 'whale598'), { recursive: true })
    await writeFile(join(home, 'whale598', 'pet-wake-state.json'), JSON.stringify({
      lastUserActivityAt: 111,
      pets: {
        electron: { counts: { wakeCount: 5 }, baseline: { wakeCount: 1 }, baselineAt: 9 },
        pure: { counts: { wakeCount: 2 }, baseline: { wakeCount: 0 }, baselineAt: 8 },
      },
    }), 'utf8')
    await migrateGlobalSplits(home, 'pet-wake-state.json', (global, petId) => {
      const state = (global.pets as Record<string, unknown> | undefined)?.[petId]
      if (state === undefined || typeof state !== 'object') return undefined
      return { lastUserActivityAt: global.lastUserActivityAt ?? null, ...(state as Record<string, unknown>) }
    })
    expect(await readPetStateJson(home, 'electron', 'pet-wake-state.json'))
      .toEqual({ lastUserActivityAt: 111, counts: { wakeCount: 5 }, baseline: { wakeCount: 1 }, baselineAt: 9 })
    expect(await readPetStateJson(home, 'pure', 'pet-wake-state.json'))
      .toEqual({ lastUserActivityAt: 111, counts: { wakeCount: 2 }, baseline: { wakeCount: 0 }, baselineAt: 8 })
    // The root copy is renamed out of the way, not deleted.
    const rootEntries = await readdir(join(home, 'whale598'))
    expect(rootEntries.some(name => name.startsWith('pet-wake-state.json.bak-migrated-'))).toBe(true)
  })

  it('never overwrites an existing pet file during the split', async () => {
    const home = await tempHome()
    await mkdir(join(home, 'whale598', 'electron'), { recursive: true })
    await writeFile(join(home, 'whale598', 'pet-inner-voice.json'), JSON.stringify({
      sessions: { electron: { sessionId: 'stale' } }, generations: { electron: 1 },
    }), 'utf8')
    await writeFile(join(home, 'whale598', 'electron', 'pet-inner-voice.json'), JSON.stringify({
      sessions: { electron: { sessionId: 'fresh' } }, generations: { electron: 7 },
    }), 'utf8')
    await migrateGlobalSplits(home, 'pet-inner-voice.json', (global, petId) => {
      const sessions = (global.sessions as Record<string, unknown> | undefined)?.[petId]
      const generations = (global.generations as Record<string, number> | undefined)?.[petId]
      if (sessions === undefined && generations === undefined) return undefined
      return {
        ...(sessions === undefined ? {} : { sessions: { [petId]: sessions } }),
        ...(generations === undefined ? {} : { generations: { [petId]: generations } }),
      }
    })
    expect(await readPetStateJson(home, 'electron', 'pet-inner-voice.json'))
      .toEqual({ sessions: { electron: { sessionId: 'fresh' } }, generations: { electron: 7 } })
  })

  it('reads through the three-layer chain: pet file → whale598 root → ~/.dsh root', async () => {
    const home = await tempHome()
    await mkdir(join(home, 'whale598'), { recursive: true })
    expect(await readPetStateJson(home, 'electron', 'pet-window.json')).toEqual({})
    await writeFile(join(home, 'pet-window.json'), JSON.stringify({ x: 3, y: 4 }), 'utf8')
    expect(await readPetStateJson(home, 'electron', 'pet-window.json')).toEqual({ x: 3, y: 4 })
    await writeFile(join(home, 'whale598', 'pet-window.json'), JSON.stringify({ x: 5, y: 6 }), 'utf8')
    expect(await readPetStateJson(home, 'electron', 'pet-window.json')).toEqual({ x: 5, y: 6 })
    await mkdir(join(home, 'whale598', 'electron'), { recursive: true })
    await writeFile(petStatePaths(home, 'electron', 'pet-window.json').current, JSON.stringify({ x: 7, y: 8 }), 'utf8')
    expect(await readPetStateJson(home, 'electron', 'pet-window.json')).toEqual({ x: 7, y: 8 })
  })

  it('reads a root-level array ledger through both layers', async () => {
    const home = await tempHome()
    expect(await readGlobalArrayJson(home, 'pet-interactions.json')).toEqual([])
    await writeFile(join(home, 'pet-interactions.json'), JSON.stringify([{ id: 'legacy' }]), 'utf8')
    expect(await readGlobalArrayJson(home, 'pet-interactions.json')).toEqual([{ id: 'legacy' }])
    await mkdir(join(home, 'whale598'), { recursive: true })
    await writeFile(join(home, 'whale598', 'pet-interactions.json'), JSON.stringify([{ id: 'current' }]), 'utf8')
    expect(await readGlobalArrayJson(home, 'pet-interactions.json')).toEqual([{ id: 'current' }])
  })

  it('layout guard: after the splits no petId-keyed state file remains at the whale598 root', async () => {
    const home = await tempHome()
    await mkdir(join(home, 'whale598', 'electron'), { recursive: true })
    const SPLIT_FILES = ['pet-inner-voice.json', 'pet-wake-plans.json', 'pet-wake-state.json', 'pet-binding-status.json', 'pet-window.json']
    const keyedExtract = (field: string) => (global: Record<string, unknown>, petId: string): Record<string, unknown> | undefined => {
      const slice = (global[field] as Record<string, unknown> | undefined)?.[petId]
      return slice === undefined ? undefined : { [field]: slice }
    }
    // Fixture shapes match each file's real extractor field, exactly like
    // the driver's migrate calls (sessions/plans/pets/pets/single object).
    const FIXTURES: Record<string, Record<string, unknown>> = {
      'pet-inner-voice.json': { sessions: { electron: { sessionId: 's' } }, generations: { electron: 1 } },
      'pet-wake-plans.json': { plans: { electron: [{ id: 'p', at: 1, intent: 'i', createdAt: 1 }] } },
      'pet-wake-state.json': { lastUserActivityAt: 1, pets: { electron: { counts: {}, baseline: {}, baselineAt: 1 } } },
      'pet-binding-status.json': { updatedAt: 1, pets: { electron: { armed: false } }, failures: [] },
      'pet-window.json': { x: 1, y: 2 },
    }
    for (const name of SPLIT_FILES) {
      await writeFile(join(home, 'whale598', name), JSON.stringify(FIXTURES[name]), 'utf8')
    }
    await migrateGlobalSplits(home, 'pet-inner-voice.json', keyedExtract('sessions'))
    await migrateGlobalSplits(home, 'pet-wake-plans.json', keyedExtract('plans'))
    await migrateGlobalSplits(home, 'pet-wake-state.json', keyedExtract('pets'))
    await migrateGlobalSplits(home, 'pet-binding-status.json', keyedExtract('pets'))
    await migrateGlobalSplits(home, 'pet-window.json', (global, petId) => (petId === 'electron' && Object.keys(global).length > 0 ? { ...global } : undefined))
    const root = await readdir(join(home, 'whale598'))
    for (const name of SPLIT_FILES) {
      expect(root).not.toContain(name)
      expect(root.some(entry => entry.startsWith(`${name}.bak-migrated-`))).toBe(true)
    }
  })
})
