/**
 * The catalog port: a structural subset of the host `ctx.llm` (`LlmRuntime`),
 * with snapshot caching for the routing core.
 *
 * WHY A STRUCTURAL SUBSET AND NOT AN IMPORT (plan "Verified facts" 1; the
 * `SessionRef`/`AgentRef` pattern from `src/engine.ts`). This plugin compiles
 * against hand-declared mirrors of the four `LlmRuntime` members it uses, so
 * a host member disappearing fails the compile-time boundary bearer
 * (`test/routing-boundary.test.ts` assigns the REAL `LlmRuntime.prototype`
 * to {@link LlmRuntimeSubset}) instead of surfacing as `undefined` at
 * runtime — the exact failure mode `test/host-types.test.ts` was written to
 * catch for `Session.events`. Field names mirror
 * `@deepseek-ai/dsh-llm`'s `LlmProviderInfo` / `LlmModelInfo` /
 * `LlmResolvedModelInfo` / `LlmCallConfig`; nothing is quoted at runtime and
 * nothing is imported from a dsh package in `src/` (guarded by a source-scan
 * test in `test/routing.test.ts`).
 *
 * WHY THE CATALOG IS ONLY `ctx.llm` (AC1). `listProviders()`/`listModels()`
 * are the adapter-preferred order; `resolveModelInfo()` is the exact-route
 * fact source (context window, reasoning efforts) and is INDEPENDENT of the
 * advisory catalog listing; `resolveCallConfig()` is the preflight that
 * validates an explicit effort against exact capability. There is no parallel
 * provider registry in this plugin, and the volatile settings backend is
 * never read here (authorization lives in `./authorize.ts` and the session
 * policy, never in settings).
 *
 * Snapshot discipline (plan "Route records and stability"): a snapshot is
 * cached until {@link RouteCatalog.invalidate} — the engine calls that on
 * `llm/adapters-updated`, which is payload-free by design, so the catalog is
 * re-read per commit. An absent `llm` service yields an EMPTY catalog with
 * `catalogStatus: 'unavailable'` recorded, never a throw and never a guess.
 */

import { errorMessage } from '../domain/types.js'

/** Display metadata for one registered provider route (mirror of `LlmProviderInfo`). */
export interface LlmProviderInfo {
  readonly id: string
  readonly name: string
}

/** Merge-extensible provider model modality vocabulary (mirror subset). */
export type ModelModality = 'text' | 'image'

/** One adapter-discovered catalog model (mirror of `LlmModelInfo`); listing is advisory. */
export interface LlmModelInfo {
  readonly provider: string
  readonly id: string
  readonly name: string
  readonly description?: string
  readonly inputModalities?: readonly ModelModality[]
}

/** Provider-owned context capacity for one exact route (mirror of `LlmModelContext`). */
export interface LlmModelContext {
  readonly contextWindow: number
}

/** One adapter-owned reasoning effort (mirror of `LlmReasoningEffortInfo`). */
export interface LlmReasoningEffortInfo {
  readonly id: string
  readonly name: string
  readonly description?: string
}

/** Selectable reasoning efforts for one exact route (mirror of `LlmModelReasoningInfo`). */
export interface LlmModelReasoningInfo {
  readonly efforts: readonly LlmReasoningEffortInfo[]
  readonly defaultEffort?: string
}

/**
 * Exact-route model metadata (mirror of `LlmResolvedModelInfo`). `context`
 * and `reasoning` are OPTIONAL because the adapter may not disclose them —
 * "unknown facts" are a first-class selector input, not an error.
 */
export interface LlmResolvedModelInfo extends LlmModelInfo {
  readonly context?: LlmModelContext
  readonly defaultMaxTokens?: number
  readonly reasoning?: LlmModelReasoningInfo
  readonly systemPromptUpdate?: 'in-history'
  readonly toolUpdate?: 'in-history' | 'addition-only'
}

/** A conversation call config (mirror of `LlmCallConfig`); the preflight input/output. */
export interface LlmCallConfig {
  provider: string
  model: string
  reasoningEffort?: string
  temperature?: number
  maxTokens?: number
  stop?: string[]
}

/**
 * The structural subset of `ctx.llm` the routing core touches. Method syntax
 * (not property syntax) on purpose: it keeps the parameter comparison
 * bivariant, so the branded host effort ids stay assignable to the mirror's
 * plain strings in both directions.
 */
export interface LlmRuntimeSubset {
  /** Detached provider metadata in registration order. */
  listProviders(): readonly LlmProviderInfo[]
  /** Discoverable models in adapter-preferred order for one owned provider. */
  listModels(provider: string): Promise<readonly LlmModelInfo[]>
  /** Exact-route facts; independent of the advisory catalog listing. */
  resolveModelInfo(provider: string, model: string, signal?: AbortSignal): Promise<LlmResolvedModelInfo>
  /** Validate an explicit effort against exact capability; does not bind a later dispatch. */
  resolveCallConfig(config: LlmCallConfig, signal?: AbortSignal): Promise<LlmCallConfig>
}

/** Whether the catalog was read from a live `llm` service. */
export type CatalogStatus = 'live' | 'unavailable'

