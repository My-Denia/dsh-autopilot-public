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
  const calls = { definitions: [], slots: [] }
  return {
    calls,
    ctx: {
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

const TOTAL = 19
console.log(`\n${failures === 0 ? `ALL GREEN (${TOTAL} assertions)` : `${failures} RED of ${TOTAL}`}`)
process.exitCode = failures === 0 ? 0 : 1
