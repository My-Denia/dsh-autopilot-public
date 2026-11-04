/**
 * The plugin's declared configuration schema (roadmap §9.7).
 *
 * WHY a real Schemastery schema and not the hand-rolled `resolveConfig`
 * defaults alone: cordis validates a plugin's config through
 * `runtime.Config['~standard'].validate(config)` (measured in
 * `vendor/cordis/src/fiber.ts`, the Standard Schema protocol). Without an
 * exported `Config` a typo in a profile's `cordis.patch.yml` reaches the
 * plugin as `undefined` and is silently defaulted away — the deployment gets
 * the default behaviour while believing it configured something else. With
 * one, the loader refuses the profile and says which key is wrong.
 *
 * WHY THE UNKNOWN-KEY GUARD IS EXPLICIT. A plain `Schema.object` does NOT
 * deliver the sentence above: schemastery's object resolver ends with
 * `if (!strict) merge(result, data)` (`vendor/schemastery` `Schema.extend('object', …)`),
 * i.e. unknown properties are copied THROUGH, no issue raised. Measured
 * 2026-08-24: `Config['~standard'].validate({storeKindd:'domain'})` returned a
 * value with `storeKind:'auto'` and no issues — exactly the silent default this
 * module claims to have eliminated. `strict` is not reachable from the public
 * builder API, so the known-key surface is declared once in
 * {@link CONFIG_KEY_SPEC} and enforced as a pre-resolution refusal in the
 * `~standard` façade below (formerly a transform composed alongside the
 * shape; see {@link Config} for why the composition changed when routing
 * gained volatile fields). A claim a checker cannot observe being false is
 * the one thing this repository's doctrine forbids, so the check exists
 * rather than the wording being softened.
 *
 * WHY the Standard-Schema protocol makes a second physical copy of
 * Schemastery harmless here: the host touches only `['~standard'].validate`,
 * a structural contract, never a class identity. That is the same reasoning
 * DESIGN.md §1 applies to every other dsh surface this package reaches.
 *
 * `resolveConfig` in `./index.ts` is NOT replaced by this: the schema governs
 * what a deployment may WRITE, `resolveConfig` governs what the engine READS,
 * and it keeps working on a plain object so the tests can construct config
 * without going through the validator.
 */

import Schema from '@deepseek-ai/schemastery'
import type { ConfigInput } from './index.js'
import { DEFAULT_WORK_CLASSES } from './routing/work-class.js'
import type { WorkClassName } from './routing/work-class.js'

/**
 * Default tool surface for a delegated executor child (write-capable, no
 * nested delegation).
 *
 * WHY IT LIVES HERE rather than next to `resolveConfig`: the schema's default
 * and the reader's fallback must be the SAME list. When they were two lists,
 * the schema's `Schema.array(...)` defaulted to `[]`, `[]` is not nullish, and
 * `?? DEFAULT_EXECUTOR_TOOLS` in `resolveConfig` therefore never fired on the
 * loader path — every delegated executor on a real deployment started with
 * nothing but `autopilot_submit_packet`. One constant, imported by both, is
 * what makes that divergence unrepresentable.
 *
 * `run_terminal` WAS REMOVED (2026-08-24) rather than renamed. No dsh package
 * defines that tool — it existed only in the v1 `tool-gah` plugin this one
 * replaces — so the allow entry granted nothing while documenting a surface
 * that does not exist. The real PTY surface is `terminal_open` /
 * `terminal_send` / `terminal_read` / `terminal_signal` / `terminal_close`,
 * and substituting those here would GRANT a delegated child a capability it
 * never had. The rename went the other way instead: the gate's `SHELL_TOOLS`
 * scan (`SHELL_TOOLS` in `./roles/tools.ts`, formerly the egress gate) gained the terminal names, because widening what
 * is SCANNED is the fail-closed direction and widening what is ALLOWED is not.
 * Nothing egress-capable belongs in this list, and `test/config.test.ts`
 * asserts both the exact array and that property — in BOTH directions, because
 * the additive one is the security-relevant one.
 *
 * WHY `bash` AND `pwsh` BOTH STAY, even though only one of them is ever
 * registered. They are ONE capability under two names, split by platform in the
 * base bundle: `tool-bash` carries `disabled: process.platform === 'win32'` and
 * `tool-pwsh` carries `disabled: process.platform !== 'win32'`
 * (`packages/bundle/base/cordis.patch.yml`), so a delegated executor sees
 * exactly one shell and the other name is inert. That is what separates this
 * pair from `run_terminal`, which was inert on EVERY platform and therefore
 * dead: dropping either name here would leave the executor with NO shell on the
 * platform that registers it, which is the same "the child starts with nothing"
 * failure the shared-constant note above exists to prevent — just conditioned on
 * the host OS instead of the config path. Two names for a two-platform product
 * is the honest static answer.
 *
 * WHY NOT `process.platform === 'win32' ? 'pwsh' : 'bash'` HERE. This constant
 * is a DECLARED SCHEMA DEFAULT: it is what `Config` advertises, what a config
 * dump prints, and what an operator copies into a profile. Branching on the
 * mounting machine's OS would make the documented default differ per machine
 * while the profile that overrides it does not, which trades an inert allow
 * entry (grants nothing — the allow-list is a filter over tools the host
 * actually registered) for a config surface that cannot be read the same way
 * twice. An allow-list may name a tool the deployment does not have; it may not
 * OMIT a tool the deployment does have and the executor needs.
 */
