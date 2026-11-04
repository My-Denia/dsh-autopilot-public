/**
 * `ctx.autopilot`: a READ-ONLY view of the run state for other plugins and the
 * host UI (roadmap §9.7).
 *
 * WHY THIS IS NOT `class AutopilotService extends Service` — the evidence,
 * measured 2026-08-24 against the vendored cordis 4.0.1 this deployment runs:
 *
 * 1. `Service`'s constructor does exactly one registration act:
 *    `ctx.reflect.provide(name, self, this[Service.check])`
 *    (`vendor/cordis/src/service.ts`). Everything else it does is local
 *    bookkeeping — `self.ctx`, `self.name`, and the tracker symbol.
 * 2. `extends Service` needs cordis as a RUNTIME import, and a second physical
 *    copy of a dsh SERVICE package gives the plugin a different class identity
 *    than the host's. That is the standing rule (DESIGN.md §1), and it is a rule
 *    about service-class identity, NOT about the number of runtime imports:
 *    `src/` imports two non-relative packages, and the other one
 *    (`@deepseek-ai/schemastery`, `src/config.ts`) is exempt because the host
 *    touches only its `['~standard'].validate` structural contract and never a
 *    class identity. Adding a runtime cordis import for a read-only accessor
 *    would trade the guarantee for zero behaviour.
 *    (Corrected 2026-08-25: this reason used to be spelled "its only runtime
 *    dependency is `@deepseek-ai/dsh-tools`" — a sentence DESIGN.md §1 retracts
 *    as false. §6 delegates the extends-Service rationale to this file, so a
 *    reader following that pointer landed on what §1 declares false.)
 * 3. The trade would not even be forced: cordis's symbols are `Symbol.for(...)`
 *    (`vendor/cordis/src/utils.ts:50-73`), i.e. cross-realm by construction,
 *    so the tracker metadata a `Service` attaches can be attached by key from
 *    outside without importing the class.
 *
 * So this registers through the SAME call a `Service` would, and attaches the
 * SAME tracker symbol, without the import. What is genuinely NOT reproduced —
 * stated rather than glossed — is `Service`'s intercept-config resolution
 * (`[Service.resolveConfig]`) and its `[Service.filter]` isolate check. Both
 * exist to let a service be RECONFIGURED or ISOLATED per consuming context;
 * this surface exposes a few read-only methods over one ledger store and has
 * nothing to reconfigure or isolate. If that changes, the honest fix is to
 * take the runtime dependency deliberately, not to grow this file.
 */

import type { LegacyRunProjection, LegacyRunSummary, LedgerProjection } from './domain/ledger-types.js'
import type { LegacySources } from './legacy/index.js'
import { projectLedger } from './web.js'
import type { LedgerStoreLike } from './store/ledger.js'

/** Cross-realm tracker key cordis reads when tracing service access. */
const CORDIS_TRACKER = Symbol.for('cordis.tracker')

/**
 * Structural subset of the registration surface. `provide` is cordis's
 * `ctx.provide(name, value)`; `reflect.provide` is the same call one level
 * down, kept as a fallback because only the latter is guaranteed present on
 * every context shape this plugin may be handed.
 */
export interface ProvideHost {
  provide?: (name: string, value?: unknown, check?: () => boolean) => (() => void) | undefined
  reflect?: { provide(name: string, value?: unknown, check?: () => boolean): () => void }
}

/**
 * The read-only surface published at `ctx.autopilot`.
 *
 * Deliberately read-only: the ledger is written by the engine alone, under the
 * live root Agent's authority. A service handle has no agent, so a mutator here
 * would be a second write path with no authority check.
 *
 * Ledger reads come from the store's in-memory cache (filled at open and
 * advanced by this process's own writes); legacy reads go to the frozen 0.2.x
 * reader and are asynchronous because they fold event streams.
 */
export interface AutopilotReadOnly {
  /** The ledger projection of one root session (with its legacy runs attached), or `undefined`. */
  ledger(sessionId: string): Promise<LedgerProjection | undefined>
  /** Every session that has a ledger, projected. */
  ledgers(): Promise<readonly LedgerProjection[]>
  /** Every legacy run in both backends. */
  legacyRuns(): Promise<readonly LegacyRunSummary[]>
  /** One legacy run in full, or `undefined`. */
  legacyRun(runId: string): Promise<LegacyRunProjection | undefined>
  /** One-time notes (e.g. retired config keys that were ignored). */
  notes(): readonly string[]
  /** Which backend holds the ledgers. */
  readonly storeKind: 'file' | 'domain'
}

