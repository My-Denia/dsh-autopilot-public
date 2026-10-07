/**
 * BOUNDARY LAYER — the tests that cross into dsh instead of stopping at a mock.
 *
 * WHY THIS FILE EXISTS. The suite was 556 green when the harness was driven on
 * a real dsh host for the first time and came back with 22 defects, 8 of them
 * high. Every one of the high defects sat at a seam the suite mocks:
 *
 *   - `test/tools.test.ts` collects tool definitions into a `Map` and awaits
 *     `def.execute()` directly. No `ToolRuntime`, therefore no output
 *     serialization, therefore the lossless-JSON output contract was never
 *     evaluated once across 556 tests.
 *   - `test/helpers.ts`'s `stubSubagents.startContinuable` never reads
 *     `spec.request.toolFilter`, and nothing anywhere calls `tools.restrict()`.
 *     The filters the engine builds were asserted only against themselves.
 *   - `test/child-setup.test.ts` hand-builds a `childCtx` and never calls dsh's
 *     `applyChildComposition` — the function that runs first on a real host and
 *     the one that actually applies the filter.
 *   - Nothing exercised plugin mount ordering, so what the host observes after
 *     `ctx.plugin()` resolves was never observed at all.
 *
 * So a fix validated only against those mocks reproduces the failure it is
 * meant to end. This file imports the REAL symbols and drives them.
 *
 * ── WHAT IS REAL HERE ──────────────────────────────────────────────────────
 *   `Context`                      @deepseek-ai/cordis          (real)
 *   `ToolRuntime`                  @deepseek-ai/dsh-tools       (real registry,
 *                                    real execute pipeline, real output validator)
 *   `snapshotJsonValue`            @deepseek-ai/dsh-util-values (the real
 *                                    lossless-JSON boundary the runtime calls;
 *                                    moved out of dsh-session in dsh 0.1.2)
 *   `SubagentRuntime`,
 *   `applyChildComposition`,
 *   `NO_START_CAPABILITIES`        @deepseek-ai/dsh-subagent    (real)
 *   `ToolCallId`                   @deepseek-ai/dsh-llm         (real; `CallId` before 0.1.2)
 *   `SystemPrompt`, `createScope`  @deepseek-ai/dsh-system-prompt,
 *                                  @deepseek-ai/dsh-scope       (real; see
 *                                    {@link resolveFromDshTools} for why they
 *                                    are loaded by path rather than by name)
 *
 * ── WHAT IS *NOT* REAL, AND WHAT WAS SUBSTITUTED ───────────────────────────
 * A boundary test that quietly re-mocks its boundary is worse than no test,
 * because it advertises coverage it does not have. The three substitutions:
 *
 * 1. AGENTS. `@deepseek-ai/dsh-agent`'s `AgentRuntime` needs an LLM provider,
 *    a session store and a running loop; none of that is reachable from this
 *    package's dependency closure. Agents here are structural stand-ins
 *    (`{ id, options, session }`) used as SCOPE KEYS. What that costs and what
 *    it does not: `ToolRuntime` treats a scope key as an opaque identity, so
 *    registration, shadowing, restriction, visibility and dispatch are all
 *    exercised for real; only the agent's own behaviour is not. Where a real
 *    scoped CONTEXT matters — root tool installation, child composition — the
 *    context is a real `createScope(...).ctx`, not an object literal.
 *
 * 2. THE DSH GLOBAL TOOL SET. The real `read`/`bash`/`grep`/... tools live in
 *    packages (`dsh-tool-fs`, `dsh-tool-bash`, ...) this project does not
 *    depend on. {@link DSH_GLOBAL_TOOL_NAMES} registers NAME-FAITHFUL
 *    stand-ins under names transcribed from upstream `defineTool` call sites,
 *    each cited below. That substitution is EXACT for the boundary under test
 *    — `tools.restrict()` validates names against the registry and never
 *    touches a definition's body — and would be worthless for anything that
 *    executes those tools. Nothing here executes them.
 *
 * 3. `startContinuable`. The real one needs the continuation manager's session
 *    persistence services. The executor filter is therefore CAPTURED from the
 *    engine's real request object and then pushed through the REAL
 *    `applyChildComposition`/`tools.restrict()`. The filter is the engine's own
 *    and the restriction is dsh's own; only the transport between them is not.
 *    The auditor filter needs no such substitution — it is captured from a
 *    dispatch through the real `SubagentRuntime`.
 *
 * ── DELIBERATELY NOT IMPORTING `./helpers.js` ──────────────────────────────
 * `test/helpers.ts` is the mock layer whose blind spots produced two of these
 * defects. Sharing it here would reintroduce them one import at a time, so
 * this file builds its own fixtures even where they look similar.
 *
 * ── PROVEN ABLE TO FAIL (DESIGN.md §5) ─────────────────────────────────────
 * Every assertion below except the two UPSTREAM CANARIES was driven red by a
 * targeted mutation in a sandbox copy, then restored. Measured 2026-08-25
 * against this tree, one mutation at a time, 13 tests total:
 *
 *   restore `usage: snapshot.usage` in autopilot_init ............... 2 red
 *   put `autopilot_submit_packet` back in the executor allow-list ... 1 red
 *   add an unregistrable name to AUDITOR_TOOL_ALLOW ................. 1 red
 *   float apply()'s mount work behind an unawaited promise .......... 1 red
 *   skip installRootTools at mount .................................. 2 red
 *   read the child agent with `childCtx.get('agent')` alone ......... 1 red
 *   drop the executor-authorization check in the child setup ........ 1 red
 *   register the packet tool globally instead of child-scoped ....... 1 red
 *   put the negative-control name into the registry .................. 1 red
 *   give the capability-less provider every capability ............... 1 red
 *
 * The two exceptions are labelled UPSTREAM CANARY where they appear. They pin
 * a dsh/cordis contract the rest of the file rests on, and NO change to this
 * repository can turn them red — only an upstream version change can, which is
 * exactly what they are here to announce. Stating that ceiling is the point:
 * counting them as defect bearers would overstate what this file covers.
 */