export const DEFAULT_EXECUTOR_TOOLS: readonly string[] = [
  'read', 'glob', 'grep', 'read_image',
  'write', 'edit', 'str_replace_editor',
  'bash', 'pwsh',
  'todo_write',
]

/** Explicit LLM route for a dispatched child. */
const AgentOptions = Schema.object({
  provider: Schema.string().description('LLM provider id.'),
  model: Schema.string().description('Model id.'),
  maxTokens: Schema.natural().description('Retired in 0.3.0 and ignored (the route grant is provider, model and reasoningEffort only).'),
  /**
   * Reasoning effort ([R2-P3-1]). Declared here so a legacy route may name
   * one; it is validated against exact model capability by the dispatch
   * preflight (`resolveCallConfig`) and NEVER invented. `AgentOptionsLike`
   * in `./engine.ts` is widened by packet E3 — the config layer declares the
   * wider input shape first (`AgentOptionsInput` in `./index.ts`).
   */
  reasoningEffort: Schema.string().description('Reasoning effort; validated at dispatch preflight, never invented.'),
})

/** Per-role auditor routing (the cross-family review matrix's landing point). */
const AuditorRoute = Schema.object({
  provider: Schema.string().description('Retired in 0.3.0 and ignored: the one-shot transport provider no longer exists. Reviews use the role route only.'),
  agentOptions: AgentOptions,
})

/**
 * One explicit route lock: the new `routing` section's grant shape.
 *
 * WHY A TRANSFORM REFINEMENT AND NOT TWO `.required()` FIELDS: schemastery's
 * object resolver runs on the cloned `{}` default too, so required children
 * would make an ABSENT lock invalid — the optional-ness lives at the field
 * level, and the pairing rule is enforced on whatever object IS present:
 * a lock is either absent/blank or a FULL route (provider and model
 * together; a lone `reasoningEffort` names tuning for a route that was never
 * named, which is exactly the silently-inert config this module refuses to
 * ship). Blank strings count as absent (trim-exact, the identity axis rule
 * from `./routing/identity.ts`), so `{ provider: ' ' }` alone is a no-op
 * lock, not a refusal. Resolve-time (`resolveConfig`) makes the same rule
 * unrepresentable for hand-built config objects: `mode: 'locked'` without a
 * lock route throws there, because the schema cannot see `mode` from inside
 * `lock` (a role-level transform would wrap the whole role object and
 * schemastery forbids volatile fields under a transform — see {@link Config}).
 */
