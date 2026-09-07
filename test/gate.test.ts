/**
 * Gate decision matrix. Assertions are on the exact decision KIND
 * (CC Checker-Resolution lesson: never collapse an N-valued outcome to a
 * boolean; exercise each value at least once).
 */

import { describe, expect, it } from 'vitest'
import {
  EGRESS_FAIL_CLOSED_REASON,
  SHELL_TOOLS,
  commandTextOf,
  decideTool,
  egressCommandOf,
  egressScanModeOf,
  egressSegments,
  isEgressCommand,
} from '../src/gate/decide.js'
import type { GateConfig } from '../src/gate/decide.js'
import { makeSnapshot } from './helpers.js'

/** Default matrix runs with the native seam installed, so the guard defers on egress. */
const CONFIG: GateConfig = { toolDeny: true, egressDeny: true, strictShell: false, egressSeam: 'native-ask' }

/** The fail-closed fallback: no pre-execute seam, so the guard owns egress alone. */
const GUARD_ONLY: GateConfig = { ...CONFIG, egressSeam: 'guard-deny' }

function standardPrePlan(sandbox: 'active' | 'degraded' | 'off' = 'active') {
  return makeSnapshot(
    { enforcement: { sandbox, reminders: 0, ownerApprovals: [] } },
    { size: 'standard', risk: 'medium', auditMode: 'independent' },
  )
}

