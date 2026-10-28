/**
 * dsh-pet preload. Exposes the one bridge the renderer needs: toggling the
 * window's OS-level mouse-ignore so the desktop underneath stays clickable
 * everywhere except over the pet body and bubbles. Runs unsandboxed because
 * the carrier's preload is ESM; contextIsolation stays on.
 */

import { contextBridge, ipcRenderer } from 'electron'

contextBridge.exposeInMainWorld('petDesktop', {
  /** Report whether an interaction bubble is currently on screen. */
  setBubbleVisible(visible: boolean): void {
    ipcRenderer.send('pet:bubble-visibility', visible === true)
  },
  /**
   * Manual window drag: the renderer reports the gesture in one coordinate
   * space end to end — its own fractional DIP screenX/screenY — and the main
   * process follows with size-pinned setBounds (see main.ts for why).
   */
  dragStart(screenX: number, screenY: number): void { ipcRenderer.send('pet:drag-start', screenX, screenY) },
  dragMove(screenX: number, screenY: number): void { ipcRenderer.send('pet:drag-move', screenX, screenY) },
  dragEnd(): void { ipcRenderer.send('pet:drag-end') },
  /** Control interface (driver's four operations) deliveries from the main process. */
  onSay(listener: (notice: { text: string }) => void): void {
    ipcRenderer.on('pet:say', (_event, notice) => { listener(notice) })
  },
  reportStatus(snapshot: Record<string, unknown>): void {
    ipcRenderer.send('pet:status-report', snapshot)
  },
  onState(listener: (state: unknown) => void): void {
    ipcRenderer.on('pet:set-state', (_event, state) => { listener(state) })
  },
  onAction(listener: (action: unknown) => void): void {
    ipcRenderer.on('pet:action', (_event, action) => { listener(action) })
  },
  onInteraction(listener: (request: unknown) => void): void {
    ipcRenderer.on('pet:interaction', (_event, request) => { listener(request) })
  },
  onInteractionCancel(listener: (notice: { id: string }) => void): void {
    ipcRenderer.on('pet:interaction-cancel', (_event, notice) => { listener(notice) })
  },
  answerInteraction(id: string, answer: unknown): void {
    ipcRenderer.send('pet:interaction-answer', { id, answer })
  },
  /** A completed touch gesture on the pet body (click, not drag). */
  reportTouch(touch: { part: string }): void {
    ipcRenderer.send('pet:touch', touch)
  },
  /** A finished one-shot animation: the completion trace for /action. */
  reportActionDone(done: { action: string; durationMs?: number; requestId?: string }): void {
    ipcRenderer.send('pet:action-done', done)
  },
})
