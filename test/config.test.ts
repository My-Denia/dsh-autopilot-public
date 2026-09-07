/**
 * The declared `Config` schema, exercised through the REAL loader path.
 *
 * WHY this file exists at all: every other test in this suite builds config as
 * a plain object and hands it straight to `resolveConfig`. cordis does not —
 * it runs `runtime.Config['~standard'].validate(config)` and passes the
 * DEFAULTED result to `apply()` (`vendor/cordis/src/fiber.ts`). Those are two
 * different inputs, and a defect that lives only in the difference is a defect
 * the whole suite is structurally unable to observe. So the assertions below
 * drive `resolveConfig(Config['~standard'].validate(x).value)` — the shape a
 * deployment actually gets — and never a hand-built object.
 */

import { describe, expect, it } from 'vitest'
import { Config, DEFAULT_EXECUTOR_TOOLS } from '../src/config.js'
import { SHELL_TOOLS, isEgressCommand } from '../src/gate/decide.js'
import { resolveConfig } from '../src/index.js'
import type { ConfigInput } from '../src/index.js'

/** Run one raw profile fragment through the loader exactly as cordis would. */
function loaded(raw: unknown): { value?: ConfigInput; issues?: readonly { message: string }[] } {
  return Config['~standard'].validate(raw) as never
}

describe('Config — the loader path', () => {
  it('hands the engine the real executor tool allow-list, not an empty one', () => {
    const result = loaded({ auditProvider: 'spawn' })
    expect(result.issues).toBeUndefined()
    const viaLoader = resolveConfig(result.value).executor.toolAllowList

    // Asserted BY VALUE against the shared constant rather than a count, so
    // adding a tool to the default surface cannot silently move this anchor.
    expect(viaLoader).toEqual([...DEFAULT_EXECUTOR_TOOLS])
    // The failing shape this test exists to catch: a schema default of []
    // survives `?? DEFAULT_EXECUTOR_TOOLS` and leaves the executor child with
    // nothing but its packet tool.
    expect(viaLoader.length).toBeGreaterThan(0)
    expect(viaLoader).toContain('read')
    expect(viaLoader).toContain('write')
    expect(viaLoader).toContain('bash')
  })

  it('agrees with the plain-object path the rest of the suite uses, FIELD FOR FIELD', () => {
    // This used to compare `.executor.toolAllowList` alone and was therefore
    // structurally unable to observe the divergence it exists to catch:
    // schemastery's `Schema.object({...})` defaults to `{}` rather than
    // `undefined`, so the loader produced `auditors.plan = { agentOptions: {} }`
    // and `executor.agentOptions = {}` where the plain path produced
    // `undefined` — and the engine's `...(agentOptions === undefined ? {} :
    // { agentOptions })` then sent `agentOptions: {}` to `subagents.start` on
    // every REAL deployment while every test in this suite omitted the key.
    // Deep equality over the whole ResolvedConfig is what makes the class of
    // defect unrepresentable rather than this one instance of it.
    expect(resolveConfig(loaded({}).value)).toEqual(resolveConfig({}))
    expect(resolveConfig(loaded({}).value)?.skillInstall).toBe('auto')
  })

  it('an empty nested object is ABSENT on both paths, so nothing reaches subagents.start', () => {
    const viaLoader = resolveConfig(loaded({}).value)
    expect(viaLoader.executor.agentOptions).toBeUndefined()
    expect('agentOptions' in viaLoader.executor).toBe(false)
    expect(viaLoader.auditors).toEqual({})
    // DETECTOR: a route that carries actual routing survives, on both paths.
    const routed = resolveConfig(loaded({ auditors: { plan: { agentOptions: { provider: 'p', model: 'm' } } } }).value)
    expect(routed.auditors.plan?.agentOptions).toEqual({ provider: 'p', model: 'm' })
    expect(routed.auditors.execution).toBeUndefined()
  })

  it('still honours an explicitly empty allow-list (the default is a default, not a floor)', () => {
    const result = loaded({ executor: { toolAllowList: [] } })
    expect(result.issues).toBeUndefined()
    expect(resolveConfig(result.value).executor.toolAllowList).toEqual([])
  })

  it('accepts a fully specified profile (positive control for every negative below)', () => {
    const result = loaded({
      auditProvider: 'spawn',
      executorProvider: 'spawn',
      auditors: { plan: { agentOptions: { provider: 'deepseek-official', model: 'deepseek-v4-pro' } } },
      executor: { persona: 'lead', toolAllowList: ['read', 'write'] },
      gate: { egressDeny: true, restoreMode: 'workspace-write' },
      storeKind: 'file',
      storeRoot: '/tmp/runs',
      skillInstall: 'off',
    })
    expect(result.value?.skillInstall).toBe('off')
    expect(result.issues).toBeUndefined()
    expect(result.value?.storeKind).toBe('file')
  })

  it('REFUSES an unknown top-level key and names it', () => {
    const result = loaded({ storeKindd: 'domain' })
    // The exact failure the schema was introduced to eliminate: a typo that
    // silently defaults storeKind back to 'auto'.
    expect(result.issues?.length ?? 0).toBeGreaterThanOrEqual(1)
    expect(result.issues?.some(issue => issue.message.includes('storeKindd'))).toBe(true)
    expect(result.value).toBeUndefined()
  })

  it('REFUSES an unknown NESTED key and names its path', () => {
    const result = loaded({ gate: { egresDeny: false } })
    expect(result.issues?.some(issue => issue.message.includes('gate.egresDeny'))).toBe(true)
  })

  it('still rejects a value outside the storeKind enum', () => {
    const bogus = 'sqlite'
    // In-place assertion that the fixture is still outside the accepted set.
    expect(['auto', 'file', 'domain']).not.toContain(bogus)
    const result = loaded({ storeKind: bogus })
    expect(result.issues?.some(issue => issue.message.includes('storeKind'))).toBe(true)
  })

  it('still rejects a wrongly typed gate flag', () => {
    const result = loaded({ gate: { toolDeny: 'yes' } })
    expect(result.issues?.some(issue => issue.message.includes('toolDeny'))).toBe(true)
  })
})