describe('decideTool', () => {
  it('allows everything when no run exists', () => {
    expect(decideTool(undefined, 'write', {}, CONFIG).kind).toBe('allow')
  })

  it('allows everything after a terminal phase', () => {
    const done = makeSnapshot({ phase: 'blocked' }, { size: 'standard', risk: 'medium', auditMode: 'independent' })
    expect(decideTool(done, 'write', {}, CONFIG).kind).toBe('allow')
  })

  it('denies write/edit pre-plan-gate on standard runs', () => {
    expect(decideTool(standardPrePlan(), 'write', {}, CONFIG).kind).toBe('deny-plan-gate')
    expect(decideTool(standardPrePlan(), 'edit', {}, CONFIG).kind).toBe('deny-plan-gate')
  })

  it('allows str_replace_editor view but denies mutating commands pre-plan-gate', () => {
    expect(decideTool(standardPrePlan(), 'str_replace_editor', { command: 'view' }, CONFIG).kind).toBe('allow')
    expect(decideTool(standardPrePlan(), 'str_replace_editor', { command: 'create' }, CONFIG).kind).toBe('deny-plan-gate')
  })

  it('does not clamp lightweight runs (CC parity)', () => {
    const lightweight = makeSnapshot() // defaults: lightweight/low/self-check
    expect(decideTool(lightweight, 'write', {}, CONFIG).kind).toBe('allow')
  })

  it('allows shell pre-plan-gate when the OS sandbox holds read-only', () => {
    expect(decideTool(standardPrePlan('active'), 'bash', { command: 'git status' }, CONFIG).kind).toBe('allow')
  })

  it('degrades honestly when sandbox coupling failed and strictShell is off', () => {
    const decision = decideTool(standardPrePlan('degraded'), 'bash', { command: 'git status' }, CONFIG)
    expect(decision.kind).toBe('allow-degraded')
  })

  it('denies shell pre-plan-gate under strictShell when the sandbox is unavailable', () => {
    const strict: GateConfig = { ...CONFIG, strictShell: true }
    const decision = decideTool(standardPrePlan('off'), 'pwsh', { command: 'git status' }, strict)
    expect(decision.kind).toBe('deny-plan-gate')
  })

  it('allows mutations after the plan gate passes', () => {
    const passed = makeSnapshot(
      { planGate: 'pass', phase: 'executing' },
      { size: 'standard', risk: 'medium', auditMode: 'independent' },
    )
    expect(decideTool(passed, 'write', {}, CONFIG).kind).toBe('allow')
    expect(decideTool(passed, 'bash', { command: 'pnpm test' }, CONFIG).kind).toBe('allow')
  })

  it('defers egress to the native seam when it is installed, in ANY non-terminal phase', () => {
    const passed = makeSnapshot(
      { planGate: 'pass', phase: 'executing' },
      { size: 'standard', risk: 'medium', auditMode: 'independent' },
    )
    // Asserted by VALUE, not as a plain allow: 'defer-egress' proves the guard
    // recognised the egress and stood down, where 'allow' would also be
    // returned by a matcher that simply failed to fire.
    expect(decideTool(passed, 'bash', { command: 'git push origin main' }, CONFIG).kind).toBe('defer-egress')
    // Lightweight runs are equally bound by owner boundaries.
    const light = makeSnapshot()
    expect(decideTool(light, 'bash', { command: 'gh pr create --title x' }, CONFIG).kind).toBe('defer-egress')
  })

  it('denies egress unconditionally when the native seam is NOT installed (fail-closed fallback)', () => {
    const passed = makeSnapshot(
      { planGate: 'pass', phase: 'executing' },
      { size: 'standard', risk: 'medium', auditMode: 'independent' },
    )
    expect(decideTool(passed, 'bash', { command: 'git push origin main' }, GUARD_ONLY).kind).toBe('deny-egress')
    // DELIBERATE BEHAVIOR CHANGE vs v1: v1 allowed this once an owner approval
    // existed and consumed it synchronously. v2's guard fallback cannot read or
    // validate an outbound manifest, so a stored approval no longer opens it.
    const approved = makeSnapshot(
      {
        planGate: 'pass',
        phase: 'executing',
        enforcement: {
          sandbox: 'off',
          reminders: 0,
          ownerApprovals: [{ seq: 0, target: 'push the release branch', grantedAtRevision: 3 }],
        },
      },
      { size: 'standard', risk: 'medium', auditMode: 'independent' },
    )
    expect(decideTool(approved, 'bash', { command: 'git push origin main' }, GUARD_ONLY).kind).toBe('deny-egress')
  })

  it('the master switch turns the boundary off entirely', () => {
    const off: GateConfig = { ...CONFIG, egressDeny: false, egressSeam: 'off' }
    const light = makeSnapshot()
    expect(decideTool(light, 'bash', { command: 'git push origin main' }, off).kind).toBe('allow')
  })

  it('scans run_code code text for egress', () => {
    const light = makeSnapshot()
    expect(decideTool(light, 'run_code', { code: 'await $`git push origin main`' }, CONFIG).kind).toBe('defer-egress')
    expect(decideTool(light, 'run_code', { code: 'await $`git push origin main`' }, GUARD_ONLY).kind).toBe('deny-egress')
  })

  describe('usage-declaration clamp', () => {
    function standardExecuting(usageClass: 'undeclared' | 'cli') {
      return makeSnapshot(
        {
          planGate: 'pass',
          phase: 'executing',
          usage: { entries: [{ id: 'm1', usageClass, boundaryStates: [], artifacts: [], attempted: [] }] },
        },
        { size: 'standard', risk: 'medium', auditMode: 'independent' },
      )
    }

    it('denies write/edit/str_replace_editor by KIND while an entry is undeclared', () => {
      expect(decideTool(standardExecuting('undeclared'), 'write', {}, CONFIG).kind).toBe('deny-usage-undeclared')
      expect(decideTool(standardExecuting('undeclared'), 'edit', {}, CONFIG).kind).toBe('deny-usage-undeclared')
      expect(decideTool(standardExecuting('undeclared'), 'str_replace_editor', { command: 'create' }, CONFIG).kind)
        .toBe('deny-usage-undeclared')
    })

    it('is a DIFFERENT denial from the plan gate, and names the undeclared ids', () => {
      const decision = decideTool(standardExecuting('undeclared'), 'write', {}, CONFIG)
      expect(decision.kind).toBe('deny-usage-undeclared')
      if (decision.kind !== 'deny-usage-undeclared') throw new Error('unreachable')
      expect(decision.reason).toContain('m1')
      expect(decision.reason).not.toContain('plan gate is')
    })

    it('positive control: the same call is allowed once the entry is declared', () => {
      expect(decideTool(standardExecuting('cli'), 'write', {}, CONFIG).kind).toBe('allow')
      // and reads were never clamped by this rule at all
      expect(decideTool(standardExecuting('undeclared'), 'str_replace_editor', { command: 'view' }, CONFIG).kind)
        .toBe('allow')
      expect(decideTool(standardExecuting('undeclared'), 'read', {}, CONFIG).kind).toBe('allow')
    })

    it('CLAMPS a lightweight run that acquired a usage dimension (the layers must agree)', () => {
      // This used to assert `allow`, on the premise that "lightweight runs
      // never carry a usage dimension at all". They can: `autopilot_usage` has
      // no size gate and `declareUsage` builds from `prior.usage?.entries ?? []`,
      // so a lightweight run CREATES one by declaring into it — after which the
      // ENGINE refuses the plan gate for an undeclared entry (the fold's rule is
      // size-blind) while this guard exempted every mutation by size. The two
      // layers disagreeing about one run is the defect; the clamp is now keyed
      // off the dimension both layers actually read.
      const light = makeSnapshot({
        usage: { entries: [{ id: 'm1', usageClass: 'undeclared', boundaryStates: [], artifacts: [], attempted: [] }] },
      })
      expect(light.triage.size).toBe('lightweight')
      expect(decideTool(light, 'write', {}, CONFIG).kind).toBe('deny-usage-undeclared')
      // Positive control on the same snapshot shape: declaring the entry lifts it.
      const declared = makeSnapshot({
        usage: { entries: [{ id: 'm1', usageClass: 'docs', boundaryStates: [], artifacts: [], attempted: [] }] },
      })
      expect(decideTool(declared, 'write', {}, CONFIG).kind).toBe('allow')
    })

    it('clamps SHELL too, not just the three write tool names', () => {
      // The plan-gate clamp above has always carried a SHELL_TOOLS branch; the
      // usage clamp had none, so a run holding an undeclared entry was refused
      // `write` and then mutated the same workspace through `bash`. Asserted
      // over every shell name, because the gap was invisible while only 'bash'
      // was ever exercised.
      const strict: GateConfig = { ...CONFIG, strictShell: true }
      for (const tool of ['bash', 'pwsh', 'terminal_open']) {
        expect(decideTool(standardExecuting('undeclared'), tool, { command: 'rm -rf src' }, strict).kind)
          .toBe('deny-usage-undeclared')
      }
      expect(decideTool(standardExecuting('undeclared'), 'run_code', { code: 'fs.rmSync("src")' }, strict).kind)
        .toBe('deny-usage-undeclared')
      expect(decideTool(standardExecuting('undeclared'), 'terminal_send', { sessionId: 's', text: 'rm -rf src' }, strict).kind)
        .toBe('deny-usage-undeclared')
      // DETECTOR that the matrix can still say something else about shell:
      // declared -> allow, and an OS sandbox holding the session read-only is
      // already the enforcement this clamp is asking for.
      expect(decideTool(standardExecuting('cli'), 'bash', { command: 'rm -rf src' }, strict).kind).toBe('allow')
    })

    it('mirrors the plan gate ladder for shell: sandbox active allows, no strictShell degrades honestly', () => {
      const undeclaredWithSandbox = makeSnapshot(
        {
          planGate: 'pass',
          phase: 'executing',
          enforcement: { sandbox: 'active', reminders: 0, ownerApprovals: [] },
          usage: { entries: [{ id: 'm1', usageClass: 'undeclared', boundaryStates: [], artifacts: [], attempted: [] }] },
        },
        { size: 'standard', risk: 'medium', auditMode: 'independent' },
      )
      expect(decideTool(undeclaredWithSandbox, 'bash', { command: 'ls' }, { ...CONFIG, strictShell: true }).kind)
        .toBe('allow')
      const degraded = decideTool(standardExecuting('undeclared'), 'bash', { command: 'ls' }, CONFIG)
      expect(degraded.kind).toBe('allow-degraded')
      if (degraded.kind !== 'allow-degraded') throw new Error('unreachable')
      expect(degraded.note).toContain('undeclared usage')
      // The write clamp stays absolute in exactly the same snapshot.
      expect(decideTool(undeclaredWithSandbox, 'write', {}, CONFIG).kind).toBe('deny-usage-undeclared')
    })

    it('exempts a legacy stream that has no usage dimension at all', () => {
      const legacy = makeSnapshot(
        { planGate: 'pass', phase: 'executing' },
        { size: 'standard', risk: 'medium', auditMode: 'independent' },
      )
      expect(legacy.usage).toBeUndefined()
      expect(decideTool(legacy, 'write', {}, CONFIG).kind).toBe('allow')
    })
  })

  it('leaves non-egress shell untouched by the egress branch', () => {
    const light = makeSnapshot()
    expect(decideTool(light, 'bash', { command: 'git status && git log' }, CONFIG).kind).toBe('allow')
  })

  it('denies send_message/interrupt_agent targeting the authorized executor (single control loop)', () => {
    const withExecutor = makeSnapshot(
      {
        planGate: 'pass',
        phase: 'executing',
        executor: {
          childId: 'child-uuid-1234',
          generation: 1,
          executionRevision: 1,
          state: 'running',
          route: { provider: 'spawn', routeProvider: 'p', routeModel: 'm', routeStatus: 'verified' },
        },
      },
      { size: 'standard', risk: 'medium', auditMode: 'independent', executionMode: 'delegated' },
    )
    expect(decideTool(withExecutor, 'send_message', { agentId: 'child-uuid-1234', text: 'do more work' }, CONFIG).kind)
      .toBe('deny-executor-bypass')
    expect(decideTool(withExecutor, 'interrupt_agent', { sessionId: 'child-uuid-1234' }, CONFIG).kind)
      .toBe('deny-executor-bypass')
    // Messaging OTHER children stays allowed; only the authorized executor is fenced.
    expect(decideTool(withExecutor, 'send_message', { agentId: 'some-other-child', text: 'hi' }, CONFIG).kind)
      .toBe('allow')
  })
})