const RouteLock = Schema.transform(
  Schema.object({
    provider: Schema.string().description('Locked provider route key.'),
    model: Schema.string().description('Locked model id.'),
    reasoningEffort: Schema.string().description('Optional reasoning effort; validated at dispatch preflight, never invented.'),
  }),
  (value: { provider?: string | null; model?: string | null; reasoningEffort?: string | null }, options?: unknown) => {
    const present = (field: string | null | undefined): boolean => field !== undefined && field !== null && field.trim().length > 0
    const claimsRoute = present(value.provider) || present(value.model) || present(value.reasoningEffort)
    if (!claimsRoute) return value
    const missing: string[] = []
    if (!present(value.provider)) missing.push('provider')
    if (!present(value.model)) missing.push('model')
    if (missing.length > 0) {
      throw new Schema.ValidationError(
        `routing lock requires provider and model together (missing: ${missing.join(', ')})`,
        (options ?? {}) as never,
      )
    }
    return value
  },
)

/**
 * Per-role routing. `planner` defaults to `'inherit'` (plan "Roles and
 * routing": the planner IS the root agent, and GAH does not reroute the
 * user's session model unless opted in); every other role defaults to
 * `'auto'`.
 *
 * WHY A FACTORY AND NOT ONE SHARED SCHEMA: only the `mode` default differs,
 * and schemastery defaults live in node metadata — one shared instance would
 * give every role the last-applied default.
 */
const RoleRoutingShape = (defaultMode: 'auto' | 'inherit') => Schema.object({
  mode: Schema.union([
    Schema.const('auto').description('Select from the authorized set by the ordered rule table.'),
    Schema.const('inherit').description('Never reroute this role; the deployment default applies.'),
    Schema.const('locked').description('Always dispatch the locked route (a plugin-config grant).'),
  ]).default(defaultMode).volatile(),
  lock: RouteLock.volatile(),
  minContext: Schema.natural().volatile().description(
    'Role floor in tokens for this role\'s EXPLICIT selections (unknown context windows stay eligible, ranked last). '
    + 'Applies in auto mode only; defaults are declared in src/routing/select.ts.',
  ),
  workClass: Schema.union([
    Schema.const('mechanical').description('Speed-dominant: holders of a real low effort (DESIGN §1.2).'),
    Schema.const('simple').description('Daily work: speed + price, economy tier, rotation within the class.'),
    Schema.const('hard').description('Try economy first; escalation is a request, not a prediction.'),
    Schema.const('audit').description('Ceiling + independence: the standard tier.'),
    Schema.const('extreme').description('Ceiling: the reserve tier; absence is recorded, never invented.'),
  ]).volatile().description(
    'The work class this role draws from (DESIGN §1.2). Absent = the role default: executor/planner simple, auditors audit. '
    + 'Inert for locked/inherit modes — those make no selection.',
  ),
})

/**
 * Role-true model routing (plan v3 "Config"). Every leaf is `.volatile()`:
 * machine-readable, patch-writable config — no shipped Settings GUI is
 * claimed for it (the visible control surface is the run card).
 */
/**
 * The owner's routing ladder.
 *
 * WHY FIXED TIER NAMES rather than an owner-authored record: Schemastery
 * refuses a volatile field beneath a transform or a keyed dict, and the loader
 * follows volatile references only so deep. economy/standard/reserve are fixed
 * paths, so each leaf stays volatile and live-editable, which is what makes an
 * owner edit take effect without a restart.
 */
const LadderShape = Schema.object({
  tiers: Schema.object({
    economy: Schema.array(Schema.string()).default([]).volatile().description('Routes the owner places in the economy tier, as provider/model.'),
    standard: Schema.array(Schema.string()).default([]).volatile().description('Routes the owner places in the standard tier, as provider/model.'),
    reserve: Schema.array(Schema.string()).default([]).volatile().description('Routes the owner reserves, as provider/model.'),
  }),
  auditTier: Schema.union([
    Schema.const('economy').description('Audit roles may draw from the economy tier.'),
    Schema.const('standard').description('Audit roles may draw from the standard tier.'),
    Schema.const('reserve').description('Audit roles may draw from the reserve tier.'),
    Schema.const('none').description('No tier restriction is configured (the shipped default).'),
  ]).default('none').volatile(),
  rotation: Schema.boolean().default(false).volatile().description('Engine-level re-selection at a role\'s next dispatch (DESIGN §9 item 15): a healthy pin yields to a full re-selection — for an AUDITOR role the offset is its audit-count ordinal within the top independence class (never overriding independence), and for the EXECUTOR it is the run\'s own executorDispatches count (one per new child) within the ranked survivor list. A running executor child is never re-routed: only startExecutor reaches the resolver, and resumeExecutor continues the child on its recorded route. Default off preserves the shipped pin-stability semantics exactly.'),
  speedOrder: Schema.array(Schema.string()).default([]).volatile().description('Owner-declared speed order, fastest first, as provider/model. Empty means speed is unknown and is not ranked.'),
  costOverrides: Schema.array(Schema.string()).default([]).volatile().description('Owner cost overrides, "provider/model=inputPerM/outputPerM". These beat the seeded cost. A malformed entry is refused.'),
})

