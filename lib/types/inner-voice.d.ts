/**
 * The inner voice (docs/inner-voice.md): the pet's self-initiated expression
 * loop. This module owns the pure, testable half — config parsing with
 * defaults and clamps, the durable petId→sessionId store, and the wake/touch
 * prompt builders. The driver (driver.ts) owns the wiring: timers, gates,
 * SessionController calls, and the per-pet pending locks.
 * @module dsh-agentic-pet/inner-voice
 */
import { type PresenceFacts } from './presence.ts';
/** Durable petId → sessionId mapping for the inner-voice sessions. */
export interface InnerVoiceStore {
    readonly sessions: Record<string, {
        sessionId: string;
        createdAt: number;
    }>;
    /** Session-id generation per pet, PERSISTED: must survive reboots AND
     * plugin reinstall — a re-install that restarted the counter would mint
     * ids colliding with archived ones (born dead). */
    readonly generations: Record<string, number>;
}
/** 自主唤醒的忙时策略：'fire'（到点必醒，默认）| 'defer'（忙时顺延重试）。 */
export type SelfWakeBusyPolicy = 'fire' | 'defer';
/** ONE model-authored wake plan (pet_schedule_wake): a one-shot self alarm.
 * `at` is an ABSOLUTE epoch-ms stamp — sleep/reboot can then tell "expired"
 * and the catch-up fires once, merged, never one wake per missed plan (a
 * relative delay would drift under sleep). The driver keeps a SET of these
 * per pet: the model may stack plans, and neither the world clock nor a
 * user-initiated wake ever cancels them — a plan is consumed only when DUE. */
export interface WakePlan {
    id: string;
    at: number;
    intent: string;
    createdAt: number;
}
/** The `innerVoice` half of pet-settings.json, defaults folded in and clamped. */
export interface InnerVoiceConfig {
    enabled: boolean;
    /** Preset id the self-session mounts: the trimmed catalog by default, the
     * full work catalog only if the user opts in. */
    preset: string;
    /** Per-pet preset overrides (petId → preset id, multi-pet design): a pet
     * named here mounts ITS preset at mint time; everyone else falls back to
     * the global `preset`. Values are validated against PET_PRESET_IDS —
     * unknown or empty entries drop, absent keys inherit. */
    presets: Record<string, string>;
    /** Random-wake cadence in minutes. */
    wakeIntervalMinutes: number;
    /** Probability the wake actually speaks (the gate decides, never the model). */
    speakProbability: number;
    /** Probability a touch earns a reply turn. */
    touchReplyProbability: number;
    /** Minimum seconds between touch-reply turns per pet (0 = no cooldown;
     * the probability gate alone decides). Legacy minute-keyed settings fold
     * in ×60. */
    touchReplyCooldownSeconds: number;
    /** 自主唤醒（pet_schedule_wake 计划）到点遇用户主会话忙时的策略：
     * 'fire' = 到点必醒（计划是模型自己的决定，不带礼貌门）；'defer' =
     * 忙时顺延——计划放回待执行集，下一个扫描拍重试，永不丢弃。 */
    selfWakeBusyPolicy: SelfWakeBusyPolicy;
    /** 宠物间消息（pet_say 的 audience 指向另一只宠）的投递方式：
     * 'queue' = 进收件箱，目标下次唤醒时 prompt 报数、pet_inbox 取文（默认，
     * 像活物不刷屏）；'immediate' = 气泡 5s 后立即唤醒目标投递。 */
    petToPetDelivery: 'immediate' | 'queue';
    /** 宠物间定向消息的分档限频上限（滑动窗口，一小时内）：任一档超了即拒，
     * 四个数值用户可配。 */
    petMessageLimits: PetMessageLimits;
    /** Manually bound sessions (petId → sessionId): the user's own
     * conversations the inner voice should live in — highest priority, used
     * as-is (no creation, no rename, never auto-retired). Empty = automatic
     * management (the durable store + generation mints). */
    boundSessions: Record<string, string>;
}
export declare const VOICE_SESSION_PREFIX = "whale598-";
/** Read `innerVoice` from pet-settings.json; anything missing or mistyped
 * folds to its default (defensive parse, `readAutonomy` precedent). */