describe('isEgressCommand', () => {
  const positives = [
    'git push origin main',
    'git add . && git commit -m x && git push',
    'gh pr create --title "t"',
    'gh release create v1.0.0',
    'gh api repos/o/r/issues -X POST',
    'npm publish',
    'pnpm publish --access public',
    'git send-email patch.mbox',
    // Evasions INSIDE channels the pattern list already enumerates, measured
    // 2026-08-24 as passing through. `gh api` switches to POST implicitly the
    // moment a field/body flag is present, so an explicit -X was never needed.
    'gh api -f a=b /repos/o/r/issues',
    'gh api --input body.json /repos/o/r/pulls',
    'gh api graphql -f query=mutation',
    'gh workflow run deploy.yml',
    'gh secret set NPM_TOKEN',
    'gh variable set REGION',
    // A shell line continuation split one genuine command across the `\n` the
    // git pattern deliberately excludes from its gap.
    'git -C repo \\\n  push origin main',
    // THE TRAP THE 2026-08-25 ALLOW-DIRECTION REPAIR HAD TO SURVIVE. Quoting in
    // a shell decides only whether whitespace splits words, so a naive "strip
    // quoted strings" makes every one of these invisible. Each is a REAL egress
    // carrying quotes, a comment, an env prefix, a `-C` prefix, or a chain.
    'git push "origin" main',
    'git push origin "feature/my branch"',
    // AND THE HALF THE FIRST DRAFT OF THIS LIST MISSED, caught by mutating the
    // stripper to the naive form and watching the suite stay 96/96 GREEN. Every
    // row above keeps `git` and `push` OUTSIDE the quotes, so dropping quoted
    // spans entirely still leaves `git … push` matchable and the naive stripper
    // passes. These put the VERB inside the quotes, which is what shell quote
    // removal is actually for: bash runs `git "push"`, `"git" push` and
    // `git pu"sh"` as one and the same push. A stripper that deletes quoted
    // content makes all three invisible — an evasion one keystroke wide.
    'git "push" origin main',
    '"git" push origin main',
    'git pu"sh" origin main',
    "git p'u'sh origin main",
    'npm "publish"',
    "gh 'release' create v1.0.0",
    'git -C "my repo" push origin main',
    'GIT_SSH_COMMAND="ssh -i key" git push origin main',
    'git push origin main # release day',
    'cd repo && git push origin main',
    'git add . && git commit -m "wip" && git push',
    'echo "# git push" && git push origin main',
    'gh pr create --title "release: publish v2"',
    // An INTERPRETER on the line hands a string to something that runs it, so
    // the command-shaped reading is abandoned and matching goes back to
    // verbatim. Without this the quoted-argument rule would be a bypass.
    'bash -c "git push origin main"',
    "sh -c 'npm publish'",
    'ssh build@host "cd repo && git push origin main"',
    'python -c "import os; os.system(\'git push\')"',
    'echo "git push origin main" | bash',
    'find . -name "*.md" | xargs grep -l "git push"',
  ]
  const negatives = [
    'git status',
    'git log --oneline',
    'gh pr list',
    'gh api repos/o/r/pulls',
    'echo push',
    'npm install',
    // DETECTORS for the widened patterns: a read-only `gh api`, and a
    // `git status` on the line AFTER an unrelated one, still do not match.
    'gh api /repos/o/r/releases',
    'gh workflow list',
    'gh secret list',
    'echo hello\ngit status',
    // THE MENTION CLASS. Until 2026-08-25 this array had ZERO fixtures of it and
    // every row below was DENIED — measured on the tree, 8 of 8. The phrase is
    // DATA here: a grep pattern, a filename, a commit message, a jq path, a
    // shell comment. The first eight are the measured eight, verbatim.
    'grep -rn "git push" docs/',
    'cat "notes/git push.md"',
    'git commit -m "docs: explain why we git push"',
    'git diff HEAD~1 -- "src/**"  # no push here',
    '# git push origin main',
    `jq '.scripts["npm publish"]' package.json`,
    `history | grep 'git send-email'`,
    'rg --fixed-strings "npm publish" .',
    // and the same class in shapes of our own
    'echo "remember to git push later"',
    'echo "do not git push" | tee notes.md',
    `git log --grep='git push'`,
    'ls "scripts/git push/"',
    'test -f ".github/workflows/git push.yml"',
    `sed -i 's/git push/git pull/' README.md`,
    'git config alias.p "push origin"',
  ]
  // Cardinality floors: both lists must actually exercise the matcher. The
  // negatives floor is raised past the mention class so deleting it is visible.
  it('has non-empty fixtures on both sides', () => {
    expect(positives.length).toBeGreaterThanOrEqual(5)
    expect(negatives.length).toBeGreaterThanOrEqual(15)
  })
  for (const command of positives) {
    it(`matches: ${command}`, () => { expect(isEgressCommand(command)).toBe(true) })
  }
  for (const command of negatives) {
    it(`does not match: ${command}`, () => { expect(isEgressCommand(command)).toBe(false) })
  }
})

