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
    proactivity: { enabled: false, cooldownMinutes: 10, idleThresholdMinutes: 5 },
    debug: { cdp: false },
};
/** The touch ledger the driver owns; reset writes the driver's empty shape. */
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
    }
    const patchDebug = patch.debug;
    if (typeof patchDebug === 'object' && patchDebug !== null) {
        const d = patchDebug;
        if (typeof d.cdp === 'boolean')
            debug.cdp = d.cdp;
    }
    return { proactivity, debug };
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
    const ledgerPath = join(home, 'pet-affection.json'); // legacy electron book
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
        const legacyBook = await readFile(ledgerPath, 'utf8').then(raw => JSON.parse(raw), () => null);
        const bookIds = new Set(status.pets.map(pet => String(pet.id)));
        bookIds.add('electron');
        for (const id of bookIds) {
            const file = id === 'electron' && legacyBook !== null
                ? ledgerPath
                : join(home, 'pet-affection.d', `${id}.json`);
            const book = await readFile(file, 'utf8').then(raw => JSON.parse(raw), () => null);
            if (book !== null)
                affection[id] = book;
        }
        writeJson(res, 200, { settings, affection, windowPosition, pets: status.pets });
    });
    route('POST', '/api/pet-settings/update', async (req, res) => {
        const body = await readJsonBody(req);
        const patch = body === undefined ? undefined : body.patch;
        if (typeof patch !== 'object' || patch === null) {
            writeJson(res, 400, { error: 'body must be {patch:{...}}' });
            return;
        }
        const current = await readSettings();
        const next = mergeSettings(current, patch);
        await writeFile(settingsPath, `${JSON.stringify(next, null, 2)}\n`, 'utf8');
        writeJson(res, 200, { ok: true, settings: next });
    });
    route('POST', '/api/pet-settings/reset-affection', async (_req, res) => {
        await writeFile(ledgerPath, `${JSON.stringify(EMPTY_LEDGER)}\n`, 'utf8');
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