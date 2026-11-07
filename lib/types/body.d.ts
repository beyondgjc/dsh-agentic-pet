/**
 * body/1 — the body's own description of what it is and what it can do.
 * The driver owns this envelope (shapes, validation); the body owns the
 * values (ids, tags, usage, fallbacks). Unknown fields are preserved, never
 * interpreted here. Capability kinds: listing capabilities (actions,
 * expressions, …) follow the catalog/tags/count shape; the three known
 * BEHAVIOR kinds (`kind: "facing" | "idle" | "transition"`, body iteration
 * Phase 0) carry their own typed shape instead — they describe HOW the body
 * moves, not what it lists.
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
/** The three known behavior capabilities (body iteration Phase 0). A
 * capability entry declaring one of these kinds follows its typed shape;
 * anything else falls through to the generic catalog/tags/count shape. */
export type BodyBehaviorKind = 'facing' | 'idle' | 'transition';
/** Validate the body/1 envelope; preserve every unknown field. A missing or
 * foreign schema is legacy, not an error: old bodies keep working. */
export declare function normalizeBody(raw: unknown): BodyNormalization;
export type ExpressionResolution = {
    readonly kind: 'ok';
    readonly expression: string;
} | {
    readonly kind: 'unsupported';
    readonly capability: BodyCapability;
} | {
    readonly kind: 'unknown';
    readonly available: readonly string[];
} | {
    readonly kind: 'missing';
};
/** Resolve pet_express against the CURRENT body's own expression capability.
 * There is no cross-body expression vocabulary. */
export declare function resolveExpressionRequest(body: BodyDescription | null, requested: string): ExpressionResolution;
export interface ExpressionFallbackSuggestion {
    readonly message: string;
    readonly fallback: {
        readonly tool: string;
        readonly args: Readonly<Record<string, unknown>>;
    } | null;
    readonly availableTags: readonly string[];
}
/** Compute the degradation per REQUEST, not per body: a name that is also an
 * action tag gets that tag; otherwise the body's declared default is used
 * (and labelled as a default), never presented as a per-request match. */
export declare function suggestExpressionFallback(capability: BodyCapability, requested: string, actionTags: readonly string[]): ExpressionFallbackSuggestion;
export declare function formatMissingExpression(): string;
//# sourceMappingURL=body.d.ts.map