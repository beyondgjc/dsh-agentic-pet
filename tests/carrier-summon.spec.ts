/**
 * Summon decision table (settings-page summon card, carrier-summon.ts): the
 * pure plan's priority order — environment gates first, install integrity
 * second, electron availability last. The async liveness probe stays outside
 * on purpose; these cases are the whole synchronous surface.
 */

import { describe, expect, it } from 'vitest'
import { planSummon, type SummonPlanInput } from '../src/carrier-summon.ts'

const base: SummonPlanInput = {
  url: 'http://127.0.0.1:50289/',
  noSpawn: false,
  carrierDirExists: true,
  electronBinaryReady: true,
  electronInstallable: true,
}

describe('planSummon', () => {
  it('spawns when the world is intact (binary ready)', () => {
    expect(planSummon(base)).toEqual({ action: 'spawn' })
  })

  it('skips without the host webserver URL', () => {
    expect(planSummon({ ...base, url: undefined })).toEqual({ action: 'skip', reason: 'no-webserver' })
  })

  it('skips under the DSH_PET_NO_SPAWN operator gate', () => {
    expect(planSummon({ ...base, noSpawn: true })).toEqual({ action: 'skip', reason: 'spawn-disabled' })
  })

  it('skips when the carrier app directory is missing (broken install)', () => {
    expect(planSummon({ ...base, carrierDirExists: false })).toEqual({ action: 'skip', reason: 'carrier-missing' })
  })

  it('routes to the electron installer when no binary is staged but the npm package exists', () => {
    expect(planSummon({ ...base, electronBinaryReady: false })).toEqual({ action: 'install-electron' })
  })

  it('skips when electron is neither staged nor installable', () => {
    expect(planSummon({ ...base, electronBinaryReady: false, electronInstallable: false }))
      .toEqual({ action: 'skip', reason: 'electron-unavailable' })
  })

  it('gates in priority order: NO_SPAWN wins over a missing carrier directory', () => {
    expect(planSummon({ ...base, noSpawn: true, carrierDirExists: false }))
      .toEqual({ action: 'skip', reason: 'spawn-disabled' })
  })

  it('gates in priority order: carrier-missing wins over electron-unavailable', () => {
    expect(planSummon({ ...base, carrierDirExists: false, electronBinaryReady: false, electronInstallable: false }))
      .toEqual({ action: 'skip', reason: 'carrier-missing' })
  })
})
