/**
 * The pet model-expression tools as an ordinary agent-plane plugin row. The
 * pet preset composes this row, so sessions mounting other presets never see
 * `pet_*` in their tool catalog; the host-side glue (state push, interaction
 * waterfalls, ledgers, settings) stays in the main entry, which composes
 * regardless of the session's preset.
 * @module dsh-agentic-pet/tools
 */
import type { Context } from '@deepseek-ai/cordis';
/**
 * Register the five pet tools for sessions mounted with the pet preset. The
 * `petService` host service is owned by the main entry and read late from the
 * composition root — host-plane services are visible to agent-plane rows (the
 * job-controls precedent); a composition without the main entry registers
 * nothing rather than failing the row.
 */
export default class PetTools {
    private readonly ctx;
    static inject: string[];
    constructor(ctx: Context);
    apply(): void;
}
//# sourceMappingURL=tools.d.ts.map