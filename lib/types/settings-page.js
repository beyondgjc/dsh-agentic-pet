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
        boundSessions: {},
    },
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
/** Merge a patch into the settings, accepting only the known keys. */
function mergeSettings(current, patch) {
    const proactivity = { ...DEFAULT_SETTINGS.proactivity, ...current.proactivity };
    const innerVoice = { ...DEFAULT_SETTINGS.innerVoice, ...current.innerVoice };
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
    // NOTE: display names are NOT a pet-settings.json section anymore — they
    // live in whale598/<petId>/pet-name.json (see the update handler).
    // pet-settings.json is SHARED with the carrier (its tuning/outfit/rev keys
    // live in the same file): preserve every key this page does not own, or one
    // save here silently wipes the carrier's half.
    return { ...current, proactivity, innerVoice, tts, debug };
}
function openPathInFileManager(path) {
    if (process.platform === 'win32') {
        spawn('explorer.exe', [path], { detached: true, stdio: 'ignore' }).unref();
        return;
    }
    const command = process.platform === 'darwin' ? 'open' : 'xdg-open';
    spawn(command, [path], { detached: true, stdio: 'ignore' }).unref();
}
/**
 * Register the settings page's routes. One registration per exact path with
 * internal method dispatch; every handler runs behind the fence.
 * @param ctx - plugin context inside the runtime.
 * @param home - the dsh home holding the settings/ledger/manifest files.
 */
export function installSettingsPage(ctx, home, pet) {
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
    route('GET', '/api/pet-settings/read', async (_req, res) => {
        const [settings, windowPosition, status] = await Promise.all([
            readSettings(),
            petdata.readGlobalJson(home, 'pet-window.json').then(raw => (Object.keys(raw).length > 0 ? raw : null)),
            petStatus(),
        ]);
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
        writeJson(res, 200, { settings: composed, affection, windowPosition, pets: status.pets, touchTotals });
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
        await petdata.writeGlobalJson(home, 'pet-settings.json', next);
        // The driver re-pushes the autonomy payload to the pets on this event —
        // a changed switch reaches the renderer without waiting for the next
        // session state transition.
        ctx.emit('pet-settings/changed');
        writeJson(res, 200, { ok: true, settings: next });
    });
    route('POST', '/api/pet-settings/reset-affection', async (_req, res) => {
        await petdata.writeAffectionRaw(home, 'electron', EMPTY_LEDGER);
        writeJson(res, 200, { ok: true, affection: EMPTY_LEDGER });
    });
    route('POST', '/api/pet-settings/reset-position', async (_req, res) => {
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
                writeJson(res, 502, { error: `BreezeBlue HTTP ${String(response.status)}${detail ? `: ${detail.slice(0, 200)}` : ''}` });
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