/**
 * One work class (DESIGN §1.2): which ladder tiers it draws members from and
 * which axis dominates. Fixed class names for the same schemastery volatile
 * reason as the ladder tier names. The owner table is the declared default;
 * an override replaces one class at a time, never the whole table.
 *
 * WHY A FACTORY: schemastery defaults live in node metadata — one shared
 * instance would give every class the last-applied default (the same reason
 * {@link RoleRoutingShape} is a factory).
 */
const WorkClassShape = (name: WorkClassName) =>
  Schema.object({
    tiers: Schema.array(
      Schema.union([Schema.const('economy'), Schema.const('standard'), Schema.const('reserve')]),
    )
      .default([...DEFAULT_WORK_CLASSES[name].tiers])
      .volatile()
      .description('The ladder tiers this class draws members from. Empty = entry by the class\'s own thresholds (mechanical: the low-effort license).'),
    axis: Schema.union([
      Schema.const('speed').description('Owner-declared speedOrder first; cost is NOT an axis.'),
      Schema.const('speed-cost').description('Speed first, effective cost breaks ties.'),
      Schema.const('economy-first').description('Effective cost ascending first — the cheapest mapped tier is tried first.'),
      Schema.const('ceiling-independence').description('No ranking of its own: the tier mapping and auditor independence carry it.'),
      Schema.const('ceiling').description('No ranking of its own: the tier mapping carries it.'),
    ])
      .default(DEFAULT_WORK_CLASSES[name].axis)
      .volatile(),
  })

const RoutingShape = Schema.object({
  mode: Schema.union([
    Schema.const('auto').description('Route by the ordered rule table over the session-authorized set.'),
    Schema.const('off').description('Reproduce 0.2.0 dispatch semantics (legacy config surfaces only).'),
  ]).default('auto').volatile(),
  preference: Schema.union([
    Schema.const('balanced').description('Efforts preferred, then context window descending.'),
    Schema.const('economy').description('Smallest sufficient context window first.'),
    Schema.const('quality').description('Reasoning efforts first, then context window descending.'),
    Schema.const('axis').description('Sufficiency thresholds pass/fail (never ranked), then survivors ranked on the declared axes: effective cost (outputPerM then inputPerM), then the owner-declared speed order when one is declared.'),
  ]).default('balanced').volatile(),
  orderingAxisDefault: Schema.boolean().default(false).volatile().description(
    'Owner opt-in: when no explicit preference is detectable, rank by the ordering axes (effective cost, then the owner-declared speed order) instead of the provisional balanced default. An explicit preference is never overridden.',
  ),
  roles: Schema.object({
    executor: RoleRoutingShape('auto'),
    planner: RoleRoutingShape('inherit'),
    planAuditor: RoleRoutingShape('auto'),
    executionAuditor: RoleRoutingShape('auto'),
    rulesAuditor: RoleRoutingShape('auto'),
  }),
  ladder: LadderShape,
  workClasses: Schema.object({
    mechanical: WorkClassShape('mechanical'),
    simple: WorkClassShape('simple'),
    hard: WorkClassShape('hard'),
    audit: WorkClassShape('audit'),
    extreme: WorkClassShape('extreme'),
  }).description('Per-class overrides of the owner-table work classes (DESIGN §1.2). A class absent here keeps the owner-table default.'),
})