export declare function readInnerVoiceConfig(home: string): Promise<InnerVoiceConfig>;
export declare function innerVoiceStorePath(home: string): string;
export declare function wakePlansStorePath(home: string): string;
/** Load every pet's pending wake plans: per-pet files
 * (whale598/<petId>/pet-wake-plans.json, own-keyed map each) merged over the
 * root-level legacy map (pre-split data / version skew). The in-memory shape
 * is unchanged — callers keep seeing the whole petId → plans map. */
export declare function loadWakePlans(home: string): Promise<Record<string, WakePlan[]>>;
/** Save per-pet slices: each pet's plans land in its own state file; keys
 * dropped from the map have their pet file removed so the next load cannot
 * resurrect them. */
export declare function saveWakePlans(home: string, plans: Record<string, WakePlan[]>): Promise<void>;
/** Upsert by id: re-scheduling with a known id REPLACES the old plan —
 * "能定、能改、能撤" 的改。 */
export declare function upsertPlan(list: WakePlan[], plan: WakePlan): WakePlan[];
/** Remove one plan by id (or ALL when id is undefined). Returns the removed
 * plans so the caller can report them; an empty removal is the unknown-id
 * case the caller turns into a self-correcting error. */
export declare function cancelPlans(list: WakePlan[], id?: string): {
    next: WakePlan[];
    removed: WakePlan[];
};
/** Consume every DUE plan (at <= now): they leave the pending set for good —
 * a consumed plan must produce a wake, never a silent drop. Future plans
 * survive untouched (被打断不碰 plans). */
export declare function takeDuePlans(list: WakePlan[], now: number): {
    next: WakePlan[];
    due: WakePlan[];
};
/** The ±60s merge window: a plan due around NOW folds into a user-initiated
 * turn instead of firing its own wake a minute later (同一分钟不醒两次). */
export declare function takeNearDuePlan(list: WakePlan[], now: number, windowMs?: number): {
    next: WakePlan[];
    plan: WakePlan | undefined;
};
/** Plans among `due` that went stale BEFORE the driver came up (at < bootAt):
 * the catch-up wake says 「错过了 N 个计划」 and lists them together instead
 * of bombing one wake per missed plan. */
export declare function missedPlans(due: WakePlan[], bootAt: number): WakePlan[];
/** One queued pet-to-pet message. Bubbles are on the user's desktop — this
 * is表演, not a private channel. */
export interface PetMessage {
    from: string;
    text: string;
    at: number;
}
export declare const PET_MESSAGES_CAP = 20;
export declare function petMessagesStorePath(home: string): string;
/** Load every pet's unread inbox: current → legacy → {} (defensive like the
 * other stores). */
export declare function loadPetMessages(home: string): Promise<Record<string, PetMessage[]>>;
export declare function savePetMessages(home: string, messages: Record<string, PetMessage[]>): Promise<void>;
/** Append one message to a pet's inbox, oldest dropped past the cap (a
 * neglected inbox cannot grow without bound). */
export declare function queuePetMessage(list: PetMessage[], message: PetMessage): PetMessage[];
/** Consume the WHOLE inbox (pet_inbox 取文即清空; the wake prompt only
 * announces counts). Returns the taken messages and the emptied tail. */
export declare function takePetMessages(list: PetMessage[]): {
    taken: PetMessage[];
    next: PetMessage[];
};
export interface PetMessageLimits {
    minutes5: number;
    minutes10: number;
    minutes30: number;
    minutes60: number;
}
export declare const DEFAULT_PET_MESSAGE_LIMITS: PetMessageLimits;
export type PetMessageRateVerdict = {
    ok: true;
    recent: number[];
} | {
    ok: false;
    windowMinutes: number;
    cap: number;
    count: number;
    retryAfterSeconds: number;
};
/** The tiered sliding-window check for one from→to pair. `timestamps` are the
 * pair's recent send times; the hour window prunes them (静默一小时后自然
 * 重新开始), then each tier rejects when its window already holds the cap.
 * The first (narrowest) violated tier is reported, with the earliest moment
 * a slot frees up. `recent` on success = the pruned list — the caller appends
 * its own timestamp after the send succeeds. */
