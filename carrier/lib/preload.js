/**
 * dsh-pet preload. Exposes the one bridge the renderer needs: toggling the
 * window's OS-level mouse-ignore so the desktop underneath stays clickable
 * everywhere except over the pet body and bubbles. Runs unsandboxed because
 * the carrier's preload is ESM; contextIsolation stays on.
 */
import { contextBridge, ipcRenderer } from 'electron';
contextBridge.exposeInMainWorld('petDesktop', {
    /** Report whether an interaction bubble is currently on screen. */
    setBubbleVisible(visible) {
        ipcRenderer.send('pet:bubble-visibility', visible === true);
    },
    /**
     * Manual window drag: the renderer reports the gesture in one coordinate
     * space end to end — its own fractional DIP screenX/screenY — and the main
     * process follows with size-pinned setBounds (see main.ts for why).
     */
    dragStart(screenX, screenY) { ipcRenderer.send('pet:drag-start', screenX, screenY); },
    dragMove(screenX, screenY) { ipcRenderer.send('pet:drag-move', screenX, screenY); },
    dragEnd() { ipcRenderer.send('pet:drag-end'); },
    /** Control interface (driver's four operations) deliveries from the main process. */
    onSay(listener) {
        ipcRenderer.on('pet:say', (_event, notice) => { listener(notice); });
    },
    reportStatus(snapshot) {
        ipcRenderer.send('pet:status-report', snapshot);
    },
    onState(listener) {
        ipcRenderer.on('pet:set-state', (_event, state) => { listener(state); });
    },
    onAction(listener) {
        ipcRenderer.on('pet:action', (_event, action) => { listener(action); });
    },
    /** The action catalog scanned by the main process at boot (what /action
     * names resolve against, and the idle theater's pool). */
    onCatalog(listener) {
        ipcRenderer.on('pet:catalog', (_event, catalog) => { listener(catalog); });
    },
    onInteraction(listener) {
        ipcRenderer.on('pet:interaction', (_event, request) => { listener(request); });
    },
    onInteractionCancel(listener) {
        ipcRenderer.on('pet:interaction-cancel', (_event, notice) => { listener(notice); });
    },
    answerInteraction(id, answer) {
        ipcRenderer.send('pet:interaction-answer', { id, answer });
    },
    /** A completed touch gesture on the pet body (click, not drag). */
    reportTouch(touch) {
        ipcRenderer.send('pet:touch', touch);
    },
    /** A finished one-shot animation: the completion trace for /action. */
    reportActionDone(done) {
        ipcRenderer.send('pet:action-done', done);
    },
    /** chat上行 (§6 2026-10-31): one in-flight message per pet — the main
     * process rejects with reason:'busy' until the previous one is carried out
     * by a /events response. */
    async sendChat(text) {
        return await ipcRenderer.invoke('pet:chat', { text });
    },
});
//# sourceMappingURL=preload.js.map