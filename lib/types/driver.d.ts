/**
 * The pet driver: converges in-process DSH events into pet control
 * operations. This is the DSH-knowledge half of the §7.2 split — the pet
 * surface keeps shrinking toward a dumb display while everything that
 * understands the runtime's vocabulary lives here. v1 drives semantic state;
 * interaction waterfalls move over with the WS path's retirement.
 * @module dsh-agentic-pet/driver
 */
import type { Context } from '@deepseek-ai/cordis';
import { type VoiceBindingSnapshot, type VoiceBindingView } from './binding.ts';
import { type PetService } from './service.ts';
declare module '@deepseek-ai/cordis' {
    interface Events {
        'api-session/status'(sessionId: string, running: boolean): void;
        'api-session/activity'(sessionId: string, updatedAt: number): void;
        'api-session/error'(sessionId: string, message: string): void;
        'api-session/removed'(sessionId: string): void;
        'pet-settings/changed'(): void;
        'pet-binding/failed'(payload: {
            petId: string;
            sessionId: string;
            errorCode: string;
            expectedCwd: string;
            actualCwd: string | null;
            at: number;
        }): void;
        'pet-binding/armed'(payload: {
            petId: string;
            sessionId: string;
            at: number;
        }): void;
        'pet-binding/rebound'(payload: {
            petId: string;
            fromSessionId: string;
            toSessionId: string | null;
            at: number;
        }): void;
        'approval/request'(request: {
            toolName?: string;
            reason?: string;
            displayReason?: {
                readonly en?: string;
                readonly [locale: string]: string | undefined;
            };
            signal?: AbortSignal;
            /** Host-side correlation (the asking controller's agent identity).
             * Read defensively — the ledger records null when absent. */
            agent?: {
                id?: unknown;
            };
        }, next: () => Promise<unknown>): Promise<unknown>;
        'user-questions/request'(request: {
            questions: Array<{
                id: string;
                question: unknown;
                detail?: unknown;
                header?: unknown;
                options?: Array<{
                    label: unknown;
                    description?: unknown;
                }>;
                multiSelect?: boolean;
            }>;
            signal?: AbortSignal;
            /** Host-side correlation — see approval/request. */
            agent?: {
                id?: unknown;
            };
        }, next: () => Promise<unknown>): Promise<unknown>;
    }
}
/** Local-time log stamp: the driver log is the user's primary debugging
 * tool, so timestamps show the USER's wall clock, not UTC (toISOString's Z
 * form read 8h off and cost a confusion round). Sortable, zero-padded. */
export declare const logStamp: () => string;
/** Export for the settings page: the live snapshot, no file round-trip. */
export declare function voiceBindingSnapshot(): VoiceBindingSnapshot;
export interface PetDriverControl {
    bindingSnapshot(): VoiceBindingSnapshot;
    testBinding(petId: string): Promise<{
        ok: boolean;
        petId: string;
        sessionId: string | null;
        binding: VoiceBindingView;
    }>;
}
export declare function installPetDriver(ctx: Context, home: string, pet: PetService): PetDriverControl;
/**
 * The model-expression layer: three thin tools over the pet's control
 * interface (§6 — accurate state stays program-driven; these carry only the
 * model's expressive intent). Registered only when a tools service is
 * mounted; a missing pet answers with a clear string the model can relay.
 * @param ctx - plugin context inside the runtime.
 * @param home - the dsh home holding the pet control manifest.
 */
export declare function registerPetTools(ctx: Context, home: string, pet: PetService): void;
