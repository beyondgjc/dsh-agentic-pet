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
import { readFile, unlink, writeFile } from 'node:fs/promises';
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
    // NOTE: display names are NOT a pet-settings.json section anymore — they
    // live in whale598/<petId>/pet-name.json (see the update handler).
    // pet-settings.json is SHARED with the carrier (its tuning/outfit/rev keys
    // live in the same file): preserve every key this page does not own, or one
    // save here silently wipes the carrier's half.
    return { ...current, proactivity, innerVoice, debug };
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
    const settingsPath = join(home, 'pet-settings.json');
    const windowPath = join(home, 'pet-window.json');
    /** Summarize EVERY live pet (id, online flag, normalized /status). */
    const petStatus = async () => {
        const pets = await Promise.all((await pet.list()).map(entry => pet.snapshot(entry)));
        return {
            pets: pets.map(({ id, online, ...rest }) => ({ id, online, ...rest })),
        };
    };
    const readSettings = async () => {
        try {
            const parsed = JSON.parse(await readFile(settingsPath, 'utf8'));
            return mergeSettings(parsed, {});
        }
        catch {
            return mergeSettings({}, {});
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
    route('GET', '/api/pet-settings/read', async (_req, res) => {
        const [settings, windowPosition, status] = await Promise.all([
            readSettings(),
            readFile(windowPath, 'utf8').then(raw => JSON.parse(raw), () => null),
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
        // 三期 history: per-pet touch totals + recent tool calls, aggregated
        // from the whale598/<petId>/ JSONL streams.
        const history = [];
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
            for (const call of await petdata.readJsonl(petdata.toolCallsFile(home, id), 12)) {
                history.push({ ...call, petId: id });
            }
        }
        history.sort((a, b) => Number(b.at ?? 0) - Number(a.at ?? 0));
        writeJson(res, 200, { settings: composed, affection, windowPosition, pets: status.pets, history: history.slice(0, 12), touchTotals });
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
        await writeFile(settingsPath, `${JSON.stringify(next, null, 2)}\n`, 'utf8');
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
        if (existsSync(windowPath))
            await unlink(windowPath);
        writeJson(res, 200, { ok: true });
    });
    route('POST', '/api/pet-settings/open-logs', async (_req, res) => {
        const logsDir = join(home, 'logs');
        const target = existsSync(logsDir) ? logsDir : home;
        openPathInFileManager(target);
        writeJson(res, 200, { ok: true, opened: target });
    });
}
//# sourceMappingURL=settings-page.js.map