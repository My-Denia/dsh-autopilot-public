/** Types for the verbatim rc.5 excerpt in ./grouping.js. */
export type RootEntry =
  | { readonly kind: 'node'; readonly key: string; readonly groupPart?: string }
  | { readonly kind: 'group'; readonly members: readonly string[] }
export declare function groupTurn(
  turnKeys: readonly string[],
  readNode: (key: string) => { readonly kind: string; readonly groupTree?: string },
  reasoning?: (node: unknown) => boolean,
  reply?: (node: unknown) => boolean,
): RootEntry[]
export declare function isAtOrOutside(node: { readonly groupTree?: string }, position: 'exchange' | 'input' | 'turn' | 'process'): boolean