export declare function checkPetMessageRate(timestamps: number[], now: number, limits: PetMessageLimits): PetMessageRateVerdict;
/** The immediate-delivery prompt (petToPetDelivery='immediate'): the target
 * is woken right away with the sender's name and id — the id because the
 * reply path is pet_say audience="<fromId>". The target's current affection
 * toward the sender rides along so the reply carries history, not a blank
 * slate. Responding or ignoring is the target's own call, exactly like any
 * other wake. */
export declare function buildCrossPetPrompt(facts: {
    fromName: string;
    fromId: string;
    text: string;
    affection: number;
}): string;
export declare function loadInnerVoiceStore(home: string): Promise<InnerVoiceStore>;
export declare function saveInnerVoiceStore(home: string, store: InnerVoiceStore): Promise<void>;
export declare function voiceSessionIdFor(petId: string): string;
/** Mint the next voice session id: the bare base for generation 0, `-gN`
 * after any retire. The generation counter lives in memory only — a desktop
 * restart resets it to zero while the archive set still holds every retired
 * id, so a naive mint lands on an ARCHIVED ancestor: the platform accepts
 * the prompt (bare `accepted` receipt) but its gate silently blocks every
 * turn of an archived session — born dead, retired by the 25s window, and
 * the replacement collides again (field spiral 2026-10-31, g1→g3 dead on
 * arrival). The mint therefore SKIPS any id the archive authority still
 * holds; with the counter reset this walks past g1..g16 to the first free
 * slot. The hop cap keeps a pathological archive set from spinning forever.
 * Returns the (possibly advanced) generation so callers persist it — a
 * later mint must not reuse a skipped id either — plus the hop count for
 * the skip log line. */
export declare function mintVoiceSessionId(petId: string, generation: number, isArchived: (sessionId: string) => boolean): {
    sessionId: string;
    generation: number;
    hops: number;
};
export interface GreetPromptFacts {
    affection: number;
    bondValue: number;
    bondDays: number;
    bondTier: string;
    /** 用户起的名字（未起则内置默认）：自我介绍的依据，改名后第一天尤其重要。 */
    name: string;
    /** 用户刚从一段离开中回来：最多一行的期间摘要。 */
    presence?: PresenceFacts;
}
/** The boot-greeting prompt: fired once per dsh start when the pet first
 * comes online — before the random-wake cadence takes over. Always speaks
 * (no probability gate on this one); the time context rides the preset. */
export declare function buildGreetPrompt(facts: GreetPromptFacts): string;
/** B 层 · 羁绊档位：days-with-interaction → tier name. Only grows, never
 * decays; the names are the display contract (settings page keeps its own
 * copy of the thresholds). */
export declare const BOND_TIERS: Array<{
    since: number;
    name: string;
}>;
export declare function bondTier(days: number): string;
/** Shared mood vocabulary (pet_state computes the same from the ledger). */
export declare function moodOf(affection: number): 'happy' | 'content' | 'neutral';
/** Touch part → spoken wording; `unknown` never earns a reply turn (the
 * driver filters it before building a prompt). */