/**
 * Where a run's canonical event stream lives.
 *
 * 'auto' is the default because the correct answer is a property of the
 * DEPLOYMENT, not of the operator's preference: `ctx.storageDomain` is mounted
 * by the web-app bundle only (`packages/bundle/web-app/cordis.patch.yml`), and
 * the `headless` profile (`packages/bundle/headless/cordis.patch.yml`) has
 * none.
 * A hardcoded 'domain' would make headless fail to start; a hardcoded 'file'
 * would leave the native backend unused wherever it exists. 'auto' probes and
 * the run RECORDS what it got in `enforcement.store`.
 */
export const StoreKindSchema = Schema.union([
  Schema.const('auto').description('Prefer the storageDomain backend when it is observable, else files.'),
  Schema.const('file').description('Always the file store under $DSH_HOME/storages/dsh-autopilot.'),
  Schema.const('domain').description('Require ctx.storageDomain; refuse to mount without it.'),
]).description('RETIRED in 0.3.0 and ignored: the ledger is always one file per session under the store root; legacy domain runs are only read. No default is declared, so only a written key reads as retired.')

/** Declared plugin configuration shape; mirrors `ConfigInput` in `./index.ts`. */
const ConfigShape = Schema.object({
  auditProvider: Schema.string().description('Retired in 0.3.0 and ignored. No default is declared, so only a written key reads as retired.'),
  executorProvider: Schema.string().description('Retired in 0.3.0 and ignored. No default is declared, so only a written key reads as retired.'),
  auditors: Schema.object({
    plan: AuditorRoute,
    execution: AuditorRoute,
    rules: AuditorRoute,
  }).description('Per-role auditor routing; omitted roles inherit the deployment default.'),
  executor: Schema.object({
    agentOptions: AgentOptions,
    persona: Schema.string().description('Retired in 0.3.0 and ignored: the role personas are fixed in src/roles.'),
    toolAllowList: Schema.array(Schema.string()).description('Retired in 0.3.0 and ignored: the role tool surfaces are fixed in src/roles.'),
  }),
  crossFamily: Schema.object({
    enabled: Schema.boolean().description('Retired in 0.3.0 and ignored: a reviewer always seeks a different provider family than the work it reviews.'),
    minRisk: Schema.union(['low', 'medium', 'high', 'critical'] as const).description('Retired in 0.3.0 and ignored.'),
    pool: Schema.array(AgentOptions).description('Retired in 0.3.0 and ignored: the reviewer draws from the ladder and the session policy.'),
  }).description('Retired in 0.3.0 and ignored (see each key).'),
  routing: RoutingShape.description(
    'Role-true model routing over the live catalog. Every GAH-config-sourced explicit route (a lock, legacy role config, a legacy pool pick) is a plugin-config grant under one rule in every mode; a grant outside an existing session model-selection policy escalates to the owner instead of dispatching. In auto mode the routing core subsumes the legacy pool fallback: pool entries stay consultable as grants, never widen the session-authorized set, and never override a role lock.',
  ),
  // RETIRED in 0.3.0 and ignored. NO defaults are declared on these leaves on purpose: the loader fills
  // declared defaults before `apply()` sees the config, and a default here would make every mount read
  // as having written a retired key (`retiredKeysIn`). `resolveConfig` supplies its own defaults.
  gate: Schema.object({
    sandboxCoupling: Schema.boolean().description('Retired, ignored: the plan-gate sandbox clamp is gone.'),
    toolDeny: Schema.boolean().description('Retired, ignored: the pre-plan-gate tool deny is gone.'),
    egressDeny: Schema.boolean().description('Retired, ignored: the egress boundary is gone.'),
    stopReminder: Schema.boolean().description('Retired, ignored: the turn-stop reminder is gone.'),
    strictShell: Schema.boolean().description('Retired, ignored: the shell gate is gone.'),
    restoreMode: Schema.string().description('Retired, ignored: a clamped session is restored to the mode its run recorded.'),
  }),
  storeKind: StoreKindSchema,
  storeRoot: Schema.string().default('').description('Run store directory; empty means $DSH_HOME/storages/dsh-autopilot.'),
  governance: Schema.object({
    maxAuditRoundsPerRole: Schema.number().min(1).description(
      'Brake on audit storms: refuse further same-role audit dispatches beyond this many rounds. Retired in 0.3.0 and ignored. Off when unset; escalation to the owner is never automatic.',
    ),
    unattended: Schema.boolean().description(
      'Retired in 0.3.0 and ignored: the egress policy it tuned no longer exists.',
    ),
  }).description('Governance pragmatics knobs (all optional, all off by default).'),
  skillInstall: Schema.union([
    Schema.const('auto').description('Copy bundled SKILL.md into the skill-scan root if absent; warn on drift, never overwrite.'),
    Schema.const('off').description('Do not touch the skill-scan root.'),
  ]).default('auto').description('Whether apply() installs the bundled skill into $DSH_AGENTS_HOME/skills.'),
}).description('dsh-autopilot: role delegation routing, review independence and the delegation ledger.')

