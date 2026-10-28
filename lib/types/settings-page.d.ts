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
import type { Context } from '@deepseek-ai/cordis';
import type { PetService } from './service.ts';
/**
 * Register the settings page's routes. One registration per exact path with
 * internal method dispatch; every handler runs behind the fence.
 * @param ctx - plugin context inside the runtime.
 * @param home - the dsh home holding the settings/ledger/manifest files.
 */
export declare function installSettingsPage(ctx: Context, home: string, pet: PetService): void;
//# sourceMappingURL=settings-page.d.ts.map