describe('commandTextOf', () => {
  it('reads command for shell tools and code for run_code', () => {
    expect(commandTextOf('bash', { command: 'ls' })).toBe('ls')
    expect(commandTextOf('run_code', { code: 'x' })).toBe('x')
    expect(commandTextOf('bash', {})).toBeUndefined()
    expect(commandTextOf('bash', null)).toBeUndefined()
  })
})

describe('SHELL_TOOLS and egressCommandOf (the shared boundary list)', () => {
  it('names the tools that actually exist, and no longer names run_terminal', () => {
    // `run_terminal` is defined by NO dsh package: it existed only in the v1
    // `tool-gah` plugin this one replaces. Listing it made the gate look wider
    // than it was, and left the REAL PTY surface unscanned.
    expect(SHELL_TOOLS).not.toContain('run_terminal')
    expect([...SHELL_TOOLS].sort()).toEqual(['bash', 'pwsh', 'run_code', 'terminal_open', 'terminal_send'])
  })

  it('reads terminal_send{sessionId,text} as command text and gates it', () => {
    // Measured before the fix: commandTextOf('terminal_send', {sessionId,text})
    // returned undefined, so the whole PTY channel fell through to next().
    expect(commandTextOf('terminal_send', { sessionId: 's1', text: 'git push origin main\n' }))
      .toBe('git push origin main\n')
    expect(egressCommandOf('terminal_send', { sessionId: 's1', text: 'git push origin main' }))
      .toBe('git push origin main')
    expect(egressCommandOf('terminal_open', { command: 'gh release create v1' }))
      .toBe('gh release create v1')
    // DETECTORS: a non-shell tool, and a shell tool with a benign command.
    expect(egressCommandOf('python', { command: 'git push' })).toBeUndefined()
    expect(egressCommandOf('bash', { command: 'git status' })).toBeUndefined()
  })

  it('the guard denies the terminal channel under the fail-closed fallback', () => {
    const light = makeSnapshot()
    expect(decideTool(light, 'terminal_send', { sessionId: 's', text: 'git push origin main' }, GUARD_ONLY).kind)
      .toBe('deny-egress')
    expect(decideTool(light, 'terminal_send', { sessionId: 's', text: 'git push origin main' }, CONFIG).kind)
      .toBe('defer-egress')
  })
})