/**
 * DEFAULT_EXECUTOR_TOOLS is the delegated executor child's tool allow-list.
 *
 * The loader test above asserts `viaLoader` equals `[...DEFAULT_EXECUTOR_TOOLS]`
 * — i.e. it compares the loader's output against the very constant it is
 * supposed to pin, so the list was unguarded in BOTH directions. Measured:
 * appending 'web_fetch','network_post' left the suite green, and dropping
 * 'glob','grep','read_image' left it green too. The ADDITIVE direction is the
 * security-relevant one — a harness whose purpose is owner-only egress control
 * must be able to observe a delegated child being granted network-capable tools
 * by default.
 */
describe('DEFAULT_EXECUTOR_TOOLS is pinned by value, in both directions', () => {
  it('is exactly this list, stated as a literal', () => {
    expect([...DEFAULT_EXECUTOR_TOOLS]).toEqual([
      'read', 'glob', 'grep', 'read_image',
      'write', 'edit', 'str_replace_editor',
      'bash', 'pwsh',
      'todo_write',
    ])
    expect(DEFAULT_EXECUTOR_TOOLS.length).toBe(10)
  })

  it('grants no tool that names an egress-capable transport', () => {
    // A name-shaped floor rather than a second copy of the list: an entry whose
    // NAME advertises the network is refused even if someone adds it "just for
    // this one deployment".
    const networkish = /fetch|http|curl|wget|network|upload|publish|webhook|browser|request/i
    for (const tool of DEFAULT_EXECUTOR_TOOLS) {
      expect(networkish.test(tool)).toBe(false)
    }
    // DETECTOR: the pattern is not vacuous.
    expect(networkish.test('web_fetch')).toBe(true)
    expect(networkish.test('network_post')).toBe(true)
  })

  it('no longer grants run_terminal, and does not substitute the real PTY names', () => {
    // `run_terminal` is defined by NO dsh package — it existed only in the v1
    // tool-gah plugin — so the entry granted nothing while documenting a
    // surface that does not exist. Removing it is the fail-closed repair;
    // substituting terminal_* would GRANT a capability the child never had.
    expect(DEFAULT_EXECUTOR_TOOLS).not.toContain('run_terminal')
    for (const tool of ['terminal_open', 'terminal_send', 'terminal_read', 'terminal_signal', 'terminal_close']) {
      expect(DEFAULT_EXECUTOR_TOOLS).not.toContain(tool)
    }
    // The GATE went the other way: it scans the terminal channel it cannot allow.
    expect(SHELL_TOOLS).toContain('terminal_send')
    expect(isEgressCommand('git push origin main')).toBe(true)
    // The shell the executor DOES get is still the shell the gate scans.
    expect(DEFAULT_EXECUTOR_TOOLS.filter(tool => SHELL_TOOLS.includes(tool))).toEqual(['bash', 'pwsh'])
  })
})


