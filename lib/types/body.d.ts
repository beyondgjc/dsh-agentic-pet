/**
 * body/1 — the body's own description of what it is and what it can do.
 * The driver owns this envelope (shapes, validation); the body owns the
 * values (ids, tags, usage, fallbacks). Unknown fields and capability kinds
 * are preserved, never interpreted here.
 * @module dsh-agentic-pet/body
 */
export interface BodyCapability {
    readonly supported: boolean;
    readonly usage: string;
    readonly example?: {
        readonly tool: string;
        readonly args: Readonly<Record<string, unknown>>;
    };
    readonly catalog?: readonly string[];
    readonly tags?: readonly string[];
    readonly count?: number;
    /** catalog/tags are illustrative; count is the real total. */
    readonly sample?: boolean;
    readonly vocabulary?: string;
    readonly fallback?: {
        readonly note: string;
        readonly substitute: {
            readonly tool: string;
            readonly args: Readonly<Record<string, unknown>>;
        };
    };
    readonly [key: string]: unknown;
}
export interface BodyDescription {
    readonly schema: 'body/1';
    readonly bodyId?: string;
    readonly renderer?: string;
    readonly appearance?: {
        readonly name: string;
        readonly [key: string]: unknown;
    };
    readonly hitboxes?: {
        readonly parts: readonly string[];
        readonly rects?: Readonly<Record<string, readonly number[]>>;
        readonly coordinateSpace?: string;
        readonly [key: string]: unknown;
    };
    readonly capabilities?: Readonly<Record<string, BodyCapability>>;
    readonly extensions?: Readonly<Record<string, unknown>>;
    readonly [key: string]: unknown;
}
export type BodyNormalization = {
    readonly kind: 'body';
    readonly body: BodyDescription;
} | {
    readonly kind: 'legacy';
    readonly reason: string;
};
/** Validate the body/1 envelope; preserve every unknown field. A missing or
 * foreign schema is legacy, not an error: old bodies keep working. */
export declare function normalizeBody(raw: unknown): BodyNormalization;