/**
 * A node in the known-key tree: `null` marks a leaf (any shape the schema above
 * already governs), a nested record marks an object whose own keys are checked.
 */
interface KeySpec {
  readonly [key: string]: KeySpec | null
}

/** The route shape both `auditors.*` and `executor` reuse. */
const AGENT_OPTIONS_KEYS: KeySpec = { provider: null, model: null, maxTokens: null, reasoningEffort: null }
const AUDITOR_ROUTE_KEYS: KeySpec = { provider: null, agentOptions: AGENT_OPTIONS_KEYS }
/** The lock shape inside `routing.roles.<role>` (mirrors {@link RouteLock}). */
const ROUTE_LOCK_KEYS: KeySpec = { provider: null, model: null, reasoningEffort: null }
/** One `routing.roles.<role>` entry. */
const ROLE_ROUTING_KEYS: KeySpec = { mode: null, lock: ROUTE_LOCK_KEYS, minContext: null, workClass: null }
/** One `routing.workClasses.<name>` entry. */
const WORK_CLASS_KEYS: KeySpec = { tiers: null, axis: null }
/** The five routable roles, exactly as the shape declares them. */
const ROUTING_ROLES_KEYS: KeySpec = {
  executor: ROLE_ROUTING_KEYS,
  planner: ROLE_ROUTING_KEYS,
  planAuditor: ROLE_ROUTING_KEYS,
  executionAuditor: ROLE_ROUTING_KEYS,
  rulesAuditor: ROLE_ROUTING_KEYS,
}

/**
 * Every key a profile may write, mirroring {@link ConfigShape} exactly.
 *
 * Kept as data rather than derived from the schema because schemastery's
 * internal `dict` is not part of its public contract; a hand-written mirror
 * that drifts is caught by the positive fixture in `test/config.test.ts`,
 * which validates a fully specified profile and asserts NO issues.
 */
const CONFIG_KEY_SPEC: KeySpec = {
  auditProvider: null,
  executorProvider: null,
  auditors: { plan: AUDITOR_ROUTE_KEYS, execution: AUDITOR_ROUTE_KEYS, rules: AUDITOR_ROUTE_KEYS },
  executor: { agentOptions: AGENT_OPTIONS_KEYS, persona: null, toolAllowList: null },
  crossFamily: { enabled: null, minRisk: null, pool: null },
  routing: {
    mode: null,
    preference: null,
    orderingAxisDefault: null,
    roles: ROUTING_ROLES_KEYS,
    ladder: {
      tiers: { economy: null, standard: null, reserve: null },
      auditTier: null,
      rotation: null,
      speedOrder: null,
      costOverrides: null,
    },
    workClasses: {
      mechanical: WORK_CLASS_KEYS,
      simple: WORK_CLASS_KEYS,
      hard: WORK_CLASS_KEYS,
      audit: WORK_CLASS_KEYS,
      extreme: WORK_CLASS_KEYS,
    },
  },
  gate: {
    sandboxCoupling: null,
    toolDeny: null,
    egressDeny: null,
    stopReminder: null,
    strictShell: null,
    restoreMode: null,
  },
  storeKind: null,
  storeRoot: null,
  skillInstall: null,
  governance: { maxAuditRoundsPerRole: null, unattended: null },
}

