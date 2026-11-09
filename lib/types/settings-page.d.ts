/**

 * The settings page's host half: local HTTP routes backing the desktop

 * sidebar "桌宠" page (the client half lives in ./client/pet-settings.js and

 * registers through the web GUI's slot system, per the dsh-qqbot precedent).

 * Settings persist in their own JSON file in the dsh home — the platform

 * settings service derives namespaces from profile entry config schemas,

 * which this bundle does not declare; a file keeps the surface honest.

 * Routes use the raw handler form (resource routes postdate rc.3) behind a

 * same-origin loopback fence, one registration per path with internal method

 * dispatch — the webserver throws on duplicate path registration.

 * @module dsh-agentic-pet/settings-page

 */
import type { Context } from '@deepseek-ai/cordis';
import type { SummonOutcome } from './carrier-summon.ts';
import { type PetDriverControl } from './driver.ts';
import type { PetService } from './service.ts';
/** The proactivity switches. `enabled`/`cooldownMinutes`/

 * `idleThresholdMinutes` are the upcoming v1 speech scheduler's; the

 * `idleAnimation` pair is consumed TODAY by the renderer's idle theater

 * (riding to the pet on /state pushes). */
interface ProactivitySettings {
    enabled?: boolean;
    cooldownMinutes?: number;
    idleThresholdMinutes?: number;
    idleAnimation?: boolean;
    idleAnimationGapMinutes?: number;
}
/** The inner voice (docs/inner-voice.md §9): the self-initiated expression

 * loop's config. The driver re-reads pet-settings.json fresh on every wake/

 * touch decision, so a saved patch takes effect without any push. */
interface InnerVoiceSettings {
    enabled?: boolean;
    preset?: string;
    wakeIntervalMinutes?: number;
    speakProbability?: number;
    touchReplyProbability?: number;
    touchReplyCooldownSeconds?: number;
    /** 自主唤醒（pet_schedule_wake 计划）到点遇用户忙的策略：
  
     * 'fire' = 到点必醒（默认）；'defer' = 忙时顺延下一拍重试。 */
    selfWakeBusyPolicy?: 'defer' | 'fire';
    /** 宠物间消息（pet_say audience 指向另一只宠）的投递方式：
  
     * 'queue' = 收件箱 + 下次唤醒报数（默认）；'immediate' = 立即唤醒目标。 */
    petToPetDelivery?: 'immediate' | 'queue';
    /** 宠物间定向消息的分档限频上限（滑动窗口分钟数固定 5/10/30/60）：
  
     * 任一档超了即拒。缺省 5/8/10/15。 */
    petMessageLimits?: {
        minutes5?: number;
        minutes10?: number;
        minutes30?: number;
        minutes60?: number;
    };
    boundSessions?: Record<string, string>;
}
/** Debug switches read by the carrier at startup (CDP needs a restart). */
interface DebugSettings {
    cdp?: boolean;
}
/** Say-side TTS (BreezeBlue): consumed by the carrier's /say pipeline, which

 * re-reads pet-settings.json with an mtime cache — a saved switch reaches the

 * pet on its next utterance, no push and no restart. The key lives in the

 * same local settings file as the rest of the dsh home's machine-local

 * secrets; the voices proxy route below is the only code that forwards it

 * onward (the settings page's browser cannot reach api.breeze.blue: CORS). */
interface TtsSettings {
    enabled?: boolean;
    apiKey?: string;
    voiceId?: string;
    modelId?: string;
    languageCode?: string;
    /** 0.5–2.0 */
    speed?: number;
    /** 0.01–2.0 */
    volume?: number;
}
interface QuietSettings {
    from?: string;
    to?: string;
    allowTouchReply?: boolean;
}
interface RhythmSettings {
    quiet?: QuietSettings | null;
}
interface JournalSettings {
    enabled?: boolean;
    injectRecent?: number;
    maxEntryChars?: number;
    maxFileBytes?: number;
    allowUnboundAppend?: boolean;
}
interface PresenceSettings {
    enabled?: boolean;
}
interface PetSettings {
    proactivity?: ProactivitySettings;
    innerVoice?: InnerVoiceSettings;
    rhythm?: RhythmSettings;
    journal?: JournalSettings;
    presenceSummary?: PresenceSettings;
    tts?: TtsSettings;
    debug?: DebugSettings;
    /** The user-editable character card (src/persona.ts): absent or empty
     * falls back to DEFAULT_PERSONA at prompt-assembly time. */
    persona?: string;
}
/** Merge a patch into the settings, accepting only the known keys. Exported
 * for the persona-merge spec (tests/persona.spec.ts). */
export declare function mergeSettings(current: PetSettings, patch: Record<string, unknown>): PetSettings;
/**

 * Register the settings page's routes. One registration per exact path with

 * internal method dispatch; every handler runs behind the fence.

 * @param ctx - plugin context inside the runtime.

 * @param home - the dsh home holding the settings/ledger/manifest files.

 */
/** The multi-instance face (multi-pet design §4): per-pet summon/dismiss
 * backed by the plugin's spawn machinery. petId 'new' allocates the next
 * free instance id; the primary summons through the plain summon face. */
export interface InstanceControl {
    summonInstance(petId?: string): Promise<SummonOutcome & {
        petId?: string;
    }>;
    dismissInstance(petId: string): Promise<{
        ok: boolean;
        reason?: string;
    }>;
}
export declare function installSettingsPage(ctx: Context, home: string, pet: PetService, control?: PetDriverControl, summon?: () => SummonOutcome, instances?: InstanceControl): void;
export {};
//# sourceMappingURL=settings-page.d.ts.map