/**
 * Acceptance harness for `lib/client.js`.
 *
 * Re-implements the host loader's contract faithfully — registration keyed by
 * `id` with a `/client` suffix stripped, a synchronous `require` answered from
 * the platform seed table, one memoized materialization (dsh
 * `packages/client/modules/src/client/system.ts`) — and drives the artifact
 * with the REAL react out of the dsh checkout, so a JSX call that does not land
 * on the seeded `react/jsx-runtime` cannot pass.
 *
 * It then feeds the materialized definition the SAME real session-log fixtures
 * the vitest suite uses, so the assertions cover the shipped artifact and not
 * only the TypeScript sources.
 *
 * Usage: node scripts/run-bundle.mjs [bundle.js] [expected-id]
 */
import { readFileSync } from 'node:fs'
import { createRequire } from 'node:module'
import { homedir } from 'node:os'
import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import vm from 'node:vm'

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..')
/**
 * The sibling dsh checkout's pnpm store, where the REAL react lives.
 *
 * This is LOAD-BEARING, not decoration: the requires below resolve through it.
 * It used to be one developer's absolute path written out literally. Deriving
 * it from `homedir()` is what let that username leave the repository without
 * changing which directory is read on the machine that authored it — the
 * assumption is unchanged and still machine-specific (a `dsh` checkout sitting
 * directly under the home directory), it is merely no longer spelled out.
 * `DSH_STORE` overrides it for a checkout kept anywhere else. Separators are
 * normalized to `/` because `homedir()` returns backslashes on Windows and
 * these values are interpolated into require paths.
 */
// resolve() first: createRequire rejects non-absolute filenames, so a
// relative DSH_STORE override (../dsh/node_modules/.pnpm) must be anchored
// to the working directory; an absolute value passes through unchanged.
const STORE = resolve(process.env.DSH_STORE ?? `${homedir()}/dsh/node_modules/.pnpm`).replace(/\\/g, '/')
const reactRequire = createRequire(`${STORE}/react@18.3.1/node_modules/react/index.js`)
const domRequire = createRequire(`${STORE}/react-dom@18.3.1_react@18.3.1/node_modules/react-dom/index.js`)
const React = reactRequire('react')
const ReactJsxRuntime = reactRequire('react/jsx-runtime')
const renderToStaticMarkup = domRequire('react-dom/server').renderToStaticMarkup

/** The subset of packages/client/web/src/seed.ts this bundle can reach. */
const seed = new Map([['react', React], ['react/jsx-runtime', ReactJsxRuntime]])

// dsh 0.1.2: `@deepseek-ai/dsh-client-runtime/client` no longer exists and the
// bundle no longer requires any preloaded external — the surface-event
// predicate is the bundle's own mirror. Only the two react seed words remain.

const file = process.argv[2] ?? resolve(root, 'lib/client.js')
const expectedId = process.argv[3] ?? 'dsh-goal-autopilot'
const source = readFileSync(file, 'utf8')

/** Run the artifact in a fresh context and collect its registrations. */
function register() {
  const seen = []
  const sandbox = { console, window: { __ModuleLoader__: { load: r => seen.push(r) } } }
  sandbox.globalThis = sandbox
  vm.createContext(sandbox)
  try {
    vm.runInContext(source, sandbox, { filename: file })
  } catch (error) {
    console.log(`      artifact failed to evaluate: ${error.message}`)
  }
  return seen
}

/** The loader's require: a seed word, or a hard miss. */
function hostRequire(spec) {
  hostRequire.calls.push(spec)
  if (seed.has(spec)) return seed.get(spec)
  throw new Error(`client-modules: require("${spec}") missed the module table`)
}
hostRequire.calls = []