describe('the egress matcher reads a command line, and the refusal says so', () => {
  const light = makeSnapshot()

  /**
   * The DEFECT this block was written for (measured 2026-08-25 on the tree,
   * with a positive control): 8 of 8 ordinary commands were denied because the
   * matcher tested raw text, so a phrase appearing as DATA counted as a phrase
   * being PERFORMED. Under `guard-deny` each was refused outright; under
   * `native-ask` each was deferred into the outbound waterfall, which then
   * demanded a fresh claim-discharging manifest before an agent could run a
   * grep.
   *
   * These fixtures are the ALLOW direction, which had no fixtures at all. They
   * are checked through `decideTool` and not only through `isEgressCommand`,
   * because the guard is where an operator meets the decision.
   */
  const mentions: Array<[string, unknown]> = [
    ['bash', { command: 'grep -rn "git push" docs/' }],
    ['bash', { command: 'cat "notes/git push.md"' }],
    ['bash', { command: 'git commit -m "docs: explain why we git push"' }],
    ['bash', { command: 'git diff HEAD~1 -- "src/**"  # no push here' }],
    ['bash', { command: '# git push origin main' }],
    ['bash', { command: `jq '.scripts["npm publish"]' package.json` }],
    ['bash', { command: `history | grep 'git send-email'` }],
    ['bash', { command: 'rg --fixed-strings "npm publish" .' }],
    ['bash', { command: 'echo "remember to git push later"' }],
    ['bash', { command: 'echo "do not git push" | tee notes.md' }],
    ['pwsh', { command: 'Select-String -Pattern "npm publish" -Path .\\notes.md' }],
    ['terminal_open', { command: 'less "docs/git push.md"' }],
  ]

  /**
   * The DENY direction, in the shapes a naive stripper breaks. Every row is a
   * real egress: quoting in a shell decides only whether whitespace splits
   * words, so `git push "origin" main` runs a push and must stay refused.
   */
  const performed: Array<[string, unknown]> = [
    ['bash', { command: 'git push origin main' }],
    ['bash', { command: 'git push "origin" main' }],
    ['bash', { command: 'git push origin "feature/my branch"' }],
    // The quoted-VERB shapes: `git "push"`, `"git" push` and `git pu"sh"` are
    // all one push after shell quote removal, and are the only fixtures that
    // can observe a stripper that DELETES quoted spans instead of fusing their
    // interior word boundaries. Measured: without these the naive-stripper
    // mutation left the suite 96/96 green.
    ['bash', { command: 'git "push" origin main' }],
    ['bash', { command: '"git" push origin main' }],
    ['bash', { command: 'git pu"sh" origin main' }],
    ['bash', { command: "git p'u'sh origin main" }],
    ['pwsh', { command: 'npm "publish"' }],
    ['terminal_open', { command: "gh 'release' create v1.0.0" }],
    ['bash', { command: 'git -C "my repo" push origin main' }],
    ['bash', { command: 'GIT_SSH_COMMAND="ssh -i key" git push origin main' }],
    ['bash', { command: 'git push origin main # release day' }],
    ['bash', { command: 'cd repo && git push origin main' }],
    ['bash', { command: 'echo "# git push" && git push origin main' }],
    ['bash', { command: 'gh pr create --title "release: publish v2"' }],
    ['bash', { command: 'bash -c "git push origin main"' }],
    ['bash', { command: "sh -c 'npm publish'" }],
    ['bash', { command: 'ssh build@host "cd repo && git push origin main"' }],
    ['bash', { command: 'echo "git push origin main" | bash' }],
    ['pwsh', { command: 'npm publish --access public' }],
    ['terminal_open', { command: 'gh release create v1.0.0' }],
  ]

  it('has cardinality floors on both directions', () => {
    expect(mentions.length).toBeGreaterThanOrEqual(8)
    expect(performed.length).toBeGreaterThanOrEqual(8)
  })

  it('ordinary work that only MENTIONS an egress phrase is allowed on both seams', () => {
    for (const [tool, args] of mentions) {
      expect(decideTool(light, tool, args, GUARD_ONLY).kind, JSON.stringify(args)).toBe('allow')
      expect(decideTool(light, tool, args, CONFIG).kind, JSON.stringify(args)).toBe('allow')
      expect(egressCommandOf(tool, args), JSON.stringify(args)).toBeUndefined()
    }
  })

  it('every real egress stays refused, including the quoted and commented shapes', () => {
    for (const [tool, args] of performed) {
      expect(decideTool(light, tool, args, GUARD_ONLY).kind, JSON.stringify(args)).toBe('deny-egress')
      expect(decideTool(light, tool, args, CONFIG).kind, JSON.stringify(args)).toBe('defer-egress')
      expect(egressCommandOf(tool, args), JSON.stringify(args)).toBeDefined()
    }
  })

  it('an unterminated quote is read fail-CLOSED, not as a way to hide a push', () => {
    // The quote never closes, so its contents land in the command skeleton
    // rather than being fused away. Chosen deliberately: the other reading
    // would make one stray `"` an allow.
    expect(isEgressCommand('git push "origin')).toBe(true)
    expect(isEgressCommand("npm publish 'x")).toBe(true)
  })

  it('a quoted `#` does not open a comment, so it cannot swallow a later push', () => {
    // The fail-OPEN mistake comment stripping could make. `"# git push"` is an
    // argument; the `#` inside it comments nothing.
    expect(isEgressCommand('echo "# hello" ; git push origin main')).toBe(true)
    // and `$#` / a URL fragment are not comment openers either
    expect(isEgressCommand('echo $# ; git push origin main')).toBe(true)
    expect(isEgressCommand('curl https://x#f && git push origin main')).toBe(true)
  })

  /**
   * RECORDED CEILING (DESIGN.md §6). `run_code` carries SOURCE and
   * `terminal_send` carries keystrokes into a PTY whose foreground process is
   * unknown, so neither is a shell command line and neither can distinguish a
   * mention from a performance: `"git push"` in Python source is inert until
   * something passes it to `shell=True`. Both keep VERBATIM matching, which
   * keeps the deny direction intact and keeps these two rows over-inclusive.
   */
  const opaqueChannels: Array<[string, unknown]> = [
    ['run_code', { code: '# TODO: git push after review\nprint(1)' }],
    ['terminal_send', { sessionId: 's', text: '# git push is gated here' }],
  ]

  it('RECORDED CEILING: run_code and terminal_send are matched verbatim, mentions included', () => {
    for (const [tool, args] of opaqueChannels) {
      expect(decideTool(light, tool, args, GUARD_ONLY).kind, JSON.stringify(args)).toBe('deny-egress')
      expect(decideTool(light, tool, args, CONFIG).kind, JSON.stringify(args)).toBe('defer-egress')
    }
    // The SAME two texts through a shell-line channel are allowed, which is what
    // makes the two rows above a statement about the CHANNEL and not about the
    // text. Without this control the ceiling is indistinguishable from a bug.
    expect(decideTool(light, 'bash', { command: '# TODO: git push after review\nprint(1)' }, GUARD_ONLY).kind)
      .toBe('allow')
    expect(decideTool(light, 'bash', { command: '# git push is gated here' }, GUARD_ONLY).kind).toBe('allow')
    // and the mode split is the thing that produces the difference
    expect(egressScanModeOf('bash')).toBe('shell-line')
    expect(egressScanModeOf('pwsh')).toBe('shell-line')
    expect(egressScanModeOf('terminal_open')).toBe('shell-line')
    expect(egressScanModeOf('run_code')).toBe('opaque-text')
    expect(egressScanModeOf('terminal_send')).toBe('opaque-text')
    // Every shell-class tool has a mode, so adding one to SHELL_TOOLS without
    // deciding its reading cannot pass unnoticed.
    for (const tool of SHELL_TOOLS) {
      expect(['shell-line', 'opaque-text']).toContain(egressScanModeOf(tool))
    }
    // opaque-text is the OLD behaviour, exactly: raw text, no stripping.
    expect(isEgressCommand('grep -rn "git push" .', 'opaque-text')).toBe(true)
    expect(isEgressCommand('grep -rn "git push" .', 'shell-line')).toBe(false)
  })

  /**
   * RECORDED CEILING (DESIGN.md §6), the other side of the interpreter list.
   * The list is an ENUMERATION, so a program that runs a quoted argument and is
   * not on it reads as data. `xargs` IS on it, which is why the `find | xargs
   * grep` row is a positive above; a hypothetical `mytool --run "git push"` is
   * not, and is allowed. The fixture pins the current reading so a change to it
   * is a visible change.
   */
  it('RECORDED CEILING: an un-enumerated program that executes a quoted argument reads as data', () => {
    expect(isEgressCommand('mytool --run "git push origin main"')).toBe(false)
    // the enumerated neighbour, for contrast
    expect(isEgressCommand('bash -c "git push origin main"')).toBe(true)
    expect(isEgressCommand('find . -name "*.md" | xargs grep -l "git push"')).toBe(true)
  })

  /**
   * RECORDED CEILING (DESIGN.md §6): an UNQUOTED mention is still denied,
   * because nothing in the text distinguishes `cat git-push.md` from a path
   * that a program in command position would execute. Fixing this needs a
   * command-position rule, and a command-position rule is fail-OPEN for
   * `xargs git push`, `sudo git push`, `env X=1 git push` and
   * `find . -exec git push \;` — so it was not taken.
   */
  it('RECORDED CEILING: an unquoted mention has no quoting to key off and stays denied', () => {
    expect(isEgressCommand('cat notes/git-push.md')).toBe(true)
    expect(isEgressCommand('cat <<EOF\ngit push origin main\nEOF')).toBe(true)
    // The prefixed-real-egress shapes a command-position rule would have opened.
    expect(isEgressCommand('sudo git push origin main')).toBe(true)
    expect(isEgressCommand('find . -type d -exec git push origin main \\;')).toBe(true)
  })

  it('the refusal handed to the operator states the TEXT match and its actual reach', () => {
    // The string used to assert "this command mutates remote/public state
    // (push, PR, release, publish)" — a claim about the COMMAND the matcher
    // cannot support, in shipped output a human reads.
    expect(EGRESS_FAIL_CLOSED_REASON).toContain('matches the owner-only egress command class')
    expect(EGRESS_FAIL_CLOSED_REASON).not.toContain('mutates remote/public state')
    // Its second false claim was about its own REACH: it promised that "a
    // quoted or commented occurrence inside an otherwise ordinary command is
    // refused too", which stopped being true when the stripper landed.
    expect(EGRESS_FAIL_CLOSED_REASON)
      .not.toContain('a quoted or commented occurrence inside an otherwise ordinary command is refused too')
    expect(EGRESS_FAIL_CLOSED_REASON).toContain('"#" comments and the contents of multi-word quoted arguments')
    expect(EGRESS_FAIL_CLOSED_REASON).toContain('run_code and terminal_send')
    // and it is still the string the guard actually hands back
    const denial = decideTool(light, 'bash', { command: 'git push "origin" main' }, GUARD_ONLY)
    expect(denial.kind).toBe('deny-egress')
    if (denial.kind !== 'deny-egress') throw new Error('unreachable')
    expect(denial.reason).toBe(EGRESS_FAIL_CLOSED_REASON)
  })
})