/**
 * THE SHELL PAIR — the FIX 2 defect class asked about `bash`, which is not
 * registered on Windows.
 *
 * The base bundle splits one capability across two names by platform:
 * `tool-bash` carries `disabled: process.platform === 'win32'` and `tool-pwsh`
 * carries `disabled: process.platform !== 'win32'`
 * (`packages/bundle/base/cordis.patch.yml`). So on any given host exactly one of
 * them is registered and the other is INERT — which is a different thing from
 * `run_terminal`, which was defined by no dsh package on any platform and was
 * therefore DEAD.
 *
 * That difference decides the repair. An allow-list is a filter over tools the
 * host already registered: naming a tool the deployment does not have grants
 * nothing, while OMITTING one it does have leaves the delegated executor with no
 * shell at all — the same "the child starts with nothing" failure the shared
 * `DEFAULT_EXECUTOR_TOOLS` constant exists to prevent, only conditioned on the
 * host OS instead of on the config path. So both names stay, and the tests below
 * state the platform rule rather than the literal list, so a "fix" that deletes
 * the half that looks unused on the machine it was written on goes red.
 */
describe('DEFAULT_EXECUTOR_TOOLS: the platform shell pair', () => {
  /** The base bundle's own rule, restated as data. */
  const SHELL_FOR_PLATFORM = { win32: 'pwsh', other: 'bash' } as const

  it('grants the shell that IS registered, on every platform dsh ships a shell tool for', () => {
    for (const shell of Object.values(SHELL_FOR_PLATFORM)) {
      expect(DEFAULT_EXECUTOR_TOOLS).toContain(shell)
    }
    // Including the one this test process is running on, resolved by the same
    // predicate the bundle rows use.
    expect(DEFAULT_EXECUTOR_TOOLS)
      .toContain(SHELL_FOR_PLATFORM[process.platform === 'win32' ? 'win32' : 'other'])
  })

  it('grants that pair and nothing else as a shell', () => {
    expect(DEFAULT_EXECUTOR_TOOLS.filter(tool => SHELL_TOOLS.includes(tool))).toEqual(['bash', 'pwsh'])
  })

  it('every shell-shaped entry it grants is one the gate SCANS', () => {
    // The security floor behind keeping a two-name shell surface: a shell the
    // allow-list grants but `decideTool` does not scan is an egress channel with
    // no boundary on it. Name-shaped, like the networkish floor above, so a name
    // added "just for this one deployment" is caught rather than a list copied.
    const shellish = /^(bash|sh|zsh|ksh|fish|dash|pwsh|powershell|cmd|command|run_code|exec|shell|terminal)/i
    for (const tool of DEFAULT_EXECUTOR_TOOLS) {
      if (shellish.test(tool)) expect(SHELL_TOOLS).toContain(tool)
    }
    // DETECTOR: the pattern matches the shells it is meant to and not the rest.
    expect(shellish.test('bash')).toBe(true)
    expect(shellish.test('pwsh')).toBe(true)
    expect(shellish.test('zsh')).toBe(true)
    expect(shellish.test('read')).toBe(false)
    expect(shellish.test('str_replace_editor')).toBe(false)
    // and a shell the gate does NOT scan would fail the loop above.
    expect(SHELL_TOOLS).not.toContain('zsh')
  })

  it('names only tools some dsh package actually defines', () => {
    // Verified against the upstream registrations (2026-08-25): read/write/edit/
    // read_image `packages/fs/tool-fs`, glob/grep `packages/fs/tool-fs-search`,
    // str_replace_editor `packages/fs/tool-str-replace-editor`, todo_write
    // `packages/todo/tool-todo`, bash `packages/shell/tool-bash`, pwsh
    // `packages/shell/tool-pwsh`. The list is pinned by value one describe above;
    // this states what that pin MEANS, which is the thing `run_terminal` failed.
    expect([...DEFAULT_EXECUTOR_TOOLS].sort()).toEqual([
      'bash', 'edit', 'glob', 'grep', 'pwsh', 'read', 'read_image',
      'str_replace_editor', 'todo_write', 'write',
    ])
  })
})
