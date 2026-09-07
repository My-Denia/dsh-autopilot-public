/**
 * The host half of roadmap §9.3: a same-origin read-only HTTP surface over
 * `ctx.autopilot`, so the browser can show CURRENT run state instead of the
 * card's reconstruction of past tool traffic.
 *
 * WHY THE PROJECTION IS NOT `Snapshot`, AND WHY THAT IS THE POINT.
 * `AutopilotReadOnly` exposes two readers. `peek()` returns the whole
 * {@link Snapshot}: the full plan text, the executor's returned packet or the
 * root's evidence report, every auditor's free-text note, the closeout body,
 * the residual-risk list, the usage artifacts and the baseline branch/commit.
 * That is the run's private working material, and none of it is needed to say
 * "what phase is this run in and which gates have passed". So:
 *
 *   **this module never calls `peek()`.**
 *
 * Everything it serves is derived from `status()`, the projection the engine
 * already hands the MODEL — which means nothing crosses the HTTP boundary that
 * the session log did not already carry. Two fields are dropped even from
 * that:
 *
 *  - `diagnostic`, because `engine.ts` aliases it onto an auditor's `note`
 *    (`applyVerdict`) and onto an owner's ruling text (`autopilot_signal`).
 *    Both are unbounded free text about the workspace, and a gate-status view
 *    has no use for either.
 *  - `enforcement.ownerApprovals[]`, because each entry's `target` is a "human
 *    description of the approved egress" and `consumedBy` names what consumed
 *    it — i.e. the one place in `StatusView` that names an external
 *    destination. The count and the grant revisions carry the enforcement fact
 *    without the destination.
 *
 * DEGRADATION. The route is mounted through `ctx.inject(['webServer'], …)`,
 * cordis's lazy inject: on a profile with no api-gateway (the headless
 * bundles), `webServer` never appears, the callback never runs, and the plugin
 * behaves exactly as it did before this module existed. There is no probe to
 * get wrong and no branch to test — absence is the default.
 *
 * @module dsh-autopilot/web
 */

import type { Enforcement } from './domain/types.js'
import type { StatusView } from './engine.js'
import type { AutopilotReadOnly } from './service.js'

/** Same-origin API prefix. One namespace, matching the plugin's package name. */
export const AUTOPILOT_API_PREFIX = '/api/autopilot'

// ─────────────────────────────────────────────────────────────────────────────
// Structural mirrors of the webserver contract
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Structural mirror of `node:http`'s request/response pair, narrowed to what a
 * handler here touches. Declared rather than imported so this module carries no
 * dependency on `@deepseek-ai/dsh-host-webserver`, which is not a dependency of
 * this package and is absent on a headless profile.
 */
export interface RouteRequest {
  readonly method?: string | undefined
  readonly url?: string | undefined
}

/** Structural mirror of `ServerResponse`, narrowed to the two calls used. */
export interface RouteResponse {
  writeHead(status: number, headers: Record<string, string>): unknown
  end(body?: string): unknown
}

/** Structural mirror of `WebRoute` (`@deepseek-ai/dsh-host-webserver`). */
export interface AutopilotWebRoute {
  readonly kind: 'exact' | 'prefix'
  readonly path: string
  readonly handler: (req: RouteRequest, res: RouteResponse) => void
}

/**
 * Structural mirror of the host's `connection` service, narrowed to the fence.
 *
 * `requestRejection(req)` is the Host/Origin browser-trust fence plus browser
 * authentication that the in-tree `client-connection` plugin applies to its
 * own `/api` prefix (dsh 0.1.2-rc.1 `packages/client/connection/src/index.ts`,
 * `rpc-host.ts:96`). It answers `401`, `403`, or `undefined` for "let it
 * through". `webServer.register` itself applies NO auth, so a plugin route
 * must ask this service on every request.
 */
export interface ConnectionFence {
  requestRejection(request: RouteRequest): number | undefined
}

/** The scoped context handed to the `webServer` inject callback. */
export interface WebServerScope {
  webServer: { register(route: AutopilotWebRoute): () => void }
  effect?: (setup: () => () => void, label?: string) => unknown
  /** cordis weak service lookup; `connection` is resolved PER REQUEST through it. */
  get?: (name: string) => unknown
}

/** Structural mirror of the cordis lazy-inject surface plus the `webServer` service. */
export interface WebServerHost {
  inject?: (names: readonly string[], callback: (scoped: WebServerScope) => void) => (() => void) | undefined
}

/** Body answered when the host has a web server but no `connection` service. */
export const NO_CONNECTION_SERVICE = { ok: false, error: 'no-connection-service' } as const

/**
 * Wrap a route in the host's browser-trust fence.
 *
 * FAIL-CLOSED: a host with `webServer` but no `connection` service answers
 * `503 no-connection-service` rather than serving the projection openly —
 * before dsh 0.1.2 these routes were served unfenced, which is exactly the
 * exposure the in-tree gateway closes for its own prefix. The service is looked
 * up on EVERY request, never snapshotted at mount, so a `connection` plugin
 * that loads after this one is honoured as soon as it exists.
 *
 * @param route - the unfenced route.
 * @param lookup - the scoped context's weak service lookup.
 * @returns the same route with the fence in front of its handler.
 */
