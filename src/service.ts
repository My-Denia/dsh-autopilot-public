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
 * this surface exposes three read-only methods over one engine and has
 * nothing to reconfigure or isolate. If that changes, the honest fix is to
 * take the runtime dependency deliberately, not to grow this file.
 */

import type { RunId, Snapshot } from './domain/types.js'
import type { AutopilotEngine, StatusView } from './engine.js'

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
 * Deliberately read-only: the engine's single-writer authority rests on every
 * mutation proving it came from the exact live root Agent. A service handle
 * has no agent, so exposing a mutator here would be a second write path with
 * no authority check — the one thing the whole design exists to prevent.
 */
export interface AutopilotReadOnly {
  /**
   * The folded snapshot of the run rooted at one session id.
   *
   * FRESHNESS IS PART OF THE CONTRACT (2026-08-27). Both readers answer from
   * `AutopilotEngine.peekFresh`, i.e. the engine's per-run memo revalidated
   * against the store's published revision. A consumer of this surface is by
   * definition NOT the writer — the engine's write paths never come through
   * here — so serving a memo that another process has already moved past is
   * always wrong for this surface, and was: a web mount served its first
   * observation of a headless-driven run forever.
   */
  peek(rootSessionId: RunId): Snapshot | undefined
  /** The model-facing status projection, or undefined when no run is bound. Revalidated; see {@link AutopilotReadOnly.peek}. */
  status(rootSessionId: RunId): StatusView | undefined
  /** Run ids this mount has materialized. */
  list(): readonly RunId[]
  /** Which backend holds the canonical stream, as observed at mount. */
  readonly storeKind: Snapshot['enforcement']['store']
}

/** Build the read-only view over one engine. */
export function createAutopilotService(engine: AutopilotEngine): AutopilotReadOnly {
  const service: AutopilotReadOnly = {
    peek: (rootSessionId) => engine.peekFresh(rootSessionId),
    status: (rootSessionId) => {
      const snapshot = engine.peekFresh(rootSessionId)
      if (snapshot === undefined) return undefined
      return engine.projectStatus(snapshot)
    },
    list: () => engine.listRuns(),
    storeKind: engine.storeKind,
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
