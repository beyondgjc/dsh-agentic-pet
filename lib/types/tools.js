/**
 * The pet model-expression tools as an ordinary agent-plane plugin row. The
 * pet preset composes this row, so sessions mounting other presets never see
 * `pet_*` in their tool catalog; the host-side glue (state push, interaction
 * waterfalls, ledgers, settings) stays in the main entry, which composes
 * regardless of the session's preset.
 * @module dsh-agentic-pet/tools
 */
import { petHome } from "./service.js";
import { registerPetTools } from "./driver.js";
/**
 * Register the five pet tools for sessions mounted with the pet preset. The
 * `petService` host service is owned by the main entry and read late from the
 * composition root — host-plane services are visible to agent-plane rows (the
 * job-controls precedent); a composition without the main entry registers
 * nothing rather than failing the row.
 */
export default class PetTools {
    ctx;
    static inject = ['tools'];
    constructor(ctx) {
        this.ctx = ctx;
    }
    apply() {
        const pet = this.ctx.get('petService');
        if (pet === undefined) {
            console.error('pet-surface tools: petService absent (compose the dsh-agentic-pet main entry); registering nothing');
            return;
        }
        registerPetTools(this.ctx, petHome(), pet);
    }
}
//# sourceMappingURL=tools.js.map