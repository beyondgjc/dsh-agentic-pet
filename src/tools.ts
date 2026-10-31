/**
 * The pet model-expression tools as an ordinary agent-plane plugin row. The
 * pet preset composes this row, so sessions mounting other presets never see
 * `pet_*` in their tool catalog; the host-side glue (state push, interaction
 * waterfalls, ledgers, settings) stays in the main entry, which composes
 * regardless of the session's preset.
 *
 * Cordis runs a CLASS plugin as `new Ctor(ctx, config)` plus its `Service.init`
 * hooks — an instance `apply()` method is never invoked (that shape belongs to
 * function and `{ apply }` object plugins). All side effects therefore live in
 * the constructor.
 * @module dsh-agentic-pet/tools
 */

import { appendFile } from 'node:fs/promises'
import { join } from 'node:path'
import type { Context } from '@deepseek-ai/cordis'
import { createUnregisteredPetHttp, petHome } from './service.ts'
import { logStamp, registerPetTools } from './driver.ts'

/** Diagnostic trace into the driver log: the desktop host swallows stdout, so
 * the preset-row activation path is otherwise invisible. */
const trace = (line: string): void => {
  void appendFile(join(petHome(), 'pet-driver.log'), `${logStamp()} pet-tools ${line}\n`, 'utf8').catch(() => {})
}

/**
 * Register the five pet tools for sessions mounted with the pet preset.
 *
 * The service instance is assembled HERE, not read from the main entry (a
 * Cordis service registered on the main row's fiber context is invisible to
 * the preset subtree — sibling branches do not see each other's stores) and
 * NOT registered on this row either (a same-named non-isolated service would
 * overwrite the host row's store slot and fail the preset realm's leak check).
 * createUnregisteredPetHttp returns the interface without any registration.
 */
export default class PetTools {
  static inject = ['tools']

  constructor(ctx: Context) {
    registerPetTools(ctx, petHome(), createUnregisteredPetHttp(petHome()))
    trace('registerPetTools returned')
  }
}
