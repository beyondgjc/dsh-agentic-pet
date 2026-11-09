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
import { spawn } from 'node:child_process';
import { existsSync } from 'node:fs';
import { rm } from 'node:fs/promises';
import { join } from 'node:path';
import { isPetPreset, patchTouchesElectronBinding, } from "./binding.js";
import { voiceBindingSnapshot } from "./driver.js";
import { readElectronRuntimeStatus } from "./electron-runtime-status.js";
import { DEFAULT_PERSONA, MAX_PERSONA_CHARS } from "./persona.js";
import { parseClock } from "./rhythm.js";
const DEFAULT_SETTINGS = {
    proactivity: {
        enabled: false,
        cooldownMinutes: 10,
        idleThresholdMinutes: 5,
        idleAnimation: true,
        idleAnimationGapMinutes: 10,
    },
    innerVoice: {
        enabled: true,
        preset: 'whale598',
        wakeIntervalMinutes: 2,
        speakProbability: 0.5,
        touchReplyProbability: 0.3,
        touchReplyCooldownSeconds: 30,
        selfWakeBusyPolicy: 'fire',
        petToPetDelivery: 'queue',
        petMessageLimits: { minutes5: 5, minutes10: 8, minutes30: 10, minutes60: 15 },
        boundSessions: {},
    },
    rhythm: { quiet: null },
    journal: {
        enabled: true,
        injectRecent: 3,
        maxEntryChars: 120,
        maxFileBytes: 256 * 1024,
        allowUnboundAppend: false,
    },
    presenceSummary: { enabled: false },
    tts: { enabled: false },
    debug: { cdp: false },
};
/** The touch ledger the driver owns; reset writes the driver's empty shape. */
import * as petdata from "./petdata.js";
const EMPTY_LEDGER = { affection: 0, total: 0, byPart: {}, recent: [] };
/** Same-origin loopback fence (dsh-qqbot precedent): local host only, no

 * cross-site fetches, and an Origin header — when present — must be this

 * server's own host. */
function isTrusted(req) {
    const host = req.headers.host;
    if (typeof host !== 'string')
        return false;
    let hostname;
    try {
        hostname = new URL(`http://${host}`).hostname;
    }
    catch {
        return false;
    }
    if (!/^(\[::1\]|localhost|127(\.\d{1,3}){3})$/.test(hostname))
        return false;
    if (req.headers['sec-fetch-site'] === 'cross-site')
        return false;
    const origin = req.headers.origin;
    if (origin === undefined)
        return true;
    try {
        return new URL(origin).host === host;
    }
    catch {
        return false;
    }
}
function writeJson(res, status, body) {
    res.writeHead(status, { 'content-type': 'application/json; charset=utf-8' });
    res.end(JSON.stringify(body));
}
async function readJsonBody(req) {
    const chunks = [];
    let size = 0;
    for await (const chunk of req) {
        size += chunk.length;
        if (size > 1024 * 1024)
            return undefined;
        chunks.push(chunk);
    }
    try {
        const parsed = JSON.parse(Buffer.concat(chunks).toString('utf8'));
        return typeof parsed === 'object' && parsed !== null ? parsed : undefined;
    }
    catch {
        return undefined;
    }
}
/** Clamp a number into [min, max]; undefined passthrough for absent input. */
function clampNumber(value, min, max) {
    if (typeof value !== 'number' || !Number.isFinite(value))
        return undefined;
    return Math.min(max, Math.max(min, Math.round(value)));
}
/** Merge a patch into the settings, accepting only the known keys. Exported
 * for the persona-merge spec (tests/persona.spec.ts). */
