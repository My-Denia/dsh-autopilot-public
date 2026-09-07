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
 * {@link CONFIG_KEY_SPEC} and enforced by a transform composed alongside the
 * shape. A claim a checker cannot observe being false is the one thing this
 * repository's doctrine forbids, so the check exists rather than the wording
 * being softened.
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
 * scan (`./gate/decide.ts`) gained the terminal names, because widening what
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
  maxTokens: Schema.natural().description('Per-child output cap.'),
})

/** Per-role auditor routing (the cross-family review matrix's landing point). */
const AuditorRoute = Schema.object({
  provider: Schema.string().description('Subagent transport provider for this role.'),
  agentOptions: AgentOptions,
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
]).default('auto').description('Which backend holds the canonical event stream.')

/** Declared plugin configuration shape; mirrors `ConfigInput` in `./index.ts`. */
const ConfigShape = Schema.object({
  auditProvider: Schema.string().default('spawn').description('Subagent transport provider for one-shot auditors.'),
  executorProvider: Schema.string().default('spawn').description('Subagent transport provider for the continuable executor.'),
  auditors: Schema.object({
    plan: AuditorRoute,
    execution: AuditorRoute,
    rules: AuditorRoute,
  }).description('Per-role auditor routing; omitted roles inherit the deployment default.'),
  executor: Schema.object({
    agentOptions: AgentOptions,
    persona: Schema.string().default('').description('Executor Lead persona override.'),
    toolAllowList: Schema.array(Schema.string())
      .default([...DEFAULT_EXECUTOR_TOOLS])
      .description('Tool names the executor child may call.'),
  }),
  crossFamily: Schema.object({
    enabled: Schema.boolean().default(true)
      .description('Seek an auditor from a family the executor is not from, once risk reaches minRisk.'),
    minRisk: Schema.union(['low', 'medium', 'high', 'critical'] as const).default('medium')
      .description('Risk floor at which cross-family review is sought.'),
    pool: Schema.array(AgentOptions).default([])
      .description('Candidate auditor routes to draw an out-of-family reviewer from.'),
  }).description('Cross-family review: a blind spot shared by one provider passes both gates unchallenged, so at risk the reviewer should not be from the builder family. A strategy, not a gate — the outcome is recorded per audit rather than enforced.'),
  gate: Schema.object({
    sandboxCoupling: Schema.boolean().default(true).description('Clamp standard runs read-only until the plan gate passes.'),
    toolDeny: Schema.boolean().default(true).description('Deny write/edit/str_replace_editor pre-plan-gate and while usage is undeclared.'),
    egressDeny: Schema.boolean().default(true).description('Enforce the owner-only egress boundary.'),
    stopReminder: Schema.boolean().default(true).description('Emit the bounded turn-stop execution reminder.'),
    strictShell: Schema.boolean().default(false).description('Deny shell pre-plan-gate when the sandbox is not active.'),
    restoreMode: Schema.string().default('workspace-write').description('Sandbox mode restored on plan-gate pass when none was recorded.'),
  }),
  storeKind: StoreKindSchema,
  storeRoot: Schema.string().default('').description('Run store directory; empty means $DSH_HOME/storages/dsh-autopilot.'),
  skillInstall: Schema.union([
    Schema.const('auto').description('Copy bundled SKILL.md into the skill-scan root if absent; warn on drift, never overwrite.'),
    Schema.const('off').description('Do not touch the skill-scan root.'),
  ]).default('auto').description('Whether apply() installs the bundled skill into $DSH_AGENTS_HOME/skills.'),
}).description('dsh-autopilot: plan-execute-audit gates, usage evidence, outbound manifests.')

/**
 * A node in the known-key tree: `null` marks a leaf (any shape the schema above
 * already governs), a nested record marks an object whose own keys are checked.
 */
interface KeySpec {
  readonly [key: string]: KeySpec | null
}

/** The route shape both `auditors.*` and `executor` reuse. */
const AGENT_OPTIONS_KEYS: KeySpec = { provider: null, model: null, maxTokens: null }
const AUDITOR_ROUTE_KEYS: KeySpec = { provider: null, agentOptions: AGENT_OPTIONS_KEYS }

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

/**
 * The unknown-key half of the contract. Composed with {@link ConfigShape}
 * through `Schema.intersect`, which resolves each member in STRICT mode and
 * therefore hands this transform the RAW profile fragment — the only place a
 * key the shape does not declare is still visible.
 */
const UnknownKeyGuard = Schema.transform(Schema.any(), (value: unknown, options?: unknown) => {
  const unknown = unknownKeys(value, CONFIG_KEY_SPEC, '')
  if (unknown.length > 0) {
    throw new Schema.ValidationError(
      `unknown dsh-autopilot config key(s): ${unknown.join(', ')}`,
      (options ?? {}) as never,
    )
  }
  return {}
})

/**
 * Declared plugin configuration: the shape plus the unknown-key refusal.
 *
 * Both halves are load-bearing and both are covered by a negative fixture in
 * `test/config.test.ts` — a type error, an enum violation, an unknown top-level
 * key and an unknown nested key each produce an issue naming what was wrong.
 *
 * The annotation is explicit (and the cast with it) because the inferred
 * intersect type reaches into a transitive `cosmokit` path TypeScript cannot
 * name from here; stating the contract — a validator whose accepted input and
 * produced value are both `ConfigInput` — is more useful to a reader than the
 * structural type anyway.
 */
export const Config: Schema<ConfigInput, ConfigInput> =
  Schema.intersect([ConfigShape, UnknownKeyGuard]) as unknown as Schema<ConfigInput, ConfigInput>
