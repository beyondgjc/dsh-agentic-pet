/**
 * Multi-instance registry (Phase 1 of the multi-pet design): the desired-set
 * file parse, the id arithmetic, and the summon admission rule (防呆). The
 * spawn side itself is process machinery — covered live, not here.
 */

import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterAll, describe, expect, it } from 'vitest'
import {
  admitSummon,
  nextInstanceId,
  parseInstancePlan,
  readInstancePlan,
  writeInstancePlan,
} from '../src/instances.ts'

const homes: string[] = []
const tempHome = async (): Promise<string> => {
  const dir = await mkdtemp(join(tmpdir(), 'pet-instances-'))
  homes.push(dir)
  return dir
}
afterAll(async () => {
  for (const dir of homes) await rm(dir, { force: true, recursive: true })
})

describe('parseInstancePlan', () => {
  it('degrades a mistyped file to defaults', () => {
    expect(parseInstancePlan({ maxInstances: 'three', instances: 'many' }))
      .toEqual({ maxInstances: 3, instances: [] })
  })

  it('never stores the primary as a desired instance; dedupes the rest', () => {
    expect(parseInstancePlan({ maxInstances: 5, instances: ['electron', 'electron-2', 'electron-2', ''] }))
      .toEqual({ maxInstances: 5, instances: ['electron-2'] })
  })
})

describe('nextInstanceId', () => {
  it('allocates electron-2 first, then walks past taken ordinals', () => {
    expect(nextInstanceId(['electron', 'pure'])).toBe('electron-2')
    expect(nextInstanceId(['electron', 'electron-2', 'electron-3'])).toBe('electron-4')
  })
})

describe('admitSummon', () => {
  const plan = { maxInstances: 3, instances: ['electron-2'] }

  it('admits a summon within the cap', () => {
    expect(admitSummon(plan, [], 'electron-3')).toEqual({ ok: true })
  })

  it('refuses a duplicate of a running instance', () => {
    expect(admitSummon(plan, ['electron-2'], 'electron-2')).toEqual({ ok: false, reason: 'duplicate' })
  })

  it('counts desired-but-offline instances toward the cap', () => {
    // desired [e2] + candidate e3 + primary = 3 ≤ 3 ✓
    expect(admitSummon(plan, [], 'electron-3')).toEqual({ ok: true })
    // desired [e2,e3] + candidate e4 + primary = 4 > 3
    const fuller = { maxInstances: 3, instances: ['electron-2', 'electron-3'] }
    expect(admitSummon(fuller, [], 'electron-4')).toEqual({ ok: false, reason: 'limit' })
  })

  it('counts running extras not in the desired set too', () => {
    const loose = { maxInstances: 2, instances: [] }
    expect(admitSummon(loose, ['electron-2'], 'electron-3')).toEqual({ ok: false, reason: 'limit' })
  })
})

describe('instance plan file round-trip', () => {
  it('persists under whale598/ and reads back', async () => {
    const home = await tempHome()
    const plan = { maxInstances: 4, instances: ['electron-2', 'electron-3'] }
    await writeInstancePlan(home, plan)
    expect(JSON.parse(await readFile(join(home, 'whale598', 'multi-instances.json'), 'utf8')))
      .toEqual(plan)
    expect(await readInstancePlan(home)).toEqual(plan)
  })

  it('answers defaults when the file is absent', async () => {
    const home = await tempHome()
    expect(await readInstancePlan(home)).toEqual({ maxInstances: 3, instances: [] })
  })

  it('writeInstancePlan creates the whale598 directory', async () => {
    const home = await tempHome()
    await writeInstancePlan(home, { maxInstances: 3, instances: ['electron-2'] })
    await writeFile(join(home, 'whale598', 'multi-instances.json'), 'corrupted', 'utf8')
    // A corrupted file degrades to defaults (parseInstancePlan), never throws.
    expect(await readInstancePlan(home)).toEqual({ maxInstances: 3, instances: [] })
  })
})