export function mergeSettings(current, patch) {
    const proactivity = { ...DEFAULT_SETTINGS.proactivity, ...current.proactivity };
    const innerVoice = { ...DEFAULT_SETTINGS.innerVoice, ...current.innerVoice };
    const rhythm = { quiet: null, ...current.rhythm };
    const journal = { ...DEFAULT_SETTINGS.journal, ...current.journal };
    const presenceSummary = { enabled: false, ...current.presenceSummary };
    const debug = { ...DEFAULT_SETTINGS.debug, ...current.debug };
    const patchProactivity = patch.proactivity;
    if (typeof patchProactivity === 'object' && patchProactivity !== null) {
        const p = patchProactivity;
        if (typeof p.enabled === 'boolean')
            proactivity.enabled = p.enabled;
        const cooldown = clampNumber(p.cooldownMinutes, 1, 240);
        if (cooldown !== undefined)
            proactivity.cooldownMinutes = cooldown;
        const idle = clampNumber(p.idleThresholdMinutes, 1, 240);
        if (idle !== undefined)
            proactivity.idleThresholdMinutes = idle;
        if (typeof p.idleAnimation === 'boolean')
            proactivity.idleAnimation = p.idleAnimation;
        const gap = clampNumber(p.idleAnimationGapMinutes, 1, 120);
        if (gap !== undefined)
            proactivity.idleAnimationGapMinutes = gap;
    }
    const patchInnerVoice = patch.innerVoice;
    if (typeof patchInnerVoice === 'object' && patchInnerVoice !== null) {
        const v = patchInnerVoice;
        if (typeof v.enabled === 'boolean')
            innerVoice.enabled = v.enabled;
        if (typeof v.preset === 'string' && v.preset !== '')
            innerVoice.preset = v.preset;
        const wake = clampNumber(v.wakeIntervalMinutes, 1, 60);
        if (wake !== undefined)
            innerVoice.wakeIntervalMinutes = wake;
        // Probabilities stay fractional: clamp without the round() clampNumber applies.
        if (typeof v.speakProbability === 'number' && Number.isFinite(v.speakProbability)) {
            innerVoice.speakProbability = Math.min(1, Math.max(0, v.speakProbability));
        }
        if (typeof v.touchReplyProbability === 'number' && Number.isFinite(v.touchReplyProbability)) {
            innerVoice.touchReplyProbability = Math.min(1, Math.max(0, v.touchReplyProbability));
        }
        const replyCooldown = clampNumber(v.touchReplyCooldownSeconds, 0, 600);
        if (replyCooldown !== undefined)
            innerVoice.touchReplyCooldownSeconds = replyCooldown;
        // 自主唤醒忙时策略：只收白名单里的两个值，其余折叠默认（'fire'）。
        if (v.selfWakeBusyPolicy === 'defer' || v.selfWakeBusyPolicy === 'fire') {
            innerVoice.selfWakeBusyPolicy = v.selfWakeBusyPolicy;
        }
        // 宠物间消息投递方式：白名单两值，其余折叠默认（'queue'）。
        if (v.petToPetDelivery === 'immediate' || v.petToPetDelivery === 'queue') {
            innerVoice.petToPetDelivery = v.petToPetDelivery;
        }
        // 宠物间定向消息分档限频上限：逐档钳 0-999，patch 缺的档位保持现值。
        const patchLimits = v.petMessageLimits;
        if (typeof patchLimits === 'object' && patchLimits !== null) {
            const merged = { minutes5: 5, minutes10: 8, minutes30: 10, minutes60: 15, ...innerVoice.petMessageLimits };
            const base = {
                minutes5: merged.minutes5 ?? 5,
                minutes10: merged.minutes10 ?? 8,
                minutes30: merged.minutes30 ?? 10,
                minutes60: merged.minutes60 ?? 15,
            };
            const clampLimit = (value, fallback) => {
                const parsed = clampNumber(value, 0, 999);
                return parsed === undefined ? fallback : parsed;
            };
            innerVoice.petMessageLimits = {
                minutes5: clampLimit(patchLimits.minutes5, base.minutes5),
                minutes10: clampLimit(patchLimits.minutes10, base.minutes10),
                minutes30: clampLimit(patchLimits.minutes30, base.minutes30),
                minutes60: clampLimit(patchLimits.minutes60, base.minutes60),
            };
        }
        // Manual binding: petId → session id, empty strings dropped; an absent
        // key in the patch leaves the stored map untouched (partial updates).
        const bound = v.boundSessions;
        if (typeof bound === 'object' && bound !== null) {
            const record = {};
            for (const [petId, sessionId] of Object.entries(bound)) {
                if (petId !== '' && typeof sessionId === 'string' && sessionId !== '')
                    record[petId] = sessionId;
            }
            innerVoice.boundSessions = record;
        }
    }
    const patchRhythm = patch.rhythm;
    if (typeof patchRhythm === 'object' && patchRhythm !== null) {
        const r = patchRhythm;
        if (r.quiet === null) {
            rhythm.quiet = null;
        }
        else if (typeof r.quiet === 'object' && r.quiet !== null) {
            const q = r.quiet;
            const currentQuiet = current.rhythm?.quiet ?? undefined;
            const from = typeof q.from === 'string' && parseClock(q.from) !== undefined
                ? q.from
                : (currentQuiet?.from ?? '01:00');
            const to = typeof q.to === 'string' && parseClock(q.to) !== undefined
                ? q.to
                : (currentQuiet?.to ?? '09:00');
            const allow = typeof q.allowTouchReply === 'boolean'
                ? q.allowTouchReply
                : (currentQuiet?.allowTouchReply ?? true);
            rhythm.quiet = { from, to, allowTouchReply: allow };
        }
    }
    const patchJournal = patch.journal;
    if (typeof patchJournal === 'object' && patchJournal !== null) {
        const j = patchJournal;
        if (typeof j.enabled === 'boolean')
            journal.enabled = j.enabled;
        const inject = clampNumber(j.injectRecent, 1, 20);
        if (inject !== undefined)
            journal.injectRecent = inject;
        const chars = clampNumber(j.maxEntryChars, 40, 1000);
        if (chars !== undefined)
            journal.maxEntryChars = chars;
        const bytes = clampNumber(j.maxFileBytes, 4096, 4 * 1024 * 1024);
        if (bytes !== undefined)
            journal.maxFileBytes = bytes;
        if (typeof j.allowUnboundAppend === 'boolean')
            journal.allowUnboundAppend = j.allowUnboundAppend;
    }
    const patchPresence = patch.presenceSummary;
    if (typeof patchPresence === 'object' && patchPresence !== null) {
        const p = patchPresence;
        if (typeof p.enabled === 'boolean')
            presenceSummary.enabled = p.enabled;
    }
    const patchDebug = patch.debug;
    if (typeof patchDebug === 'object' && patchDebug !== null) {
        const d = patchDebug;
        if (typeof d.cdp === 'boolean')
            debug.cdp = d.cdp;
    }
    const tts = { ...current.tts };
    const patchTts = patch.tts;
    if (typeof patchTts === 'object' && patchTts !== null) {
        const t = patchTts;
        if (typeof t.enabled === 'boolean')
            tts.enabled = t.enabled;
        // Credentials and ids: empty string clears the stored value (the carrier
        // treats absent/empty as "not configured" — the pipeline stays off).
        const setText = (key) => {
            const value = t[key];
            if (typeof value !== 'string')
                return;
            const trimmed = value.trim();
            if (trimmed === '')
                Reflect.deleteProperty(tts, key);
            else
                tts[key] = trimmed;
        };
        setText('apiKey');
        setText('voiceId');
        setText('modelId');
        setText('languageCode');
        // Fractional ranges: clamp without the round() clampNumber applies.
        if (typeof t.speed === 'number' && Number.isFinite(t.speed))
            tts.speed = Math.min(2, Math.max(0.5, t.speed));
        if (typeof t.volume === 'number' && Number.isFinite(t.volume))
            tts.volume = Math.min(2, Math.max(0.01, t.volume));
    }
    // Persona (the user-editable character card, src/persona.ts): a string leaf
    // with the same clear-on-empty semantics as the TTS texts — an empty save
    // DELETES the key so the persona row falls back to DEFAULT_PERSONA, and a
    // hand-edited oversized card is truncated rather than trusted.
    const patchPersona = patch.persona;
    let persona = current.persona;
    if (typeof patchPersona === 'string') {
        const trimmed = patchPersona.trim();
        if (trimmed === '')
            persona = undefined;
        else
            persona = trimmed.length > MAX_PERSONA_CHARS ? trimmed.slice(0, MAX_PERSONA_CHARS) : trimmed;
    }
    // NOTE: display names are NOT a pet-settings.json section anymore — they
    // live in whale598/<petId>/pet-name.json (see the update handler).
    // pet-settings.json is SHARED with the carrier (its tuning/outfit/rev keys
    // live in the same file): preserve every key this page does not own, or one
    // save here silently wipes the carrier's half.
    const next = { ...current, proactivity, innerVoice, rhythm, journal, presenceSummary, tts, debug };
    // The cleared-card case must remove the key, not spread `undefined` over
    // it — `...current` already carried the stored value into `next`.
    if (persona === undefined)
        Reflect.deleteProperty(next, 'persona');
    else
        next.persona = persona;
    return next;
}
function openPathInFileManager(path) {
    if (process.platform === 'win32') {
        spawn('explorer.exe', [path], { detached: true, stdio: 'ignore' }).unref();
        return;
    }
    const command = process.platform === 'darwin' ? 'open' : 'xdg-open';
    spawn(command, [path], { detached: true, stdio: 'ignore' }).unref();
}
export function installSettingsPage(ctx, home, pet, control, summon, instances) {
    // Pet visibility flows through the capability seam: discovery, liveness,
    // and the /status field matrix are the service's job — this page only
    // renders.
    // pet-settings.json / pet-window.json moved under whale598/ — reads fall
    // back to the legacy root copies (petdata), writes go to the new layout.
    const windowPath = petdata.globalFilePath(home, 'pet-window.json');
    /** Summarize EVERY live pet (id, online flag, normalized /status). */
    const petStatus = async () => {
        const pets = await Promise.all((await pet.list()).map(entry => pet.snapshot(entry)));
        return {
            pets: pets.map(({ id, online, ...rest }) => ({ id, online, ...rest })),
        };
    };
    const readSettings = async () => {
        // readGlobalJson: whale598/ → legacy root → {} (mergeSettings folds defaults)
        const parsed = await petdata.readGlobalJson(home, 'pet-settings.json');
        return mergeSettings(parsed, {});
    };
    /** Live header first, persisted header second. `checked:false` means the
  
     * host exposed neither source — never turn that into a "missing session".
  
     * `currentPreset` comes from the preset registry / projection cache, NOT
  
     * from the immutable creation-time header field. */
    const findSessionHeader = async (sessionId) => {
        const getService = (name) => ctx.get(name);
        const sessions = getService('sessions');
        const agentPresets = getService('agentPresets');
        const live = sessions?.get(sessionId);
        if (live?.header !== undefined) {
            let currentPreset;
            try {
                const preset = agentPresets?.presetForSession(live);
                if (typeof preset === 'string' && preset !== '')
                    currentPreset = preset;
            }
            catch {
                // Unknown preset is not an error.
            }
            return { header: live.header, checked: true, currentPreset };
        }
        const persistence = getService('sessionPersistence');
        if (persistence === undefined) {
            return { header: undefined, checked: sessions !== undefined, currentPreset: undefined };
        }
        try {
            const snapshots = await persistence.list();
            const header = snapshots.find(snapshot => snapshot.header?.id === sessionId)?.header;
            let currentPreset;
            if (header !== undefined) {
                const cache = getService('sessionProjectionCache');
                try {
                    const preset = cache?.cachedSnapshot(header)?.values?.agentPreset;
                    if (typeof preset === 'string' && preset !== '')
                        currentPreset = preset;
                }
                catch {
                    // Unknown preset is not an error.
                }
            }
            return { header, checked: true, currentPreset };
        }
        catch {
            return { header: undefined, checked: false, currentPreset: undefined };
        }
    };
    const routeByPath = new Map();
    const route = (method, path, handler) => {
        let handlers = routeByPath.get(path);
        if (handlers === undefined) {
            handlers = new Map();
            routeByPath.set(path, handlers);
            ctx.effect(() => ctx.webServer.register({
                kind: 'exact',
                path,
                handler: async (req, res) => {
                    const httpReq = req;
                    const httpRes = res;
                    if (!isTrusted(httpReq)) {
                        writeJson(httpRes, 403, { error: 'refused: same-origin loopback only' });
                        return;
                    }
                    const registered = handlers?.get(String(httpReq.method ?? '').toUpperCase());
                    if (registered === undefined) {
                        writeJson(httpRes, 405, { error: 'method not allowed' });
                        return;
                    }
                    try {
                        await registered(httpReq, httpRes);
                    }
                    catch (error) {
                        writeJson(httpRes, 500, { error: error instanceof Error ? error.message : String(error) });
                    }
                },
            }), `pet-surface: settings ${path}`);
        }
        handlers.set(method, handler);
    };
    route('GET', '/api/pet-settings/binding-status', async (_req, res) => {
        writeJson(res, 200, { status: voiceBindingSnapshot() });
    });
    route('POST', '/api/pet-settings/binding-test', async (req, res) => {
        if (control === undefined) {
            writeJson(res, 503, { error: 'driver control unavailable' });
            return;
        }
        const body = await readJsonBody(req);
        const petId = typeof body?.petId === 'string' && body.petId !== '' ? body.petId : 'electron';
        const result = await control.testBinding(petId);
        writeJson(res, 200, result);
    });
    route('GET', '/api/pet-settings/read', async (_req, res) => {
        const [settings, status] = await Promise.all([
            readSettings(),
            petStatus(),
        ]);
        // Window positions are per-pet state (whale598/<petId>/pet-window.json —
        // the carrier writes its own file under DSH_PET_ID). The legacy
        // windowPosition field stays for response compat: the electron pet's
        // position, via the readPetStateJson fallback chain.
        const windowPositions = {};
        for (const id of new Set([...await petdata.existingPetIds(home), 'electron'])) {
            const raw = await petdata.readPetStateJson(home, id, 'pet-window.json');
            if (Object.keys(raw).length > 0)
                windowPositions[id] = raw;
        }
        const windowPosition = (windowPositions['electron'] ?? null);
        // Per-pet affection books: the registry's pet ids plus the legacy single
        // book (folded under 'electron' for pre-registry history).
        const affection = {};
        const bookIds = new Set(status.pets.map(pet => String(pet.id)));
        bookIds.add('electron');
        for (const id of bookIds) {
            const book = await petdata.readAffectionRaw(home, id);
            if (book !== null)
                affection[id] = book;
        }
        // Display names: composed from the per-pet store (legacy fallbacks
        // inside petdata), so the client keeps its `settings.names` map shape.
        const names = {};
        for (const id of bookIds) {
            const label = await petdata.readPetName(home, id);
            if (label !== undefined)
                names[id] = label;
        }
        const composed = { ...settings, names };
        // 三期 touch totals: per-pet touch facts aggregated from the events
        // stream (tool calls live in the session transcripts, not here).
        const touchTotals = {};
        for (const id of bookIds) {
            const events = await petdata.readJsonl(petdata.eventsFile(home, id), 600);
            const totals = { total: 0, byPart: {} };
            for (const event of events) {
                if (event.type !== 'touch')
                    continue;
                const part = typeof event.part === 'string' ? event.part : 'miss';
                totals.total += 1;
                totals.byPart[part] = (totals.byPart[part] ?? 0) + 1;
            }
            if (totals.total > 0)
                touchTotals[id] = totals;
        }
        // The persona card (src/persona.ts): current value plus the default and
        // cap so the client can placeholder and count without hardcoding the
        // row's constants.
        const persona = {
            value: typeof settings.persona === 'string' ? settings.persona : '',
            default: DEFAULT_PERSONA,
            maxLength: MAX_PERSONA_CHARS,
        };
        writeJson(res, 200, { settings: composed, affection, windowPosition, windowPositions, pets: status.pets, touchTotals, persona });
    });
    route('GET', '/api/pet-settings/electron-runtime', async (_req, res) => {
        writeJson(res, 200, { ok: true, runtime: readElectronRuntimeStatus(home) ?? null });
    });
    route('POST', '/api/pet-settings/summon', async (_req, res) => {
        // The summon card's back end. Liveness first: the card hides client-side
        // when a pet is up, this guards the double click (and the page-stale race).
        // Otherwise the pure plan decides — spawn now, or kick the electron
        // installer — and the carrier's single-instance lock keeps a lost race
        // harmless.
        const status = await petStatus();
        if (status.pets.some(entry => entry.online === true)) {
            writeJson(res, 200, { ok: true, started: false, reason: 'already-running' });
            return;
        }
        const outcome = summon === undefined
            ? { ok: false, started: false, reason: 'unsupported' }
            : summon();
        writeJson(res, 200, outcome);
    });
    route('POST', '/api/pet-settings/instance/summon', async (req, res) => {
        // Per-pet summon (multi-pet design §4): petId 'new' allocates the next
        // free electron-N instance; a named extra id summons that instance; the
        // primary rides the plain summon face. Admission (cap/duplicate) is the
        // instance layer's job.
        if (instances === undefined) {
            writeJson(res, 200, { ok: false, started: false, reason: 'unsupported' });
            return;
        }
        const body = await readJsonBody(req);
        const petId = typeof body?.petId === 'string' && body.petId !== '' ? body.petId : undefined;
        const outcome = await instances.summonInstance(petId);
        writeJson(res, 200, outcome);
    });
    route('POST', '/api/pet-settings/instance/dismiss', async (req, res) => {
        // 送走: kill the instance and drop it from the desired set. The primary
        // refuses (it IS this bundle's carrier).
        if (instances === undefined) {
            writeJson(res, 200, { ok: false, reason: 'unsupported' });
            return;
        }
        const body = await readJsonBody(req);
        const petId = typeof body?.petId === 'string' ? body.petId : '';
        const outcome = await instances.dismissInstance(petId);
        writeJson(res, 200, outcome);
    });
    route('POST', '/api/pet-settings/update', async (req, res) => {
        const body = await readJsonBody(req);
        const patch = body === undefined ? undefined : body.patch;
        if (typeof patch !== 'object' || patch === null) {
            writeJson(res, 400, { error: 'body must be {patch:{...}}' });
            return;
        }
        // names moved OUT of pet-settings.json into whale598/<petId>/pet-name.json:
        // the patch's names map writes per-pet files (missing key = revert to the
        // built-in default) and is stripped from the settings file entirely.
        const patchNames = patch.names;
        if (typeof patchNames === 'object' && patchNames !== null) {
            for (const [petId, label] of Object.entries(patchNames)) {
                await petdata.writePetName(home, petId, typeof label === 'string' && label.trim() !== '' ? label : null);
            }
            delete patch.names;
        }
        const current = await readSettings();
        const next = mergeSettings(current, patch);
        // Binding validation is patch-aware: only a save that actually edits the
        // electron binding is hard-blocked. An EXISTING binding that later became
        // non-pet (the user switched modes, or hand-edited JSON) must not turn
        // every unrelated settings save into a 400 — that reads as "settings page
        // broken". Existing invalid bindings degrade to a warning.
        const warnings = [];
        const patchTouchesBinding = patchTouchesElectronBinding(patch);
        const bound = next.innerVoice?.boundSessions?.electron;
        if (typeof bound === 'string' && bound !== '') {
            const found = await findSessionHeader(bound);
            if (found.checked && found.header === undefined) {
                warnings.push(`会话 ${bound} 不存在`);
            }
            else {
                if (found.currentPreset !== undefined && !isPetPreset(found.currentPreset)) {
                    if (patchTouchesBinding) {
                        writeJson(res, 400, {
                            error: `这个会话的当前模式是「${found.currentPreset}」，没有 pet_say/pet_do。`
                                + '请改用宠物模式（「精简（仅表达）」或「普通（含工作工具）」）的会话，'
                                + '或新建一个宠物模式会话后再绑定。',
                        });
                        return;
                    }
                    warnings.push('当前已保存的绑定会话不是宠物模式；本次保存已生效，但绑定不会有气泡回应。');
                }
                if (found.currentPreset === undefined && found.header !== undefined) {
                    warnings.push('无法确认这个会话的当前模式；如果它不是宠物模式，绑定后不会有气泡回应。');
                }
            }
        }
        await petdata.writeGlobalJson(home, 'pet-settings.json', next);
        // The driver re-pushes the autonomy payload to the pets on this event —
        // a changed switch reaches the renderer without waiting for the next
        // session state transition.
        ctx.emit('pet-settings/changed');
        writeJson(res, 200, { ok: true, settings: next, warnings });
    });
    route('POST', '/api/pet-settings/reset-affection', async (_req, res) => {
        await petdata.writeAffectionRaw(home, 'electron', EMPTY_LEDGER);
        writeJson(res, 200, { ok: true, affection: EMPTY_LEDGER });
    });
    route('POST', '/api/pet-settings/reset-position', async (_req, res) => {
        // Per-pet files first (whale598/<petId>/pet-window.json), then the two
        // legacy layers (whale598 root, ~/.dsh root).
        for (const id of await petdata.existingPetIds(home)) {
            await rm(petdata.petStatePaths(home, id, 'pet-window.json').current, { force: true });
        }
        for (const p of [windowPath, join(home, 'pet-window.json')])
            await rm(p, { force: true });
        writeJson(res, 200, { ok: true });
    });
    route('POST', '/api/pet-settings/open-logs', async (_req, res) => {
        const logsDir = join(home, 'logs');
        const target = existsSync(logsDir) ? logsDir : home;
        openPathInFileManager(target);
        writeJson(res, 200, { ok: true, opened: target });
    });
    route('GET', '/api/pet-settings/tts/voices', async (req, res) => {
        // The BreezeBlue voices search, proxied with the stored key: the settings
        // page's browser cannot call api.breeze.blue itself (CORS), and the key
        // never leaves this loopback process. A trimmed voice list is all the
        // picker needs (voice_id/name/language/gender/tone/accent/preview_url).
        const settings = await readSettings();
        const apiKey = typeof settings.tts?.apiKey === 'string' ? settings.tts.apiKey : '';
        if (apiKey === '') {
            writeJson(res, 400, { error: '尚未配置 BreezeBlue API key' });
            return;
        }
        const url = new URL(req.url ?? '/', 'http://127.0.0.1');
        const params = new URLSearchParams();
        for (const key of ['search', 'language_code', 'gender', 'accent']) {
            const value = url.searchParams.get(key);
            if (value !== null && value !== '')
                params.set(key, value);
        }
        const rawPageSize = url.searchParams.get('page_size');
        const pageSize = rawPageSize !== null ? clampNumber(Number(rawPageSize), 1, 100) : undefined;
        params.set('page_size', String(pageSize ?? 30));
        try {
            const response = await fetch(`https://api.breeze.blue/v1/voices?${params.toString()}`, {
                headers: { 'xi-api-key': apiKey },
                signal: AbortSignal.timeout(10_000),
            });
            if (!response.ok) {
                const detail = await response.text().catch(() => '');
                // 401 is the "wrong key" case by far the most likely: name the fix,
                // not just the wire fact (a key copied from another service reads
                // identically to a revoked one here).
                const message = response.status === 401
                    ? 'BreezeBlue 拒绝了这个 key（401）：请到 breezeblue.ai 的 Developer Console 复制 brz_ 开头的 API key'
                    : `BreezeBlue HTTP ${String(response.status)}${detail ? `: ${detail.slice(0, 200)}` : ''}`;
                writeJson(res, 502, { error: message });
                return;
            }
            const raw = await response.json();
            const voices = (Array.isArray(raw.voices) ? raw.voices : []).map((entry) => {
                const voice = entry;
                const str = (key) => typeof voice[key] === 'string' ? voice[key] : null;
                return {
                    voice_id: str('voice_id') ?? '',
                    name: str('name') ?? '',
                    language_code: str('language_code'),
                    gender: str('gender'),
                    tone: Array.isArray(voice.tone) ? voice.tone.filter((item) => typeof item === 'string').slice(0, 3) : [],
                    accent: str('accent'),
                    preview_url: str('preview_url'),
                };
            }).filter(voice => voice.voice_id !== '');
            writeJson(res, 200, { voices, total: typeof raw.total === 'number' ? raw.total : voices.length });
        }
        catch (error) {
            writeJson(res, 502, { error: `声音列表请求失败: ${error instanceof Error ? error.message : String(error)}` });
        }
    });
}
//# sourceMappingURL=settings-page.js.map