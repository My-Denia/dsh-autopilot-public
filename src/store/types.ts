/**
 * Shared store types.
 *
 * 0.3.0 retired the run-store seam (`RunStoreLike`: commit / appendLog / load
 * over an event stream). The persistence contract is now `LedgerStoreLike` in
 * `./ledger.ts`; only the 0.2.x session pointer type survives, for the legacy
 * reader.
 */

/**
 * Which runs one session has started, and which one is current.
 * The run directories stay the history; this file is only the pointer.
 */
export interface SessionRunIndex {
  readonly v: 1
  readonly sessionId: string
  readonly currentRunId: string
  readonly runIds: readonly string[]
}
