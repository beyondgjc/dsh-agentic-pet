import { i as petHome, t as createUnregisteredPetHttp } from "./service-CHdWnQ9Q.js";
import { n as logStamp, r as registerPetTools } from "./driver-BJoTHBaM.js";
import { appendFile } from "node:fs/promises";
import { join } from "node:path";
//#region lib/types/tools.js
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
/** Diagnostic trace into the driver log: the desktop host swallows stdout, so
* the preset-row activation path is otherwise invisible. */
const trace = (line) => {
	appendFile(join(petHome(), "whale598", "pet-driver.log"), `${logStamp()} pet-tools ${line}\n`, "utf8").catch(() => {});
};
/**
* Register the pet tools (say/inbox/do/digest/interactions/affection/state/
* schedule_wake/cancel_wake) for sessions mounted with the pet preset.
*
* The service instance is assembled HERE, not read from the main entry (a
* Cordis service registered on the main row's fiber context is invisible to
* the preset subtree — sibling branches do not see each other's stores) and
* NOT registered on this row either (a same-named non-isolated service would
* overwrite the host row's store slot and fail the preset realm's leak check).
* createUnregisteredPetHttp returns the interface without any registration.
*/
var PetTools = class {
	static inject = ["tools"];
	constructor(ctx) {
		registerPetTools(ctx, petHome(), createUnregisteredPetHttp(petHome()));
		trace("registerPetTools returned");
	}
};
//#endregion
export { PetTools as default };
