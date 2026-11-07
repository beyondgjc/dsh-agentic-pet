/**
 * dsh-pet Electron main process. Owns the pet window (transparent,
 * always-on-top, click-through outside the pet body), the pet-profile child
 * process (spawned through Electron's own binary in Node mode, mirroring
 * apps/desktop-host), and the pet-asset protocol that streams the pet's
 * animation media from a local directory without vendoring it into the
 * repository.
 *
 * Window drag is manual: the renderer captures the pointer over the pet body
 * and reports screen coordinates; the main process follows with setBounds
 * whose size is pinned to the canonical WINDOW_SIZE and whose position
 * recomputes from the gesture anchor, so neither the DWM re-measure ratchet
 * nor a per-call nudge can accumulate (DSH-PET.md §5 error chain #11-12).
 */
export {};
//# sourceMappingURL=main.d.ts.map