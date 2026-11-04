/**
 * BOUNDARY LAYER: the tests that cross into dsh instead of stopping at a mock.
 *
 * Every defect the first real-host run found sat at a seam a mock hides: the
 * lossless-JSON tool-output contract, the all-or-nothing `tools.restrict()`,
 * and the mount ordering of an async `apply`. This file imports the REAL
 * symbols and drives them.
 *
 * WHAT IS REAL: `Context` (cordis), `ToolRuntime` (the real registry, execute
 * pipeline and output validator), `snapshotJsonValue` (the real lossless-JSON
 * boundary), `SubagentRuntime` and `applyChildComposition` (dsh-subagent),
 * `SystemPrompt` and `createScope` (loaded by path from the dsh-tools peer tree).
 *
 * WHAT IS NOT: agents are structural stand-ins used as scope keys, and the dsh
 * global tool set is a list of name-faithful stand-ins transcribed from the
 * upstream `defineTool` call sites (`restrict()` validates names and never
 * touches a definition's body).
 *
 * `./helpers.js` is deliberately NOT imported: it is the mock layer whose blind
 * spots this file exists to cover.
 *
 * 0.3.0: the run tools are gone, so the output section drives the one remaining
 * tool; the tool-filter section checks the role allow-lists (`src/roles/tools.ts`)
 * against a real registry; the stage-2 dispatch adds its own cases here.
 */