/** Collect every dotted path in `value` that {@link CONFIG_KEY_SPEC} does not declare. */
function unknownKeys(value: unknown, spec: KeySpec, prefix: string): string[] {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return []
  const found: string[] = []
  for (const [key, child] of Object.entries(value as Record<string, unknown>)) {
    const path = prefix.length === 0 ? key : `${prefix}.${key}`
    if (!(key in spec)) {
      found.push(path)
      continue
    }
    const nested = spec[key]
    if (nested !== null && nested !== undefined) found.push(...unknownKeys(child, nested, path))
  }
  return found
}

/** The refusal half, as standard-schema issues; `undefined` when nothing is unknown. */
function unknownKeyIssues(value: unknown): { issues: Array<{ message: string; path?: readonly PropertyKey[] }> } | undefined {
  const unknown = unknownKeys(value, CONFIG_KEY_SPEC, '')
  if (unknown.length === 0) return undefined
  return { issues: [{ message: `unknown dsh-autopilot config key(s): ${unknown.join(', ')}` }] }
}

/**
 * Declared plugin configuration: the volatile-marked shape plus the
 * unknown-key refusal, composed as a Standard-Schema façade over
 * {@link ConfigShape}.
 *
 * WHY A FAÇADE AND NOT `Schema.intersect([ConfigShape, UnknownKeyGuard])`
 * (the composition this module shipped before routing). Schemastery 3.18's
 * volatility is STRUCTURAL: `Schema.resolve` runs `validateVolatileSchema`,
 * which refuses a volatile field anywhere under a union/intersect/transform
 * member ("volatile fields require a fixed object path without an enclosing
 * volatile field" — intersect members resolve in strict mode and count as
 * blocked paths, measured 2026-10-07 against @deepseek-ai/schemastery 3.18.4).
 * The plan's routing leaves are declared `.volatile()`, so the ROOT of this
 * schema must itself be the object schema — the fixed path volatility
 * requires — and the unknown-key guard moved to a pre-resolution step in
 * `['~standard'].validate`.
 *
 * That is the only surface the host touches (cordis resolves plugin config
 * exclusively through `runtime.Config['~standard'].validate`, measured in
 * `vendor/cordis/src/fiber.ts`) and the one every fixture in
 * `test/config.test.ts` drives; the callable form is preserved for parity
 * with the schema instance it replaces. The guard still sees the RAW profile
 * fragment — exactly what the intersect's strict-mode transform used to
 * receive — so its refusal semantics are unchanged: unknown keys are named
 * with their dotted path and the profile is refused BEFORE any default is
 * applied or any volatile reference is built.
 *
 * VOLATILE OUTPUT, STATED PLAINLY. Resolving this schema hands back, for
 * every `.volatile()` leaf, a stable reference object (cosmokit `Volatile`,
 * read via `.get()`) instead of a plain value — that is the mechanism the
 * plan's "backend + patch-writable" marking rides on, and it is why
 * `resolveConfig` in `./index.ts` unwraps references structurally: the
 * loader path and the plain-object path must keep producing the SAME
 * `ResolvedConfig`, which `test/config.test.ts` asserts by deep equality.
 *
 * The annotation is explicit (and the cast with it) for the same reason as
 * before: the façade is not a class instance of `Schema`, and stating the
 * contract — a validator whose accepted input and produced value are both
 * `ConfigInput` — is more useful to a reader than the structural type anyway.
 */
function validateConfig(raw: unknown): { value?: ConfigInput; issues?: readonly { message: string }[] } {
  const blocked = unknownKeyIssues(raw)
  if (blocked !== undefined) return blocked
  return ConfigShape['~standard'].validate(raw) as { value?: ConfigInput; issues?: readonly { message: string }[] }
}

export const Config: Schema<ConfigInput, ConfigInput> = ((raw: unknown, options?: unknown) => {
  const blocked = unknownKeyIssues(raw)
  if (blocked !== undefined) {
    throw new Schema.ValidationError(blocked.issues[0]!.message, (options ?? {}) as never)
  }
  return ConfigShape(raw as never, options as never)
}) as unknown as Schema<ConfigInput, ConfigInput>

