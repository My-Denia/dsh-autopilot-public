/**
 * Model-facing autopilot tools (root controller surface + executor child
 * packet tool). Registered per exact top-level Agent scope; the packet tool is
 * installed only into the authorized executor child (fail-closed absence).
 */

import { defineTool } from '@deepseek-ai/dsh-tools'
import type { InferValue, ValueSchemaSpec } from '@deepseek-ai/dsh-tools'
import { AutopilotError } from './domain/types.js'
import type {
  AuditRole,
  BlockingScope,
  EscalationTarget,
  Stance,
  Triage,
  UsageArtifact,
  UsageArtifactKind,
  UsageClass,
  UsageEntry,
  Verdict,
} from './domain/types.js'
import { USAGE_UNDECLARED_ENTRY } from './domain/usage.js'
import type { AgentRef, AutopilotEngine, SessionReadRef } from './engine.js'

/** JSON output helper (tool-gah pattern). */
function jsonOutput<const S extends ValueSchemaSpec>(schema: S): {
  schema: S
  render: (args: unknown, value: InferValue<S>) => [{ type: 'text'; text: string }]
} {
  return {
    schema,
    render: (_args: unknown, value: InferValue<S>) => [{ type: 'text', text: JSON.stringify(value) }],
  }
}

const JSON_VALUE = { type: 'json' } as const

/**
 * Treat a blank optional string as ABSENT. Models routinely emit every optional
 * key of a tool schema, so `x === undefined` does not mean "the caller omitted
 * it"; `''` and `'   '` mean the same thing and must not reach the record.
 */
function blankToAbsent(value: unknown): string | undefined {
  if (typeof value !== 'string') return value === undefined ? undefined : String(value)
  const trimmed = value.trim()
  return trimmed.length === 0 ? undefined : trimmed
}

/** Recover the exact calling agent from a tool execution. */
function callingAgent(agent: unknown, toolName: string): AgentRef {
  if (agent === undefined) throw new AutopilotError(`${toolName} requires a calling Agent`, 'AP_NO_AGENT')
  return agent as AgentRef
}

/**
 * Direct-human-turn authority: the current open turn window of the ROOT agent
 * must contain a user/message whose source kind is 'user'
 * (dsh goal-tool authority pattern, reimplemented).
 */
export function hasDirectHumanTurn(agent: { readonly session: SessionReadRef }): boolean {
  // Whole-log snapshot (dsh 0.1.2: `Session.events` is gone). Taken fresh on
  // every call; never cached, because `append` invalidates it.
  const events = agent.session.snapshotEvents()
  let turnStart = -1
  for (let i = events.length - 1; i >= 0; i--) {
    const type = events[i]?.type
    if (type === 'turn/start') { turnStart = i; break }
    if (type === 'turn/end') return false
  }
  if (turnStart < 0) return false
  for (let i = turnStart; i < events.length; i++) {
    const event = events[i]
    if (event?.type !== 'user/message') continue
    const data = event.data as { source?: { kind?: string } } | undefined
    if (data?.source?.kind === 'user') return true
  }
  return false
}

function requireDirectHumanTurn(agent: AgentRef, action: string): void {
  if (hasDirectHumanTurn(agent)) return
  throw new AutopilotError(
    `${action} is owner-only: it requires a direct human turn on the top-level agent (not an agent-generated turn)`,
    'AP_OWNER_AUTHORITY_REQUIRED',
  )
}

/**
 * The `autopilot_executor` output body. `Snapshot.executor` is OPTIONAL in the
 * type: the engine sets it on every path that returns normally today, but that
 * is an engine invariant this file neither sees nor owns, and emitting an own
 * property that holds `undefined` is exactly what dsh's lossless-JSON tool-output
 * validator rejects (see the note on `autopilot_init`). Total over the declared
 * type, so an engine change cannot turn this into a boundary failure.
 */
