/**
 * Say-side TTS (BreezeBlue): speech synthesis as the /say bubble's voice.
 * The control plane hands every spoken text here; this module owns the
 * DELIVERY to the page — when synthesis is configured it holds the bubble
 * until the mp3 lands (bounded by `holdMs`, default 3s) and forwards text +
 * audio as ONE message, so the pet's mouth and voice start together. A
 * timeout or failure shows the bubble alone and discards the late audio:
 * the complaint to avoid is a voice trailing seconds behind its text. With
 * synthesis off, delivery is the immediate bubble — yesterday's behavior.
 *
 * Any failure (no key, rate limit, network) degrades to visual-only and
 * never surfaces to the driver: the /say HTTP response keeps its
 * fire-and-forget budget, the delivery race runs entirely out-of-band.
 *
 * Configuration lives in the shared pet-settings.json (`tts` section, written
 * by the plugin's settings page) and is read lazily per utterance with an
 * mtime cache: a saved switch reaches the pet without any push or restart.
 * Voice identity is per pet: `tts.voices[petId]` may pin its own voiceId,
 * speed and volume (the settings page writes one table, every carrier
 * instance resolves its own entry); unset fields fall through to the shared
 * defaults, so single-pet setups behave exactly as before.
 *
 * The wire surface is a bare fetch against the BreezeBlue REST endpoint (no
 * SDK — the carrier carries none): POST /v1/text-to-speech/{voice_id} with
 * the `xi-api-key` header answers the mp3 bytes directly.
 */
import type { BrowserWindow } from 'electron';
/** The `tts` section of pet-settings.json. Absent/disabled/degenerate → the
 * pipeline stays silent (visual-only bubbles, yesterday's behavior). */
export interface TtsConfig {
    enabled?: boolean;
    apiKey?: string;
    voiceId?: string;
    modelId?: string;
    languageCode?: string;
    /** 0.5–2.0, 1 = default. */
    speed?: number;
    /** 0.01–2.0, 1 = default. */
    volume?: number;
    /** How long the bubble may wait for the audio before going out alone
     * (0–8000, default 3000). 0 = never hold (bubble immediate, voice off). */
    holdMs?: number;
}
interface SayTtsDeps {
    /** The dsh home holding pet-settings.json (whale598/ first, legacy root
     * fallback — same dual-path rule as the driver's petdata). */
    home: string;
    /** This carrier instance's pet id (DSH_PET_ID): the key this instance
     * resolves its voice override with from the shared `tts.voices` table. */
    petId: string;
    window: BrowserWindow;
    /** The one delivery channel to the page: the bubble, optionally with its
     * voice. Main process owns the wire shape; this module owns the timing. */
    deliver: (text: string, audio?: Uint8Array<ArrayBuffer>, extras?: Record<string, unknown>) => void;
    log?: (line: string) => void;
}
export interface SayTts {
    /** Forward one /say text to the page. Fire-and-forget: returns
     * immediately, never throws, and a newer call always wins — the older
     * delivery is abandoned (the newest say owns the bubble and the voice). */
    deliver(text: string, extras?: Record<string, unknown>): void;
}
/** Resolve the section for one pet: the shared defaults with this pet's
 * `voices[petId]` entry overlaid field-by-field (voiceId / speed / volume
 * only — key, model, enabled and hold are account- or timing-level and stay
 * shared). Unknown shapes fold away, so a malformed override simply falls
 * through to the global defaults. An empty-string voiceId is "not set" (the
 * settings page's clear-on-empty), never "mute". */
export declare function resolvePetTts(raw: unknown, petId: string): TtsConfig;
export declare function createSayTts(deps: SayTtsDeps): SayTts;
export {};
//# sourceMappingURL=tts.d.ts.map