/** One immutable catalog read. Plain data plus exported helpers — trivially fixture-buildable. */
export interface CatalogSnapshot {
  readonly catalogStatus: CatalogStatus
  /** `unavailable` ⇒ always empty: nothing is provably live. */
  readonly providers: readonly LlmProviderInfo[]
  /** All listed models, concatenated in `listProviders()` × per-provider adapter order. */
  readonly listedModels: readonly LlmModelInfo[]
  /** Per-provider listing failures, recorded — degradation is never silent. */
  readonly providerErrors: ReadonlyMap<string, string>
  /** Why the catalog is unavailable, when it is. */
  readonly diagnostic?: string
}

/** Collision-free key for one explicit route, trim-exact. */
export function routeKey(provider: string, model: string): string {
  return JSON.stringify([provider.trim(), model.trim()])
}

/** Whether a provider route is live in this snapshot (trim-exact; never on an unavailable catalog). */
export function providerIsLive(snapshot: CatalogSnapshot, provider: string): boolean {
  if (snapshot.catalogStatus !== 'live') return false
  const wanted = provider.trim()
  return snapshot.providers.some((candidate) => candidate.id.trim() === wanted)
}

/**
 * The adapter-preferred catalog position of one route (trim-exact), or
 * `undefined` when the model is not listed. Unlisted routes stay eligible —
 * core routing accepts unlisted model ids — but they tie-break AFTER every
 * listed route, having no adapter-preferred position to claim.
 */
export function catalogRank(snapshot: CatalogSnapshot, provider: string, model: string): number | undefined {
  const index = snapshot.listedModels.findIndex(
    (candidate) => candidate.provider.trim() === provider.trim() && candidate.id.trim() === model.trim(),
  )
  return index === -1 ? undefined : index
}

const EMPTY_UNAVAILABLE: Readonly<Pick<CatalogSnapshot, 'providers' | 'listedModels' | 'providerErrors'>> = {
  providers: [],
  listedModels: [],
  providerErrors: new Map<string, string>(),
}

/**
 * The catalog port: snapshot cache over a (possibly absent) `llm` service.
 *
 * Pure-bookkeeping object — every fact it hands out came from the host subset
 * or was recorded as degraded. It never interprets routes; ordering,
 * eligibility, and authorization live elsewhere.
 */
export class RouteCatalog {
  private readonly llm: LlmRuntimeSubset | undefined
  private cached?: Promise<CatalogSnapshot>
  private stale = true

  /** @param llm the host `ctx.llm`, or `undefined` when the service is absent on this profile. */
  constructor(llm: LlmRuntimeSubset | undefined) {
    this.llm = llm
  }

  /** Drop the cached snapshot; the next {@link snapshot} re-reads the host. Call on `llm/adapters-updated`. */
  invalidate(): void {
    this.stale = true
    this.cached = undefined
  }

  /**
   * Read (or return the cached) catalog snapshot. Concurrent callers share
   * one read. An absent service resolves immediately to the empty
   * `unavailable` snapshot — recorded, never thrown.
   */
  snapshot(): Promise<CatalogSnapshot> {
    if (this.llm === undefined) {
      return Promise.resolve({
        catalogStatus: 'unavailable',
        ...EMPTY_UNAVAILABLE,
        diagnostic: 'llm service absent on this profile — empty catalog recorded as unavailable',
      })
    }
    if (this.cached !== undefined && !this.stale) return this.cached
    this.stale = false
    const read = this.read(this.llm).catch((error: unknown): CatalogSnapshot => ({
      catalogStatus: 'unavailable',
      ...EMPTY_UNAVAILABLE,
      diagnostic: `catalog read failed: ${errorMessage(error)}`,
    }))
    this.cached = read
    return read
  }

  private async read(llm: LlmRuntimeSubset): Promise<CatalogSnapshot> {
    const providers = await Promise.resolve(llm.listProviders())
    const providerErrors = new Map<string, string>()
    const listedModels: LlmModelInfo[] = []
    for (const provider of providers) {
      const id = provider.id.trim()
      if (id.length === 0) continue
      try {
        const models = await llm.listModels(id)
        for (const model of models) {
          // Adapter-preferred order is preserved verbatim: it is the tie-break.
          listedModels.push(model)
        }
      } catch (error) {
        // A failed listing degrades that provider's models to "none listed",
        // recorded here — the provider itself stays live (listProviders named
        // it), and its routes stay eligible with facts from resolveModelInfo.
        providerErrors.set(id, errorMessage(error))
      }
    }
    return { catalogStatus: 'live', providers, listedModels, providerErrors }
  }

  /**
   * Exact-route facts for one route. May reject (unknown route, absent
   * service): the caller records the failure and treats the facts as unknown
   * rather than guessing — an unknown context window is an eligible,
   * last-ranked candidate, not an error.
   */
  resolveRoute(provider: string, model: string, signal?: AbortSignal): Promise<LlmResolvedModelInfo> {
    if (this.llm === undefined) {
      return Promise.reject(new Error(`llm service absent — facts for ${provider}/${model} unavailable`))
    }
    return this.llm.resolveModelInfo(provider, model, signal)
  }

  /**
   * Preflight one dispatch config: `resolveCallConfig` validates an explicit
   * effort against exact capability and materializes adapter defaults. A
   * preflight that does not bind the later dispatch (upstream contract), so
   * success here is evidence, not a reservation. Rejections carry the
   * adapter's reason into the caller's `fallbackFrom` record.
   */
  preflight(config: LlmCallConfig, signal?: AbortSignal): Promise<LlmCallConfig> {
    if (this.llm === undefined) {
      return Promise.reject(new Error(`llm service absent — preflight of ${config.provider}/${config.model} impossible`))
    }
    return this.llm.resolveCallConfig(config, signal)
  }
}