export function fenceRoute(route: AutopilotWebRoute, lookup: ((name: string) => unknown) | undefined): AutopilotWebRoute {
  return {
    kind: route.kind,
    path: route.path,
    handler: (req, res) => {
      const connection = lookup?.('connection') as Partial<ConnectionFence> | undefined
      if (connection === undefined || typeof connection.requestRejection !== 'function') {
        return json(res, 503, NO_CONNECTION_SERVICE)
      }
      const rejection = connection.requestRejection(req)
      if (rejection !== undefined) {
        res.writeHead(rejection, { 'content-type': 'text/plain; charset=utf-8' })
        return res.end(rejection === 401 ? 'unauthorized' : 'forbidden')
      }
      return route.handler(req, res)
    },
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// The projection — a pure function, which is the whole reason it is testable
// ─────────────────────────────────────────────────────────────────────────────

/** Enforcement, with the free-text approval descriptions replaced by counts. */
export interface EnforcementProjection {
  readonly sandbox?: string
  readonly modeAppended?: boolean
  readonly priorSandboxMode?: string
  readonly reminders?: number
  readonly store?: string
  readonly approval?: string
  readonly egress?: string
  readonly service?: string
  readonly outboundConsumed?: number
  /** How many owner approvals were granted. The `target` strings are NOT served. */
  readonly ownerApprovalsGranted: number
  /** How many of those an egress consumed. */
  readonly ownerApprovalsConsumed: number
}

/** One run, as served. Strictly narrower than `StatusView`. */
export interface RunProjection {
  readonly runId: string
  readonly revision: number
  readonly phase: string
  readonly planGate: string
  readonly executionGate: string
  readonly planRevision: number
  readonly objective: string
  readonly size: string
  readonly risk: string
  readonly executionMode: string
  readonly auditMode: string
  readonly requiredRoles: readonly string[]
  readonly latestVerdicts: Readonly<Record<string, string>>
  readonly replanBudgetRemaining: number
  readonly auditCount: number
  readonly logCount: number
  readonly closeoutSubmitted: boolean
  readonly executor?: { readonly generation: number; readonly state: string }
  readonly enforcement: EnforcementProjection
}

/** The `/runs` body. */
export interface RunsBody {
  readonly ok: true
  /** Which backend holds the canonical stream, as observed at mount. */
  readonly storeKind: string
  readonly runs: readonly RunProjection[]
}

/** The error body shape; `error` is a stable machine code, never an exception message. */
export interface ErrorBody {
  readonly ok: false
  readonly error: string
}

/** The keys of `Enforcement` that are safe to forward verbatim. */
const ENFORCEMENT_KEYS = [
  'sandbox', 'modeAppended', 'priorSandboxMode', 'reminders',
  'store', 'approval', 'egress', 'service', 'outboundConsumed',
] as const

/**
 * Project one enforcement record.
 *
 * @param enforcement - the run's enforcement block.
 * @returns the forwarded keys plus approval COUNTS; never an approval's target text.
 */
export function projectEnforcement(enforcement: Enforcement): EnforcementProjection {
  const out: Record<string, unknown> = {}
  for (const key of ENFORCEMENT_KEYS) {
    const value = enforcement[key]
    if (value !== undefined) out[key] = value
  }
  const approvals = enforcement.ownerApprovals
  const list = Array.isArray(approvals) ? approvals : []
  out.ownerApprovalsGranted = list.length
  out.ownerApprovalsConsumed = list.filter(
    entry => typeof entry === 'object' && entry !== null && (entry as { consumedBy?: unknown }).consumedBy !== undefined,
  ).length
  return out as unknown as EnforcementProjection
}

/**
 * Project one `StatusView` into the served shape.
 *
 * Deliberately an ALLOW-LIST over the status projection rather than a
 * deny-list over the snapshot: a field added to `Snapshot` later cannot leak
 * through here by omission, because nothing arrives unless it is named.
 *
 * @param status - the engine's model-facing status projection.
 * @returns the run as served, without `diagnostic` and without approval targets.
 */
export function projectRun(status: StatusView): RunProjection {
  const verdicts: Record<string, string> = {}
  for (const [role, verdict] of Object.entries(status.latestVerdicts)) {
    if (typeof verdict === 'string') verdicts[role] = verdict
  }
  return {
    runId: status.runId,
    revision: status.revision,
    phase: status.phase,
    planGate: status.planGate,
    executionGate: status.executionGate,
    planRevision: status.planRevision,
    objective: status.objective,
    size: status.size,
    risk: status.risk,
    executionMode: status.executionMode,
    auditMode: status.auditMode,
    requiredRoles: [...status.requiredRoles],
    latestVerdicts: verdicts,
    replanBudgetRemaining: status.replanBudgetRemaining,
    auditCount: status.auditCount,
    logCount: status.logCount,
    closeoutSubmitted: status.closeoutSubmitted,
    ...(status.executor === undefined
      ? {}
      : { executor: { generation: status.executor.generation, state: status.executor.state } }),
    enforcement: projectEnforcement(status.enforcement),
  }
}

/**
 * Project every run this mount has materialized.
 *
 * The no-run case is NOT an error: a mount with no run is the normal state of
 * every session before `autopilot_init`, and an empty list says exactly that.
 * A run id that `list()` reports but `status()` cannot project (a stream folded
 * to nothing) is SKIPPED rather than served as a half-filled row.
 *
 * @param service - the read-only `ctx.autopilot` surface.
 * @returns the served body.
 */
export function projectRuns(service: AutopilotReadOnly): RunsBody {
  const runs: RunProjection[] = []
  for (const runId of service.list()) {
    const status = service.status(runId)
    if (status === undefined) continue
    runs.push(projectRun(status))
  }
  return { ok: true, storeKind: service.storeKind ?? 'file', runs }
}

// ─────────────────────────────────────────────────────────────────────────────
// Routes
// ─────────────────────────────────────────────────────────────────────────────

function json(res: RouteResponse, status: number, body: RunsBody | ErrorBody | { ok: true; run: RunProjection }): void {
  res.writeHead(status, { 'content-type': 'application/json; charset=utf-8' })
  res.end(JSON.stringify(body))
}

/** Read one query parameter, URL-decoded, first occurrence wins. */
export function queryParam(url: string, key: string): string | undefined {
  const at = url.indexOf('?')
  if (at === -1) return undefined
  for (const part of url.slice(at + 1).split('&')) {
    if (!part.startsWith(`${key}=`)) continue
    try {
      return decodeURIComponent(part.slice(key.length + 1))
    } catch {
      return undefined
    }
  }
  return undefined
}

/**
 * Build the route table.
 *
 * `GET /api/autopilot/runs` — every materialized run, projected.
 * `GET /api/autopilot/run?id=<rootSessionId>` — one run, 404 when absent.
 *
 * Both are GET-only; a non-GET method answers 405 rather than being treated as
 * a read, because this surface is read-only by construction and a POST landing
 * here is a caller bug worth reporting.
 *
 * @param service - the read-only `ctx.autopilot` surface.
 * @returns the routes, ready for `webServer.register`.
 */
export function makeAutopilotRoutes(service: AutopilotReadOnly): readonly AutopilotWebRoute[] {
  return [
    {
      kind: 'exact',
      path: `${AUTOPILOT_API_PREFIX}/runs`,
      handler: (req, res) => {
        if (req.method !== 'GET') return json(res, 405, { ok: false, error: 'method-not-allowed' })
        try {
          return json(res, 200, projectRuns(service))
        } catch {
          // The message is deliberately NOT forwarded: an engine failure can
          // carry a store path, and this route serves no free text.
          return json(res, 500, { ok: false, error: 'projection-failed' })
        }
      },
    },
    {
      kind: 'exact',
      path: `${AUTOPILOT_API_PREFIX}/run`,
      handler: (req, res) => {
        if (req.method !== 'GET') return json(res, 405, { ok: false, error: 'method-not-allowed' })
        const id = queryParam(req.url ?? '', 'id')
        if (id === undefined || id === '') return json(res, 400, { ok: false, error: 'missing-id' })
        try {
          const status = service.status(id)
          if (status === undefined) return json(res, 404, { ok: false, error: 'no-run' })
          return json(res, 200, { ok: true, run: projectRun(status) })
        } catch {
          return json(res, 500, { ok: false, error: 'projection-failed' })
        }
      },
    },
  ]
}

/**
 * Mount the routes when — and only when — a web server exists.
 *
 * @param rawCtx - the plugin's cordis context.
 * @param service - the read-only surface to project.
 * @returns a disposer; a no-op on a host with no `ctx.inject`.
 */
export function installAutopilotRoutes(rawCtx: unknown, service: AutopilotReadOnly): () => void {
  const host = rawCtx as WebServerHost
  if (typeof host.inject !== 'function') return () => {}
  const routes = makeAutopilotRoutes(service)
  const dispose = host.inject(['webServer'], (scoped) => {
    const lookup = typeof scoped.get === 'function' ? scoped.get.bind(scoped) : undefined
    const mount = (): (() => void) => {
      const disposers = routes.map(route => scoped.webServer.register(fenceRoute(route, lookup)))
      return () => {
        for (const stop of disposers.reverse()) stop()
      }
    }
    // Prefer the scoped effect so an unload of the injected scope releases the
    // routes; a context without `effect` still gets them mounted.
    if (typeof scoped.effect === 'function') scoped.effect(mount, 'dsh-autopilot: routes')
    else mount()
  })
  return dispose ?? (() => {})
}