import { describe, expect, it } from 'vitest'
import { createRequire } from 'node:module'
import { mkdtempSync, realpathSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { Context } from '@deepseek-ai/cordis'
// dsh 0.1.2 export drift (R-11): `CallId` → `ToolCallId` in dsh-llm;
// `snapshotJsonValue` moved from dsh-session to dsh-util-values.
import { ToolCallId } from '@deepseek-ai/dsh-llm'
import { snapshotJsonValue } from '@deepseek-ai/dsh-util-values'
import ToolRuntime from '@deepseek-ai/dsh-tools'
import SubagentRuntime, { NO_START_CAPABILITIES, applyChildComposition } from '@deepseek-ai/dsh-subagent'
import { AutopilotEngine, AUDITOR_TOOL_ALLOW } from '../src/engine.js'
import type { AgentRef } from '../src/engine.js'
import * as autopilotPlugin from '../src/index.js'
import { createContinuableChildSetup, resolveConfig } from '../src/index.js'
import { RunStore } from '../src/store/file.js'
import { installRootTools, packetToolDefinition } from '../src/tools.js'
import type { Triage } from '../src/domain/types.js'

/* ────────────────────────────── module loading ───────────────────────────── */

/**
 * Load a dsh package that this project does not declare as a dependency but
 * that IS physically installed as a peer of `@deepseek-ai/dsh-tools`.
 *
 * `dsh-system-prompt` and `dsh-scope` are peer dependencies of `dsh-tools`, so
 * pnpm materializes them inside the tools package's own virtual-store node
 * folder. They are unreachable by bare specifier from here, and this file may
 * not run `pnpm add`. Resolving from the tools package's REAL path (pnpm links
 * `node_modules/@deepseek-ai/dsh-tools` into `.pnpm`, and Node's resolver does
 * not walk back out through the link) reaches exactly the copy the installed
 * `ToolRuntime` itself uses — so the `SystemPrompt` service mounted below is
 * the same physical class the runtime injects, not a second one.
 *
 * A resolution failure THROWS rather than skipping. A boundary file that
 * silently degrades to "no assertions" is the failure mode this whole file was
 * written against.
 */
function resolveFromDshTools(specifier: string): string {
  const toolsPkg = fileURLToPath(new URL('../node_modules/@deepseek-ai/dsh-tools/package.json', import.meta.url))
  const req = createRequire(pathToFileURL(realpathSync(toolsPkg)))
  return req.resolve(specifier)
}

async function loadFromDshTools(specifier: string): Promise<Record<string, unknown>> {
  const href = pathToFileURL(resolveFromDshTools(specifier)).href
  return await import(href) as Record<string, unknown>
}

const SystemPromptPlugin = (await loadFromDshTools('@deepseek-ai/dsh-system-prompt'))['default']
const createScope = (await loadFromDshTools('@deepseek-ai/dsh-scope'))['createScope'] as
  (ctx: unknown, key: unknown) => { ctx: Context }

/* ─────────────────────────────── fixtures ────────────────────────────────── */

/**
 * The GLOBAL tool names a dsh deployment mounts, transcribed from the upstream
 * `defineTool({ name: ... })` call sites so the list is INDEPENDENT of the
 * allow-lists it is used to validate. Populating this from
 * `AUDITOR_TOOL_ALLOW`/`DEFAULT_EXECUTOR_TOOLS` would make §2 circular and
 * unable to fail.
 *
 *   read                  packages/fs/tool-fs/src/read.ts
 *   read_image            packages/fs/tool-fs/src/read-image.ts
 *   write                 packages/fs/tool-fs/src/write.ts
 *   edit                  packages/fs/tool-fs/src/edit.ts
 *   str_replace_editor    packages/fs/tool-str-replace-editor/src/index.ts
 *   glob                  packages/fs/tool-fs-search/src/glob.ts
 *   grep                  packages/fs/tool-fs-search/src/grep.ts
 *   bash                  packages/shell/tool-bash/src/index.ts
 *   pwsh                  packages/shell/tool-pwsh/src/index.ts
 *   todo_write            packages/todo/tool-todo/src/index.ts
 *   ask_user_question     packages/interaction/tool-ask-user/src/index.ts
 *
 * The last two entries are deliberate NON-members of either allow-list: they
 * keep the registry a strict superset, so "the filter was accepted" cannot be
 * an artefact of the registry containing only what the filter names.
 */
const DSH_GLOBAL_TOOL_NAMES: readonly string[] = [
  'read', 'read_image', 'write', 'edit', 'str_replace_editor',
  'glob', 'grep', 'bash', 'pwsh', 'todo_write', 'ask_user_question',
  'web_search', 'web_fetch',
]

/**
 * The complete autopilot tool surface, listed rather than derived so that
 * ADDING a tool and forgetting to drive it through the real runtime is a
 * failing test rather than silent regrowth of the blind spot §1 closes.
 */
const AUTOPILOT_TOOL_NAMES: readonly string[] = [
  'autopilot_init',
  'autopilot_status',
  'autopilot_submit_plan',
  'autopilot_audit',
  'autopilot_self_check',
  'autopilot_usage',
  'autopilot_log',
  'autopilot_executor',
  'autopilot_submit_evidence',
  'autopilot_signal',
  'autopilot_submit_closeout',
  'autopilot_submit_packet',
  'autopilot_external_audit',
]

/** A name-faithful stand-in registration (see substitution 2 in the header). */
function standInTool(name: string): unknown {
  return {
    name,
    description: `stand-in for the dsh global tool "${name}"`,
    parameters: { type: 'object', properties: {} },
    output: {
      schema: { type: 'string' },
      render: (_args: unknown, value: unknown) => [{ type: 'text', text: String(value) }],
    },
    execute: () => Promise.resolve('ok'),
  }
}

/** Structural agent used as a `ToolRuntime` scope key (see substitution 1). */
interface StructuralAgent extends AgentRef {
  readonly events: Array<{ type: string; data: unknown }>
}

function structuralAgent(id: string, parentSession?: string): StructuralAgent {
  const events: Array<{ type: string; data: unknown }> = []
  const agent = {
    id,
    events,
    options: { provider: 'boundary-provider', model: 'boundary-model' },
    session: {
      header: parentSession === undefined ? {} : { parentSession },
      // dsh 0.1.2 shape: a whole-log snapshot, not an `events` array.
      snapshotEvents: () => events.slice(),
      append(type: string, data: unknown) { events.push({ type, data }) },
    },
  }
  return agent as unknown as StructuralAgent
}

/** Open a turn whose first user message has source kind 'user' (owner authority). */
function openDirectHumanTurn(agent: StructuralAgent): void {
  agent.events.push({ type: 'turn/start', data: {} })
  agent.events.push({ type: 'user/message', data: { source: { kind: 'user' } } })
}

function tempStore(): RunStore {
  return new RunStore(mkdtempSync(join(tmpdir(), 'dsh-autopilot-boundary-')))
}

interface Mounted {
  readonly ctx: Context & { tools: ToolRuntime; subagents: SubagentRuntime }
  plugin(plugin: unknown, config?: unknown): Promise<unknown>
  provide(name: string, value: unknown): void
}

/** Mount a real cordis context carrying the real dsh services this file drives. */
async function mountRuntime(options: { subagents?: boolean } = {}): Promise<Mounted> {
  const ctx = new Context() as Context & { tools: ToolRuntime; subagents: SubagentRuntime }
  const raw = ctx as unknown as {
    plugin(plugin: unknown, config?: unknown): Promise<unknown>
    provide(name: string, value?: unknown): unknown
  }
  await raw.plugin(SystemPromptPlugin, {})
  await raw.plugin(ToolRuntime)
  if (options.subagents === true) await raw.plugin(SubagentRuntime)
  return {
    ctx,
    plugin: (plugin, config) => raw.plugin(plugin, config),
    provide: (name, value) => { raw.provide(name, value) },
  }
}

/** Mint a real scoped context keyed by `key`, the way a dsh agent's ctx is minted. */
async function mintScope(mounted: Mounted, key: unknown): Promise<Context> {
  let scoped: Context | undefined
  await mounted.plugin(Object.assign(
    (inner: Context) => { scoped = createScope(inner, key).ctx },
    { inject: ['tools', 'systemPrompt'] },
  ))
  if (scoped === undefined) throw new Error('scope minting did not run')
  return scoped
}

function makeEngine(subagents: unknown, agents: ReadonlyMap<string, AgentRef>): AutopilotEngine {
  return new AutopilotEngine(
    { get: (id: string) => agents.get(id) } as never,
    subagents as never,
    tempStore(),
    resolveConfig(),
    () => true,
    {},
  )
}

const BASE_TRIAGE: Triage = {
  objective: 'boundary objective',
  scope: ['src/'],
  nonGoals: ['docs/'],
  acceptanceCriteria: ['the boundary holds'],
  risk: 'low',
  size: 'lightweight',
  executionMode: 'inline',
  auditMode: 'self-check',
  touchesOperatingLayer: false,
  baseline: {},
}

/* ══════════════════════════════════════════════════════════════════════════
 * §1  TOOL OUTPUT × the real lossless-JSON boundary
 *
 * dsh validates every successful tool value with `snapshotJsonValue` and
 * raises `ToolOutputError` / `INVALID_TOOL_OUTPUT` when it fails
 * (`@deepseek-ai/dsh-tools` `snapshotToolValue`). An OWN property whose value
 * is `undefined` is NOT lossless JSON, so `{ ...ok, usage: snapshot.usage }`
 * with `usage` absent from the snapshot is a runtime failure the model sees —
 * invisible to any test that awaits `def.execute()` and inspects the object.
 * ══════════════════════════════════════════════════════════════════════════ */

/** One tool call through the real registry, recording which tools were driven. */
async function callTool(
  ctx: Context & { tools: ToolRuntime },
  driven: Set<string>,
  name: string,
  args: Record<string, unknown>,
  agent: AgentRef,
): Promise<{ isError: boolean; code: string | undefined; message: string | undefined; value: unknown }> {
  driven.add(name)
  const result = await ctx.tools.execute({
    signal: new AbortController().signal,
    callId: ToolCallId(`boundary-${name}`),
    name,
    arguments: args,
    agent: agent as never,
  })
  return result.isError
    ? { isError: true, code: result.error.info?.code, message: result.error.message, value: undefined }
    : { isError: false, code: undefined, message: undefined, value: result.value }
}

interface ToolBed {
  readonly ctx: Context & { tools: ToolRuntime }
  readonly engine: AutopilotEngine
  readonly root: StructuralAgent
  readonly agents: Map<string, AgentRef>
  readonly driven: Set<string>
}

/** Register the full autopilot tool surface on a real `ToolRuntime`. */
async function toolBed(verdicts: Array<{ verdict: string; note: string }> = []): Promise<ToolBed> {
  const mounted = await mountRuntime()
  const agents = new Map<string, AgentRef>()
  const root = structuralAgent('boundary-root')
  agents.set(root.id, root)
  const queue = [...verdicts]
  let auditors = 0
  const subagents = {
    async start() {
      auditors += 1
      const id = `boundary-auditor-${auditors}`
      const child = structuralAgent(id, root.id)
      agents.set(id, child)
      const next = queue.shift() ?? { verdict: 'pass', note: 'boundary default' }
      return {
        id,
        localAgent: child,
        result: Promise.resolve({ output: [], stopReason: 'completed', structured: next }),
        async dispose() { /* nothing to release */ },
      }
    },
    async startContinuable(spec: { childId: string }) {
      const child = structuralAgent(spec.childId, root.id)
      agents.set(spec.childId, child)
      return {}
    },
    async sendMessage() { return 'scripted-message' },
    interrupt() { /* not exercised here */ },
    async drainContinuableChildren() { return {} },
  }
  const engine = makeEngine(subagents, agents)
  installRootTools(mounted.ctx.tools as never, engine)
  // The packet tool is child-scoped on a real host; registering it globally
  // here is only so §1 can drive its OUTPUT through the same validator. §2
  // asserts the layer it actually belongs in.
  mounted.ctx.tools.register(packetToolDefinition(engine) as never)
  return { ctx: mounted.ctx, engine, root, agents, driven: new Set<string>() }
}

const INIT_REQUIRED = {
  objective: BASE_TRIAGE.objective,
  scope: [...BASE_TRIAGE.scope],
  nonGoals: [...BASE_TRIAGE.nonGoals],
  acceptanceCriteria: [...BASE_TRIAGE.acceptanceCriteria],
  risk: 'low',
}

describe('§1 tool output crosses the real lossless-JSON validator', () => {
  it('UPSTREAM CANARY: an own property whose value is undefined is not lossless JSON', () => {
    // Pinned upstream contract, not a restatement of our own code: if dsh ever
    // relaxed this, every "must not emit undefined" assertion below would be
    // asserting nothing, and this bearer is what says so.
    expect(snapshotJsonValue({ revision: 1, usage: undefined })).toBeUndefined()
    expect(snapshotJsonValue({ revision: 1 })).toEqual({ revision: 1 })
    expect(snapshotJsonValue({ nested: { usage: undefined } })).toBeUndefined()
  })

  it('autopilot_init on a LIGHTWEIGHT run returns a serializable value', async () => {
    // THE BEARER FOR DEFECT #1. A lightweight run seeds no usage evidence, so
    // `snapshot.usage` is absent and the body's `{ ..., usage: snapshot.usage }`
    // materializes an own `usage: undefined`. `test/tools.test.ts` sees a plain
    // object and passes; the real runtime refuses the value.
    const bed = await toolBed()
    const result = await callTool(bed.ctx, bed.driven, 'autopilot_init', {
      ...INIT_REQUIRED, size: 'lightweight', executionMode: 'inline', auditMode: 'self-check',
    }, bed.root)
    expect(result.code).not.toBe('INVALID_TOOL_OUTPUT')
    expect(result.isError).toBe(false)
  })

  it('drives every autopilot tool through the runtime with all optional arguments omitted', async () => {
    const delegated = await toolBed([
      { verdict: 'pass', note: 'plan ok' },
      { verdict: 'pass', note: 'execution ok' },
    ])
    const failures: string[] = []
    const drive = async (name: string, args: Record<string, unknown>, agent: AgentRef): Promise<unknown> => {
      const outcome = await callTool(delegated.ctx, delegated.driven, name, args, agent)
      if (outcome.isError) failures.push(`${name}: [${String(outcome.code)}] ${String(outcome.message)}`)
      return outcome.value
    }

    // Delegated / standard / independent: every optional parameter omitted.
    await drive('autopilot_init', {
      ...INIT_REQUIRED, risk: 'medium', size: 'standard',
      executionMode: 'delegated', auditMode: 'independent',
    }, delegated.root)
    await drive('autopilot_submit_plan', { text: 'boundary plan' }, delegated.root)
    await drive('autopilot_usage', { id: 'm1', usageClass: 'internal' }, delegated.root)
    await drive('autopilot_log', { text: 'checkpoint', stance: 'on-plan' }, delegated.root)
    await drive('autopilot_audit', { role: 'plan', prompt: 'audit packet' }, delegated.root)
    const started = await drive('autopilot_executor', { action: 'start', prompt: 'go' }, delegated.root)
    const childId = (started as { executor?: { childId?: string } } | undefined)?.executor?.childId
    expect(typeof childId).toBe('string')
    const child = delegated.agents.get(String(childId))
    expect(child).toBeDefined()
    await drive('autopilot_submit_packet', { packet: 'execution packet', executionRevision: 1 }, child as AgentRef)
    await drive('autopilot_audit', { role: 'execution', prompt: 'audit packet' }, delegated.root)
    await drive('autopilot_status', {}, delegated.root)
    await drive('autopilot_submit_closeout', {
      summary: 'done',
      changedFiles: ['src/x.ts'],
      commands: ['npx vitest run'],
      evidence: [{ criterion: 'the boundary holds', bearer: 'test/boundary.test.ts', status: 'proven', kind: 'path' }],
      workspaceCleanup: 'nothing created',
      drift: 'none found',
    }, delegated.root)

    // Inline / lightweight / self-check: the remaining tools, same omissions.
    const inline = await toolBed()
    openDirectHumanTurn(inline.root)
    const driveInline = async (name: string, args: Record<string, unknown>): Promise<void> => {
      const outcome = await callTool(inline.ctx, inline.driven, name, args, inline.root)
      if (outcome.isError) failures.push(`${name}: [${String(outcome.code)}] ${String(outcome.message)}`)
    }
    await driveInline('autopilot_init', {
      ...INIT_REQUIRED, size: 'lightweight', executionMode: 'inline', auditMode: 'self-check',
    })
    await driveInline('autopilot_submit_plan', { text: 'inline plan' })
    await driveInline('autopilot_self_check', { role: 'plan', verdict: 'pass', note: 'checked' })
    await driveInline('autopilot_submit_evidence', { report: 'inline evidence' })
    await driveInline('autopilot_signal', { action: 'owner-approve', note: 'git push' })
    await driveInline('autopilot_self_check', { role: 'execution', verdict: 'pass', note: 'checked' })

    // External / standard: the owner-countersign channel. It needs its own bed
    // because `auditMode` is immutable after init, and its own direct human
    // turn because the tool refuses an agent-generated one — which is the
    // whole reason `external` is not just a self-check with better paperwork.
    const external = await toolBed()
    openDirectHumanTurn(external.root)
    const driveExternal = async (name: string, args: Record<string, unknown>): Promise<void> => {
      const outcome = await callTool(external.ctx, external.driven, name, args, external.root)
      if (outcome.isError) failures.push(`${name}: [${String(outcome.code)}] ${String(outcome.message)}`)
    }
    await driveExternal('autopilot_init', {
      ...INIT_REQUIRED, size: 'standard', risk: 'low',
      executionMode: 'inline', auditMode: 'external',
    })
    await driveExternal('autopilot_submit_plan', { text: 'external plan' })
    // A standard run seeds an undeclared usage entry, and the plan gate refuses
    // to flip while one is outstanding. Measured here, which is worth keeping:
    // the countersign goes through the SAME `applyVerdict` path as a dispatched
    // audit, so `external` does not get a private door past the usage gate.
    await driveExternal('autopilot_usage', { id: 'm1', usageClass: 'internal' })
    await driveExternal('autopilot_external_audit', {
      role: 'plan', verdict: 'pass', note: 'reviewed offline',
      reviewer: 'a human', reviewRef: 'review/plan-review.md',
    })

    const driven = new Set([...delegated.driven, ...inline.driven, ...external.driven])
    // A tool added to the surface and never driven here would leave §1 blind
    // exactly where it was blind before, so the omission is itself a failure.
    expect([...driven].sort()).toEqual([...AUTOPILOT_TOOL_NAMES].sort())
    expect(delegated.ctx.tools.schemas().map(schema => schema.name).sort())
      .toEqual([...AUTOPILOT_TOOL_NAMES].sort())
    expect(failures).toEqual([])
  })
})

/* ══════════════════════════════════════════════════════════════════════════
 * §2  toolFilter × the real registry
 *
 * `ToolRestriction` is applied by `applyChildComposition` →
 * `childCtx.tools.restrict(filter)`. `restrict()` throws on any name outside
 * the scope's INHERITED surface — which excludes the child's OWN layer
 * (`ToolRuntime.view`: "A restriction filters what a scope inherits ... and
 * never what its OWN layer registers"). So a filter naming a child-scoped tool
 * is not merely redundant, it is fatal, and it fails BEFORE the continuable
 * setup that registers that tool ever runs: `materializeTracked` calls
 * `applyChildComposition(childCtx, parent, composition)` and only then
 * `this.setupRegistry.apply(childCtx)`.
 * ══════════════════════════════════════════════════════════════════════════ */

interface ChildBed {
  readonly ctx: Context & { tools: ToolRuntime }
  readonly childCtx: Context
  readonly childKey: object
}

/** A real registry holding the real dsh global names, plus a real child scope. */
async function childBed(): Promise<ChildBed> {
  const mounted = await mountRuntime()
  for (const name of DSH_GLOBAL_TOOL_NAMES) mounted.ctx.tools.register(standInTool(name) as never)
  const childKey = { id: 'boundary-child' }
  const childCtx = await mintScope(mounted, childKey)
  return { ctx: mounted.ctx, childCtx, childKey }
}

/**
 * dsh's own composition entry point. `parent` is reached only through the
 * optional `agentPresets` service (`childCtx.get('agentPresets')?.composeFrom`),
 * which is absent on this context, so a structural stand-in never participates.
 */
function compose(bed: ChildBed, filter: { allow?: readonly string[]; deny?: readonly string[] }): void {
  applyChildComposition(bed.childCtx, { ctx: undefined } as never, { toolFilter: filter as never })
}

function visibleToChild(bed: ChildBed): string[] {
  return bed.ctx.tools.schemas(bed.childKey as never).map(schema => schema.name).sort()
}

describe('§2 the engine\'s tool filters against a real registry', () => {
  it('negative control: restrict() refuses a name the registry does not know', async () => {
    // Without this the two assertions below could both pass against a check
    // with no teeth, and §2 would certify nothing.
    // A FRESH bed per composition: `applyChildComposition` also registers the
    // `subagent:delegation` prompt context, and a real child context accepts
    // that name exactly once, so composing twice into one scope would fail for
    // a reason that has nothing to do with the filter.
    const rejected = await childBed()
    expect(() => { compose(rejected, { allow: ['read', 'definitely_not_a_dsh_tool'] }) })
      .toThrowError(/unknown global tool "definitely_not_a_dsh_tool"/)
    const accepted = await childBed()
    expect(() => { compose(accepted, { allow: ['read'] }) }).not.toThrow()
    expect(visibleToChild(accepted)).toEqual(['read'])
  })

  it('the AUDITOR filter — captured from a real SubagentRuntime dispatch — is restrictable', async () => {
    // The filter is not transcribed here: it is read back off the request the
    // engine handed to the real `ctx.subagents`, so a change to
    // AUDITOR_TOOL_ALLOW travels into this assertion by itself.
    const mounted = await mountRuntime({ subagents: true })
    const captured: Array<Record<string, unknown>> = []
    const root = structuralAgent('boundary-root')
    const agents = new Map<string, AgentRef>([[root.id, root]])
    mounted.ctx.subagents.registerProvider({
      name: 'spawn',
      capabilities: { outputSchema: true, depthLimit: true, toolFilter: true, persona: true },
      start: (async (request: Record<string, unknown>) => {
        captured.push(request)
        const child = structuralAgent('boundary-auditor', root.id)
        return {
          id: child.id,
          localAgent: child,
          result: Promise.resolve({ output: [], stopReason: 'completed', structured: { verdict: 'pass', note: 'ok' } }),
          dispose: async () => {},
        }
      }) as never,
    } as never)

    const engine = makeEngine(mounted.ctx.subagents, agents)
    await engine.init(root, { ...BASE_TRIAGE, risk: 'medium', size: 'standard', auditMode: 'independent' },
      [{ id: 'm1', usageClass: 'undeclared', boundaryStates: [], artifacts: [], attempted: [] }])
    await engine.submitPlan(root, 'plan')
    await engine.declareUsage(root, { id: 'm1', usageClass: 'internal', boundaryStates: [], artifacts: [], attempted: [] })
    const outcome = await engine.audit(root, { role: 'plan', prompt: 'audit packet' })
    expect(outcome.verdict).toBe('pass')

    const request = captured[0]
    expect(request).toBeDefined()
    const filter = request?.['toolFilter'] as { allow: readonly string[] } | undefined
    expect(filter?.allow).toEqual([...AUDITOR_TOOL_ALLOW])

    const bed = await childBed()
    expect(() => { compose(bed, filter as { allow: readonly string[] }) }).not.toThrow()
    expect(visibleToChild(bed)).toEqual([...AUDITOR_TOOL_ALLOW].sort())
  })

  it('the EXECUTOR filter — captured from the engine\'s own request — is restrictable', async () => {
    // THE BEARER FOR THE EXECUTOR-FILTER DEFECT. `startContinuable` is the one
    // place the executor filter is built, and `test/helpers.ts` never reads
    // `spec.request.toolFilter`. Here the captured filter is handed to the real
    // `applyChildComposition`, which is what a dsh host does with it first.
    const root = structuralAgent('boundary-root')
    const agents = new Map<string, AgentRef>([[root.id, root]])
    let captured: { allow?: readonly string[]; deny?: readonly string[] } | undefined
    const subagents = {
      async start() {
        const child = structuralAgent('boundary-auditor', root.id)
        agents.set(child.id, child)
        return {
          id: child.id,
          localAgent: child,
          result: Promise.resolve({ output: [], stopReason: 'completed', structured: { verdict: 'pass', note: 'ok' } }),
          async dispose() {},
        }
      },
      async startContinuable(spec: { childId: string; request: { toolFilter?: { allow?: readonly string[] } } }) {
        captured = spec.request.toolFilter
        agents.set(spec.childId, structuralAgent(spec.childId, root.id))
        return {}
      },
      async sendMessage() { return 'scripted-message' },
      interrupt() {},
      async drainContinuableChildren() { return {} },
    }
    const engine = makeEngine(subagents, agents)
    await engine.init(root, {
      ...BASE_TRIAGE, risk: 'medium', size: 'standard',
      executionMode: 'delegated', auditMode: 'independent',
    }, [{ id: 'm1', usageClass: 'undeclared', boundaryStates: [], artifacts: [], attempted: [] }])
    await engine.submitPlan(root, 'plan')
    await engine.declareUsage(root, { id: 'm1', usageClass: 'internal', boundaryStates: [], artifacts: [], attempted: [] })
    await engine.audit(root, { role: 'plan', prompt: 'audit packet' })
    await engine.startExecutor(root, { prompt: 'go', signal: new AbortController().signal })
    expect(captured).toBeDefined()

    const bed = await childBed()
    // The child's own layer already holds the packet tool at composition time
    // on a real host only AFTER this call; registering it first is the more
    // permissive of the two orders, so a rejection here is not an ordering
    // artefact.
    ;(bed.childCtx as unknown as { tools: ToolRuntime }).tools.register(
      packetToolDefinition(engine) as never,
    )
    expect(() => { compose(bed, captured as { allow: readonly string[] }) }).not.toThrow()
  })

  it('a child-scoped packet tool survives the restriction without being named in it', async () => {
    // Why the fix for the assertion above is "drop the name", not "register it
    // globally": an own-layer registration is exempt from the filter, so the
    // executor keeps `autopilot_submit_packet` while every inherited tool is
    // still masked down to the allow-list.
    const bed = await childBed()
    ;(bed.childCtx as unknown as { tools: ToolRuntime }).tools.register(
      packetToolDefinition({} as never) as never,
    )
    compose(bed, { allow: ['read', 'grep'] })
    expect(visibleToChild(bed)).toEqual(['autopilot_submit_packet', 'grep', 'read'])
    expect(bed.ctx.tools.get('autopilot_submit_packet', bed.childKey as never)).toBeDefined()
    expect(bed.ctx.tools.get('bash', bed.childKey as never)).toBeUndefined()
  })

  it('a provider without the toolFilter capability refuses the audit dispatch outright', async () => {
    // A DEPLOYMENT ceiling rather than a code defect, pinned so it cannot be
    // rediscovered on a host: the engine's audit request names outputSchema,
    // depthLimit and toolFilter, and `SubagentRuntime.assertCapabilities`
    // rejects the whole start when the configured provider advertises none of
    // them (`NO_START_CAPABILITIES` — every out-of-process backend).
    const mounted = await mountRuntime({ subagents: true })
    let started = 0
    mounted.ctx.subagents.registerProvider({
      name: 'out-of-process',
      capabilities: NO_START_CAPABILITIES,
      start: (async () => { started += 1; throw new Error('unreachable') }) as never,
    } as never)
    await expect(mounted.ctx.subagents.start('out-of-process', {
      prompt: [{ type: 'text', text: 'packet' }],
      parent: structuralAgent('boundary-root') as never,
      signal: new AbortController().signal,
      outputSchema: { type: 'object', properties: {} },
      maxDepth: 1,
      toolFilter: { allow: [...AUDITOR_TOOL_ALLOW] },
    } as never)).rejects.toThrowError(/does not support the "outputSchema" capability/)
    expect(started).toBe(0)
  })
})

/* ══════════════════════════════════════════════════════════════════════════
 * §3  MOUNT ORDERING × a real cordis Context
 *
 * `apply()` registers the whole surface inside an async `ctx.effect`, so what
 * the host sees when `ctx.plugin()` resolves depends on whether cordis awaits
 * an async effect body. It does not — it awaits an async `apply`. On a
 * deployment whose `ctx.storageDomain` resolves on a real I/O turn, the plugin
 * therefore reports mounted while its tools, gate, policy section and service
 * are all still absent.
 * ══════════════════════════════════════════════════════════════════════════ */

interface MountBed {
  readonly mounted: Mounted
  readonly rootKey: Record<string, unknown>
}

async function pluginBed(): Promise<MountBed> {
  const mounted = await mountRuntime()
  const root = structuralAgent('boundary-root') as unknown as Record<string, unknown>
  root['ctx'] = await mintScope(mounted, root)
  mounted.provide('agents', { get: () => undefined, list: () => [root], roots: () => [root] })
  mounted.provide('subagents', { registerContinuableSetup: () => () => {} })
  return { mounted, rootKey: root }
}

function rootSurface(bed: MountBed): string[] {
  return bed.mounted.ctx.tools.schemas(bed.rootKey as never).map(schema => schema.name).sort()
}

describe('§3 the plugin mount as the host observes it', () => {
  it('UPSTREAM CANARY: cordis awaits an async apply but not an async effect', async () => {
    // The mechanism §3 rests on, pinned against the installed cordis rather
    // than assumed. If this flips, the assertion below stops meaning what its
    // comment says it means.
    const awaited: Record<string, boolean> = { apply: false, effect: false }
    const ctxA = new Context() as unknown as { plugin(p: unknown, c?: unknown): Promise<unknown> }
    await ctxA.plugin({
      name: 'async-apply-probe',
      async apply() {
        await new Promise(resolve => setTimeout(resolve, 30))
        awaited['apply'] = true
        return () => {}
      },
    })
    const ctxB = new Context() as unknown as { plugin(p: unknown, c?: unknown): Promise<unknown> }
    await ctxB.plugin({
      name: 'async-effect-probe',
      apply(inner: Context) {
        (inner as unknown as { effect(factory: () => unknown, label?: string): unknown }).effect(async () => {
          await new Promise(resolve => setTimeout(resolve, 30))
          awaited['effect'] = true
          return () => {}
        }, 'async-effect-probe')
      },
    })
    expect(awaited['apply']).toBe(true)
    expect(awaited['effect']).toBe(false)
  })

  it('exposes the root controller surface once ctx.plugin() resolves', async () => {
    const bed = await pluginBed()
    await bed.mounted.plugin(autopilotPlugin, { storeRoot: mkdtempSync(join(tmpdir(), 'dsh-autopilot-mount-')) })
    expect(rootSurface(bed)).toContain('autopilot_init')
  })

  it('a slow store cannot remove tools from the surface the host observes', async () => {
    // THE BEARER FOR THE MOUNT RACE. `storageDomain` is mounted by the web-app
    // bundle, and a facility whose `open` needs a real I/O turn is the ordinary
    // case there, not an exotic one. `opened` proves the delay was actually
    // taken rather than collapsed into a microtask.
    const bed = await pluginBed()
    let opened = false
    bed.mounted.provide('storageDomain', {
      open: async () => {
        await new Promise(resolve => setTimeout(resolve, 40))
        opened = true
        throw new Error('this deployment has no autopilot domain')
      },
    })
    await bed.mounted.plugin(autopilotPlugin, { storeRoot: mkdtempSync(join(tmpdir(), 'dsh-autopilot-slow-')) })
    expect(opened).toBe(true)
    expect(rootSurface(bed)).toContain('autopilot_init')
  })
})

/* ══════════════════════════════════════════════════════════════════════════
 * §4  EXECUTOR-CHILD SETUP × a real scoped context
 *
 * `test/child-setup.test.ts` hands `createContinuableChildSetup` an object
 * literal with a `tools.register` spy. dsh hands it the child's unpublished
 * scoped `Context` (`ContinuableSetupContribution = (childCtx: Context) => ...`),
 * on which `agent` is an OWN property installed by `root.extend({ agent })` and
 * `tools.register` / `tools.guard` / `on('tools/pre-execute')` are the real
 * services. That difference is where the `childCtx.get('agent')` defect lived.
 * ══════════════════════════════════════════════════════════════════════════ */

describe('§4 the continuable child setup on a real cordis child context', () => {
  it('installs the packet tool into the child scope for an authorized executor', async () => {
    const mounted = await mountRuntime()
    const root = structuralAgent('boundary-root')
    const agents = new Map<string, AgentRef>([[root.id, root]])
    let childId = ''
    const subagents = {
      async start() {
        const auditor = structuralAgent('boundary-auditor', root.id)
        agents.set(auditor.id, auditor)
        return {
          id: auditor.id,
          localAgent: auditor,
          result: Promise.resolve({ output: [], stopReason: 'completed', structured: { verdict: 'pass', note: 'ok' } }),
          async dispose() {},
        }
      },
      async startContinuable(spec: { childId: string }) {
        childId = spec.childId
        agents.set(spec.childId, structuralAgent(spec.childId, root.id))
        return {}
      },
      async sendMessage() { return 'scripted-message' },
      interrupt() {},
      async drainContinuableChildren() { return {} },
    }
    const engine = makeEngine(subagents, agents)
    await engine.init(root, {
      ...BASE_TRIAGE, risk: 'medium', size: 'standard',
      executionMode: 'delegated', auditMode: 'independent',
    }, [{ id: 'm1', usageClass: 'undeclared', boundaryStates: [], artifacts: [], attempted: [] }])
    await engine.submitPlan(root, 'plan')
    await engine.declareUsage(root, { id: 'm1', usageClass: 'internal', boundaryStates: [], artifacts: [], attempted: [] })
    await engine.audit(root, { role: 'plan', prompt: 'audit packet' })
    await engine.startExecutor(root, { prompt: 'go', signal: new AbortController().signal })
    expect(childId).not.toBe('')

    const childAgent = agents.get(childId)
    const childKey = { id: childId }
    const scoped = await mintScope(mounted, childKey)
    // dsh publishes the child agent with `root.extend({ agent })` — an own
    // property, never `provide('agent', ...)`. That is precisely the shape the
    // old `childCtx.get('agent')` read could not see.
    const childCtx = (scoped as unknown as { extend(meta: object): Context }).extend({ agent: childAgent })

    const dispose = createContinuableChildSetup(engine, resolveConfig().gate)(childCtx as never)
    expect(mounted.ctx.tools.get('autopilot_submit_packet', childKey as never)).toBeDefined()
    dispose()
    expect(mounted.ctx.tools.get('autopilot_submit_packet', childKey as never)).toBeUndefined()
  })

  it('installs nothing for a context whose agent is not the authorized executor', async () => {
    const mounted = await mountRuntime()
    const root = structuralAgent('boundary-root')
    const engine = makeEngine({
      async start() { throw new Error('not used') },
      async startContinuable() { return {} },
      async sendMessage() { return 'scripted-message' },
      interrupt() {},
      async drainContinuableChildren() { return {} },
    }, new Map<string, AgentRef>([[root.id, root]]))
    const stranger = structuralAgent('boundary-stranger', root.id)
    const strangerKey = { id: stranger.id }
    const scoped = await mintScope(mounted, strangerKey)
    const childCtx = (scoped as unknown as { extend(meta: object): Context }).extend({ agent: stranger })
    createContinuableChildSetup(engine, resolveConfig().gate)(childCtx as never)
    expect(mounted.ctx.tools.get('autopilot_submit_packet', strangerKey as never)).toBeUndefined()
  })
})