function executorOutput(snapshot: {
  runId: string
  revision: number
  phase: unknown
  executor?: unknown
}): never {
  return {
    runId: snapshot.runId,
    revision: snapshot.revision,
    phase: snapshot.phase,
    ...(snapshot.executor === undefined ? {} : { executor: snapshot.executor }),
  } as never
}

/** Structural tool registry for one scope. */
export interface ToolRegistryRef {
  register(definition: unknown): () => void
}

/** Install the root controller tools on one agent scope; returns a disposer. */
export function installRootTools(
  agentTools: ToolRegistryRef,
  engine: AutopilotEngine,
): () => void {
  const disposers: Array<() => unknown> = []
  const register = (definition: unknown): void => { disposers.push(agentTools.register(definition)) }

  try {
    register(defineTool({
      name: 'autopilot_init',
      description: 'Start an autopilot run on this session with the CC triage contract: objective, scope, non-goals, acceptance criteria, risk, size, execution mode, audit mode, workspace baseline. Standard runs clamp the session read-only until the plan audit passes.',
      parameters: {
        objective: { type: 'string', required: true, description: 'One concrete completion objective.' },
        scope: { type: 'array', required: true, items: { type: 'string' }, description: 'Paths/branches in bounds.' },
        nonGoals: { type: 'array', required: true, items: { type: 'string' }, description: 'What must not change.' },
        acceptanceCriteria: { type: 'array', required: true, items: { type: 'string' }, description: 'Binary observable checks; closeout evidence maps one bearer to each.' },
        risk: { type: 'string', required: true, enum: ['low', 'medium', 'high', 'critical'], description: 'Risk level (medium+ requires independent audits).' },
        size: { type: 'string', required: true, enum: ['lightweight', 'standard'], description: 'lightweight: ≤3 files, single concern; standard: everything else (mechanically gated).' },
        executionMode: { type: 'string', required: true, enum: ['inline', 'delegated'], description: 'WHO implements: this context (inline) or a dispatched executor child (delegated; standard size only).' },
        auditMode: { type: 'string', required: true, enum: ['self-check', 'independent', 'external'], description: 'self-check only for lightweight+low; independent dispatches real auditor subagents.' },
        touchesOperatingLayer: { type: 'boolean', description: 'True when the run modifies rules/skills/hooks/agent config; adds the rules audit role. Default false.' },
        baselineCommit: { type: 'string', description: 'Workspace baseline commit hash.' },
        baselineBranch: { type: 'string', description: 'Workspace baseline branch.' },
        baselineDirty: { type: 'boolean', description: 'Whether the worktree was dirty at triage.' },
        baselineNote: { type: 'string', description: 'Any workspace-gate note (inherited changes, concurrent actors, drift).' },
        usageIds: {
          type: 'array',
          items: { type: 'string' },
          description: 'Standard runs only: ids of the user-visible changes this run will make, seeded as "undeclared". Defaults to a single entry "m1". Each must be answered with autopilot_usage before the plan gate can pass.',
        },
      },
      output: jsonOutput(JSON_VALUE),
      async execute(args, exec) {
        const agent = callingAgent(exec.agent, 'autopilot_init')
        const triage: Triage = {
          objective: args.objective,
          scope: args.scope,
          nonGoals: args.nonGoals,
          acceptanceCriteria: args.acceptanceCriteria,
          risk: args.risk,
          size: args.size,
          executionMode: args.executionMode,
          auditMode: args.auditMode,
          touchesOperatingLayer: args.touchesOperatingLayer ?? false,
          baseline: {
            ...(args.baselineCommit === undefined ? {} : { commit: args.baselineCommit }),
            ...(args.baselineBranch === undefined ? {} : { branch: args.baselineBranch }),
            ...(args.baselineDirty === undefined ? {} : { dirty: args.baselineDirty }),
            ...(args.baselineNote === undefined ? {} : { note: args.baselineNote }),
          },
        }
        // Usage seeding is STANDARD-ONLY: lightweight runs skip mechanical
        // enforcement across the board (CC parity — the same exemption the
        // plan gate and the sandbox clamp already use), and `usage: undefined`
        // is exactly the legacy-exempt shape the settlement rules honour.
        const seeds = args.size === 'standard'
          ? (args.usageIds !== undefined && args.usageIds.length > 0
              ? args.usageIds.map(id => USAGE_UNDECLARED_ENTRY(id))
              : [USAGE_UNDECLARED_ENTRY()])
          : undefined
        const snapshot = await engine.init(agent, triage, seeds)
        // OMIT rather than emit `undefined`. dsh's tool-output validator
        // (`packages/core/session/src/json.ts` `walkJsonValue`, reached from
        // `ToolRuntime.createSuccessResult` -> `snapshotToolValue`) walks every
        // OWN ENUMERABLE STRING KEY and rejects any value that is not null,
        // boolean, string, finite non-negative-zero number, plain array, or
        // plain object. `undefined` is none of those, so an own property
        // HOLDING undefined fails the whole output with
        // `tool "autopilot_init" returned invalid output: value is not lossless
        // JSON` — even though `JSON.stringify` would have silently dropped it.
        // A key that is ABSENT is never visited and is fine.
        //
        // This is the shipped defect (100% reproduction on the real dsh host,
        // 2026-08-25): `usage` is seeded STANDARD-ONLY, so every lightweight
        // run returned `usage: undefined` and every lightweight `autopilot_init`
        // failed at the boundary AFTER the run was already created — the model
        // was told the harness failed and then met "an autopilot run is already
        // active on this session" on retry.
        return {
          runId: snapshot.runId,
          revision: snapshot.revision,
          phase: snapshot.phase,
          enforcement: snapshot.enforcement,
          ...(snapshot.usage === undefined ? {} : { usage: snapshot.usage }),
        } as never
      },
    }))

    register(defineTool({
      name: 'autopilot_status',
      description: 'Read the autopilot run status: phase, gates, required audit roles with latest verdicts, replan budget, enforcement state.',
      parameters: {},
      output: jsonOutput(JSON_VALUE),
      execute(_args, exec) {
        const agent = callingAgent(exec.agent, 'autopilot_status')
        const view = engine.status(agent)
        return Promise.resolve((view ?? { initialized: false, note: 'no autopilot run on this session' }) as never)
      },
    }))

    register(defineTool({
      name: 'autopilot_submit_plan',
      description: 'Submit the plan text (milestones with binary validation checks, files touched, assumptions, rollback). Increments the plan revision and resets the plan gate to pending.',
      parameters: {
        text: { type: 'string', required: true, description: 'Complete plan text.' },
      },
      output: jsonOutput(JSON_VALUE),
      async execute(args, exec) {
        const agent = callingAgent(exec.agent, 'autopilot_submit_plan')
        const snapshot = await engine.submitPlan(agent, args.text)
        return { runId: snapshot.runId, revision: snapshot.revision, phase: snapshot.phase, planRevision: snapshot.plan.revision, planGate: snapshot.planGate } as never
      },
    }))

    register(defineTool({
      name: 'autopilot_audit',
      description: 'Dispatch one fresh independent auditor subagent (read-only tools, structured verdict, depth cap 1). role=plan gates the plan; role=execution gates completion; role=rules audits operating-layer changes. Give it a bounded packet (contract, plan, diff, raw evidence), never your own reasoning.',
      parameters: {
        role: { type: 'string', required: true, enum: ['plan', 'execution', 'rules'], description: 'Audit role.' },
        prompt: { type: 'string', required: true, description: 'Complete bounded audit packet for the auditor.' },
      },
      output: jsonOutput(JSON_VALUE),
      async execute(args, exec) {
        const agent = callingAgent(exec.agent, 'autopilot_audit')
        // NO `provider` ON THE MODEL SURFACE. `provider` names a subagent
        // TRANSPORT registered at mount (`subagents.list()`, e.g. 'spawn'), not
        // a model — but "provider" reads as a model-routing word in every LLM
        // API, and the model cannot enumerate a deployment's registered
        // transports. A live model duly hallucinated `provider: 'openai/gpt-5.6'`
        // (2026-08-25). Both outcomes are bad: an unregistered name throws
        // SubagentError NO_PROVIDER from `expectProvider` mid-transaction, and a
        // registered-but-wrong name runs the audit elsewhere AND writes that
        // name into `RouteRecord.provider` — the single field the audit trail
        // uses to say where a verdict came from. Routing is a DEPLOYMENT fact
        // already owned end to end by config
        // (`auditors[role].provider` -> `auditProvider` -> 'spawn', with
        // `auditors[role].agentOptions` carrying the actual model), so the
        // parameter offered the model no information config lacked and one way
        // to corrupt provenance. `engine.audit` keeps its optional `provider`:
        // the engine API is not the model surface.
        const outcome = await engine.audit(agent, {
          role: args.role as AuditRole,
          prompt: args.prompt,
        })
        return outcome as never
      },
    }))

    register(defineTool({
      name: 'autopilot_self_check',
      description: 'Record a labeled same-context self-check verdict. Only legal on auditMode=self-check runs (lightweight+low); independent runs must dispatch autopilot_audit.',
      parameters: {
        role: { type: 'string', required: true, enum: ['plan', 'execution', 'rules'] },
        verdict: { type: 'string', required: true, enum: ['pass', 'needs-fix', 'needs-replan', 'blocked', 'needs-owner-decision'] },
        note: { type: 'string', required: true, description: 'Honest findings summary.' },
      },
      output: jsonOutput(JSON_VALUE),
      async execute(args, exec) {
        const agent = callingAgent(exec.agent, 'autopilot_self_check')
        const outcome = await engine.selfCheck(agent, {
          role: args.role as AuditRole,
          verdict: args.verdict as Verdict,
          note: args.note,
        })
        return outcome as never
      },
    }))

    register(defineTool({
      name: 'autopilot_external_audit',
      description: 'Owner-only: record an EXTERNAL review that a human performed outside this harness. Legal only on auditMode=external runs, and only on a direct human turn — an agent-generated turn may not countersign the run it is running. The review itself must be attached: reviewRef names a file inside the run directory, checked non-empty at completion. An external pass is weaker evidence than a dispatched audit and is recorded as such.',
      parameters: {
        role: { type: 'string', required: true, enum: ['plan', 'execution', 'rules'] },
        verdict: { type: 'string', required: true, enum: ['pass', 'needs-fix', 'needs-replan', 'blocked', 'needs-owner-decision'] },
        note: { type: 'string', required: true, description: 'What the reviewer concluded, in their terms.' },
        reviewer: { type: 'string', required: true, description: 'Who countersigned. The harness cannot verify identity and records that it cannot.' },
        reviewRef: { type: 'string', required: true, description: 'Run-directory-relative path to the review itself (e.g. review/plan-review.md). Settled at completion: must resolve inside the run directory and be non-empty.' },
        treeHash: { type: 'string', description: 'Optional: the work-tree the reviewer says they read (git commit/tree hash, 7-64 hex). DECLARED, never verified — the harness cannot measure a tree hash. Compared against the run\'s declared baseline commit and reported as a diagnostic, never a refusal. Omit it rather than guessing.' },
      },
      output: jsonOutput(JSON_VALUE),
      async execute(args, exec) {
        const agent = callingAgent(exec.agent, 'autopilot_external_audit')
        // Same gate as owner-approve. Without it `external` degrades into a
        // self-check with better paperwork: the agent driving the run would be
        // able to sign for a review of its own work.
        requireDirectHumanTurn(agent, 'external countersign')
        // `=== undefined` would be the wrong test for `treeHash`, for the
        // reason `autopilot_log`'s note records above: the providers this
        // harness runs fill every optional property in the schema, so an
        // omitted hash arrives as `""` rather than absent.
        //
        // STATED HONESTLY: this seam is REDUNDANT and its failure is not
        // independently observable. `AutopilotEngine.recordExternalAudit`
        // normalizes through `normalizeTreeHash` before it validates or writes,
        // so replacing this line with `args.treeHash` changes no outcome
        // anywhere — measured 2026-08-27 by doing exactly that: the whole suite
        // stayed green. It is kept because every optional string seam in this
        // file treats blank as absent and a reader is entitled to find the same
        // shape here, NOT because it is the thing that makes the rule true. The
        // rule is true at the engine, which is the single construction site and
        // the only path a foreign caller can also take.
        const treeHash = blankToAbsent(args.treeHash)
        const outcome = await engine.recordExternalAudit(agent, {
          role: args.role as AuditRole,
          verdict: args.verdict as Verdict,
          note: args.note,
          review: {
            reviewer: args.reviewer,
            reviewRef: args.reviewRef,
            ...(treeHash === undefined ? {} : { treeHash }),
          },
        })
        return outcome as never
      },
    }))

    register(defineTool({
      name: 'autopilot_usage',
      description: 'Declare (or re-declare) how one change of this run was actually OPERATED, not just built. Last-wins per id. Classes: gui|cli|api-behavior need >=2 boundary states (>=1 from the canonical menu) and >=1 artifact; harness needs a test-run artifact; internal|docs need neither; unsupported is an honest terminal and needs unsupportedReason + attempted[]. Neither the plan gate nor completion can pass while any entry is still "undeclared".',
      parameters: {
        id: { type: 'string', required: true, description: 'The change id being answered for (matches an id seeded at autopilot_init, or a new one).' },
        usageClass: {
          type: 'string',
          required: true,
          enum: ['gui', 'cli', 'api-behavior', 'internal', 'docs', 'harness', 'unsupported', 'undeclared'],
          description: 'What kind of surface this change touched.',
        },
        boundaryStates: {
          type: 'array',
          items: { type: 'string' },
          description: 'States actually exercised. Menu: empty, full, at-top, at-bottom, extreme-value, interrupted, narrow-window, first-run, permission-denied, offline, fallback, long-running, concurrent, error-path.',
        },
        artifacts: {
          type: 'array',
          description: 'Evidence that the change was operated. Refs resolve inside the run directory and must post-date the plan-gate pass.',
          items: {
            type: 'object',
            additionalProperties: false,
            properties: {
              kind: { type: 'string', required: true, enum: ['screenshot', 'screencast', 'session-log', 'http-trace', 'device-log', 'test-run'] },
              ref: { type: 'string', required: true, description: 'Run-directory-relative path.' },
              covers: { type: 'array', required: true, items: { type: 'string' }, description: 'Boundary-state or claim labels this artifact bears.' },
              capturedAt: { type: 'string', required: true, description: 'ISO-8601 UTC capture time.' },
              inheritedFrom: { type: 'string', description: '"<run-id>/<ref>" when citing a prior run\'s artifact (exempt from containment and freshness).' },
            },
          },
        },
        unsupportedReason: { type: 'string', description: 'Required for class unsupported: why this environment cannot operate the change.' },
        attempted: { type: 'array', items: { type: 'string' }, description: 'Required (non-empty) for class unsupported: what was actually tried.' },
      },
      output: jsonOutput(JSON_VALUE),
      async execute(args, exec) {
        const agent = callingAgent(exec.agent, 'autopilot_usage')
        const entry: UsageEntry = {
          id: args.id,
          usageClass: args.usageClass as UsageClass,
          boundaryStates: args.boundaryStates ?? [],
          artifacts: (args.artifacts ?? []).map((artifact): UsageArtifact => ({
            kind: artifact.kind as UsageArtifactKind,
            ref: artifact.ref,
            covers: artifact.covers,
            capturedAt: artifact.capturedAt,
            ...(artifact.inheritedFrom === undefined ? {} : { inheritedFrom: artifact.inheritedFrom }),
          })),
          ...(args.unsupportedReason === undefined ? {} : { unsupportedReason: args.unsupportedReason }),
          attempted: args.attempted ?? [],
        }
        const snapshot = await engine.declareUsage(agent, entry)
        // `Snapshot.usage` is optional in the TYPE. `declareUsage` happens to
        // always set it, but that is an ENGINE invariant this file cannot see
        // and does not own; the tool must be total over the declared type or it
        // is one engine edit away from the `autopilot_init` failure above.
        return {
          runId: snapshot.runId,
          revision: snapshot.revision,
          ...(snapshot.usage === undefined ? {} : { usage: snapshot.usage }),
        } as never
      },
    }))

    register(defineTool({
      name: 'autopilot_log',
      description: 'Append one execution-log checkpoint (record as you go, not at phase end). Stance: on-plan | detour | grind | escalate (escalate requires note).',
      parameters: {
        text: { type: 'string', required: true, description: 'What ran / what changed, with the result.' },
        stance: { type: 'string', required: true, enum: ['on-plan', 'detour', 'grind', 'escalate'] },
        note: { type: 'string', description: 'Required for escalate.' },
        escalationTarget: { type: 'string', enum: ['root-agent', 'stronger-model', 'owner', 'external-review'] },
        blockingScope: { type: 'string', enum: ['none', 'subtask', 'milestone', 'run'] },
      },
      output: jsonOutput(JSON_VALUE),
      async execute(args, exec) {
        const agent = callingAgent(exec.agent, 'autopilot_log')
        const snapshot = await engine.log(agent, {
          text: args.text,
          stance: args.stance as Stance,
          // `=== undefined` is the WRONG test here. The models this harness
          // actually runs fill every optional key, so a blank string arrives
          // instead of an absent one and `present-but-blank` survives into the
          // durable record. Measured on the real host 2026-08-25: an ON-PLAN
          // checkpoint rendered as `note:  -> root-agent (blocks: none)` in
          // log.md, i.e. the human-readable log reported an escalation target
          // for a step that had none. Same defect class as the usage
          // `inheritedFrom` blank that rejected every artifact-bearing
          // declaration; treat blank as absent at every optional seam.
          ...(blankToAbsent(args.note) === undefined ? {} : { note: args.note as string }),
          // NOT blankToAbsent: these are enum-typed, and `defineTool` refuses a
          // blank against the enum before execute runs (measured 2026-08-25 —
          // `invalid arguments: "escalationTarget" must be one of [...]`). A
          // blank can never arrive here; what DOES arrive is a legal-but-
          // meaningless value on a non-escalate stance, which the engine drops.
          ...(args.escalationTarget === undefined ? {} : { escalationTarget: args.escalationTarget as EscalationTarget }),
          ...(args.blockingScope === undefined ? {} : { blockingScope: args.blockingScope as BlockingScope }),
        })
        return { runId: snapshot.runId, revision: snapshot.revision, logCount: snapshot.logCount } as never
      },
    }))

    register(defineTool({
      name: 'autopilot_executor',
      description: 'Delegated runs only: start the continuable Executor Lead child (requires plan gate pass), or resume the SAME child after a needs-fix audit. The child receives autopilot_submit_packet automatically.',
      parameters: {
        action: { type: 'string', required: true, enum: ['start', 'resume'] },
        prompt: { type: 'string', required: true, description: 'start: initial dispatch packet (on-disk artifact refs, not conversation). resume: the next dispatch prompt.' },
        persona: { type: 'string', description: 'start only: persona override.' },
        findings: { type: 'string', description: 'resume only: audit findings to relay.' },
      },
      output: jsonOutput(JSON_VALUE),
      async execute(args, exec) {
        const agent = callingAgent(exec.agent, 'autopilot_executor')
        if (args.action === 'start') {
          // No model-supplied `provider` here either, for the reason spelled out
          // on `autopilot_audit`: it is a transport name the model cannot know,
          // and `config.executorProvider` already owns the choice.
          const snapshot = await engine.startExecutor(agent, {
            prompt: args.prompt,
            ...(args.persona === undefined ? {} : { persona: args.persona }),
            signal: exec.signal,
          })
          return executorOutput(snapshot)
        }
        const snapshot = await engine.resumeExecutor(agent, {
          findings: args.findings ?? '',
          nextPrompt: args.prompt,
          signal: exec.signal,
        })
        return executorOutput(snapshot)
      },
    }))

    register(defineTool({
      name: 'autopilot_submit_evidence',
      description: 'Inline runs only: submit the execution evidence report (what changed, commands with results, validation output refs) to enter execution review.',
      parameters: {
        report: { type: 'string', required: true, description: 'Complete evidence report.' },
        residualRisks: { type: 'array', items: { type: 'string' }, description: 'Residual risk items.' },
      },
      output: jsonOutput(JSON_VALUE),
      async execute(args, exec) {
        const agent = callingAgent(exec.agent, 'autopilot_submit_evidence')
        const snapshot = await engine.submitExecutionEvidence(agent, {
          report: args.report,
          residualRisks: args.residualRisks ?? [],
        })
        return { runId: snapshot.runId, revision: snapshot.revision, phase: snapshot.phase } as never
      },
    }))

    register(defineTool({
      name: 'autopilot_signal',
      description: 'Run control signals. replan: rewrite the plan (drains any executor). block / owner-decision: stop the run. owner-approve: grant ONE egress approval (owner-only; requires a direct human turn). owner-resolve: resolve a needs-owner-decision pause (owner-only; decision resume-planning or block).',
      parameters: {
        action: { type: 'string', required: true, enum: ['replan', 'block', 'owner-decision', 'owner-approve', 'owner-resolve'] },
        note: { type: 'string', required: true, description: 'Reason / ruling / approval target description.' },
        ownerDecision: { type: 'string', enum: ['resume-planning', 'block'], description: 'owner-resolve only.' },
      },
      output: jsonOutput(JSON_VALUE),
      async execute(args, exec) {
        const agent = callingAgent(exec.agent, 'autopilot_signal')
        switch (args.action) {
          case 'replan': {
            const snapshot = await engine.replan(agent, args.note)
            return { runId: snapshot.runId, revision: snapshot.revision, phase: snapshot.phase } as never
          }
          case 'block': {
            const snapshot = await engine.setBlocked(agent, args.note)
            return { runId: snapshot.runId, revision: snapshot.revision, phase: snapshot.phase } as never
          }
          case 'owner-decision': {
            const snapshot = await engine.setOwnerDecision(agent, args.note)
            return { runId: snapshot.runId, revision: snapshot.revision, phase: snapshot.phase } as never
          }
          case 'owner-approve': {
            requireDirectHumanTurn(agent, 'owner-approve')
            const snapshot = await engine.ownerApprove(agent, args.note)
            return { runId: snapshot.runId, revision: snapshot.revision, approvals: snapshot.enforcement.ownerApprovals } as never
          }
          case 'owner-resolve': {
            requireDirectHumanTurn(agent, 'owner-resolve')
            const decision = args.ownerDecision
            if (decision !== 'resume-planning' && decision !== 'block') {
              throw new AutopilotError('owner-resolve requires ownerDecision resume-planning|block', 'AP_INVALID_ARGUMENT')
            }
            const snapshot = await engine.ownerResolve(agent, { decision, note: args.note })
            return { runId: snapshot.runId, revision: snapshot.revision, phase: snapshot.phase } as never
          }
          default:
            // UNREACHABLE through the tool surface, kept as defence in depth:
            // `defineTool` validates arguments against the declared `enum`
            // BEFORE execute runs. Measured 2026-08-25 — an unknown action
            // rejects as ToolArgsError/INVALID_ARGS with
            // `invalid arguments: "action" must be one of [...]`, never
            // reaching this line. A mutation of this arm therefore SURVIVES
            // the suite by construction, and that is correct: the rule
            // "an unrecognized action is refused" is borne by the schema,
            // and the bearer for it asserts the schema's own message rather
            // than a bare throw (test/tools.test.ts).
            throw new AutopilotError(`unknown action ${String(args.action)}`, 'AP_INVALID_ARGUMENT')
        }
      },
    }))

    register(defineTool({
      name: 'autopilot_submit_closeout',
      description: 'Submit the structured closeout and complete the run. Refused mechanically unless: both gates pass, every required audit role\'s latest verdict is pass (mode-consistent provenance), evidence maps exactly one bearer (or an honest unproven) to EVERY acceptance criterion, and no proven bearer is reused across two criteria.',
      parameters: {
        summary: { type: 'string', required: true },
        changedFiles: { type: 'array', required: true, items: { type: 'string' } },
        commands: { type: 'array', required: true, items: { type: 'string' }, description: 'Commands run with key results.' },
        evidence: {
          type: 'array',
          required: true,
          description: 'Exactly one entry per acceptance criterion; a proven bearer may not be reused (Single-Bearer both directions).',
          items: {
            type: 'object',
            additionalProperties: false,
            properties: {
              criterion: { type: 'string', required: true, description: 'The acceptance criterion, verbatim.' },
              bearer: { type: 'string', required: true, description: 'The single bearing artifact (may be empty only when unproven).' },
              status: { type: 'string', required: true, enum: ['proven', 'unproven'] },
              kind: {
                type: 'string',
                required: true,
                enum: ['path', 'command'],
                description: 'What the bearer is: "path" (a file/dir, folded against the run workspace so ./x and /ws/x are one artifact) or "command" (compared verbatim, so "git status" and "./git status" stay two).',
              },
              note: { type: 'string' },
            },
          },
        },
        residualRisks: { type: 'array', items: { type: 'string' } },
        exclusions: { type: 'array', items: { type: 'string' }, description: 'What was deliberately not changed.' },
        workspaceCleanup: { type: 'string', required: true, description: 'Self-created artifacts kept/archived/deleted/left, with reasons.' },
        drift: { type: 'string', required: true, description: '"none found" or exact upstream facts to update.' },
      },
      output: jsonOutput(JSON_VALUE),
      async execute(args, exec) {
        const agent = callingAgent(exec.agent, 'autopilot_submit_closeout')
        const snapshot = await engine.submitCloseout(agent, {
          summary: args.summary,
          changedFiles: args.changedFiles,
          commands: args.commands,
          // No cast: the compiler checks the evidence item shape against
          // EvidenceEntry here, so dropping a `required` flag or widening the
          // status enum inside the schema is a TYPE error rather than a silent
          // runtime hole (`as never` used to swallow both).
          evidence: args.evidence,
          residualRisks: args.residualRisks ?? [],
          exclusions: args.exclusions ?? [],
          workspaceCleanup: args.workspaceCleanup,
          drift: args.drift,
        })
        return { runId: snapshot.runId, revision: snapshot.revision, phase: snapshot.phase } as never
      },
    }))
  } catch (error: unknown) {
    for (const dispose of disposers.reverse()) void dispose()
    throw error
  }

  return () => {
    for (const dispose of disposers.reverse()) void dispose()
  }
}

/** Build the executor-child packet tool definition (installed only into the authorized executor). */
export function packetToolDefinition(engine: AutopilotEngine): unknown {
  return defineTool({
    name: 'autopilot_submit_packet',
    description: 'Executor Lead only: submit the execution packet (what changed, commands run with results, validation evidence, residual risks). Your final deliverable — never a status update.',
    parameters: {
      packet: { type: 'string', required: true, description: 'The complete execution packet text.' },
      residualRisks: { type: 'array', items: { type: 'string' } },
      executionRevision: {
        type: 'integer',
        required: true,
        description: 'The live executor executionRevision this packet is for (1 at start, incremented on each needs-fix resume). A stale or missing value is refused.',
      },
    },
    output: jsonOutput(JSON_VALUE),
    async execute(args, exec) {
      const child = callingAgent(exec.agent, 'autopilot_submit_packet')
      const snapshot = await engine.submitExecutionPacket(child, {
        packet: args.packet,
        residualRisks: args.residualRisks ?? [],
        executionRevision: args.executionRevision,
      })
      return { runId: snapshot.runId, revision: snapshot.revision, phase: snapshot.phase } as never
    },
  })
}
