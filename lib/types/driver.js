/**
 * The pet driver: converges in-process DSH events into pet control
 * operations. This is the DSH-knowledge half of the §7.2 split — the pet
 * surface keeps shrinking toward a dumb display while everything that
 * understands the runtime's vocabulary lives here. v1 drives semantic state;
 * interaction waterfalls move over with the WS path's retirement.
 * @module dsh-agentic-pet/driver
 */
import { randomUUID } from 'node:crypto';
import { existsSync } from 'node:fs';
import { appendFile, readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { defineTool } from '@deepseek-ai/dsh-tools';
import { formatAvailableActions, resolveActionRequest } from "./actions.js";
import { notifyPets, routePet } from "./registry.js";
const EMPTY_LEDGER = { affection: 0, total: 0, byPart: {}, lastTouchAt: undefined, recent: [] };
async function readLedger(ledgerFile) {
    try {
        const raw = JSON.parse(await readFile(ledgerFile, 'utf8'));
        return {
            affection: typeof raw.affection === 'number' ? raw.affection : 0,
            total: typeof raw.total === 'number' ? raw.total : 0,
            byPart: raw.byPart ?? {},
            lastTouchAt: raw.lastTouchAt,
            recent: raw.recent ?? [],
        };
    }
    catch {
        return { ...EMPTY_LEDGER, byPart: {}, recent: [] };
    }
}
/** The per-pet ledger file. Legacy deployments' single book is folded under
 * the electron id so pre-registry affection history survives the upgrade. */
function ledgerFileFor(home, petId) {
    if (petId === 'electron' && !existsSync(join(home, 'pet-affection.d'))) {
        return join(home, 'pet-affection.json');
    }
    return join(home, 'pet-affection.d', `${petId}.json`);
}
const driverLog = (home, line) => {
    void appendFile(join(home, 'pet-driver.log'), `${new Date().toISOString()} ${line}
`, 'utf8').catch(() => { });
};
export function installPetDriver(ctx, home, pet) {
    driverLog(home, 'installPetDriver entered');
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
            const raw = JSON.parse(await readFile(join(home, 'pet-settings.json'), 'utf8'));
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
        if (sessionId !== boundSessionId)
            boundPetId = undefined;
        boundSessionId = sessionId;
        // A message mid-turn must not downgrade a working agent back to thinking.
        if (currentState === undefined || currentState === 'idle')
            void pushState('thinking');
    });
    events.on('api-session/error', (sessionId, _message) => {
        if (sessionId !== boundSessionId)
            return;
        void pushState('error'); // the error flash is transient: pushState clears the
        // dedup entry after an 'error' push, so the next status re-establishes.
    });
    events.on('api-session/removed', (sessionId) => {
        if (sessionId !== boundSessionId)
            return;
        boundSessionId = undefined;
        boundPetId = undefined;
        pushState('idle');
    });
    events.on('pet-settings/changed', () => {
        // The autonomy payload rides on /state pushes: a settings change
        // re-pushes the current state immediately (the dedup key includes the
        // payload, so an unchanged semantic state still delivers the new config).
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
    const interactionLedgerFile = join(home, 'pet-interactions.json');
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
    // Touch events: pull EVERY live pet's queue on a cadence and fold each
    // touch into that pet's own affection ledger (per-pet books — "她们").
    // Nothing here ever enters conversation context — the model senses the
    // ledger only through pet_state.
    const lastEventSeqs = new Map();
    const recordTouch = async (petId, part, at) => {
        const ledgerFile = ledgerFileFor(home, petId);
        const ledger = await readLedger(ledgerFile);
        ledger.total += 1;
        ledger.byPart[part] = (ledger.byPart[part] ?? 0) + 1;
        const before = ledger.affection;
        ledger.affection = Math.min(100, ledger.affection + (part === 'head' ? 2 : 1));
        ledger.lastTouchAt = at;
        ledger.recent.unshift({ part, at });
        ledger.recent = ledger.recent.slice(0, 10);
        try {
            await writeFile(ledgerFile, `${JSON.stringify(ledger)}
`, 'utf8');
        }
        catch (error) {
            console.error(`pet-surface driver: could not write the ledger: ${error instanceof Error ? error.message : String(error)}`);
        }
        // Every crossed ten of affection earns one unprompted hop — a runtime-side
        // reaction with no model in the loop, delivered to the touched pet only.
        if (Math.floor(ledger.affection / 10) > Math.floor(before / 10)) {
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
    };
    const pollEvents = async () => {
        for (const target of await pet.list()) {
            const lastEventSeq = lastEventSeqs.get(target.id) ?? 0;
            try {
                const response = await fetch(`http://127.0.0.1:${String(target.port)}/events?since=${String(lastEventSeq)}`);
                if (!response.ok)
                    continue;
                const payload = JSON.parse(await response.text());
                if (typeof payload.latest === 'number' && payload.latest < lastEventSeq) {
                    // The pet restarted and its queue restarted with it.
                    lastEventSeqs.set(target.id, 0);
                    continue;
                }
                for (const event of payload.events ?? []) {
                    if (typeof event.seq === 'number' && typeof event.part === 'string') {
                        await recordTouch(target.id, event.part, typeof event.at === 'number' ? event.at : Date.now());
                    }
                    lastEventSeqs.set(target.id, Math.max(lastEventSeqs.get(target.id) ?? 0, typeof event.seq === 'number' ? event.seq : 0));
                }
            }
            catch {
                // pet gone; the next tick re-resolves through the registry
            }
        }
    };
    const pollTimer = setInterval(() => { void pollEvents(); }, 5_000);
    void pollEvents();
    ctx.effect(() => () => { clearInterval(pollTimer); }, 'pet-surface: touch poll');
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
                const raw = JSON.parse(await readFile(join(home, 'pet-settings.json'), 'utf8'));
                return typeof raw.focus === 'string' && raw.focus !== '' ? raw.focus : undefined;
            }
            catch {
                return undefined;
            }
        };
        const resolveTarget = async (targetPet) => {
            const pets = await pet.list();
            if (typeof targetPet === 'string' && targetPet !== '') {
                const named = pets.find(entry => entry.id === targetPet);
                if (named === undefined) {
                    throw new Error(`no running pet named "${targetPet}" (running: ${pets.map(entry => entry.id).join(', ') || 'none'})`);
                }
                return named;
            }
            const focus = await readFocus();
            const focused = focus !== undefined ? pets.find(entry => entry.id === focus) : undefined;
            const target = focused ?? routePet(pets, undefined);
            if (target === undefined)
                throw new Error('no pet is running');
            return target;
        };
        const control = async (path, init, targetPet) => {
            const entry = await resolveTarget(targetPet);
            return pet.call(entry, path, init);
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
            async execute(args) {
                const text = String(args.text).slice(0, 200);
                console.log(`pet-surface driver: pet_say ${JSON.stringify(text).slice(0, 60)}`);
                try {
                    await control('/say', {
                        method: 'POST',
                        headers: { 'content-type': 'application/json' },
                        body: JSON.stringify({ text }),
                    }, args.pet);
                }
                catch (error) {
                    throw classify(error);
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
            async execute(args) {
                try {
                    const entry = await resolveTarget(args.pet);
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
                        const done = snap.lastActionDone;
                        if (done != null && done.requestId === requestId) {
                            return JSON.stringify({ performed: true, action, durationMs: done.durationMs });
                        }
                    }
                    return JSON.stringify({ performed: true, action, waitTimedOut: true });
                }
                catch (error) {
                    throw classify(error);
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
            async execute(args) {
                try {
                    const entry = await resolveTarget(args.pet);
                    const cursor = digestCursors.get(entry.id) ?? 0;
                    let payload = await pet.call(entry, `/events?since=${String(cursor)}`);
                    const latest = typeof payload.latest === 'number' ? payload.latest : cursor;
                    let events = Array.isArray(payload.events) ? payload.events : [];
                    if (latest < cursor) {
                        // The pet restarted and its queue restarted with it: re-read
                        // everything retained.
                        payload = await pet.call(entry, '/events?since=0');
                        events = Array.isArray(payload.events) ? payload.events : [];
                    }
                    const counts = {};
                    let total = 0;
                    let lastTouchAt = null;
                    let newest = cursor;
                    for (const event of events) {
                        if (typeof event.part !== 'string')
                            continue;
                        const part = event.part === 'unknown' ? 'miss' : event.part;
                        counts[part] = (counts[part] ?? 0) + 1;
                        total += 1;
                        if (typeof event.at === 'number')
                            lastTouchAt = Math.max(lastTouchAt ?? 0, event.at);
                        if (typeof event.seq === 'number')
                            newest = Math.max(newest, event.seq);
                    }
                    digestCursors.set(entry.id, newest);
                    const ledger = await readLedger(ledgerFileFor(home, entry.id));
                    const mood = ledger.affection >= 80 ? 'happy' : ledger.affection >= 40 ? 'content' : 'neutral';
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
                    throw classify(error);
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
                    const raw = JSON.parse(await readFile(join(home, 'pet-interactions.json'), 'utf8'));
                    if (Array.isArray(raw))
                        list = raw;
                }
                catch {
                    // no interactions recorded yet
                }
                return JSON.stringify({ recent: list.slice(0, limit) });
            },
        }));
        scope.tools.register(defineTool({
            name: 'pet_state',
            description: 'Read the desktop pets\' current state: every running pet with its id, what it is doing, which animation is playing, its window position and visibility, plus each pet\'s affection book. Use it when the user refers to a pet, to pick a target for pet_say/pet_do, or to react to a pet.',
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
                    const ledger = await readLedger(ledgerFileFor(home, id));
                    const mood = ledger.affection >= 80 ? 'happy' : ledger.affection >= 40 ? 'content' : 'neutral';
                    ledgers[id] = { ...ledger, mood };
                }
                const petsOut = states.map(state => {
                    const actions = actionsById.get(state.id);
                    return actions === undefined ? state : { ...state, actions };
                });
                return JSON.stringify({ defaultPet: pets[0]?.id ?? null, pets: petsOut, affection: ledgers });
            },
        }));
    });
}
//# sourceMappingURL=driver.js.map