describe('egressSegments', () => {
  it('returns every egress-classified segment and drops the rest', () => {
    expect(egressSegments('git push origin main && npm publish'))
      .toEqual(['git push origin main', 'npm publish'])
    expect(egressSegments('cd repo && pnpm build && git push origin main'))
      .toEqual(['git push origin main'])
    // `||` is split before `|`, so it does not degrade into two empty pipes.
    expect(egressSegments('git push origin main || npm publish'))
      .toEqual(['git push origin main', 'npm publish'])
    // A line that egresses nowhere has no egress segments at all.
    expect(egressSegments('pnpm test && pnpm build')).toEqual([])
  })

  it('a single & chains too, and is split (the git-push gap excludes & on purpose)', () => {
    // Measured 2026-08-25: with `&` absent from the separator set the whole line
    // still matched the push pattern (its gap excludes the ampersand) and the
    // publish rode along behind a push-only manifest, undeclared.
    expect(egressSegments('git push origin main & npm publish'))
      .toEqual(['git push origin main', 'npm publish'])
    // and a trailing background marker leaves exactly one segment
    expect(egressSegments('git push origin main &')).toEqual(['git push origin main'])
  })

  it('RECORDED CEILING: command substitution carries no separator, so it is NOT segmented', () => {
    // Measured 2026-08-25 and recorded rather than fixed: `$(...)` chains a second
    // egress without any of the listed separators, so the line is one segment and
    // a push-only declaration covers it. Segmenting this needs a real shell
    // parser, not more separators (DESIGN.md §6). The fixture pins the CURRENT
    // behaviour so a future change to it is a visible change.
    expect(egressSegments('git push origin main $(npm publish)'))
      .toEqual(['git push origin main $(npm publish)'])
    // The same shape with a listed separator IS segmented, which is what makes
    // the line above a statement about `$(...)` and not about the splitter.
    expect(egressSegments('git push origin main; npm publish'))
      .toEqual(['git push origin main', 'npm publish'])
  })

  it('a backslash continuation is joined before splitting, as the shell joins it', () => {
    expect(egressSegments('git \\\npush origin main'))
      .toEqual(['git  push origin main'])
  })

  it('segments are classified under the same command-shaped reading as the guard', () => {
    // The authorization side (`validateManifest`, `approvalAuthorizes`) asks
    // this function which parts of a line need declaring. If it kept the raw
    // reading while the guard moved to the command-shaped one, a mention would
    // be allowed to run and then demand a manifest entry that names it.
    expect(egressSegments('grep -rn "git push" . && pnpm build')).toEqual([])
    expect(egressSegments('git commit -m "prep for git push" && git push origin main'))
      .toEqual(['git push origin main'])
    // The RETURNED text is the raw segment, not the skeleton — the manifest's
    // token-boundary matching runs against what the operator actually declared.
    expect(egressSegments('cd repo && git push "origin" main'))
      .toEqual(['git push "origin" main'])
    // and the opaque reading is still reachable for the two channels that need it
    expect(egressSegments('grep -rn "git push" .', 'opaque-text'))
      .toEqual(['grep -rn "git push" .'])
  })
})
