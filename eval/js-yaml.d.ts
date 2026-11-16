/** Minimal ambient types for js-yaml (only what the eval harness uses; the
 * full @types/js-yaml is not installed — see AGENTS.md §2 on the fragile
 * devDependencies set). */

declare module 'js-yaml' {
  export interface LoadOptions {
    readonly schema?: unknown
  }
  export function load(input: string, options?: LoadOptions): unknown
}
