/**
 * The host half of the card: a same-origin read-only HTTP surface over
 * `ctx.autopilot`, so the browser shows CURRENT ledger state.
 *
 * ROUTES (constants live in `domain/ledger-types.ts`, shared with the card):
 *  - `GET LEDGER_ROUTE?session=<id>`  one session's ledger plus its legacy runs.
 *  - `GET LEGACY_RUNS_ROUTE`          every pre-0.3.0 run, both backends.
 *  - `GET LEGACY_RUN_ROUTE?id=<id>`   one pre-0.3.0 run in full.
 *
 * Error bodies carry a stable code and never text from the store: a stored
 * path or exception message must not cross the HTTP boundary. Routes read
 * through the read-only service, never the engine.
 *
 * DEGRADATION. The routes are mounted through `ctx.inject(['webServer'], ...)`,
 * cordis's lazy inject: on a profile with no api-gateway (the headless
 * bundles), `webServer` never appears, the callback never runs, and the plugin
 * behaves exactly as it did before this module existed.
 *
 * @module dsh-autopilot/web
 */

import { LEDGER_ROUTE, LEGACY_RUN_ROUTE, LEGACY_RUNS_ROUTE } from './domain/ledger-types.js'
import type {
  ErrorBody,
  LedgerBody,
  LedgerProjection,
  Ledger,
  LegacyRunBody,
  LegacyRunsBody,
  LegacyRunSummary,
} from './domain/ledger-types.js'
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
// The projection: a pure function, which is the whole reason it is testable
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Project one ledger for the card.
 *
 * Attaches the legacy runs that belong to this session (matched by the run's
 * session id, or by the id list the ledger recorded) and overlays each run's
 * `sandboxRestore` with what the ledger recorded for it: the ledger is the only
 * place the one-time restore outcome is kept, so it wins over the reader's
 * summary.
 *
 * @param ledger - the session's ledger.
 * @param legacyRuns - every legacy run summary; the others are ignored.
 * @param notes - one-time notes to show.
 * @param retiredConfigKeys - retired config keys the host ignored, as data for the card's own wording.
 */
export function projectLedger(
  ledger: Ledger,
  legacyRuns: readonly LegacyRunSummary[],
  notes: readonly string[],
  retiredConfigKeys: readonly string[] = [],
): LedgerProjection {
  const recorded = new Set(ledger.legacyRunIds)
  const runs = legacyRuns
    .filter(run => run.sessionId === ledger.sessionId || recorded.has(run.runId))
    .map(run => {
      const restore = ledger.legacyRestores?.[run.runId]
      return restore === undefined ? run : { ...run, sandboxRestore: restore }
    })
  return {
    v: ledger.v,
    sessionId: ledger.sessionId,
    revision: ledger.revision,
    ...(ledger.goal === undefined ? {} : { goal: ledger.goal }),
    previousGoals: ledger.previousGoals,
    delegations: ledger.delegations,
    reviews: ledger.reviews,
    links: ledger.links,
    ...(ledger.hostRestart === undefined ? {} : { hostRestart: ledger.hostRestart }),
    autoContinue: ledger.autoContinue,
    depth: ledger.depth,
    legacyRuns: runs,
    notes: [...notes],
    ...(retiredConfigKeys.length === 0 ? {} : { retiredConfigKeys: [...retiredConfigKeys] }),
    updatedAt: ledger.updatedAt,
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// Routes
// ─────────────────────────────────────────────────────────────────────────────

type Body = LedgerBody | LegacyRunsBody | LegacyRunBody | ErrorBody | { readonly ok: false; readonly error: 'method-not-allowed' | 'no-connection-service' }

function json(res: RouteResponse, status: number, body: Body): void {
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
 * Build the route table. All routes are GET-only: a non-GET method answers 405
 * rather than being treated as a read, because a POST landing here is a caller
 * bug worth reporting.
 *
 * @param service - the read-only `ctx.autopilot` surface.
 * @returns the routes, ready for `webServer.register`.
 */
export function makeAutopilotRoutes(service: AutopilotReadOnly): readonly AutopilotWebRoute[] {
  const route = (path: string, read: (req: RouteRequest, res: RouteResponse) => Promise<void>): AutopilotWebRoute => ({
    kind: 'exact',
    path,
    handler: (req, res) => {
      if (req.method !== 'GET') return json(res, 405, { ok: false, error: 'method-not-allowed' })
      // The failure detail is deliberately NOT forwarded: it can carry a store path.
      read(req, res).catch(() => json(res, 500, { ok: false, error: 'internal' }))
    },
  })
  return [
    route(LEDGER_ROUTE, async (req, res) => {
      const session = queryParam(req.url ?? '', 'session')
      if (session === undefined || session === '') return json(res, 400, { ok: false, error: 'missing-session' })
      const ledger = await service.ledger(session)
      if (ledger === undefined) return json(res, 404, { ok: false, error: 'no-ledger' })
      return json(res, 200, { ok: true, ledger })
    }),
    route(LEGACY_RUNS_ROUTE, async (_req, res) => {
      return json(res, 200, { ok: true, runs: await service.legacyRuns() })
    }),
    route(LEGACY_RUN_ROUTE, async (req, res) => {
      const id = queryParam(req.url ?? '', 'id')
      if (id === undefined || id === '') return json(res, 400, { ok: false, error: 'missing-id' })
      const run = await service.legacyRun(id)
      if (run === undefined) return json(res, 404, { ok: false, error: 'no-run' })
      return json(res, 200, { ok: true, run })
    }),
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
