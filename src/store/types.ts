/**
 * The store seam: everything the engine is allowed to know about persistence.
 *
 * v1 wrote a run's canonical stream straight to files. v2 keeps that backend
 * but stops making it the only possible one: `ctx.storageDomain` (dsh's
 * schema-validated, change-emitting KV domains over a routed storage backend)
 * is the native home for plugin-owned durable state — routable by the host,
 * observable through `domain/changed`, and versioned at the medium — where a
 * private file tree is none of those things.
 *
 * WHY this is a seam and not a migration: `storage-domain` is mounted by the
 * web-app bundle ONLY (`packages/bundle/web-app/cordis.patch.yml:59`, measured
 * 2026-08-24 against dsh 0.1.1-rc.2); the `headless` profile has no
 * `ctx.storageDomain` at all. A migration would delete headless. So both
 * implementations stay, the engine depends on this interface instead of a
 * class, and the run RECORDS which backend it actually got
 * (`Enforcement.store`) rather than claiming a capability it cannot observe.
 *
 * WHY `commit` and `appendLog` are asynchronous here while the file store's
 * are synchronous: a domain table write queues on the domain's per-domain
 * write chain and resolves only after durability, so it is async by
 * construction — `KvTable.put`/`delete` return promises
 * (`packages/storage/storage-domain/src/domain.ts`). Widening the seam is
 * only safe because v2 also moves the last SYNCHRONOUS commit caller — egress
 * approval consumption, which used to run inside the synchronous `ToolGuard`
 * — onto the async `tools/pre-execute` waterfall. With that caller async, an
 * async commit strands nobody.
 *
 * WHY `load` stays synchronous: both backends can preload. The file store
 * reads the stream off disk; the domain facility has already materialized
 * every record into memory by the time `open` resolves, and `KvTable`'s
 * `get`/`entries`/`keys` are synchronous reads from that memory. Making load
 * async would buy nothing and would force every engine read path to await.
 *
 * WHAT DOES NOT MOVE ACROSS THE SEAM: validation. `applyEvent` still runs
 * SYNCHRONOUSLY in the engine, against the in-memory prior snapshot, BEFORE
 * any store call is made. An illegal transition is therefore rejected before
 * a single byte is persisted, in both backends alike. The async boundary
 * introduced here is a DURABILITY boundary, never a validation boundary — no
 * invariant is now checked "after the write".
 */

import type { LogEntry, Operation, RunEvent, RunId, Snapshot, StoreKind } from '../domain/types.js'

/**
 * The persistence contract the engine depends on. Both `RunStore` (files) and
 * `DomainRunStore` (`ctx.storageDomain`) satisfy it; nothing else about a
 * backend is visible to the engine.
 */
export interface RunStoreLike {
  /**
   * Where this run's human/side artifacts live: `log.md`, the outbound
   * manifest, and usage artifacts all resolve against this path. It stays a
   * real filesystem path in BOTH backends — the domain has no place for an
   * appendable markdown log or for a screenshot, and moving those paths when
   * the event backend changes would break `UsageArtifact.ref` containment.
   */
  runDir(runId: RunId): string

  /**
   * Every run id the BACKING STORE holds, not merely the ones this process has
   * touched. `AutopilotEngine.listRuns` used to answer from its in-memory cache,
   * so a freshly started server reported zero runs while the store held dozens
   * — measured 2026-08-25 in the real web profile, where `/api/autopilot/runs`
   * returned `[]` against a populated store and only grew as individual ids
   * were probed. Enumeration must therefore be a STORE question.
   *
   * Ordering is not guaranteed. Ids that cannot be resolved are omitted rather
   * than guessed at: the file backend sanitizes ids into directory names
   * (lossy), so it recovers the true id from each run's own projection instead
   * of un-mangling the path.
   */
  listRuns(): readonly RunId[]

  /**
   * Replay a run's canonical event stream under the strict fold.
   * @returns the folded snapshot, or `undefined` when the run has no stream.
   * @throws AutopilotError when the stored stream is corrupt or illegal —
   * a bad stream is loud, never silently repaired or skipped.
   */
  load(runId: RunId): Snapshot | undefined

  /**
   * OPTIONAL freshness probe: the revision the backing medium holds right now,
   * answered WITHOUT folding the stream.
   *
   * Optional, and absent means "this backend cannot tell you" rather than
   * "this backend is current" — the same least-capable-default doctrine as
   * `EnvironmentProbes` in the engine. `AutopilotEngine.peekFresh` uses it to
   * revalidate its per-run memo on the READ-ONLY path; a backend that omits it
   * simply keeps the old behaviour (serve the memo), which is honest because
   * nothing observed it to be stale.
   *
   * `DomainRunStore` deliberately does NOT implement it: `ctx.storageDomain`
   * materializes every record at `open` and never re-reads the medium, so any
   * number it could return would describe this process's own memory rather
   * than the medium — a freshness claim the code cannot observe. That backend's
   * cross-process story is worse than stale anyway (storage-json is
   * read-once-at-open plus whole-file republish, i.e. two writers CLOBBER each
   * other), which is why the deployment pins the file backend; see DESIGN.md §6.
   *
   * @param runId - the run to probe.
   * @returns the medium's current revision, or `undefined` when unknowable.
   */
  currentRevision?(runId: RunId): number | undefined

  /**
   * Persist one already-validated transition: append the event to the
   * canonical stream, then refresh the snapshot projection.
   * @returns the event as it was written (its `time` is assigned here).
   */
  commit(runId: RunId, op: Operation, snapshot: Snapshot, detail?: unknown): Promise<RunEvent>

  /** Append one checkpoint line to the run's human-readable `log.md`. */
  appendLog(runId: RunId, entry: LogEntry): Promise<void>

  /** Which backend this instance is, recorded into `Enforcement.store` rather than assumed. */
  readonly kind: StoreKind
}
