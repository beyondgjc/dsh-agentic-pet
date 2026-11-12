/**
 * dsh-pet preload. Exposes the one bridge the renderer needs: toggling the
 * window's OS-level mouse-ignore so the desktop underneath stays clickable
 * everywhere except over the pet body and bubbles. Runs unsandboxed because
 * the carrier's preload is ESM; contextIsolation stays on.
 */
import { contextBridge, ipcRenderer } from 'electron';
contextBridge.exposeInMainWorld('petDesktop', {
    /** True = the window ignores mouse events (desktop clicks pass through). */
    setClickThrough(enabled) {
        ipcRenderer.send('pet:click-through', enabled === true);
    },
});
//# sourceMappingURL=preload.js.map