/** The slice of `src/legacy` this service uses; injectable so tests need no fixtures on disk. */
export interface LegacyReader {
  list(sources: LegacySources): Promise<readonly LegacyRunSummary[]>
  read(sources: LegacySources, runId: string): Promise<LegacyRunProjection | undefined>
}

/** The real reader, loaded on first use. */
const frozenLegacyReader: LegacyReader = {
  list: async (sources) => (await import('./legacy/index.js')).listLegacyRuns(sources),
  read: async (sources, runId) => (await import('./legacy/index.js')).readLegacyRun(sources, runId).then(found => found?.projection),
}

export interface AutopilotServiceInput {
  readonly ledgers: LedgerStoreLike
  readonly sources: LegacySources
  /** Notes are read on every call so a note added after mount still shows. */
  readonly notes?: () => readonly string[]
  readonly legacy?: LegacyReader
}

/** Build the read-only view over a ledger store and the legacy sources. */
export function createAutopilotService(input: AutopilotServiceInput): AutopilotReadOnly {
  const legacy = input.legacy ?? frozenLegacyReader
  const notes = (): readonly string[] => input.notes?.() ?? []
  // The ledger is the only place the one-time sandbox restore outcome is kept, so it
  // wins over the reader's default (`pending`) for every run, whichever route asks.
  const restoreOf = (runId: string) => {
    for (const ledger of input.ledgers.list()) {
      const record = ledger.legacyRestores?.[runId]
      if (record !== undefined) return record
    }
    return undefined
  }
  const listRuns = async (): Promise<readonly LegacyRunSummary[]> =>
    (await legacy.list(input.sources)).map(run => {
      const restore = restoreOf(run.runId)
      return restore === undefined ? run : { ...run, sandboxRestore: restore }
    })
  const project = async (sessionId: string): Promise<LedgerProjection | undefined> => {
    const ledger = input.ledgers.load(sessionId)
    if (ledger === undefined) return undefined
    return projectLedger(ledger, await listRuns(), notes())
  }
  const service: AutopilotReadOnly = {
    ledger: project,
    ledgers: async () => {
      const runs = await listRuns()
      return input.ledgers.list().map(ledger => projectLedger(ledger, runs, notes()))
    },
    legacyRuns: listRuns,
    legacyRun: async (id) => {
      let runId = id
      let run = await legacy.read(input.sources, runId)
      if (run === undefined) {
        // A session id is also accepted: the first 0.2.x run of a session was named after it, and a later
        // run is reached through the session's own listing. The last run listed for the session is served.
        const ofSession = (await legacy.list(input.sources)).filter(candidate => candidate.sessionId === id)
        const latest = ofSession[ofSession.length - 1]
        if (latest !== undefined) {
          runId = latest.runId
          run = await legacy.read(input.sources, runId)
        }
      }
      const restore = restoreOf(runId)
      return run === undefined || restore === undefined ? run : { ...run, sandboxRestore: restore }
    },
    notes,
    storeKind: input.ledgers.kind,
  }
  Object.defineProperty(service, CORDIS_TRACKER, {
    value: { associate: 'autopilot', property: 'ctx' },
    enumerable: false,
    writable: false,
    configurable: true,
  })
  return service
}

/**
 * Register the read-only surface as `ctx.autopilot`.
 *
 * @returns a disposer plus the outcome. Registration failure is NOT fatal and
 * NOT hidden: the returned disposer is a no-op and `registered` says false,
 * while a host that already provides `autopilot` (or hands us a context without
 * a provide surface) still gets a working harness instead of a plugin that
 * refuses to load over an accessor.
 *
 * `registered` is READ by `apply()` and lands in `Enforcement.service`, the
 * same way every sibling probe's outcome lands in `Enforcement`. It has to be:
 * a failure that nothing writes down is a checker whose fail is unobservable in
 * production, which is the one shape DESIGN.md §5 names outright.
 */
export function registerAutopilotService(
  host: ProvideHost,
  service: AutopilotReadOnly,
): { readonly registered: boolean; readonly dispose: () => void; readonly diagnostic?: string } {
  try {
    if (typeof host.provide === 'function') {
      const dispose = host.provide('autopilot', service)
      return { registered: true, dispose: dispose ?? (() => {}) }
    }
    if (host.reflect !== undefined && typeof host.reflect.provide === 'function') {
      return { registered: true, dispose: host.reflect.provide('autopilot', service) }
    }
    return { registered: false, dispose: () => {}, diagnostic: 'context exposes neither ctx.provide nor ctx.reflect.provide' }
  } catch (error: unknown) {
    return {
      registered: false,
      dispose: () => {},
      diagnostic: `ctx.provide("autopilot") failed: ${error instanceof Error ? error.message : String(error)}`,
    }
  }
}
