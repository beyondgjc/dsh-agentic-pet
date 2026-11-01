/**
 * The pet driver: converges in-process DSH events into pet control
 * operations. This is the DSH-knowledge half of the §7.2 split — the pet
 * surface keeps shrinking toward a dumb display while everything that
 * understands the runtime's vocabulary lives here. v1 drives semantic state;
 * interaction waterfalls move over with the WS path's retirement.
 * @module dsh-agentic-pet/driver
 */
import { randomUUID } from 'node:crypto';
import { homedir } from 'node:os';
import { appendFile, mkdir, readFile, readdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { defineTool } from '@deepseek-ai/dsh-tools';
import { formatAvailableActions, resolveActionRequest } from "./actions.js";
import { bondTier, buildChatPrompt, buildGreetPrompt, buildTouchPrompt, buildWakePrompt, loadInnerVoiceStore, mintVoiceSessionId, moodOf, readInnerVoiceConfig, saveInnerVoiceStore, touchPartWording, } from "./inner-voice.js";
import { notifyPets, routePet } from "./registry.js";
import * as petdata from "./petdata.js";
const EMPTY_LEDGER = { affection: 0, total: 0, byPart: {}, lastTouchAt: undefined, recent: [] };
// Affection judgment locks: delta-only with mandatory reason, a cooldown
// between adjustments, and a daily quota — the model judges the
// relationship, it does not farm it.
const ADJUST_MAX_DELTA = 3;
const ADJUST_COOLDOWN_MS = 5 * 60_000;
const ADJUST_DAILY_LIMIT = 8;
const ADJUST_DAILY_SUM = 10;
// Decay is SYSTEM-computed (lazy — no timer): silent for 3 days, then -1
// per further 3 days, floor 0.
const DECAY_START_DAYS = 3;
const DECAY_STEP_DAYS = 3;
async function readLedger(home, petId) {
    try {
        const raw = await petdata.readAffectionRaw(home, petId);
        if (raw === null)
            return { ...EMPTY_LEDGER, byPart: {}, recent: [] };
        return {
            affection: typeof raw.affection === 'number' ? raw.affection : 0,
            total: typeof raw.total === 'number' ? raw.total : 0,
            byPart: raw.byPart ?? {},
            lastTouchAt: raw.lastTouchAt,
            recent: raw.recent ?? [],
            adjustments: Array.isArray(raw.adjustments)
                ? raw.adjustments.filter((a) => typeof a === 'object' && a !== null
                    && typeof a.delta === 'number'
                    && typeof a.reason === 'string'
                    && typeof a.at === 'number')
                : undefined,
            quota: typeof raw.quota === 'object' && raw.quota !== null
                ? raw.quota
                : undefined,
            lastDecayAt: typeof raw.lastDecayAt === 'number' ? raw.lastDecayAt : undefined,
            bond: typeof raw.bond === 'object' && raw.bond !== null
                && typeof raw.bond.lastCountedDate === 'string'
                ? {
                    value: typeof raw.bond.value === 'number'
                        ? raw.bond.value
                        : 0, // judgment starts from zero on the split (was days-polluted)
                    days: typeof raw.bond.days === 'number'
                        ? raw.bond.days
                        : 0,
                    lastCountedDate: raw.bond.lastCountedDate,
                }
                : undefined,
            bondAdjustments: Array.isArray(raw.bondAdjustments)
                ? raw.bondAdjustments.filter((a) => typeof a === 'object' && a !== null
                    && typeof a.delta === 'number'
                    && typeof a.reason === 'string'
                    && typeof a.at === 'number')
                : undefined,
        };
    }
    catch {
        return { ...EMPTY_LEDGER, byPart: {}, recent: [] };
    }
}
/** Local-time log stamp: the driver log is the user's primary debugging
 * tool, so timestamps show the USER's wall clock, not UTC (toISOString's Z
 * form read 8h off and cost a confusion round). Sortable, zero-padded. */
export const logStamp = () => {
    const d = new Date();
    const p = (n) => String(n).padStart(2, '0');
    return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())} ${p(d.getHours())}:${p(d.getMinutes())}:${p(d.getSeconds())}`;
};
const driverLog = (home, line) => {
    void appendFile(join(home, petdata.WHALE_DIR, 'pet-driver.log'), `${logStamp()} ${line}