export declare function touchPartWording(part: string): string | undefined;
export interface WakePromptFacts {
    affection: number;
    bondValue: number;
    bondTier: string;
    bondDays: number;
    /** Minutes since this pet last spoke on its own; undefined = first wake. */
    minutesSinceLastSpoke: number | undefined;
    /** Minutes since the bound session last showed activity; undefined = none recorded. */
    minutesSinceUserActivity: number | undefined;
    userActive: boolean;
    /** 唤醒源：'world' = 世界时钟（环境节拍，程序周期）；'self' = 模型自己定的
     * 计划到点；'world+self' = 两者同拍合并。缺省按 'world'（旧调用点）。 */
    source?: 'world' | 'self' | 'world+self';
    /** 本次已消费的到期计划 intent（self / world+self 时非空）。 */
    dueIntents?: Array<string>;
    /** 到期计划中离线期间错过的条数（补醒时 >0 → 「错过了 N 个计划」）。 */
    missedCount?: number;
    /** 计划定下时就已经过期（pet_schedule_wake 收到过去的时间戳，立即补醒一次）。 */
    overdue?: boolean;
    /** 未到期的待执行计划（最近 ≤5 条）：世界时钟唤醒也告知模型自己的作息，
     * 继续、改时间或取消由模型决定。 */
    pendingPlans?: Array<{
        at: number;
        intent: string;
    }>;
    /** 收件箱未读（按来源宠聚合）：prompt 只报数不携全文——想看就调
     * pet_inbox，读不读由她决定（宠物间消息的排队投递侧）。 */
    unread?: Array<{
        fromName: string;
        count: number;
    }>;
    /** 客厅记事板新字（多宠设计 §5，反收音机）：只报数与来源——全文在
     * pet_board read 后面；注入即已读，不重复注入，也不打断。 */
    boardUnread?: {
        count: number;
        fromNames: string[];
    };
    /** 静默时段：只压制世界时钟；自主唤醒仍触发，prompt 说明用户可能已睡。 */
    quiet?: boolean;
    /** 最近几条连续性记录（已按 maxEntryChars 截断、已做边界转义）。 */
    journal?: Array<{
        at: number;
        source: string;
        label?: string;
        text: string;
    }>;
    /** 阶段摘要索引行（REQ-M05）：一笔一行，只给锚点不给细节。 */
    journalEpochs?: string[];
    /** 兜底（REQ-M05）：当前文件没有近期条目时，注入最近一条 epoch 全文。 */
    journalEpochFallback?: {
        at: number;
        label?: string;
        text: string;
    };
    /** 阶段摘要到点了（REQ-M05）：唤醒时提示她自己写。 */
    journalEpochDue?: string;
    /** 用户刚从一段离开中回来：最多一行的期间摘要。 */
    presence?: PresenceFacts;
}
/** Local HH:mm for plan times: the model's clock talk is the USER's wall
 * clock (logStamp precedent), and plans are compared against it. */
export declare const wakePlanClock: (at: number) => string;
/** Date + local time for journal entries (imported entries may be days old). */
export declare const journalClock: (at: number) => string;
/** The wake prompt. Time context is injected by the preset's time-context
 * row; the leading tag doubles as the durable trigger marker in the log —
 * and now names the SOURCE: [世界时钟] (the environment's tick), [自主唤醒]
 * (the model's own schedule, with the original intent), or the merged form. */
export declare function buildWakePrompt(facts: WakePromptFacts): string;
/** A self-scheduled plan folded into a USER-initiated turn (chat 上行 / touch
 * 回应)：the plan sat within the ±60s merge window, so both wake in one —
 * the tag names the union ([用户+自主唤醒]) and the intent rides along. */
export interface MergedWakePlan {
    at: number;
    intent: string;
}
export interface TouchPromptFacts {
    part: string;
    /** Touches on this pet today, from the ledger's recent window. */
    touchesToday: number;
    affection: number;
    /** ±60s 内到期的自主计划：合并进这次回应，计划标记为已消费。 */
    mergedPlan?: MergedWakePlan;
    /** 用户刚从一段离开中回来：最多一行的期间摘要。 */
    presence?: PresenceFacts;
}
export declare function buildTouchPrompt(facts: TouchPromptFacts): string;
/** The chat上行 prompt (§6 2026-10-31 revision): the user typed at the
 * pet's surface. The text rides verbatim — the pet answers through pet_say
 * (and may pet_do); it is a conversation turn, not a touch reaction. Length
 * clamps to the contract's 2000-character ceiling. A plan inside the ±60s
 * merge window folds in: the tag becomes the union and the intent rides. */
export declare function buildChatPrompt(text: string, mergedPlan?: MergedWakePlan, presence?: PresenceFacts): string;
//# sourceMappingURL=inner-voice.d.ts.map