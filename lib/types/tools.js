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
import { appendFile } from 'node:fs/promises';
import { join } from 'node:path';
import { PetHttpService, petHome } from "./service.js";
import { registerPetTools } from "./driver.js";
/** Diagnostic trace into the driver log: the desktop host swallows stdout, so
 * the preset-row activation path is otherwise invisible. */
const trace = (line) => {
    void appendFile(join(petHome(), 'pet-driver.log'), `${new Date().toISOString()} pet-tools ${line}\n`, 'utf8').catch(() => { });
};
/**
 * Register the five pet tools for sessions mounted with the pet preset.
 *
 * The service instance is constructed HERE, not read from the main entry: a
 * Cordis service registered on the main row's fiber context is invisible to
 * the preset subtree (sibling branches do not see each other's stores —
 * verified: `ctx.get('petService')` resolved ABSENT from inside the mount).
 * PetHttpService is stateless over the on-disk registry, so a second instance
 * scoped to this row behaves identically.
 */
export default class PetTools {
    static inject = ['tools'];
    constructor(ctx) {
        registerPetTools(ctx, petHome(), new PetHttpService(ctx, petHome()));
        trace('registerPetTools returned');
    }
}
//# sourceMappingURL=tools.js.map