;(Config as unknown as Record<string, unknown>)['~standard'] = {
  version: 1,
  vendor: 'dsh-autopilot',
  validate: (value: unknown) => validateConfig(value),
}

/**
 * Settings whose mechanism 0.3.0 removed. The schema still ACCEPTS them, so a
 * profile written for 0.2.x loads without error, but they have no effect.
 *
 * - `gate.*`: the sandbox clamp, tool deny, egress deny, stop reminder, strict
 *   shell and restore mode belonged to the retired run state machine.
 * - `governance.*`: audit-round cap and unattended egress policy likewise.
 * - `storeKind`: history now reads both backends; the ledger follows what the
 *   host offers.
 *
 * Still live (not listed): `routing.*` (child routing), `crossFamily.*`
 * (reviewer independence), `storeRoot`, `skillInstall`. `auditors.*`,
 * `auditProvider`, `executorProvider` and `executor.*` are accepted but are not
 * yet listed here; whether 0.3.0 still reads them is the engine's call.
 */
export const RETIRED_CONFIG_KEYS: readonly string[] = [
  'gate.sandboxCoupling',
  'gate.toolDeny',
  'gate.egressDeny',
  'gate.stopReminder',
  'gate.strictShell',
  'gate.restoreMode',
  'governance.maxAuditRoundsPerRole',
  'governance.unattended',
  'storeKind',
  'auditProvider',
  'executorProvider',
  'executor.persona',
  'executor.toolAllowList',
  'executor.agentOptions.maxTokens',
  'auditors.plan.provider',
  'auditors.plan.agentOptions.maxTokens',
  'auditors.execution.provider',
  'auditors.execution.agentOptions.maxTokens',
  'auditors.rules.provider',
  'auditors.rules.agentOptions.maxTokens',
  'crossFamily.enabled',
  'crossFamily.minRisk',
  'crossFamily.pool',
]

/**
 * The legacy keys that are STILL READ, and by what. `executor.agentOptions`
 * (provider, model, reasoningEffort) becomes the `routing.roles.executor` lock
 * and so pins the worker and executor-lead route; `auditors.<role>.agentOptions`
 * becomes the matching auditor lock and so pins the reviewer route (`legacyRouteFor`
 * in `./index.ts`, read by `routeForDelegation`). Everything else of the 0.2.x
 * surface is in {@link RETIRED_CONFIG_KEYS}.
 */
export const LEGACY_KEYS_STILL_READ: readonly string[] = [
  'executor.agentOptions.provider',
  'executor.agentOptions.model',
  'executor.agentOptions.reasoningEffort',
  'auditors.plan.agentOptions.provider',
  'auditors.plan.agentOptions.model',
  'auditors.plan.agentOptions.reasoningEffort',
  'auditors.execution.agentOptions.provider',
  'auditors.execution.agentOptions.model',
  'auditors.execution.agentOptions.reasoningEffort',
  'auditors.rules.agentOptions.provider',
  'auditors.rules.agentOptions.model',
  'auditors.rules.agentOptions.reasoningEffort',
]

/** The retired keys the user actually wrote in `input`, in {@link RETIRED_CONFIG_KEYS} order. */
export function retiredKeysIn(input: unknown): readonly string[] {
  return RETIRED_CONFIG_KEYS.filter(path => {
    let node: unknown = input
    for (const part of path.split('.')) {
      if (typeof node !== 'object' || node === null || Array.isArray(node)) return false
      node = (node as Record<string, unknown>)[part]
    }
    // An EMPTY array is what the loader fills in for an unwritten array leaf, so it is not a written key.
    return node !== undefined && !(Array.isArray(node) && node.length === 0)
  })
}

/** One plain status note naming the ignored keys, or `undefined` when there are none. */
export function retiredConfigNote(keys: readonly string[]): string | undefined {
  if (keys.length === 0) return undefined
  return `dsh-autopilot 0.3.0 ignores retired settings: ${keys.join(', ')}; they no longer have an effect.`
}