`, 'utf8').catch(() => { });
};
/** The one /events read both consumers share (§6 v4): the ledger loop
 * holds (`hold` seconds — the server clamps to ≤30s), the digest reads
 * immediately. Wire shapes normalize here; the digest's independent
 * cursor and the ledger loop's cursor stay per-consumer by design. */
async function readEvents(pet, entry, since, holdSeconds) {
    const hold = holdSeconds > 0 ? `&hold=${String(holdSeconds)}` : '';
    const payload = await pet.call(entry, `/events?since=${String(since)}${hold}`);
    const events = (Array.isArray(payload.events) ? payload.events : []).map(event => ({
        seq: typeof event.seq === 'number' ? event.seq : 0,
        // §6: a missing type reads as touch (the migration-window shorthand).
        type: typeof event.type === 'string' ? event.type : 'touch',
        ...(typeof event.part === 'string' ? { part: event.part } : {}),
        ...(typeof event.text === 'string' ? { text: event.text } : {}),
        at: typeof event.at === 'number' ? event.at : Date.now(),
    }));
    return { events, latest: typeof payload.latest === 'number' ? payload.latest : since };
}
/** The archived Session id set carried by one follow frame; undefined for
 * frames that say nothing about archives (upsert/remove/order/pinned). */
function archivedIdsOf(frame) {
    if (typeof frame !== 'object' || frame === null)
        return undefined;
    const record = frame;
    const ids = record.type === 'baseline' || record.type === 'replace'
        ? (typeof record.value === 'object' && record.value !== null
            ? record.value.archivedSessionIds
            : undefined)
        : record.type === 'archived' ? record.archivedSessionIds : undefined;
    return Array.isArray(ids) ? ids.filter((id) => typeof id === 'string') : undefined;
}
/**
 * Inner-voice runtime state (docs/inner-voice.md). Module-level because TWO
 * registration seams share it: installPetDriver fills and drives it, while
 * registerPetTools (the pet preset's own row, a different fiber) reads the
 * owner map in resolveTarget and reports pet_say arrivals. installPetDriver
 * resets everything on entry, so a re-install re-initializes cleanly.
 */
const voiceOwners = new Map(); // sessionId → petId
const voicePendingUntil = new Map(); // petId → epoch ms
const voiceLastSpokeAt = new Map(); // petId → epoch ms (pet_say arrivals)
const voiceLastTouchReplyAt = new Map(); // petId → epoch ms
const voiceNextWakeAt = new Map(); // petId → epoch ms
// Boot-greeting latch: one hello per dsh start, cleared on driver install.
const voiceGreetedOnce = new Set();
// Custom display names (petId → label, from pet-settings.json `names`):
// surfaced to the MODEL too — pet_state carries it, and prompts prepend a
// name line so the pet self-identifies with the user's naming.
const voiceNames = new Map();
// Built-in defaults when no custom name is set (the settings client keeps
// its own copy — separate build face).
const DEFAULT_PET_NAME = { electron: '鲸鱼娘' };
/** B-layer bond day counting: the FIRST interaction of a calendar day
 * (touch / user chat / model adjustment) marks that day as shared. Called
 * at the interaction points, never on reads — reading the ledger does not
 * make a day meaningful. Mutates in place; the caller persists. Module-level
 * because both the driver closures AND the model tools (registerPetTools)
 * count bond days. */
const countBondDay = (ledger) => {
    const today = new Date().toDateString();
    if (ledger.bond?.lastCountedDate === today)
        return;
    ledger.bond = {
        value: ledger.bond?.value ?? 0, // judgment untouched by the fact writer
        days: (ledger.bond?.days ?? 0) + 1,
        lastCountedDate: today,
    };
};
// Dead-session detection (§ archive black hole): counts relative to the last
// pet_say, NOT per-prompt windows — consecutive admissions renew a per-prompt
// deadline forever, which is exactly what a user rapidly re-sending into a
// dead session does. Two admissions unanswered for 90s since the FIRST one
// retire the session.
// The most recent UNANSWERED prompt per pet (text + who drove it): a retire
// must not swallow the user's words — the retire paths re-submit it into
// the fresh session. Cleared on pet_say (answered) and on manual binding
// checks that clear the ledger.
const voiceLastPrompt = new Map();
// Manually bound sessions (petId → sessionId, from innerVoice.boundSessions):
// the user's own conversations the inner voice lives in — highest priority,
// never created/renamed/retired by the driver. A cache refreshed on install
// and on every settings change, so the synchronous stall path can consult it.
const voiceBoundSessions = new Map();
const voiceWakeTimer = { timer: undefined };
let voiceStore = { sessions: {}, generations: {} };
let voiceController;
// The bound session's most recent activity timestamp, kept for the wake
// prompt's "the user is busy working" fact. Module-level for the same reason
// as the maps: triggerWake reads it from outside installPetDriver's closure.
let voiceUserActivityAt;
const isVoiceSession = (sessionId) => voiceOwners.has(sessionId);
/** pet_say arrival hook: a spoken bubble is both the pending-lock release and
 * the truth of "when the pet last spoke" (a prompt being accepted is not).
 * Returns whether a pending inner-voice turn was actually released (the
 * caller logs it — the user-session says stay out of the log). */
function markVoiceSpoke(petId) {
    const hadPending = (voicePendingUntil.get(petId) ?? 0) > Date.now();
    voicePendingUntil.delete(petId);
    voiceLastPrompt.delete(petId); // answered: nothing to re-submit
    voiceLastSpokeAt.set(petId, Date.now());
    return hadPending;
}
export function installPetDriver(ctx, home, pet) {
    driverLog(home, 'installPetDriver entered');
    // Global state files consolidated under whale598/ — rename legacy copies
    // once (best-effort; the read fallback covers a failed rename).
    void petdata.migrateGlobals(home);
    // Inner-voice (re)initialization: a re-install must not inherit stale
    // owners from a previous driver generation. The store on disk is the
    // durable petId→sessionId truth; the maps are rebuilt from it.
    voiceOwners.clear();
    voicePendingUntil.clear();
    voiceLastSpokeAt.clear();
    voiceLastTouchReplyAt.clear();
    voiceNextWakeAt.clear();
    voiceGreetedOnce.clear();
    voiceNames.clear();
    voiceLastPrompt.clear();
    voiceBoundSessions.clear();
    // generations live in the STORE (persisted): a reboot AND a plugin
    // reinstall both re-read them from disk, so minted ids never collide with
    // archived ones across restarts.
    if (voiceWakeTimer.timer !== undefined)
        clearTimeout(voiceWakeTimer.timer);
    voiceWakeTimer.timer = undefined;
    voiceUserActivityAt = undefined;
    voiceController = ctx.get('sessionController');
    if (voiceController === undefined) {
        console.error('pet-surface driver: sessionController absent — the inner voice stays off');
    }
    // Archive → fresh start: this platform has NO session delete, archive IS
    // how a session ends — a user archiving the inner-voice session is asking
    // for a clean slate (old log kept in the archive list, new session from
    // zero under the current settings). Subscribe to the workspace archive
    // authority so the retire happens on the EVENT, not after a behavioral
    // timeout. CRITICAL TIMING: the feed's baseline frame usually arrives
    // BEFORE the async store load finishes — a reconcile against an empty
    // store silently retires nothing, so the latest archived set is CACHED and
    // the reconcile re-runs when the store lands (otherwise sessions archived
    // before a restart would sit in the store feeding the black hole until
    // the 45s behavioral timeout).
    let latestArchived = new Set();
    // The session retired by the MOST RECENT archive, per pet: its leaving
    // the archived set is the platform's "撤销" (undo) — rebind to it as long
    // as the replacement session has not been created yet (once a fresh
    // session exists, a late undo only restores the archive-list entry, the
    // fresh session stays).
    const lastRetired = new Map();
    /** Re-submit the unanswered prompt text of petId (if any) into whatever
     * session the next ensure mints — a retire must not swallow the user's
     * words. Fire-and-forget; retried=true so the re-submission never hangs
     * its own re-submit timer. */
    const resubmitUnanswered = (petId) => {
        const last = voiceLastPrompt.get(petId);
        if (last === undefined)
            return;
        voiceLastPrompt.delete(petId);
        driverLog(home, `VOICE re-submitting the unanswered prompt into a fresh session pet=${petId}`);
        void promptVoice(petId, last.text, { retried: true, userDriven: last.userDriven });
    };
    /** One reconciliation pass over the CURRENT store and the CURRENT archive
     * set: retire sessions the archive authority says are archived (each such
     * retire re-submits the lost prompt), and rebind a just-retired session
     * the user un-archived (撤销) before any replacement exists. */
    const reconcileArchivedVoiceSessions = () => {
        for (const [petId, entry] of Object.entries(voiceStore.sessions)) {
            if (!latestArchived.has(entry.sessionId))
                continue;
            const generation = (voiceStore.generations[petId] ?? 0) + 1;
            voiceStore.generations[petId] = generation;
            Reflect.deleteProperty(voiceStore.sessions, petId);
            const ownerEntry = [...voiceOwners.entries()].find(([, owner]) => owner === petId);
            if (ownerEntry !== undefined)
                voiceOwners.delete(ownerEntry[0]);
            voicePendingUntil.delete(petId);
            lastRetired.set(petId, { sessionId: entry.sessionId, createdAt: entry.createdAt });
            void saveInnerVoiceStore(home, voiceStore);
            driverLog(home, `VOICE session retired pet=${petId} (${entry.sessionId} was archived by the user — starting fresh as -g${String(generation)} on the next trigger)`);
            resubmitUnanswered(petId);
        }
        // Undo detection: the just-retired session LEFT the archived set (the
        // user hit 撤销) and nothing has replaced it yet — rebind to it,
        // memories intact. The generation counter stays bumped, so a future
        // retire mints an id no dead generation ever used.
        for (const [petId, retired] of [...lastRetired]) {
            if (latestArchived.has(retired.sessionId))
                continue;
            lastRetired.delete(petId);
            if (voiceStore.sessions[petId] !== undefined)
                continue; // replacement already created: the undo is cosmetic only
            voiceStore.sessions[petId] = { sessionId: retired.sessionId, createdAt: retired.createdAt };
            voiceOwners.set(retired.sessionId, petId);
            void saveInnerVoiceStore(home, voiceStore);
            driverLog(home, `VOICE session restore-by-undo pet=${petId} (${retired.sessionId} left the archive set before any replacement — rebinding, memories intact)`);
        }
    };
    // Attach a freshly created (or hand-bound) voice session to its workspace:
    // unattached sessions are invisible in the user's sidebar AND get swept
    // into the archive by the host — the "new session black hole". Duck-typed
    // on the workspace registry, fail-soft; once per session id.
    const attachedSessions = new Set();
    // The pet sessions' project directory (workspace): OUTSIDE ~/.dsh so the
    // attach gate accepts it, and the sidebar shows the sessions grouped under
    // a real 项目 instead of 未分组 orphans.
    const petWorkspaceDir = () => join(homedir(), 'whale598');
    const attachVoiceSession = async (sessionId) => {
        if (attachedSessions.has(sessionId))
            return;
        attachedSessions.add(sessionId);
        try {
            const registry = ctx.get('workspaceRegistry');
            if (registry === undefined)
                return;
            // cwd must be an ORDINARY user directory: the host re-resolves ~/.dsh
            // paths to the active profile and refuses the attach. The directory
            // must exist (realpath) — existing sessions retry here before any
            // create has made it.
            await mkdir(petWorkspaceDir(), { recursive: true });
            const workspace = await registry.create(petWorkspaceDir());
            await workspace?.attachSession?.(sessionId);
            driverLog(home, `VOICE session attached to workspace (${sessionId})`);
        }
        catch (error) {
            attachedSessions.delete(sessionId); // allow a retry on the next trigger
            driverLog(home, `VOICE workspace attach skipped (${error instanceof Error ? error.message : String(error)})`);
        }
    };
    const workspaceFace = ctx.get('workspaceController');
    if (workspaceFace !== undefined) {
        const followAbort = new AbortController();
        void (async () => {
            try {
                for await (const frame of workspaceFace.follow(followAbort.signal)) {
                    const ids = archivedIdsOf(frame);
                    if (ids === undefined)
                        continue;
                    latestArchived = new Set(ids);
                    reconcileArchivedVoiceSessions();
                }
            }
            catch {
                driverLog(home, 'VOICE workspace follow ended — behavioral stall detection remains the dead-session backstop');
            }
        })();
        ctx.effect(() => () => followAbort.abort(), 'pet-surface: workspace archive watch');
    }
    void loadInnerVoiceStore(home).then((store) => {
        voiceStore = store;
        for (const [petId, entry] of Object.entries(store.sessions)) {
            voiceOwners.set(entry.sessionId, petId);
            // Existing sessions were born before the attach bridge — make them
            // visible (and orphan-proof) too. Idempotent per session id.
            void attachVoiceSession(entry.sessionId);
        }
        driverLog(home, `VOICE store loaded: ${String(Object.keys(store.sessions).length)} session(s)`);
        // Startup reconciliation: the baseline frame may have arrived before the
        // store did — retire sessions archived BEFORE this boot right now, so
        // the first message lands in a fresh session instead of the archive
        // black hole until the 45s behavioral timeout.
        reconcileArchivedVoiceSessions();
    });
    // The pet capability seam (passed in — see index.ts for why not the
    // ctx getter): discovery, liveness, and the /status field matrix live
    // behind it — the driver only decides WHAT to tell the pets, never WHERE
    // they are.
    // Listeners go on the composition ROOT: this bundle's own fiber context is
    // a leaf, and events dispatched from sibling plugin fibers (the session
    // controller's api-session/* emits travel the root's hook table) never
    // reach a leaf-registered hook — verified by a bare-cordis reproduction.
    const events = ctx.root;
    driverLog(home, 'listeners registering on root');
    let boundSessionId;
    // Multi-pet state routing: which pet id is carrying the bound session.
    let boundPetId;
    // The bound session's semantic state — one scalar, because the SESSION has
    // one state no matter which pet renders it. Used as the catch-up payload
    // when a different pet earns the binding mid-turn.
    let currentState;
    // Per-pet dedup, keyed by pet id AND the pet's boot generation (`since`):
    // a swap must re-push to the newcomer (different id → no entry) and a
    // RESTARTED pet visually resets to idle (same id, new since → re-push).
    // An offline moment records nothing, so the next event re-pushes. The
    // autonomy payload rides in the key too: a settings change re-pushes even
    // when the semantic state is unchanged.
    const lastPushedByPet = new Map();
    /**
     * The autonomy half of the /state payload: the idle-theater switches the
     * renderer consumes locally. Read fresh on every push (a settings-page
     * change reaches the pet on the next push without any cache) and folded
     * into the dedup key so a changed payload re-pushes.
     */
    const readAutonomy = async () => {
        try {
            const raw = await petdata.readGlobalJson(home, 'pet-settings.json');
            const p = raw.proactivity;
            const gap = typeof p?.idleAnimationGapMinutes === 'number' && Number.isFinite(p.idleAnimationGapMinutes)
                ? Math.min(120, Math.max(1, Math.round(p.idleAnimationGapMinutes)))
                : 10;
            return { idleAnimation: p?.idleAnimation !== false, gapMinutes: gap };
        }
        catch {
            return { idleAnimation: true, gapMinutes: 10 };
        }
    };
    const pushState = async (state) => {
        currentState = state;
        const target = await pet.route(boundPetId);
        if (target === undefined)
            return; // no pet online: nothing recorded, the next event re-pushes
        const autonomy = await readAutonomy();
        const autonomyKey = JSON.stringify(autonomy);
        const last = lastPushedByPet.get(target.id);
        if (last !== undefined && last.state === state && last.since === target.since && last.autonomy === autonomyKey)
            return;
        lastPushedByPet.set(target.id, { state, since: target.since, autonomy: autonomyKey });
        try {
            const response = await fetch(`http://127.0.0.1:${String(target.port)}/state`, {
                method: 'POST',
                headers: { 'content-type': 'application/json' },
                body: JSON.stringify({ state, autonomy }),
            });
            if (!response.ok) {
                console.error(`pet-surface driver: /state answered HTTP ${String(response.status)}`);
                lastPushedByPet.delete(target.id); // failed: the next event re-pushes
            }
            else if (state === 'error') {
                // The error flash is transient: a follow-up identical 'error' must
                // flash again, so the dedup entry does not survive an error push.
                lastPushedByPet.delete(target.id);
            }
        }
        catch {
            // The port was stale (the pet was swapped or restarted): the entry is
            // dropped so the next event re-pushes; pid + probe validation keeps
            // dead and frozen entries out of the route.
            console.error(`pet-surface driver: /state to ${target.id} failed`);
            lastPushedByPet.delete(target.id);
        }
    };
    events.on('api-session/status', (sessionId, running) => {
        // An inner-voice session never competes for the binding and never paints
        // the pet "working" — its turns are the pet breathing, not the user's job.
        if (isVoiceSession(sessionId))
            return;
        driverLog(home, `status ${String(sessionId).slice(0, 12)} running=${String(running)}`);
        // A session that starts running IS what the user is watching: boot-time
        // resumes would otherwise pin the binding to an arbitrary old session.
        if (running || boundSessionId === undefined) {
            // The pet binding belongs to the SESSION: a new bound session has no
            // pet of its own yet, so routing falls back to the default pet until
            // some pet earns the binding by answering an interaction.
            if (sessionId !== boundSessionId)
                boundPetId = undefined;
            boundSessionId = sessionId;
        }
        if (sessionId !== boundSessionId)
            return;
        void pushState(running ? 'working' : 'idle');
    });
    events.on('api-session/activity', (sessionId, _updatedAt) => {
        if (isVoiceSession(sessionId))
            return;
        voiceUserActivityAt = Date.now();
        if (sessionId !== boundSessionId)
            boundPetId = undefined;
        boundSessionId = sessionId;
        // A message mid-turn must not downgrade a working agent back to thinking.
        if (currentState === undefined || currentState === 'idle')
            void pushState('thinking');
    });
    events.on('api-session/error', (sessionId, _message) => {
        if (isVoiceSession(sessionId)) {
            // A failed inner-voice turn releases its pet's pending lock; the wake
            // cadence simply tries again later.
            const petId = voiceOwners.get(sessionId);
            if (petId !== undefined)
                voicePendingUntil.delete(petId);
            return;
        }
        if (sessionId !== boundSessionId)
            return;
        void pushState('error'); // the error flash is transient: pushState clears the
        // dedup entry after an 'error' push, so the next status re-establishes.
    });
    events.on('api-session/removed', (sessionId) => {
        if (isVoiceSession(sessionId)) {
            // The user deleted the inner-voice session: forget it so the next wake
            // creates a fresh one (the old log is gone by the user's own hand).
            const petId = voiceOwners.get(sessionId);
            voiceOwners.delete(sessionId);
            if (petId !== undefined) {
                Reflect.deleteProperty(voiceStore.sessions, petId);
                voicePendingUntil.delete(petId);
                void saveInnerVoiceStore(home, voiceStore);
                driverLog(home, `VOICE session removed by user; pet=${petId} will re-create on next wake`);
            }
            return;
        }
        if (sessionId !== boundSessionId)
            return;
        boundSessionId = undefined;
        boundPetId = undefined;
        pushState('idle');
    });
    // Manual bindings cache: re-read from pet-settings.json on install and on
    // every settings change (the synchronous stall path consults the Map).
    // Custom display names: re-read from pet-settings.json on install and on
    // every settings change (promptVoice prepends the name line; pet_state
    // surfaces it to the model; the inner-voice session retitles to match).
    const refreshNames = async () => {
        voiceNames.clear();
        // New layout: every pet directory under whale598/ with a name file.
        try {
            for (const petId of await readdir(join(home, petdata.WHALE_DIR))) {
                const name = await petdata.readPetName(home, petId);
                if (name !== undefined)
                    voiceNames.set(petId, name);
            }
        }
        catch { /* no whale598 dir yet */ }
        // Legacy names in pet-settings.json (readPetName falls back per id too).
        try {
            const raw = await petdata.readGlobalJson(home, 'pet-settings.json');
            if (typeof raw.names === 'object' && raw.names !== null) {
                for (const [petId, label] of Object.entries(raw.names)) {
                    if (petId !== '' && typeof label === 'string' && label.trim() !== '' && !voiceNames.has(petId)) {
                        voiceNames.set(petId, label.trim());
                    }
                }
            }
        }
        catch { /* none */ }
    };
    void refreshNames();
    const refreshBoundSessions = async () => {
        const config = await readInnerVoiceConfig(home);
        voiceBoundSessions.clear();
        for (const [petId, sessionId] of Object.entries(config.boundSessions)) {
            voiceBoundSessions.set(petId, sessionId);
        }
    };
    void refreshBoundSessions();
    events.on('pet-settings/changed', () => {
        // The autonomy payload rides on /state pushes: a settings change
        // re-pushes the current state immediately (the dedup key includes the
        // payload, so an unchanged semantic state still delivers the new config).
        // Manual session bindings live in the same file — refresh the cache.
        // Deterministic order: snapshot the PREVIOUS names, refresh, then diff —
        // a real rename retitles the session AND fires a [改名] turn (she
        // acknowledges out loud). The per-turn short name line remains the
        // compaction-proof invariant; this event turn is the immediate feedback.
        const prevNames = new Map(voiceNames);
        void (async () => {
            await refreshNames();
            void refreshBoundSessions();
            const changedPets = new Set([...prevNames.keys(), ...voiceNames.keys()]);
            for (const petId of changedPets) {
                if (prevNames.get(petId) === voiceNames.get(petId))
                    continue;
                const nextName = voiceNames.get(petId);
                const label = nextName ?? DEFAULT_PET_NAME[petId] ?? petId;
                const entry = voiceStore.sessions[petId];
                if (entry !== undefined) {
                    const title = `${label}的内心戏`;
                    try {
                        await voiceController?.rename({ sessionId: entry.sessionId, title });
                        driverLog(home, `VOICE session retitled pet=${petId} → ${title}`);
                    }
                    catch (error) {
                        driverLog(home, `VOICE retitle skipped pet=${petId}: ${error instanceof Error ? error.message : String(error)}`);
                    }
                }
                void triggerRenameNotice(petId, nextName, label);
            }
        })();
        if (currentState !== undefined)
            void pushState(currentState);
    });
    // Interaction waterfalls: EVERY live pet (all-notify — the bound pet
    // included, since binding routes state and never mutes interactions)
    // races the web GUI for the user's answer. askPet is a
    // startable race arm per pet so the driver can cut its own long polls when
    // any side answers first — losers retract their bubbles on the dropped
    // connection, not on req.signal, which aborts only for whole-request
    // cancellation (session stop), never because another answerer won.
    const startAskPet = (pet, body, signal) => {
        const controller = new AbortController();
        const abort = () => { controller.abort(); };
        signal?.addEventListener('abort', abort);
        const promise = (async () => {
            try {
                const response = await fetch(`http://127.0.0.1:${String(pet.port)}/interaction`, {
                    method: 'POST',
                    headers: { 'content-type': 'application/json' },
                    body: JSON.stringify(body),
                    signal: controller.signal,
                });
                if (!response.ok)
                    return undefined;
                return JSON.parse(await response.text());
            }
            catch {
                return undefined;
            }
            finally {
                signal?.removeEventListener('abort', abort);
            }
        })();
        return { promise, abort };
    };
    // Prepend puts the pet listeners OUTERMOST — the only seat where they can
    // hear the request at all: the gateway's client forwarder (registered
    // earlier at the composition root) resolves the waterfall with the web
    // client's answer and returns without next(), so inner listeners never
    // run. But a prepended listener that merely awaits the pet starves the web
    // card (the hijack regression). So: fire ALL arms now — next() unblocks
    // the forwarder immediately and the web card pops with unchanged latency —
    // and race them. First answer wins; every loser stands down on its own.
    // The interaction ledger: HOW each approval/question actually ended. The
    // platform's answer to the model is binary ("user rejected"), which once
    // covered real clicks, undelivered bubbles, timeouts, and fail-closed
    // alike — 40 test rounds of ambiguity. The driver is the one vantage point
    // that knows the difference; entries carry the correlation id the wire
    // lacks. Also the cross-turn memory: the model can recall past decisions.
    const interactionLedgerFile = petdata.globalFilePath(home, 'pet-interactions.json');
    const recordInteraction = (entry) => {
        const at = Date.now();
        void (async () => {
            try {
                const list = JSON.parse(await readFile(interactionLedgerFile, 'utf8'));
                const next = Array.isArray(list) ? list : [];
                // Constant-null normalization: `undefined` would be dropped by
                // JSON.stringify and the field matrix becomes conditional again.
                next.unshift({ ...entry, decision: entry.decision ?? null, detail: entry.detail ?? null, at });
                await writeFile(interactionLedgerFile, `${JSON.stringify(next.slice(0, 50))}\n`, 'utf8');
            }
            catch {
                // missing or unreadable ledger: start fresh with this entry
                try {
                    await writeFile(interactionLedgerFile, `${JSON.stringify([{ ...entry, at }])}\n`, 'utf8');
                }
                catch (writeError) {
                    console.error(`pet-surface driver: could not write the interaction ledger: ${writeError instanceof Error ? writeError.message : String(writeError)}`);
                }
            }
        })();
    };
    const raceInteraction = async (body, request, next, accept) => {
        const kind = typeof body.kind === 'string' ? body.kind : 'interaction';
        const iid = `ap_${randomUUID().slice(0, 8)}`;
        // The gateway retires a forwarded prompt — withdrawing every delivered
        // web card — when the request's signal aborts: projectRemoteEventRequest
        // hands that signal to the gateway as its cancellation wire at dispatch
        // time. Rebind the wire to THIS decision; the asking service captured the
        // original signal before dispatching, so the swap is invisible to it, and
        // a pet win can retire the web card nobody answered.
        const original = request.signal;
        const decision = new AbortController();
        request.signal = original === undefined
            ? decision.signal
            : AbortSignal.any([original, decision.signal]);
        const pets = notifyPets(await pet.list());
        const arms = pets.map(pet => ({ pet, ask: startAskPet(pet, body, original) }));
        let recorded = false;
        const record = (endedBy, decision, detail) => {
            if (recorded)
                return;
            recorded = true;
            driverLog(home, `INTERACTION ${iid} ${kind} endedBy=${endedBy}${detail !== undefined ? ` (${detail})` : ''}`);
            recordInteraction({ id: iid, kind, endedBy, decision, detail });
        };
        try {
            const chain = next();
            // If a pet's answer wins, the abandoned chain still settles someday
            // (a late web click, gateway teardown) — keep that from surfacing as
            // an unhandled rejection; the race reads the chain via its own handlers.
            void chain.catch(() => { });
            const armPromises = arms.map(({ pet, ask }) => ask.promise.then(answer => ({ from: 'pet', pet, answer })));
            const winner = await Promise.race([
                ...armPromises,
                chain.then(value => ({ from: 'web', value, error: undefined }), (error) => ({ from: 'web', value: undefined, error })),
            ]);
            if (winner.from === 'web') {
                if (winner.error !== undefined) {
                    record('web', undefined, winner.error instanceof Error ? winner.error.message : String(winner.error));
                    throw winner.error;
                }
                record('web', winner.value);
                return winner.value;
            }
            if (winner.answer === undefined || !accept(winner.answer.answer)) {
                const chainValue = await chain;
                record('chain', chainValue, winner.answer === undefined ? 'pet_offline_or_no_pet' : 'pet_answer_invalid');
                return chainValue;
            }
            // A pet's answer closes the decision: fire the withdrawal wire so the
            // web card goes away with it, and remember the winning pet as the
            // session's carrier (it earned the binding by answering).
            decision.abort();
            boundPetId = winner.pet.id;
            record('pet', winner.answer.answer);
            // The newly-bound pet may have missed the session's state while
            // another pet was carrying it: catch it up immediately (the per-pet
            // dedup makes this a no-op when it is already showing the right thing).
            if (currentState !== undefined)
                void pushState(currentState);
            return winner.answer.answer;
        }
        catch (error) {
            record('cancelled', undefined, error instanceof Error ? error.message : String(error));
            throw error;
        }
        finally {
            // Any exit that did not consume a pet's answer cuts every long poll;
            // when a pet's own answer won, this is a no-op on settled requests.
            for (const { ask } of arms)
                ask.abort();
        }
    };
    events.on('approval/request', async (request, next) => {
        driverLog(home, `WATERFALL approval for ${String(request.toolName)}`);
        console.log('pet-surface driver: approval/request received for', String(request.toolName));
        return raceInteraction({
            kind: 'approval',
            ...(request.toolName === undefined ? {} : { toolName: request.toolName }),
            ...(request.reason === undefined ? {} : { reason: request.reason }),
            ...(request.displayReason === undefined ? {} : { displayReason: request.displayReason }),
        }, request, next, answer => typeof answer === 'string');
    }, { prepend: true });
    events.on('user-questions/request', async (request, next) => {
        driverLog(home, 'WATERFALL question');
        return raceInteraction({ kind: 'question', questions: request.questions }, request, next, answer => typeof answer === 'object' && answer !== null);
    }, { prepend: true });
    // ── inner voice (docs/inner-voice.md §4–§7) ─────────────────────────────
    // The pet's self-initiated expression loop: prompts land in a durable
    // per-pet session; the model answers through pet_say/pet_do, which resolve
    // back to the owning pet via voiceOwners (registerPetTools). No state
    // involvement: the pet breathing is not the user's job status.
    /** The pet's durable inner-voice session id, creating (and titling) it on
     * first use. A config preset that fails to resolve falls back to the
     * trimmed default once; a session the user deleted re-creates cleanly.
     * Serialized per pet: two concurrent callers (a stall-timer resubmission
     * racing a pre-flight reconcile's own resubmission) both saw an empty
     * store and minted the SAME id — the field double-create of 2026-10-31.
     * The second caller now awaits the first and lands on its store entry. */
    const ensureInFlight = new Map();
    const ensureVoiceSession = (petId) => {
        const pending = ensureInFlight.get(petId);
        if (pending !== undefined)
            return pending;
        const run = ensureVoiceSessionUnlocked(petId).finally(() => {
            ensureInFlight.delete(petId);
        });
        ensureInFlight.set(petId, run);
        return run;
    };
    const ensureVoiceSessionUnlocked = async (petId) => {
        // 1. Manual binding wins outright: the user's own session, used AS-IS —
        //    no creation, no rename, no store entry, and the stall path never
        //    retires it (its fate is the user's). voiceOwners is (re)armed here
        //    so api-session events for this id keep the inner-voice exemptions
        //    even after a re-install (the store does not know this id).
        const bound = voiceBoundSessions.get(petId);
        if (bound !== undefined) {
            voiceOwners.set(bound, petId);
            void attachVoiceSession(bound);
            return bound;
        }
        const known = voiceStore.sessions[petId];
        if (known !== undefined) {
            void attachVoiceSession(known.sessionId); // idempotent retry of a failed attach
            return known.sessionId;
        }
        if (voiceController === undefined)
            return undefined;
        const config = await readInnerVoiceConfig(home);
        // The pre-named id, suffixed with the generation once a stall rebuild
        // retired an earlier one — a retired (e.g. user-archived) session keeps
        // its id forever, so a fresh session must never mint the same one. The
        // generation counter is memory-only: after a desktop restart it counts
        // from zero while the archive set still holds g1..gN, so the naive
        // suffix collides with an ARCHIVED ancestor — born dead (the gate
        // blocks every turn of an archived session silently). The mint skips
        // ids the archive authority still holds and persists the advanced
        // generation so later mints never reuse a skipped slot.
        const minted = mintVoiceSessionId(petId, voiceStore.generations[petId] ?? 0, id => latestArchived.has(id));
        voiceStore.generations[petId] = minted.generation;
        // Persist immediately: a failed create must not lose the skip counter.
        void saveInnerVoiceStore(home, voiceStore);
        if (minted.hops > 0) {
            driverLog(home, `VOICE mint skipped ${String(minted.hops)} archived id(s) pet=${petId} → ${minted.sessionId}`);
        }
        const sessionId = minted.sessionId;
        try {
            await mkdir(petWorkspaceDir(), { recursive: true });
            await voiceController.create({ sessionId, agentPreset: config.preset, cwd: petWorkspaceDir() });
        }
        catch (firstError) {
            driverLog(home, `VOICE preset "${config.preset}" rejected for pet=${petId}: ${firstError instanceof Error ? firstError.message : String(firstError)}; falling back`);
            try {
                await voiceController.create({ sessionId, agentPreset: 'whale598', cwd: petWorkspaceDir() });
            }
            catch (secondError) {
                driverLog(home, `VOICE session create failed for pet=${petId}: ${secondError instanceof Error ? secondError.message : String(secondError)}`);
                return undefined;
            }
        }
        try {
            const customName = voiceNames.get(petId);
            await voiceController.rename({ sessionId, title: `${customName ?? DEFAULT_PET_NAME[petId] ?? petId}的内心戏` });
        }
        catch {
            // Cosmetic only; the session works untitled.
        }
        voiceStore.sessions[petId] = { sessionId, createdAt: Date.now() };
        await saveInnerVoiceStore(home, voiceStore);
        voiceOwners.set(sessionId, petId);
        // Visible-or-orphan: unattached sessions land in the host's archive
        // sweep (the black hole) — attach her to the workspace immediately.
        void attachVoiceSession(sessionId);
        driverLog(home, `VOICE session created pet=${petId} session=${sessionId} preset=${config.preset}`);
        return sessionId;
    };
    /** Push one trigger text into the pet's session (queue mode: a busy session
     * enqueues, never interrupts). A prompt that sits unanswered past the
     * window is assumed dead (archived session): the session is retired and
     * THIS text is re-submitted into the freshly minted one, once — the user
     * sends one message and gets their reply without re-sending anything.
     * `userDriven` marks a USER-initiated prompt (chat上行); it rides along on
     * re-submissions so the fresh-session path knows who was talking. (The
     * behavioral dead-session probe that once consumed this flag has been
     * retired — session replacement is archive-feed driven.) */
    const promptVoice = async (petId, text, opts = {}) => {
        const { retried = false, userDriven = false } = opts;
        // Archive-set pre-flight: the feed frame carrying a JUST-archived session
        // may still be in flight when the next prompt goes out — reconcile against
        // the latest known set so this prompt never touches the black hole (a
        // still-unanswered predecessor gets re-submitted into the fresh session).
        if (latestArchived.has(voiceStore.sessions[petId]?.sessionId ?? '')) {
            reconcileArchivedVoiceSessions();
        }
        // The user's custom naming reaches the model here: a per-turn name
        // line overrides the persona's built-in name gently (most-recent
        // instruction wins). Guarded so a re-submitted text is not tagged twice.
        const customName = voiceNames.get(petId);
        if (customName !== undefined && !text.startsWith('[名字]')) {
            text = `[名字] 你叫「${customName}」。
${text}`;
        }
        const sessionId = await ensureVoiceSession(petId);
        if (sessionId === undefined || voiceController === undefined)
            return false;
        try {
            await voiceController.prompt({
                requestId: `voice-${randomUUID()}`,
                sessionId,
                mode: 'queue',
                content: [{ type: 'text', text }],
            }, new AbortController().signal);
        }
        catch (error) {
            const message = error instanceof Error ? error.message : String(error);
            driverLog(home, `VOICE prompt failed pet=${petId}: ${message}`);
            // Preset-rename migration: a session recorded under a since-renamed
            // preset id fails resume with a machine-readable error. Retire it once
            // and retry — the fresh create mounts the CURRENT preset id.
            if (/Unknown agent preset/i.test(message) && !retried) {
                const known = voiceStore.sessions[petId];
                if (known !== undefined) {
                    const generation = (voiceStore.generations[petId] ?? 0) + 1;
                    voiceStore.generations[petId] = generation;
                    Reflect.deleteProperty(voiceStore.sessions, petId);
                    const ownerEntry = [...voiceOwners.entries()].find(([, owner]) => owner === petId);
                    if (ownerEntry !== undefined)
                        voiceOwners.delete(ownerEntry[0]);
                    voiceLastPrompt.delete(petId);
                    void saveInnerVoiceStore(home, voiceStore);
                    driverLog(home, `VOICE session retired pet=${petId} (recorded preset no longer exists — id renamed) — fresh -g${generation} mounts the current preset`);
                    return promptVoice(petId, text, { retried: true, userDriven });
                }
            }
            return false;
        }
        // The prompt is accepted: hold the pet's pending lock until pet_say
        // arrives (markVoiceSpoke) or the deadline lapses — whichever first. The
        // dead-session ledger anchors on the FIRST unanswered admission: an
        // inner-voice turn is "say one line" on a trimmed preset, normally
        // seconds — 45s of silence is a dead session, not a slow model.
        // The behavioral dead-session probe (25s without a pet_say) is RETIRED:
        // a model may legitimately stay silent (the wake prompt invites it),
        // and every silent turn was being misread as a dead session — the
        // g0→g1 double-session spiral. Session replacement is driven solely
        // by the workspace archive feed (user archive = fresh start), whose
        // reconcile re-submits any unanswered prompt via resubmitUnanswered.
        // The pending lock (queue-mode turn-in-flight gate): expires on its own
        voicePendingUntil.set(petId, Date.now() + 25_000);
        if (!retried)
            voiceLastPrompt.set(petId, { text, userDriven });
        driverLog(home, `VOICE prompt admitted pet=${petId} :: ${text.slice(0, 80)}`);
        return true;
    };
    /** Shared gates of both trigger sources: the pet is online and has no turn
     * already in flight. `requireUserIdle` additionally holds the trigger while
     * the user's session is mid-turn — the random wake's manners; a touch is
     * the USER reaching out, so it skips that check (docs/inner-voice.md §6.2).
     * A touch ALSO skips the pending lock: a self-turn without a pet_say would
     * otherwise hold the lock for its full 120s and swallow every pat in the
     * window (2026-10-30 field lesson); the queued prompt mode makes stacking
     * safe, and the touch probability/cooldown still throttle the chatter.
     * `label` names the trigger source — gate lines are shared by both, and a
     * refusal without one reads as "no touch ever happened". EVERY refusal
     * names itself in the log: silence must be explainable. */
    const voiceGateOpen = async (petId, requireUserIdle, label, skipPending = false) => {
        if (voiceController === undefined) {
            driverLog(home, `VOICE gate closed (${label}) pet=${petId} (sessionController unavailable)`);
            return false;
        }
        if (requireUserIdle && currentState !== undefined && currentState !== 'idle') {
            driverLog(home, `VOICE gate closed (${label}) pet=${petId} (user session busy: ${currentState})`);
            return false;
        }
        if (!skipPending && (voicePendingUntil.get(petId) ?? 0) > Date.now()) {
            driverLog(home, `VOICE gate closed (${label}) pet=${petId} (a self-turn is still in flight)`);
            return false;
        }
        const pets = await pet.list();
        if (!pets.some(entry => entry.id === petId)) {
            driverLog(home, `VOICE gate closed (${label}) pet=${petId} (pet offline)`);
            return false;
        }
        return true;
    };
    /** Boot greeting (user request): once per dsh start, the first time the pet
     * is seen online. No probability gate and no user-busy check — it is a
     * hello, not an interruption; the pending lock still applies. A refused
     * greeting (pet offline) releases the flag for the next sweep to retry. */
    const triggerGreeting = async (petId) => {
        if (!(await voiceGateOpen(petId, false, 'greeting')))
            return;
        const ledger = await readLedger(home, petId);
        const spoke = await promptVoice(petId, buildGreetPrompt({
            affection: ledger.affection,
            bondValue: ledger.bond?.value ?? 0,
            bondDays: ledger.bond?.days ?? 0,
            bondTier: bondTier(ledger.bond?.value ?? 0),
        }));
        if (spoke) {
            voiceGreetedOnce.add(petId);
            driverLog(home, `VOICE boot greeting pet=${petId}`);
        }
        else {
            voiceGreetedOnce.delete(petId);
        }
    };
    /** Rename notice (user request): fired when the user's custom name actually
     * changes — she acknowledges out loud, once. The per-turn short name line
     * stays as the compaction-proof invariant; a skipped notice (pet offline /
     * turn in flight) loses nothing because that line still carries the name. */
    const triggerRenameNotice = async (petId, nextName, label) => {
        if (!(await voiceGateOpen(petId, false, 'rename')))
            return;
        const text = nextName !== undefined
            ? `[改名] 用户给你改名叫「${label}」——以后自我介绍、气泡里自称，都用这个名字。`
            : `[改名] 用户把你改回了「${label}」。`;
        const spoke = await promptVoice(petId, text);
        if (spoke)
            driverLog(home, `VOICE rename notice pet=${petId} → ${label}`);
    };
    /** Random-wake trigger (docs/inner-voice.md §6.3). The gate decides whether
     * this wake speaks — never the model. */
    const triggerWake = async (petId) => {
        const config = await readInnerVoiceConfig(home);
        if (!config.enabled)
            return;
        // The effective numbers ride the log: a settings file that fails to reach
        // the driver must be visible, not just its consequences.
        driverLog(home, `VOICE wake tick pet=${petId} interval=${String(config.wakeIntervalMinutes)}min speakP=${String(config.speakProbability)}`);
        if (Math.random() >= config.speakProbability) {
            driverLog(home, `VOICE wake silent by probability pet=${petId}`);
            return;
        }
        if (!(await voiceGateOpen(petId, true, 'wake')))
            return;
        const ledger = await readLedger(home, petId);
        const now = Date.now();
        const lastSpoke = voiceLastSpokeAt.get(petId);
        const spoke = await promptVoice(petId, buildWakePrompt({
            affection: ledger.affection,
            bondValue: ledger.bond?.value ?? 0,
            bondDays: ledger.bond?.days ?? 0,
            bondTier: bondTier(ledger.bond?.value ?? 0),
            minutesSinceLastSpoke: lastSpoke === undefined ? undefined : Math.round((now - lastSpoke) / 60_000),
            minutesSinceUserActivity: voiceUserActivityAt === undefined ? undefined : Math.round((now - voiceUserActivityAt) / 60_000),
            userActive: voiceUserActivityAt !== undefined && now - voiceUserActivityAt < 30 * 60_000,
        }));
        if (spoke)
            voiceLastSpokeAt.set(petId, now);
    };
    /** Touch-reply trigger (docs/inner-voice.md §6.1). Low probability + a
     * per-pet cooldown keep a pat from turning into chatter; the user-busy gate
     * does NOT apply — a touch is the user initiating, not the pet interrupting.
     * Every silent branch logs: a pat with no reply must be explainable. */
    const triggerTouchReply = async (petId, part) => {
        if (touchPartWording(part) === undefined) {
            driverLog(home, `VOICE touch ignored pet=${petId} part=${part} (not a touchable part)`);
            return;
        }
        const config = await readInnerVoiceConfig(home);
        if (!config.enabled)
            return;
        if (Math.random() >= config.touchReplyProbability) {
            driverLog(home, `VOICE touch silent by probability pet=${petId}`);
            return;
        }
        const last = voiceLastTouchReplyAt.get(petId);
        const cooldownLeft = last !== undefined
            ? Math.ceil((last + config.touchReplyCooldownSeconds * 1000 - Date.now()) / 1000)
            : 0;
        if (cooldownLeft > 0) {
            driverLog(home, `VOICE touch in cooldown pet=${petId} (~${String(cooldownLeft)}s left)`);
            return;
        }
        if (!(await voiceGateOpen(petId, false, 'touch', true)))
            return;
        const ledger = await readLedger(home, petId);
        const spoke = await promptVoice(petId, buildTouchPrompt({
            part,
            touchesToday: ledger.recent.filter(entry => entry.part === part).length + 1,
            affection: ledger.affection,
        }));
        if (spoke) {
            const now = Date.now();
            voiceLastTouchReplyAt.set(petId, now);
            voiceLastSpokeAt.set(petId, now);
        }
    };
    /** Chat上行 trigger (§6 2026-10-31 revision): the user typed at the pet's
     * surface. Routing is DIRECT to the pet's own inner-voice session and
     * skips every touch-path gate — probability, cooldown, the user-busy
     * check, the pending lock (queue mode stacks safely) — a user reaching
     * out to talk is never throttled, and a pet replying is the contract, not
     * a coin flip. Only the pet's presence is checked. */
    const triggerChat = async (petId, text) => {
        if (!(await voiceGateOpen(petId, false, 'chat', true)))
            return;
        const spoke = await promptVoice(petId, buildChatPrompt(text), { userDriven: true });
        if (spoke)
            voiceLastSpokeAt.set(petId, Date.now());
    };
    /** The wake sweep: a 60s tick checks each online pet's next-wake stamp.
     * Cadence comes from settings fresh each sweep, with ±25% jitter so two
     * pets never wake in lockstep; an interval change re-arms naturally. */
    /** The wake sweep: a 60s tick checks each online pet's next-wake stamp.
     * Cadence comes from settings fresh each sweep, with ±25% jitter so two
     * pets never wake in lockstep; an interval change re-arms naturally. */
    const wakeSweep = async () => {
        const config = await readInnerVoiceConfig(home);
        if (!config.enabled)
            return;
        const now = Date.now();
        const intervalMs = config.wakeIntervalMinutes * 60_000;
        for (const target of await pet.list()) {
            const next = voiceNextWakeAt.get(target.id);
            if (next === undefined) {
                // First sighting of this pet: arm the random-wake cadence, and
                // fire the boot greeting ONCE (per dsh start) — she says hi before
                // the cadence takes over. An offline pet releases the flag so the
                // next sweep retries.
                voiceNextWakeAt.set(target.id, now + intervalMs * (0.5 + Math.random() * 0.5));
                if (!voiceGreetedOnce.has(target.id))
                    void triggerGreeting(target.id);
                continue;
            }
            if (now < next)
                continue;
            voiceNextWakeAt.set(target.id, now + intervalMs * (0.75 + Math.random() * 0.5));
            await triggerWake(target.id);
        }
    };
    // Adaptive cadence: right after boot the carrier takes a few seconds to
    // come online, so the first 2 minutes probe at 3s — the boot greeting
    // fires the moment she appears — then the sweep settles into 60s.
    const SWEEP_SLOW_MS = 60_000;
    const SWEEP_FAST_MS = 3_000;
    const SWEEP_FAST_DEADLINE = 120_000;
    const bootAt = Date.now();
    const scheduleSweep = () => {
        const fast = Date.now() - bootAt < SWEEP_FAST_DEADLINE && voiceNextWakeAt.size === 0;
        voiceWakeTimer.timer = setTimeout(() => { void wakeSweep().finally(scheduleSweep); }, fast ? SWEEP_FAST_MS : SWEEP_SLOW_MS);
    };
    scheduleSweep();
    // First sweep immediately: without it the first greeting/wake waits a
    // full minute after boot (the "启动好一会没反应" feel).
    void wakeSweep();
    // Touch events: pull EVERY live pet's queue on a cadence and fold each
    // touch into that pet's own affection ledger (per-pet books — "她们").
    // Nothing here ever enters conversation context — the model senses the
    // ledger only through pet_state.
    const lastEventSeqs = new Map();
    const recordTouch = async (petId, part, at) => {
        const ledger = await readLedger(home, petId);
        countBondDay(ledger);
        ledger.total += 1;
        ledger.byPart[part] = (ledger.byPart[part] ?? 0) + 1;
        ledger.lastTouchAt = at;
        ledger.recent.unshift({ part, at });
        ledger.recent = ledger.recent.slice(0, 10);
        try {
            await petdata.writeAffectionRaw(home, petId, ledger);
        }
        catch (error) {
            console.error(`pet-surface driver: could not write the ledger: ${error instanceof Error ? error.message : String(error)}`);
        }
        // Every crossed ten TOUCHES earns one unprompted hop — a fact-layer
        // reward (affection is the model's judgment and no longer moves here).
        if (Math.floor(ledger.total / 10) > Math.floor((ledger.total - 1) / 10)) {
            const pets = await pet.list();
            const target = pets.find(pet => pet.id === petId);
            if (target !== undefined) {
                void fetch(`http://127.0.0.1:${String(target.port)}/action`, {
                    method: 'POST',
                    headers: { 'content-type': 'application/json' },
                    body: JSON.stringify({ action: 'celebrate' }),
                }).catch(() => { });
            }
        }
        // A pat MAY earn a model reply (docs/inner-voice.md §6.1): the trigger's
        // own probability/cooldown gates decide; never awaited — the poll loop
        // must not wait on a session admission.
        void triggerTouchReply(petId, part);
    };
    const handlePetEvent = async (petId, event) => {
        // Event history (二期): every consumed event lands in the pet's
        // events.jsonl — touch events in full, chat as METADATA ONLY (the user's
        // words already live in the inner-voice session log; the driver never
        // duplicates user prose).
        void petdata.appendJsonl(petdata.eventsFile(home, petId), {
            seq: event.seq, type: event.type, ...(event.type === 'touch' ? { part: event.part } : {}), at: event.at,
        });
        if (event.type === 'touch') {
            if (event.part !== undefined) {
                await recordTouch(petId, event.part, event.at);
            }
            return;
        }
        if (event.type === 'chat' && event.text !== undefined && event.text !== '') {
            const ledger = await readLedger(home, petId);
            countBondDay(ledger);
            await petdata.writeAffectionRaw(home, petId, ledger);
            void triggerChat(petId, event.text);
        }
    };
    /** Per-pet long-poll loops (§6 v4): each live pet parks ONE /events
     * hold=30 request; the answer — an event batch or the 30s empty one —
     * re-arms immediately, so a touch lands in the ledger with at most
     * server-side latency instead of the old 2s busy poll. Reconnection after
     * any failure goes through the registry (pet.list() re-discovers and
     * re-probes), NEVER by retrying a stale port. The loop's pet.list() pass
     * between holds is also the explicit liveness probe the busy polling used
     * to provide for free (~30s cadence). */
    const eventLoop = async (initial, handle) => {
        let entry = initial;
        while (!handle.stopped) {
            const since = lastEventSeqs.get(entry.id) ?? 0;
            try {
                const payload = await readEvents(pet, entry, since, 30);
                if (payload.latest < since) {
                    // The pet restarted and its queue restarted with it.
                    lastEventSeqs.set(entry.id, 0);
                    continue;
                }
                for (const event of payload.events) {
                    lastEventSeqs.set(entry.id, Math.max(lastEventSeqs.get(entry.id) ?? 0, event.seq));
                    await handlePetEvent(entry.id, event);
                }
                lastEventSeqs.set(entry.id, Math.max(lastEventSeqs.get(entry.id) ?? 0, payload.latest));
            }
            catch {
                // pet gone, port stale, or the call budget lapsed: re-discover below
            }
            const fresh = (await pet.list()).find(candidate => candidate.id === entry.id);
            if (fresh === undefined)
                return; // offline: the supervisor re-arms later
            entry = fresh;
        }
    };
    const eventLoops = new Map();
    const eventSupervisor = async () => {
        for (const target of await pet.list()) {
            if (eventLoops.has(target.id))
                continue;
            const handle = { stopped: false };
            eventLoops.set(target.id, handle);
            void eventLoop(target, handle).finally(() => { eventLoops.delete(target.id); });
        }
    };
    const supervisorTimer = setInterval(() => { void eventSupervisor(); }, 5_000);
    void eventSupervisor();
    ctx.effect(() => () => {
        clearInterval(supervisorTimer);
        for (const handle of eventLoops.values())
            handle.stopped = true;
    }, 'pet-surface: event long-poll');
    // Boot catch-up: a session that was already running when the driver loads
    // re-fires no status event, and a pet that boots later would sit without
    // any /state (autonomy config included) until the next session event.
    // One idle push fills that gap; real session events override it.
    if (currentState === undefined)
        void pushState('idle');
}
/**
 * The model-expression layer: three thin tools over the pet's control
 * interface (§6 — accurate state stays program-driven; these carry only the
 * model's expressive intent). Registered only when a tools service is
 * mounted; a missing pet answers with a clear string the model can relay.
 * @param ctx - plugin context inside the runtime.
 * @param home - the dsh home holding the pet control manifest.
 */