let failures = 0
const assert = (label, ok, detail = '') => {
  if (!ok) failures += 1
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${label}${detail === '' ? '' : ` — ${detail}`}`)
}

const seen = register()
assert('A1 exactly one __ModuleLoader__.load registration', seen.length === 1, `got ${seen.length}`)
assert('A2 registered id equals the graph row id', seen[0]?.id === expectedId, `got ${JSON.stringify(seen[0]?.id)}`)
assert('A3 factory is a unary function', typeof seen[0]?.factory === 'function' && seen[0].factory.length === 1)
assert('A4 artifact contains no ESM import/export statement', !/^[ \t]*(import|export)[ \t]/m.test(source))
assert('A5 jsx compiled to require("react/jsx-runtime")', source.includes('require("react/jsx-runtime")'))
assert('A6 no bundler/tslib helper was injected', !/__importStar|__importDefault|require\("tslib"\)/.test(source))

let materializeError = null
let exports = {}
try {
  if (seen.length === 1) exports = seen[0].factory(hostRequire)
} catch (error) {
  materializeError = error
  console.log(`      materialization threw: ${error.message}`)
}
assert('A6b factory materialized without throwing', materializeError === null)
assert('A7 factory returned an object (cordis plugin shape)', typeof exports === 'object' && exports !== null)
assert('A8 exports.apply is a function', typeof exports.apply === 'function')
assert('A9 exports.inject is an array of service names', Array.isArray(exports.inject)
  && exports.inject.every(n => typeof n === 'string' && !n.includes('/')), JSON.stringify(exports.inject))

// `react` JOINED THIS SET on 2026-08-27 and the reason is worth a sentence:
// the card gained a `useState`/`useEffect` hook (`client/live.ts` + the poll in
// AutopilotRunCard), so the bundle now requires the react runtime itself and
// not merely its jsx entry. That is a real widening of what the host must
// provide, which is exactly why this assertion is an equality against a written
// list rather than a subset check — a dependency arriving unnoticed is the thing
// it exists to catch. Since dsh 0.1.2 the set is the two react seed words only:
// the client-runtime external is gone with the package, and the surface-event
// predicate is the bundle's own mirror. Both are HOST-PROVIDED seed words, so
// nothing was installed.
const externals = [...new Set(hostRequire.calls)].sort()
assert('A10 externals are exactly the declared set', JSON.stringify(externals) === JSON.stringify([
  'react', 'react/jsx-runtime',
]), JSON.stringify(externals))

/** Minimal stand-ins for the two client services `apply` touches. */
function fakeCtx() {
  const calls = { definitions: [], slots: [], effects: 0 }
  return {
    calls,
    ctx: {
      // `locale` is left out on purpose: apply()'s bindHostLocale tolerates its absence, although
      // `inject` requires it in practice (uiConversation already does).
      effect: (fn) => { calls.effects += 1; return fn() },
      // dsh 0.1.2: the registry is `ctx.uiConversation.events` (ui-conversation), not `conversationEvents`.
      uiConversation: { events: { register: (d) => { calls.definitions.push(d); return () => {} } } },
      slots: {
        inject: (key, cb) => { calls.slots.push(key); cb(); return () => {} },
        register: (spec) => { calls.slots.push(spec.key); return () => {} },
      },
    },
  }
}

const host = fakeCtx()
assert('A11 apply() registers a definition and seats the renderer', (() => {
  try {
    exports.apply(host.ctx)
    return host.calls.definitions.length === 1
      && host.calls.slots.includes('conversation.chat.node')
      && host.calls.slots.includes('autopilot-run')
  } catch (error) {
    console.log(`      ${error.message}`)
    return false
  }
})(), JSON.stringify(host.calls.slots))

const definition = host.calls.definitions[0]
assert('A12 the definition module crossed the factory-local require',
  definition !== undefined && definition.kind === 'autopilot-run' && typeof definition.match === 'function')

/** Replay one real fixture through the materialized definition. */
function fold(name) {
  const events = JSON.parse(readFileSync(resolve(root, `test/fixtures/card/${name}.json`), 'utf8'))
  let state
  let starts = 0
  const key = 'autopilot-run:run'
  for (const event of events) {
    const m = definition.match(event)
    if (m === null) continue
    if (m.role === 'start') {
      starts += 1
      state = definition.start()
      continue
    }
    state = definition.update({ key, id: 'run', state, start: undefined, matches: [] },
      { event, role: 'update', location: { kind: 'session' } })
  }
  const node = definition.buildViewNode({ key, id: 'run', state, start: undefined, matches: [] })
  return { starts, node }
}

let inline = { starts: -1, node: null }
try {
  inline = fold('inline')
} catch (error) {
  console.log(`      fold threw: ${error.message}`)
}
assert('A13 the shipped reducer folds a real inline run to one start and a completed card',
  inline.starts === 1
  && inline.node !== null
  && inline.node.data.phase?.value === 'completed'
  && inline.node.data.planGate?.value === 'pass'
  && inline.node.data.audits.length === 2,
  JSON.stringify({ starts: inline.starts, phase: inline.node?.data?.phase?.value, audits: inline.node?.data?.audits?.length }))

let dup = { starts: -1, node: null }
try {
  dup = fold('dup-init')
} catch (error) {
  console.log(`      fold threw: ${error.message}`)
}
assert('A14 a real double-init session still yields exactly one start',
  dup.starts === 1 && dup.node?.data.reinitSeqs.length === 1,
  JSON.stringify({ starts: dup.starts, reinit: dup.node?.data?.reinitSeqs }))

let markup = ''
try {
  markup = renderToStaticMarkup(React.createElement(exports.AutopilotRunCard, { node: inline.node }))
} catch (error) {
  markup = `render threw: ${error.message}`
}
assert('A15 the card renders through the seeded react',
  markup.startsWith('<div style="border:1px solid var(--dsw-alias-border-l2)')
  && markup.includes('Autopilot run')
  && markup.includes('completed'),
  markup.slice(0, 160))

// A16/A17 — the executor row. `mergeExecutor` keeps a childId alive across the
// partial {generation,state} records that StatusView carries; until the card
// rendered it, that fold had NO consumer and its correctness was unobservable
// anywhere a human looks. Delegated must show it; inline must not invent it.
let delegated = { node: null }
try {
  delegated = fold('delegated')
} catch (error) {
  console.log(`      delegated fold threw: ${error.message}`)
}
let delegatedMarkup = ''
try {
  delegatedMarkup = renderToStaticMarkup(React.createElement(exports.AutopilotRunCard, { node: delegated.node }))
} catch (error) {
  delegatedMarkup = `render threw: ${error.message}`
}
const executorValue = delegated.node?.data?.executor?.value ?? {}
const childId = typeof executorValue.childId === 'string' ? executorValue.childId : ''
assert('A16 a DELEGATED run renders the executor, childId included',
  delegatedMarkup.includes('data-autopilot-executor')
  && delegatedMarkup.includes('executor ')
  && childId.length > 0
  && delegatedMarkup.includes(childId.slice(0, 8)),
  JSON.stringify({ hasRow: delegatedMarkup.includes('data-autopilot-executor'), childId: childId.slice(0, 8) }))

assert('A17 an INLINE run renders no executor row (the negative half)',
  !markup.includes('data-autopilot-executor'),
  markup.slice(0, 120))

// A18 — the PTC envelope family, through the SHIPPED bundle.
//
// This assertion exists because the vitest bearers for it could not have caught
// the defect on their own: they drive `src/`, and what was invisible on the real
// host was `lib/client.js`. A card that folds in the test tree and produces null
// in the artifact is exactly the shape of the 2026-08-27 M7 finding, so the
// artifact is asked directly. The fixture is a verbatim slice of the session
// that exhibited it.
let ptc = { starts: -1, node: null }
try {
  ptc = fold('ptc')
} catch (error) {
  console.log(`      ptc fold threw: ${error.message}`)
}
let ptcMarkup = ''
try {
  ptcMarkup = renderToStaticMarkup(React.createElement(exports.AutopilotRunCard, { node: ptc.node }))
} catch (error) {
  ptcMarkup = `render threw: ${error.message}`
}
assert('A18 a PTC session (run_code dispatches) yields a card from the shipped bundle',
  ptc.starts === 1
  && ptc.node !== null
  && ptc.node.anchorSeq === 136
  && ptc.node.data.triage?.objective === 'M7 live-card probe'
  && ptc.node.data.calls.length === 2
  && ptcMarkup.includes('Autopilot run')
  && ptcMarkup.includes('planning'),
  JSON.stringify({
    starts: ptc.starts,
    anchor: ptc.node?.anchorSeq ?? null,
    calls: ptc.node?.data?.calls?.length ?? null,
  }))

// A19 — the gate-provenance row, through the SHIPPED bundle.
//
// The same M7 lesson as A18: a row that renders in the test tree and NOT in
// `lib/client.js` is invisible on the real host, so the artifact is asked
// directly. The payload is overlaid onto a REAL folded card rather than
// hand-built, so the node keeps every field the card expects.
const withGates = (() => {
  const base = fold('inline')
  if (base.node === null || base.node === undefined) return null
  return {
    ...base.node,
    data: {
      ...base.node.data,
      gateSources: {
        value: {
          plan: { source: 'owner', planRevision: 1, ownerDecision: 1 },
          execution: { source: 'auditor', planRevision: 1 },
        },
        revision: base.node.data.revision ?? 1,
      },
    },
  }
})()
let gateMarkup = ''
try {
  gateMarkup = withGates === null
    ? 'no folded node'
    : renderToStaticMarkup(React.createElement(exports.AutopilotRunCard, { node: withGates }))
} catch (error) {
  gateMarkup = `render threw: ${error.message}`
}
assert('A19 the shipped bundle renders the gate-provenance row (owner vs auditor)',
  gateMarkup.includes('data-autopilot-gate-source="plan"')
  && gateMarkup.includes('the OWNER')
  && gateMarkup.includes('a dispatched auditor')
  && gateMarkup.includes('plan revision 1'),
  gateMarkup.slice(0, 200))

// A20+ — the v3 goal ledger view, through the SHIPPED bundle and the real react.
const fixture = (name) => JSON.parse(readFileSync(resolve(root, `test/client/fixtures/${name}.json`), 'utf8'))
const ledgerOf = (name) => fixture(name).ledger
// The card reads the host language, then navigator.language when no host is bound. Pin the
// fallback so the AutopilotRunCard renders below (no lang prop) are English on any machine.
Object.defineProperty(globalThis.navigator, 'language', { value: 'en-US', configurable: true })
const renderView = (name, lang = 'en') => {
  try {
    return renderToStaticMarkup(React.createElement(exports.GoalLedgerView, { ledger: ledgerOf(name), lang, timeZone: 'UTC' }))
  } catch (error) {
    return `render threw: ${error.message}`
  }
}
const count = (text, needle) => text.split(needle).length - 1

const parallel = renderView('active-parallel')
const leadAt = parallel.indexOf('data-autopilot-delegation="')
const workerRow = parallel.match(/<div style="[^"]*padding-left:16px[^"]*" data-autopilot-delegation="[^"]*"/)
assert('A20 active-parallel: five delegation rows, worker nested after the lead, scouts running',
  count(parallel, 'data-autopilot-delegation="') === 5
  && workerRow !== null && workerRow.index > leadAt
  && count(parallel, 'data-autopilot-state="running"') === 4
  && parallel.includes('Goal autopilot'),
  parallel.slice(0, 200))
assert('A21 active-parallel: cross-family review, issue as text, https PR as href, javascript: not an href',
  parallel.includes('data-autopilot-review-independence="cross-family"')
  && parallel.includes('MY-195')
  && !parallel.includes('href="MY-195')
  && parallel.includes('href="https://github.com/example/repo/pull/12"')
  && parallel.includes('target="_blank"')
  && parallel.includes('rel="noreferrer"')
  && !/href="javascript:/i.test(parallel))

const lost = renderView('restart-lost')
assert('A22 restart-lost: auto-continue warning with the reason, lost row, not restarted automatically',
  lost.includes('Will not auto-continue: released after host restart')
  && lost.includes('data-autopilot-state="lost"')
  && lost.includes('not restarted automatically'))
const lostZh = renderView('restart-lost', 'zh')
assert('A22z restart-lost (zh): 不会自动继续 with the reason, lost row in plain words',
  lostZh.includes('不会自动继续：released after host restart')
  && lostZh.includes('data-autopilot-state="lost"')
  && lostZh.includes('已丢失')
  && lostZh.includes('不会自动重启'))

const mismatch = renderView('mismatch')
assert('A23 mismatch: the mismatching row is flagged with both efforts shown',
  mismatch.includes('data-autopilot-route-match="mismatch"')
  && mismatch.includes('Model mismatch')
  && mismatch.includes('effort high')
  && mismatch.includes('effort medium')
  && mismatch.includes('var(--dsw-alias-state-error-primary)'))
const mismatchZh = renderView('mismatch', 'zh')
assert('A23z mismatch (zh): plain warning with both efforts and the error tone',
  mismatchZh.includes('data-autopilot-route-match="mismatch"')
  && mismatchZh.includes('实际模型与选定的不一致')
  && mismatchZh.includes('推理强度 高')
  && mismatchZh.includes('推理强度 中')
  && mismatchZh.includes('var(--dsw-alias-state-error-primary)'))
assert('A23m only a mismatching row renders the mismatch warning (match and pending rows do not)',
  count(mismatch, 'Model mismatch') === 1
  && count(parallel, 'Model mismatch') === 0
  && count(mismatchZh, '实际模型与选定的不一致') === 1
  && count(renderView('active-parallel', 'zh'), '实际模型与选定的不一致') === 0)

const reduced = renderView('reduced')
assert('A24 same-vendor review: neutral vendor row, the recorded 503 note in details, no warning wording',
  reduced.includes('data-autopilot-review-independence="reduced"')
  && reduced.includes('Reviewer vendor')
  && reduced.includes('same as the reviewed work')
  && reduced.includes('Routing note')
  && reduced.includes('HTTP 503')
  && !/[Rr]educed independence/.test(reduced))
const reducedZh = renderView('reduced', 'zh')
assert('A24z same-vendor review (zh): neutral vendor row, the recorded note verbatim in the details, no 降低',
  reducedZh.includes('data-autopilot-review-independence="reduced"')
  && reducedZh.includes('审阅模型厂商')
  && reducedZh.includes('与被审工作相同')
  && reducedZh.includes('路由记录')
  && reducedZh.includes('HTTP 503')
  && !reducedZh.includes('降低'))

const paused = renderView('paused-no-driver')
assert('A25 paused-no-driver: says there is no driver and only the owner can resume',
  paused.includes('no goal round driver in this composition')
  && paused.includes('Only you can resume'))
const pausedZh = renderView('paused-no-driver', 'zh')
assert('A25z paused-no-driver (zh): no driver reason and only the owner can resume',
  pausedZh.includes('no goal round driver in this composition')
  && pausedZh.includes('只有你能恢复')
  && pausedZh.includes('已暂停'))

const legacyRun = fixture('legacy-run').run
let legacyMarkup = ''
try {
  legacyMarkup = renderToStaticMarkup(React.createElement(exports.AutopilotRunCard, {
    node: { data: { revision: 0, calls: [], audits: [], reinitSeqs: [], stale: false } },
    ledger: ledgerOf('legacy-ledger'),
    legacyRuns: [legacyRun],
  }))
} catch (error) {
  legacyMarkup = `render threw: ${error.message}`
}
const ownerDecision = legacyRun.ownerResolutions?.[0]?.text ?? ''
assert('A26 legacy: archived section with amendments, owner decision and the rejected run',
  legacyMarkup.startsWith('<div style="border:1px solid var(--dsw-alias-border-l2)')
  && legacyMarkup.includes('data-autopilot-legacy=""')
  && legacyMarkup.includes('Autopilot run')
  && legacyMarkup.includes('archived, read-only')
  && legacyMarkup.includes('data-autopilot-legacy-run="session-legacy-amend-01"')
  && legacyMarkup.includes('data-autopilot-legacy-detail="session-legacy-amend-01"')
  && legacyMarkup.includes('2 amendments')
  && ownerDecision.length > 0 && legacyMarkup.includes(ownerDecision.replace(/&/g, '&amp;'))
  && legacyMarkup.includes('data-autopilot-legacy-run="session-legacy-bad-02"')
  && legacyMarkup.includes('could not be read'),
  legacyMarkup.slice(0, 200))

let emptyMarkup = ''
try {
  emptyMarkup = renderToStaticMarkup(React.createElement(exports.AutopilotRunCard, {
    node: { data: { revision: 0, calls: [{ seq: 1, time: 0, name: 'autopilot_status', failed: false }], audits: [], reinitSeqs: [], stale: false } },
  }))
} catch (error) {
  emptyMarkup = `render threw: ${error.message}`
}
assert('A27 no ledger and no v1 data: only the placeholder line, no archived section',
  emptyMarkup.includes('Goal autopilot')
  && emptyMarkup.includes('no goal ledger recorded for this session')
  && !emptyMarkup.includes('data-autopilot-legacy=""'))

const rendered = [parallel, lost, lostZh, mismatch, mismatchZh, reduced, reducedZh, paused, pausedZh, legacyMarkup, emptyMarkup, markup, delegatedMarkup]
assert('A28 no rendered view has a button or a retired action',
  rendered.every(m => !/<button/i.test(m) && !/approve|submit closeout|pass gate/i.test(m)),
  JSON.stringify(rendered.map(m => /<button|approve|submit closeout|pass gate/i.exec(m)?.[0] ?? null)))

assert('A29 v1 fold lives in the archived section only when the fold holds v1 data',
  markup.includes('data-autopilot-legacy=""') && markup.includes('data-autopilot-run-fold=""')
  && gateMarkup.includes('title="archived: ')
  && !emptyMarkup.includes('data-autopilot-run-fold=""'))

// A30 — a pre-upgrade v1 session the ledger route does not know: the card
// still shows the archived run detail it fetched once by the fold's poll key,
// including the sandbox-restore line and the amendment/owner history.
let noLedgerV1 = ''
try {
  const archived = JSON.parse(readFileSync(resolve(root, 'test/client/fixtures/legacy-run.json'), 'utf8')).run
  noLedgerV1 = renderToStaticMarkup(React.createElement(exports.AutopilotRunCard, {
    node: fold('inline').node, legacyRuns: [archived],
  }))
} catch (error) {
  noLedgerV1 = `render threw: ${error.message}`
}
assert('A30 no ledger, real v1 fold: archived detail still renders with sandbox and history',
  noLedgerV1.includes('no goal ledger recorded for this session')
  && noLedgerV1.includes('data-autopilot-legacy-detail="session-legacy-amend-01"')
  && noLedgerV1.includes('sandbox restored to workspace-write')
  && noLedgerV1.includes('2 amendments')
  && noLedgerV1.includes('owner passed the plan gate after amendment')
  && noLedgerV1.includes('data-autopilot-run-fold=""'),
  noLedgerV1.slice(0, 160))

// A32 — a goal-only session (native get_goal, no autopilot_* call), through the
// SHIPPED bundle: the card anchors, asks the ledger route for the ROOT session
// id, renders nothing on 404 no-ledger, and stays one card when an autopilot
// call joins. (renderToStaticMarkup runs no effects, so the request is asserted
// on the bundle's own fetchLedger/ledgerSessionId, which the card's hook calls.)
const goalCall = (seq, name) => ({ type: 'tool/call', seq, time: seq, data: { name, callId: `g${seq}`, arguments: '{}' } })
const foldEvents = (events) => {
  let state
  let starts = 0
  const key = 'autopilot-run:run'
  for (const event of events) {
    const m = definition.match(event)
    if (m === null) continue
    if (m.role === 'start') { starts += 1; state = definition.start(); continue }
    state = definition.update({ key, id: 'run', state, start: undefined, matches: [] },
      { event, role: 'update', location: { kind: 'session' } })
  }
  return { starts, node: definition.buildViewNode({ key, id: 'run', state, start: undefined, matches: [] }) }
}
const turnOne = { type: 'turn/start', seq: 1, time: 1, data: { turn: 1 } }
const goalOnly = foldEvents([turnOne, goalCall(4, 'get_goal')])
const mixed = foldEvents([turnOne, goalCall(4, 'get_goal'), goalCall(6, 'autopilot_status')])
const requested = []
let goalLedger = 'unset'
try {
  goalLedger = await exports.fetchLedger(exports.ledgerSessionId({ sessionId: 'child-9', rootSessionId: 'root-1' }), async (url) => {
    requested.push(url)
    return { ok: false, status: 404, json: async () => ({ ok: false, error: 'no-ledger' }) }
  })
} catch (error) {
  goalLedger = `threw: ${error.message}`
}
let goalMarkup = 'unset'
try {
  goalMarkup = renderToStaticMarkup(React.createElement(exports.AutopilotRunCard, { node: goalOnly.node, sessionId: 'root-1' }))
} catch (error) {
  goalMarkup = `render threw: ${error.message}`
}
assert('A32 a goal-only session (get_goal, no autopilot_*) anchors one card, requests the ledger for the root id, renders nothing on 404',
  goalOnly.starts === 1 && goalOnly.node !== null && goalOnly.node.anchorSeq === 4
  && goalOnly.node.data.calls.length === 0
  && mixed.starts === 1 && mixed.node?.anchorSeq === 4 && mixed.node.data.calls.length === 1
  && requested.length === 1 && requested[0].includes('session=root-1') && !requested[0].includes('child-9')
  && goalLedger === undefined && goalMarkup === '',
  JSON.stringify({ anchor: goalOnly.node?.anchorSeq ?? null, requested, goalLedger: String(goalLedger), goalMarkup }))

// A33 — the shipped node stands at turn level in the Chat group tree. On dsh
// 0.2.1-rc.5 a turn node without it is a member of a collapsed tool group and,
// on a completed turn, of the folded process (dsh-client-ui-chat
// TurnGroups.rebuild / ChatNodeSeat): the desktop goal session that found this
// had its card inside the first collapsed group, never on screen.
assert('A33 the shipped card node declares groupTree "turn" (outside the collapsed process groups)',
  goalOnly.node?.groupTree === 'turn' && mixed.node?.groupTree === 'turn',
  JSON.stringify({ goalOnly: goalOnly.node?.groupTree ?? null, mixed: mixed.node?.groupTree ?? null }))

const TOTAL = 38
console.log(`\n${failures === 0 ? `ALL GREEN (${TOTAL} assertions)` : `${failures} RED of ${TOTAL}`}`)
process.exitCode = failures === 0 ? 0 : 1