import { describe, expect, it } from 'vitest'
import { createRequire } from 'node:module'
import { mkdtempSync, realpathSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { Context } from '@deepseek-ai/cordis'
import { ToolCallId } from '@deepseek-ai/dsh-llm'
import { snapshotJsonValue } from '@deepseek-ai/dsh-util-values'
import ToolRuntime from '@deepseek-ai/dsh-tools'
import SubagentRuntime, { NO_START_CAPABILITIES, applyChildComposition } from '@deepseek-ai/dsh-subagent'
import type { AgentRef } from '../src/engine.js'
import * as autopilotPlugin from '../src/index.js'
import { createAutopilotService } from '../src/service.js'
import { FileLedgerStore, emptyLedger, legacySourcesOf } from '../src/store/ledger.js'
import { allowListFor } from '../src/roles/tools.js'
import { ROLES } from '../src/roles/index.js'
import { installRootTools } from '../src/tools.js'
import type { DelegationRoleName } from '../src/domain/ledger-types.js'

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
 * the role allow-lists would make §2 circular and
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
  if (options.subagents === true) {
    // dsh 0.2.1-rc.2's SubagentRuntime injects `workingDirectory` and stays
    // inactive without it, which leaves `ctx.subagents` unset.
    raw.provide('workingDirectory', {
      async ensure() { return '/tmp' },
    })
    await raw.plugin(SubagentRuntime)
  }
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


/* ══════════════════════════════════════════════════════════════════════════
 * §1  TOOL OUTPUT × the real lossless-JSON boundary
 *
 * dsh validates every successful tool value with `snapshotJsonValue` and raises
 * `INVALID_TOOL_OUTPUT` when it fails. An OWN property whose value is
 * `undefined` is NOT lossless JSON, so a body that spreads an absent field is a
 * runtime failure the model sees, invisible to a test that awaits `execute()`
 * and inspects the object.
 * ══════════════════════════════════════════════════════════════════════════ */

const LEDGER_NOW = '2026-11-04T00:00:00.000Z'

async function statusBed(withLedger: boolean) {
  const mounted = await mountRuntime()
  const root = structuralAgent('boundary-root')
  const ledgers = FileLedgerStore.open(mkdtempSync(join(tmpdir(), 'dsh-autopilot-boundary-')))
  if (withLedger) {
    // Optional ledger fields (goal, hostRestart, legacyRestores) are absent on a fresh ledger,
    // which is exactly the shape that would carry an own `undefined` if the body spread them.
    await ledgers.write(emptyLedger(root.id, LEDGER_NOW), 0)
  }
  const service = createAutopilotService({ ledgers, sources: legacySourcesOf(undefined), notes: () => ['one note'] })
  installRootTools(mounted.ctx.tools as never, service)
  return { mounted, root }
}

async function callStatus(bed: Awaited<ReturnType<typeof statusBed>>) {
  return await bed.mounted.ctx.tools.execute({
    signal: new AbortController().signal,
    callId: ToolCallId('boundary-autopilot_status'),
    name: 'autopilot_status',
    arguments: {},
    agent: bed.root as never,
  })
}

describe('§1 tool output crosses the real lossless-JSON validator', () => {
  it('UPSTREAM CANARY: an own property whose value is undefined is not lossless JSON', () => {
    // Pinned upstream contract, not a restatement of our own code: if dsh ever relaxed
    // this, every "must not emit undefined" assertion below would assert nothing.
    expect(snapshotJsonValue({ revision: 1, goal: undefined })).toBeUndefined()
    expect(snapshotJsonValue({ revision: 1 })).toEqual({ revision: 1 })
    expect(snapshotJsonValue({ nested: { goal: undefined } })).toBeUndefined()
  })

  it('autopilot_status on a session WITH a ledger returns a serializable value', async () => {
    const result = await callStatus(await statusBed(true))
    expect(result.isError).toBe(false)
    if (result.isError) return
    const value = result.value as { ledger: { sessionId: string; autoContinue: { available: boolean } }; notes: string[] }
    expect(value.ledger.sessionId).toBe('boundary-root')
    expect(value.notes).toEqual(['one note'])
  })

  it('autopilot_status on a session with NO ledger answers explicitly, with no refusal', async () => {
    const result = await callStatus(await statusBed(false))
    expect(result.isError).toBe(false)
    if (result.isError) return
    expect(result.value).toEqual({
      sessionId: 'boundary-root',
      storeKind: 'file',
      ledger: null,
      legacyRuns: [],
      notes: ['one note'],
    })
  })

  it('the registered surface is exactly autopilot_status: no retired tool is registered', async () => {
    const bed = await statusBed(false)
    expect(bed.mounted.ctx.tools.schemas().map(schema => schema.name)).toEqual(['autopilot_status'])
  })
})

/* ══════════════════════════════════════════════════════════════════════════
 * §2  role allow-lists × the real registry
 *
 * `restrict()` throws on any name outside the scope's INHERITED surface and is
 * all-or-nothing, so one name the deployment does not register takes the whole
 * dispatch with it. The lists below come from `allowListFor`, the one place the
 * plugin builds them, and are pushed through dsh's own `applyChildComposition`.
 * ══════════════════════════════════════════════════════════════════════════ */

interface ChildBed {
  readonly ctx: Context & { tools: ToolRuntime }
  readonly childCtx: Context
  readonly childKey: object
}

/** A real registry holding the real dsh global names, plus a real child scope. */
async function childBed(names: readonly string[] = DSH_GLOBAL_TOOL_NAMES): Promise<ChildBed> {
  const mounted = await mountRuntime()
  for (const name of names) mounted.ctx.tools.register(standInTool(name) as never)
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

const registeredNames = (): readonly string[] => DSH_GLOBAL_TOOL_NAMES

describe('§2 role allow-lists against a real registry', () => {
  it('negative control: restrict() refuses a name the registry does not know', async () => {
    // Without this the assertions below could all pass against a check with no teeth.
    // A FRESH bed per composition: `applyChildComposition` registers the
    // `subagent:delegation` prompt context, which a real child context accepts once.
    const rejected = await childBed()
    expect(() => { compose(rejected, { allow: ['read', 'definitely_not_a_dsh_tool'] }) })
      .toThrowError(/unknown global tool "definitely_not_a_dsh_tool"/)
    const accepted = await childBed()
    expect(() => { compose(accepted, { allow: ['read'] }) }).not.toThrow()
    expect(visibleToChild(accepted)).toEqual(['read'])
  })

  it('UPSTREAM CANARY: ask_user_question is not restrictable on the headless profile', async () => {
    const bed = await childBed(DSH_GLOBAL_TOOL_NAMES.filter(name => name !== 'ask_user_question'))
    expect(() => { compose(bed, { allow: ['read', 'ask_user_question'] }) })
      .toThrowError(/names unknown global tool "ask_user_question"/)
  })

  for (const role of Object.keys(ROLES) as DelegationRoleName[]) {
    it(`the ${role} allow-list, narrowed against the registry, is accepted verbatim by the real restrict()`, async () => {
      const allow = allowListFor(role, registeredNames())
      if (allow === 'inherit') return
      const bed = await childBed()
      expect(() => { compose(bed, { allow: [...allow] }) }).not.toThrow()
      // Everything the role is allowed that the registry holds is visible; nothing else is.
      expect(visibleToChild(bed)).toEqual([...allow].filter(name => DSH_GLOBAL_TOOL_NAMES.includes(name)).sort())
    })
  }

  it('a read-only role never sees a write or shell tool', async () => {
    for (const role of ['scout', 'reviewer', 'planner'] as const) {
      const allow = allowListFor(role, registeredNames())
      expect(allow).not.toBe('inherit')
      const bed = await childBed()
      compose(bed, { allow: [...(allow as readonly string[])] })
      const seen = visibleToChild(bed)
      for (const forbidden of ['write', 'edit', 'str_replace_editor', 'bash', 'pwsh']) expect(seen).not.toContain(forbidden)
    }
  })

  it('a child-scoped tool survives the restriction without being named in it', async () => {
    // An own-layer registration is exempt from the filter, so a tool the plugin adds to a
    // child's own scope stays visible while every inherited tool is masked to the allow-list.
    const bed = await childBed()
    ;(bed.childCtx as unknown as { tools: ToolRuntime }).tools.register(standInTool('child_scoped_probe') as never)
    compose(bed, { allow: ['read', 'grep'] })
    expect(visibleToChild(bed)).toEqual(['child_scoped_probe', 'grep', 'read'])
    expect(bed.ctx.tools.get('bash', bed.childKey as never)).toBeUndefined()
  })

  it('a provider without the toolFilter capability refuses the dispatch outright', async () => {
    // A DEPLOYMENT ceiling rather than a code defect, pinned so it cannot be
    // rediscovered on a host. The review goes through
    // `startActivation`, which still names `outputSchema` and `maxDepth`.
    // `toolFilter` is no longer a start argument (the plugin applies it on
    // `agent/created`). `assertCapabilities` rejects the whole start when the
    // provider advertises none of those capabilities
    // (`NO_START_CAPABILITIES` — every out-of-process backend).
    const mounted = await mountRuntime({ subagents: true })
    let started = 0
    mounted.ctx.subagents.registerProvider({
      name: 'out-of-process',
      capabilities: NO_START_CAPABILITIES,
      start: (async () => { started += 1; throw new Error('unreachable') }) as never,
    } as never)
    await expect(mounted.ctx.subagents.startActivation({
      provider: 'out-of-process',
      label: 'reviewer',
      request: {
        prompt: [{ type: 'text', text: 'packet' }],
        parent: structuralAgent('boundary-root') as never,
        outputSchema: { type: 'object', properties: {} },
        maxDepth: 1,
      },
      signal: new AbortController().signal,
      delivery: 'caller',
    } as never)).rejects.toThrowError(/does not support the "outputSchema" capability/)
    expect(started).toBe(0)
  })
})
/* ══════════════════════════════════════════════════════════════════════════
 * §3  MOUNT ORDERING × a real cordis Context
 *
 * `apply()` must hold the fiber open until the ledger store has opened: cordis
 * awaits an async `apply` but not an async effect body, so on a deployment whose
 * `ctx.storageDomain` resolves on a real I/O turn the plugin would otherwise
 * report mounted while its tools and service were still absent.
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
  mounted.provide('subagents', {})
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
    expect(rootSurface(bed)).toEqual(['autopilot_agents', 'autopilot_delegate', 'autopilot_status'])
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
    expect(rootSurface(bed)).toEqual(['autopilot_agents', 'autopilot_delegate', 'autopilot_status'])
  })
})

/* ══════════════════════════════════════════════════════════════════════════
 * §4  role allow-lists × a PRESET composition (the desktop / web-app shape)
 *
 * dsh-web-app 0.2.1-rc.5 disables `tool-fs`, `tool-fs-search` and `tool-bash`
 * on the host plane (`dsh-web-app/cordis.patch.yml`, rows `tool-fs` /
 * `tool-fs-search` / `tool-bash`: `disabled: true`) and mounts them again inside
 * each agent preset (`presets/standard.patch.yml`). A preset registers into its
 * generation's scope layer, and an agent joins that generation through
 * `bindScopeParent` (`dsh-agent-preset-registry` `join`); a delegated child joins
 * the parent's generation the same way (`dsh-subagent` `applyChildComposition`
 * → `composeFrom`). So on that composition `read` is NOT in the global layer:
 * `tools.schemas()` without a scope never lists it, while `tools.schemas(agent)`
 * and the child's `restrict()` both see it through the scope chain.
 *
 * The headless profile registers the same tools globally, which is why the
 * unscoped probe passed there and refused every scout and reviewer on the
 * desktop app with "this deployment does not register "read"".
 * ══════════════════════════════════════════════════════════════════════════ */

const bindScopeParent = (await loadFromDshTools('@deepseek-ai/dsh-scope'))['bindScopeParent'] as
  (key: unknown, parent: unknown) => unknown
const createScopeWithParent = (await loadFromDshTools('@deepseek-ai/dsh-scope'))['createScope'] as
  (ctx: unknown, key: unknown, options?: { parent?: unknown }) => { ctx: Context }

/** The model-facing tools a `standard` preset mounts (tool-fs, tool-fs-search, tool-bash, tool-web). */
const PRESET_TOOL_NAMES: readonly string[] = ['read', 'read_image', 'write', 'edit', 'glob', 'grep', 'bash', 'web_search', 'web_fetch']

interface PresetBed {
  readonly mounted: Mounted
  readonly root: StructuralAgent
  readonly childKey: object
  readonly childCtx: Context
}

/**
 * A real registry shaped like the web-app composition: one host-plane global
 * tool, the preset's tools in a generation scope, and a root agent and a child
 * that both join that generation.
 */
async function presetBed(presetNames: readonly string[] = PRESET_TOOL_NAMES): Promise<PresetBed> {
  const mounted = await mountRuntime()
  mounted.ctx.tools.register(standInTool('ask_user_question') as never)
  const generation = { id: 'preset-standard-generation' }
  const root = structuralAgent('preset-root')
  const childKey = { id: 'preset-child' }
  let childCtx: Context | undefined
  await mounted.plugin(Object.assign(
    (inner: Context) => {
      const presetCtx = createScopeWithParent(inner, generation).ctx as unknown as { tools: ToolRuntime }
      for (const name of presetNames) presetCtx.tools.register(standInTool(name) as never)
      ;(root as unknown as Record<string, unknown>)['ctx'] = createScopeWithParent(inner, root, { parent: generation }).ctx
      childCtx = createScopeWithParent(inner, childKey).ctx
      bindScopeParent(childKey, generation)
    },
    { inject: ['tools', 'systemPrompt'] },
  ))
  if (childCtx === undefined) throw new Error('preset scope minting did not run')
  return { mounted, root, childKey, childCtx }
}

describe('§4 role allow-lists against a preset composition', () => {
  it('UPSTREAM CANARY: preset tools are absent from the global view and present in the agent view', async () => {
    const bed = await presetBed()
    const globalNames = bed.mounted.ctx.tools.schemas().map(schema => schema.name)
    const rootNames = bed.mounted.ctx.tools.schemas(bed.root as never).map(schema => schema.name)
    expect(globalNames).toEqual(['ask_user_question'])
    expect(rootNames).toContain('read')
    expect(rootNames).toContain('ask_user_question')
  })

  it('the probe reads the calling agent\'s scope, so a scout resolves and the child accepts its list', async () => {
    const bed = await presetBed()
    const registered = autopilotPlugin.registeredToolNamesOf(bed.mounted.ctx, bed.root)
    expect(registered).toContain('read')
    for (const role of ['scout', 'reviewer', 'planner', 'clerk'] as const) {
      const allow = allowListFor(role, registered)
      expect(allow).not.toBe('inherit')
      const fresh = await presetBed()
      applyChildComposition(fresh.childCtx, { ctx: undefined } as never, { toolFilter: { allow: [...(allow as readonly string[])] } as never })
      const visible = fresh.mounted.ctx.tools.schemas(fresh.childKey as never).map(schema => schema.name).sort()
      expect(visible).toContain('read')
      expect(visible).toEqual([...(allow as readonly string[])].sort())
    }
  })

  it('a preset that really lacks read still refuses the scout and names read', async () => {
    const bed = await presetBed(PRESET_TOOL_NAMES.filter(name => name !== 'read'))
    const registered = autopilotPlugin.registeredToolNamesOf(bed.mounted.ctx, bed.root)
    expect(registered).not.toContain('read')
    expect(() => allowListFor('scout', registered)).toThrowError(/does not register "read"/)
  })

  for (const role of ['scout', 'reviewer'] as const) {
    it(`autopilot_delegate(${role}) through the mounted plugin is not refused for read`, async () => {
      const bed = await presetBed()
      bed.mounted.provide('agents', { get: () => undefined, list: () => [bed.root], roots: () => [bed.root] })
      bed.mounted.provide('subagents', {})
      await bed.mounted.plugin(autopilotPlugin, { storeRoot: mkdtempSync(join(tmpdir(), 'dsh-autopilot-preset-')) })
      openDirectHumanTurn(bed.root)
      const result = await bed.mounted.ctx.tools.execute({
        signal: new AbortController().signal,
        callId: ToolCallId(`boundary-preset-${role}`),
        name: 'autopilot_delegate',
        arguments: { role, task: 'list the callers of parse()' },
        agent: bed.root as never,
      })
      const text = JSON.stringify(result)
      expect(text).not.toMatch(/does not register/)
      expect(text).not.toMatch(/AP_TOOL_SURFACE_INCOMPLETE/)
    })
  }
})