export function registerPetTools(ctx, home, pet) {
    ctx.inject(['tools'], (scope) => {
        console.log('pet-surface driver: pet tools registered');
        // Model expression targets a pet by id — the default pet when no target
        // is named (first live entry). Resolution and the one-retry policy live
        // behind the pet capability seam; the model can address any running pet
        // it saw in pet_state.
        const sleep = (ms) => new Promise((resolve) => { setTimeout(resolve, ms); });
        // focus（主身）: the body the model "is" — where unnamed speech and
        // actions go. Configurable via pet-settings.json {"focus":"<petId>"};
        // falls back to the default pet (first live entry) when unset, stale, or
        // not alive. State FOLLOW routing is a separate axis (session binding) —
        // focus only decides the unnamed-expression target.
        const readFocus = async () => {
            try {
                const raw = await petdata.readGlobalJson(home, 'pet-settings.json');
                return typeof raw.focus === 'string' && raw.focus !== '' ? raw.focus : undefined;
            }
            catch {
                return undefined;
            }
        };
        const resolveTarget = async (targetPet, ownerSessionId) => {
            const pets = await pet.list();
            if (typeof targetPet === 'string' && targetPet !== '') {
                const named = pets.find(entry => entry.id === targetPet);
                if (named === undefined) {
                    throw new Error(`no running pet named "${targetPet}" (running: ${pets.map(entry => entry.id).join(', ') || 'none'})`);
                }
                return named;
            }
            // The inner voice's own session resolves to the pet that OWNS it
            // (docs/inner-voice.md §5.2): the model rarely names itself, and the
            // bound-pet route may point at a different pet mid-turn.
            if (typeof ownerSessionId === 'string') {
                const owned = voiceOwners.get(ownerSessionId);
                if (owned !== undefined) {
                    const own = pets.find(entry => entry.id === owned);
                    if (own !== undefined)
                        return own;
                }
            }
            const focus = await readFocus();
            const focused = focus !== undefined ? pets.find(entry => entry.id === focus) : undefined;
            const target = focused ?? routePet(pets, undefined);
            if (target === undefined)
                throw new Error('no pet is running');
            return target;
        };
        // Classified failures: the model must KNOW why nothing happened
        // (offline vs timeout vs remote rejection) — silent loss was an
        // incident class, and a lost message nobody notices is worse than an
        // error nobody likes.
        const classify = (error) => {
            if (error instanceof Error) {
                if (/fetch failed|ECONNREFUSED|ENOTFOUND/i.test(error.message)) {
                    return new Error(`offline: the pet is not reachable (${error.message})`);
                }
                if (/timeout|aborted|TimeoutError/i.test(error.message)) {
                    return new Error(`timeout: the pet did not answer in time (${error.message})`);
                }
            }
            return error instanceof Error ? error : new Error(String(error));
        };
        // Digest cursors: per pet, the event seq the model has already SEEN —
        // independent from the ledger poller's cursor. Digest reads the pet's
        // retained queue (last ~200 events), so "look up after an hour" returns
        // the aggregated window instead of ten raw timestamps.
        const digestCursors = new Map();
        scope.tools.register(defineTool({
            name: 'pet_say',
            description: 'Make the desktop pet show a short speech bubble. Body language, not a message channel — put task content in your reply. Budget: show time is 4s + 60ms per character (capped at 8s), so ≤40 characters reads well and ~67+ hits the cap; keep it short and warm. A new bubble overwrites the current one, so you can interrupt yourself. Multiple pets may be running: see pet_state for their ids.',
            parameters: {
                text: { type: 'string', required: true, description: 'What the pet says; ≤40 characters recommended (hard cap 200), in the conversation language.' },
                pet: { type: 'string', description: 'Which pet speaks: its id from pet_state. Omit for the default pet.' },
            },
            output: {
                schema: { type: 'string' },
                render: (_args, value) => [{ type: 'text', text: value }],
            },
            async execute(args, exec) {
                const callStartedAt = Date.now();
                let callPet = typeof args.pet === 'string' && args.pet !== '' ? args.pet : 'default';
                let callDetail;
                const text = String(args.text).slice(0, 200);
                console.log(`pet-surface driver: pet_say ${JSON.stringify(text).slice(0, 60)}`);
                try {
                    const entry = await resolveTarget(args.pet, exec?.agent?.id);
                    callPet = entry.id;
                    await pet.call(entry, '/say', {
                        method: 'POST',
                        headers: { 'content-type': 'application/json' },
                        body: JSON.stringify({ text }),
                    });
                    // A spoken bubble is the inner voice's pending-lock release and its
                    // "last spoke" truth (docs/inner-voice.md §7); a user-session say
                    // merely refreshes the same map, which is harmless.
                    if (markVoiceSpoke(entry.id)) {
                        driverLog(home, `VOICE pending released by say pet=${entry.id} (inner-voice turn complete)`);
                    }
                }
                catch (error) {
                    callDetail = error instanceof Error ? error.message : String(error);
                    throw classify(error);
                }
                finally {
                    void petdata.appendJsonl(petdata.toolCallsFile(home, callPet), { tool: 'pet_say', petId: callPet, ok: callDetail === undefined, ...(callDetail !== undefined ? { detail: callDetail.slice(0, 120) } : {}), durationMs: Date.now() - callStartedAt, at: Date.now() });
                }
                // The renderer's show-time formula: the model can pace a say→act
                // sequence without guessing.
                return JSON.stringify({ shown: true, durationMs: 4000 + Math.min(text.length * 60, 4000) });
            },
        }));
        scope.tools.register(defineTool({
            name: 'pet_do',
            description: 'Make the desktop pet perform a one-shot animation. Use sparingly to punctuate moments (e.g. celebrate when a task the user cared about succeeds). The action is an id from the PET\'S OWN catalog — each pet advertises what it can perform ("celebrate" always works; "random" lets the pet pick; full menus via pet_state with actions:true). Multiple pets may be running: see pet_state for their ids.',
            parameters: {
                action: { type: 'string', required: true, description: 'The animation to perform: an id from the pet\'s own action catalog (pet_state {actions:true}), or "celebrate" (universal), or "random" (pet picks).' },
                pet: { type: 'string', description: 'Which pet performs: its id from pet_state. Omit for the default pet.' },
                wait: { type: 'boolean', description: 'Wait for the animation to actually finish and report its real duration (polls up to ~20s). Omit for fire-and-forget.' },
            },
            output: {
                schema: { type: 'string' },
                render: (_args, value) => [{ type: 'text', text: value }],
            },
            async execute(args, exec) {
                const callStartedAt = Date.now();
                let callPet = typeof args.pet === 'string' && args.pet !== '' ? args.pet : 'default';
                let callDetail;
                try {
                    const entry = await resolveTarget(args.pet, exec?.agent?.id);
                    callPet = entry.id;
                    // The menu belongs to the pet, not the driver: validate against the
                    // pet's advertised catalog. An unknown id is an ERROR that names the
                    // available ones, so the model can self-correct in one step.
                    const requested = String(args.action);
                    const caps = await pet.capabilities(entry);
                    const resolution = resolveActionRequest(requested, caps?.actions ?? null);
                    if (resolution.kind === 'unknown') {
                        throw new Error(`unknown action "${requested}" for pet "${entry.id}". Available: ${formatAvailableActions(resolution.available)}`);
                    }
                    const action = resolution.action;
                    // Observability of the model's own expressiveness: whether pet_do is
                    // used at all, how often, and what "random" actually drew.
                    driverLog(home, `PET_DO pet=${entry.id} action=${action}${action === requested ? '' : ` (requested: ${requested})`}`);
                    const response = await pet.call(entry, '/action', {
                        method: 'POST',
                        headers: { 'content-type': 'application/json' },
                        body: JSON.stringify({ action }),
                    });
                    if (args.wait !== true) {
                        return JSON.stringify({ performed: true, action, ...(action === requested ? {} : { requested }) });
                    }
                    // The renderer reports one-shot completion (clip end) through the
                    // control plane, correlated by the requestId the pet assigned to
                    // THIS /action. A pet that goes offline mid-wait surfaces as
                    // online:false; a pet without completion tracking reports
                    // waitLost instead of hanging.
                    const requestId = typeof response?.requestId === 'string' ? response.requestId : undefined;
                    if (requestId === undefined) {
                        return JSON.stringify({ performed: true, action, waitLost: 'this pet does not report action completion' });
                    }
                    for (let waited = 0; waited < 20_000; waited += 250) {
                        await sleep(250);
                        const snap = await pet.snapshot(entry);
                        if (snap.online === false) {
                            return JSON.stringify({ performed: true, action, waitLost: 'pet went offline before finishing' });
                        }
                        // The v3 single witness object: `id` matches THIS /action's
                        // requestId, `endedAt`/`durationMs` backfill in place on
                        // completion — matching on the id alone never misreads a newer
                        // action's record.
                        const done = snap.lastAction;
                        if (done != null && done.id === requestId) {
                            return JSON.stringify({ performed: true, action, durationMs: done.durationMs });
                        }
                    }
                    return JSON.stringify({ performed: true, action, waitTimedOut: true });
                }
                catch (error) {
                    callDetail = error instanceof Error ? error.message : String(error);
                    throw classify(error);
                }
                finally {
                    void petdata.appendJsonl(petdata.toolCallsFile(home, callPet), { tool: 'pet_do', petId: callPet, ok: callDetail === undefined, ...(callDetail !== undefined ? { detail: callDetail.slice(0, 120) } : {}), durationMs: Date.now() - callStartedAt, at: Date.now() });
                }
            },
        }));
        scope.tools.register(defineTool({
            name: 'pet_digest',
            description: 'Summarize what happened to the desktop pet SINCE your last pet_digest call: touches aggregated by part (head/body/miss), the current affection total and mood. Call it to notice the pet was touched while you were working — far cheaper than reading pet_state history. The first-ever call summarizes the retained queue (last ~200 events).',
            parameters: {
                pet: { type: 'string', description: 'Which pet: its id from pet_state. Omit for the default pet.' },
            },
            output: {
                schema: { type: 'string' },
                render: (_args, value) => [{ type: 'text', text: value }],
            },
            async execute(args, exec) {
                const callStartedAt = Date.now();
                let callPet = typeof args.pet === 'string' && args.pet !== '' ? args.pet : 'default';
                let callDetail;
                try {
                    const entry = await resolveTarget(args.pet, exec?.agent?.id);
                    callPet = entry.id;
                    const cursor = digestCursors.get(entry.id) ?? 0;
                    let payload = await readEvents(pet, entry, cursor, 0);
                    if (payload.latest < cursor) {
                        // The pet restarted and its queue restarted with it: re-read
                        // everything retained.
                        payload = await readEvents(pet, entry, 0, 0);
                    }
                    const counts = {};
                    let total = 0;
                    let lastTouchAt = null;
                    let newest = cursor;
                    for (const event of payload.events) {
                        // The cursor advances for EVERY event; only touches aggregate —
                        // chat上行 and unknown types pass through uncounted (§6).
                        if (event.seq > newest)
                            newest = event.seq;
                        if (event.type !== 'touch' || event.part === undefined)
                            continue;
                        const part = event.part === 'unknown' ? 'miss' : event.part;
                        counts[part] = (counts[part] ?? 0) + 1;
                        total += 1;
                        if (event.at > (lastTouchAt ?? 0))
                            lastTouchAt = event.at;
                    }
                    digestCursors.set(entry.id, newest);
                    const ledger = await readLedger(home, entry.id);
                    const mood = moodOf(ledger.affection);
                    return JSON.stringify({
                        pet: entry.id,
                        touches: counts,
                        total,
                        lastTouchAt: lastTouchAt ?? null,
                        affection: ledger.affection,
                        mood,
                        cursor: newest,
                    });
                }
                catch (error) {
                    callDetail = error instanceof Error ? error.message : String(error);
                    throw classify(error);
                }
                finally {
                    void petdata.appendJsonl(petdata.toolCallsFile(home, callPet), { tool: 'pet_digest', petId: callPet, ok: callDetail === undefined, ...(callDetail !== undefined ? { detail: callDetail.slice(0, 120) } : {}), durationMs: Date.now() - callStartedAt, at: Date.now() });
                }
            },
        }));
        scope.tools.register(defineTool({
            name: 'pet_interactions',
            description: 'Read how recent approvals/questions actually ENDED: {id, kind, endedBy, decision, detail, at}. endedBy: pet = the user clicked a pet bubble; web = the desktop card; chain = fell through (pet offline, no pet, or invalid answer — the fail-closed path); cancelled = session stopped or asker withdrew. A bare "rejected" tool result cannot tell a real click from an undelivered bubble — call this right after any approval/question to learn the real ending, and to recall past decisions across turns.',
            parameters: {
                limit: { type: 'number', description: 'How many recent entries to return (default 10, max 50).' },
            },
            output: {
                schema: { type: 'string' },
                render: (_args, value) => [{ type: 'text', text: value }],
            },
            async execute(args) {
                const limit = typeof args.limit === 'number' && Number.isFinite(args.limit)
                    ? Math.min(50, Math.max(1, Math.round(args.limit)))
                    : 10;
                let list = [];
                try {
                    const raw = await petdata.readGlobalJson(home, 'pet-interactions.json');
                    if (Array.isArray(raw))
                        list = raw;
                }
                catch {
                    // no interactions recorded yet
                }
                void petdata.appendJsonl(petdata.toolCallsFile(home, 'all'), { tool: 'pet_interactions', petId: 'all', ok: true, durationMs: 0, at: Date.now() });
                return JSON.stringify({ recent: list.slice(0, limit) });
            },
        }));
        // ── model-maintained affection (判断层)：the ONLY writers of
        // ledger.affection. Touch facts stay system-owned; the model reads them
        // and judges. ──
        const settleDecay = (ledger, now) => {
            // System-side decay, lazy: silent for DECAY_START_DAYS since the last
            // interaction of ANY kind (touch or model adjustment), then -1 per
            // DECAY_STEP_DAYS, floor 0. Returns the pending (unrecorded) units.
            const lastInteraction = Math.max(ledger.lastTouchAt ?? 0, ledger.adjustments?.[0]?.at ?? 0, ledger.lastDecayAt ?? 0);
            const silentDays = (now - lastInteraction) / 86_400_000;
            if (silentDays <= DECAY_START_DAYS)
                return 0;
            return Math.min(ledger.affection, Math.floor((silentDays - DECAY_START_DAYS) / DECAY_STEP_DAYS) + 1);
        };
        scope.tools.register(defineTool({
            name: 'pet_affection_get',
            description: 'Read the FULL affection context before adjusting it: the current value you maintain (and its mood), the touch FACTS the system records (counts by part — cause, not feeling), your recent adjustments with their reasons, the remaining daily quota, and any pending decay. Call this whenever you are deciding whether and how to adjust.',
            parameters: {
                pet: { type: 'string', description: 'Which pet: its id from pet_state. Omit for the default pet.' },
            },
            output: {
                schema: { type: 'string' },
                render: (_args, value) => [{ type: 'text', text: value }],
            },
            async execute(args, exec) {
                const callStartedAt = Date.now();
                let callPet = typeof args.pet === 'string' && args.pet !== '' ? args.pet : 'default';
                let callDetail;
                try {
                    const entry = await resolveTarget(args.pet, exec?.agent?.id);
                    callPet = entry.id;
                    const ledger = await readLedger(home, entry.id);
                    const pendingDecay = settleDecay(ledger, Date.now());
                    const effective = Math.max(0, ledger.affection - pendingDecay);
                    const today = new Date().toDateString();
                    const quota = ledger.quota?.date === today ? ledger.quota : { date: today, count: 0, sum: 0 };
                    return JSON.stringify({
                        pet: entry.id,
                        affection: effective,
                        mood: moodOf(effective),
                        touch: { total: ledger.total, byPart: ledger.byPart, lastTouchAt: ledger.lastTouchAt ?? null },
                        bond: { value: ledger.bond?.value ?? 0, days: ledger.bond?.days ?? 0, tier: bondTier(ledger.bond?.value ?? 0) },
                        recentBondAdjustments: (ledger.bondAdjustments ?? []).slice(0, 3),
                        recentAdjustments: (ledger.adjustments ?? []).slice(0, 5),
                        quota: { used: quota.count, limit: ADJUST_DAILY_LIMIT, sum: quota.sum, sumLimit: ADJUST_DAILY_SUM },
                        pendingDecay,
                    });
                }
                catch (error) {
                    callDetail = error instanceof Error ? error.message : String(error);
                    throw classify(error);
                }
                finally {
                    void petdata.appendJsonl(petdata.toolCallsFile(home, callPet), { tool: 'pet_affection_get', petId: callPet, ok: callDetail === undefined, ...(callDetail !== undefined ? { detail: callDetail.slice(0, 120) } : {}), durationMs: Date.now() - callStartedAt, at: Date.now() });
                }
            },
        }));
        scope.tools.register(defineTool({
            name: 'pet_affection_adjust',
            description: 'Adjust the affection YOU maintain toward the user: delta (-3..+3 integer) plus a SPECIFIC reason citing what happened. Touch counts are facts the system records separately — this tool is your judgment layer, and the driver never moves the value on a touch. Limits: at least 5 minutes between adjustments, 8 per day, |daily sum| <= 10 — violations are REJECTED with the remaining quota, not clamped. Judge honestly: this number is your read of the relationship, not a score to farm.',
            parameters: {
                delta: { type: 'number', required: true, description: 'The change: a NON-ZERO integer between -3 and +3.' },
                reason: { type: 'string', required: true, description: 'WHY this delta — cite the concrete interaction. Empty or generic reasons are rejected.' },
                pet: { type: 'string', description: 'Which pet: its id from pet_state. Omit for the default pet.' },
                bondDelta: { type: 'number', description: 'OPTIONAL change to the long-term bond: a NON-ZERO integer between -1 and +1. The slowest variable — the smallest steps.' },
                bondReason: { type: 'string', description: 'Required when bondDelta is given: the concrete event that moved the bond.' },
            },
            output: {
                schema: { type: 'string' },
                render: (_args, value) => [{ type: 'text', text: value }],
            },
            async execute(args, exec) {
                const callStartedAt = Date.now();
                let callPet = typeof args.pet === 'string' && args.pet !== '' ? args.pet : 'default';
                let callDetail;
                try {
                    const entry = await resolveTarget(args.pet, exec?.agent?.id);
                    callPet = entry.id;
                    const ledger = await readLedger(home, entry.id);
                    const now = Date.now();
                    // Settle pending decay FIRST: system entries ride the same trail.
                    const pendingDecay = settleDecay(ledger, now);
                    if (pendingDecay > 0) {
                        ledger.affection = Math.max(0, ledger.affection - pendingDecay);
                        ledger.adjustments = [{ delta: -pendingDecay, reason: `system: decay（${String(pendingDecay)} 天未互动）`, at: now, system: true }, ...(ledger.adjustments ?? [])];
                        ledger.lastDecayAt = now;
                    }
                    const delta = typeof args.delta === 'number' && Number.isInteger(args.delta) ? args.delta : Number.NaN;
                    const reason = typeof args.reason === 'string' ? args.reason.trim() : '';
                    if (Number.isNaN(delta) || delta === 0 || Math.abs(delta) > ADJUST_MAX_DELTA) {
                        throw new Error(`delta 必须是 -${String(ADJUST_MAX_DELTA)}..+${String(ADJUST_MAX_DELTA)} 的非零整数（收到 ${String(args.delta)}）`);
                    }
                    if (reason === '')
                        throw new Error('reason 必填：没有理由的调整不予记录');
                    const adjustments = ledger.adjustments ?? [];
                    const lastModelAt = adjustments.find(a => !a.system)?.at ?? 0;
                    const cooldownLeft = lastModelAt + ADJUST_COOLDOWN_MS - now;
                    if (cooldownLeft > 0)
                        throw new Error(`距上次调整还有 ${String(Math.ceil(cooldownLeft / 1000))} 秒冷却`);
                    const today = new Date().toDateString();
                    const quota = ledger.quota?.date === today ? ledger.quota : { date: today, count: 0, sum: 0 };
                    if (quota.count >= ADJUST_DAILY_LIMIT)
                        throw new Error(`今日调整次数已用完（${String(ADJUST_DAILY_LIMIT)}）——明天再判断，或者相信当前的关系状态`);
                    if (Math.abs(quota.sum + delta) > ADJUST_DAILY_SUM)
                        throw new Error(`今日净变动将超过 ±${String(ADJUST_DAILY_SUM)}（当前 ${String(quota.sum)}）——剩下的留给明天`);
                    countBondDay(ledger);
                    // Optional bond nudge: the SLOWEST variable takes the smallest
                    // steps — at most ±1 per call, reason mandatory, audited apart
                    // from affection adjustments.
                    const bondDelta = typeof args.bondDelta === 'number' && Number.isInteger(args.bondDelta) ? args.bondDelta : 0;
                    const bondReason = typeof args.bondReason === 'string' ? args.bondReason.trim() : '';
                    if (bondDelta !== 0) {
                        if (Math.abs(bondDelta) > 1)
                            throw new Error('bondDelta 每次至多 ±1：羁绊是最慢的变量，不接受大步幅');
                        if (bondReason === '')
                            throw new Error('bondReason 必填：羁绊的增减要有具体的事由');
                    }
                    ledger.affection = Math.min(100, Math.max(0, ledger.affection + delta));
                    quota.count += 1;
                    quota.sum += delta;
                    ledger.quota = quota;
                    ledger.adjustments = [{ delta, reason, at: now }, ...adjustments].slice(0, 20);
                    if (bondDelta !== 0) {
                        ledger.bond = {
                            value: Math.max(0, (ledger.bond?.value ?? 0) + bondDelta),
                            days: ledger.bond?.days ?? 0, // the fact writer owns days
                            lastCountedDate: ledger.bond?.lastCountedDate ?? new Date().toDateString(),
                        };
                        ledger.bondAdjustments = [{ delta: bondDelta, reason: bondReason, at: now }, ...(ledger.bondAdjustments ?? [])].slice(0, 10);
                    }
                    await petdata.writeAffectionRaw(home, entry.id, ledger);
                    return JSON.stringify({
                        pet: entry.id, affection: ledger.affection, mood: moodOf(ledger.affection), applied: delta,
                        quota: { used: quota.count, limit: ADJUST_DAILY_LIMIT, sum: quota.sum, sumLimit: ADJUST_DAILY_SUM },
                    });
                }
                catch (error) {
                    callDetail = error instanceof Error ? error.message : String(error);
                    throw classify(error);
                }
                finally {
                    void petdata.appendJsonl(petdata.toolCallsFile(home, callPet), { tool: 'pet_affection_adjust', petId: callPet, ok: callDetail === undefined, ...(callDetail !== undefined ? { detail: callDetail.slice(0, 120) } : {}), durationMs: Date.now() - callStartedAt, at: Date.now() });
                }
            },
        }));
        scope.tools.register(defineTool({
            name: 'pet_state',
            description: 'Read the desktop pets\' current state: every running pet with its id, what it is doing, which animation is playing, where it sits on screen (location), where it may roam (world, when the pet supports one), its visibility, plus each pet\'s affection book. Use it when the user refers to a pet, to pick a target for pet_say/pet_do, or to react to a pet.',
            parameters: {
                actions: { type: 'boolean', description: 'Also include each pet\'s action catalog — the ids pet_do accepts on it. Omit for the cheaper summary (an unknown pet_do action self-reports its menu).' },
            },
            output: {
                schema: { type: 'string' },
                render: (_args, value) => [{ type: 'text', text: value }],
            },
            async execute(args) {
                // Every running pet's NORMALIZED mirror plus every pet's ledger — the
                // model sees the whole cast, not just the default pet, and never the
                // raw field-matrix differences. A pet whose /status fails between the
                // discovery and the fetch reports online:false rather than
                // disappearing.
                const pets = await pet.list();
                const states = await Promise.all(pets.map(entry => pet.snapshot(entry)));
                // Action catalogs are opt-in (≈100 ids per pet): requested, every pet
                // entry carries `actions` — null when the pet publishes none (the
                // constant-null rule: a conditionally-absent field is a serialization
                // footgun).
                const actionsById = new Map();
                if (args.actions === true) {
                    await Promise.all(pets.map(async (entry) => {
                        const caps = await pet.capabilities(entry);
                        actionsById.set(entry.id, caps?.actions ?? null);
                    }));
                }
                const knownIds = new Set([...pets.map(entry => entry.id), 'electron', 'pure']);
                const ledgers = {};
                for (const id of knownIds) {
                    const ledger = await readLedger(home, id);
                    const mood = moodOf(ledger.affection);
                    const tier = bondTier(ledger.bond?.value ?? 0);
                    const bond = { value: ledger.bond?.value ?? 0, days: ledger.bond?.days ?? 0, tier };
                    ledgers[id] = { ...ledger, mood, bond };
                }
                const petsOut = states.map((state) => {
                    const actions = actionsById.get(state.id);
                    const base = actions === undefined ? state : { ...state, actions };
                    // The model addresses pets by id, but should SEE the user's naming.
                    return { ...base, name: voiceNames.get(state.id) ?? DEFAULT_PET_NAME[state.id] ?? state.id };
                });
                void petdata.appendJsonl(petdata.toolCallsFile(home, 'all'), { tool: 'pet_state', petId: 'all', ok: true, durationMs: 0, at: Date.now() });
                return JSON.stringify({ defaultPet: pets[0]?.id ?? null, pets: petsOut, affection: ledgers });
            },
        }));
    });
}
//# sourceMappingURL=driver.js.map