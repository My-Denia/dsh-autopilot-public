/**
 * The native egress seam: outbound evidence manifest + `ctx.approval`.
 *
 * WHY a second seam rather than more guard: `ToolGuard` is
 * `(execution: Readonly<ToolExecution>) => string | undefined` — synchronous,
 * and monotonic by design (a guard can deny, never force-allow; measured at
 * `packages/core/tools/src/index.ts:711` against dsh 0.1.1-rc.2). Validating an
 * outbound manifest means reading a file and every artifact it cites, and
 * obtaining owner authority means putting a question to a human. Neither fits
 * a synchronous predicate. `tools/pre-execute` is the async waterfall that
 * does fit, and it is the ONLY seam that can return `ask`.
 *
 * WHY `ask` and not our own approval prompt: the runtime resolves `ask`
 * through `ctx.get('approval')` and, when no approval service is composed,
 * degrades the ask to a DENY by itself (`index.ts` `serviceAsk`). Rebuilding
 * that would mean reimplementing a fail-closed path that already exists and
 * is already the deployment's policy surface — including the session policy
 * that rejects deterministically. So this module decides WHETHER to ask and
 * lets dsh decide the answer.
 *
 * WHY consumption is archived at `tools/execute` and not here: that waterfall
 * runs only for calls that were actually allowed — after an `ask` resolved
 * `allowed-once`. A manifest spent at pre-execute would be spent by egresses
 * the human then refused, forcing the run to re-author evidence for a command
 * that never left the machine.
 *
 * Inside that waterfall the two records are written at DIFFERENT moments, on
 * purpose. The archive goes down before `next()`, because a record of what
 * authorized an egress cannot be written after the egress has already gone
 * out; it therefore attests an authorized dispatch ATTEMPT. The run's
 * `enforcement.outboundConsumed` counter goes up only after `next()` returns a
 * non-error result, because that counter is the run's claim about text that
 * actually left the machine. The pairing is what an auditor reads: an archived
 * manifest with no matching `consume-manifest` event was authorized and never
 * dispatched (DESIGN.md §6).
 *
 * WHAT THIS SEAM DOES NOT OWN: the absolute denials (plan gate, usage
 * declaration, executor bypass) stay in the synchronous guard, where they
 * belong — no human answer makes them false, so there is nothing to ask.
 */

import { readFileSync } from 'node:fs'
import { TERMINAL_PHASES, errorMessage } from '../domain/types.js'
import type { OutboundManifest } from '../domain/types.js'
import {
  archiveConsumed,
  manifestCandidates,
  missingManifestReason,
  parseManifest,
  validateManifest,
} from '../outbound/manifest.js'
import type { AutopilotEngine } from '../engine.js'
import { egressCommandOf as egressCommandOfCall } from './decide.js'

/**
 * How many validated-but-not-yet-dispatched egress authorizations one scope
 * keeps.
 *
 * WHY a cap exists: an entry is written at pre-execute for every egress whose
 * manifest validated, and deleted only on the `tools/execute` path — which
 * never runs when the owner rejects the ask or a later monotonic guard denies.
 * Every REFUSED egress therefore leaked one full manifest object for the life
 * of the agent. Eviction is oldest-first so the in-flight call (the newest) is
 * the one that survives.
 *
 * An evicted entry now REFUSES at dispatch rather than re-resolving from the
 * manifest file: the dispatch seam's independent authority check (below) is
 * what keeps the seam's safety from being owned by upstream call ordering, and
 * "the oldest of 64 simultaneously-pending, owner-unanswered egresses is
 * refused" is the fail-closed direction of that trade.
 */
export const MAX_PENDING_EGRESS_AUTHORIZATIONS = 64

/**
 * Structural subset of the runtime's `PreToolDecision`
 * (`packages/core/tools/src/index.ts`, `PreToolDecision`). Reproduced locally
 * rather than imported because a second physical copy of the tools runtime would
 * give the plugin a different service identity than the host's (DESIGN.md §1).
 * (Corrected 2026-08-25: the reason used to be spelled "this package's only
 * runtime dependency is `@deepseek-ai/dsh-tools`", which §1 retracts as false —
 * `src/config.ts` statically imports `@deepseek-ai/schemastery` as a value.)
 */
export type PreDecision =
  | { readonly kind: 'allow' }
  | { readonly kind: 'deny'; readonly reason: string }
  | { readonly kind: 'ask'; readonly reason?: string }

/** Structural subset of the `ToolExecution` a pre-execute listener receives. */
export interface PreExecution {
  readonly name: string
  readonly arguments: unknown
  readonly callId?: string
}

/**
 * Structural subset of an agent-scoped context that can register the two
 * waterfalls. The real signatures are
 * `'tools/pre-execute'(exec, next) => Promise<PreToolDecision>` and
 * `'tools/execute'(exec, next) => Promise<ToolExecutionResult>` — whose first
 * argument is a `ToolDispatchExecution`, not a `ToolExecution`; both are
 * scope-filtered, so an agent-scoped listener receives only that agent's calls.
 */
export interface PreExecuteHost {
  on(
    event: 'tools/pre-execute',
    listener: (exec: PreExecution, next: () => Promise<PreDecision>) => Promise<PreDecision>,
  ): () => void
  on(
    event: 'tools/execute',
    listener: (exec: PreExecution, next: () => Promise<unknown>) => Promise<unknown>,
  ): () => void
}

/** Injection seam so every branch is testable without a filesystem. */
export interface PreExecuteOptions {
  /** Reads the manifest file; returns undefined when it does not exist or cannot be read. */
  readonly readManifest?: (path: string) => string | undefined
  /** Artifact reader handed to `validateManifest`. */
  readonly readArtifact?: (absPath: string) => { readonly size: number; readonly text: string } | undefined
  /** Validation/consumption clock (ms since epoch). */
  readonly now?: () => number
  /** Environment used to resolve the manifest path (the owner's override channel). */
  readonly env?: NodeJS.ProcessEnv
  /**
   * The session's workspace root — the sandbox's `workspace-write` root, which
   * decides both where the workspace manifest candidate lives and whether the
   * denial should explain that the run directory is unwritable. Defaults to the
   * process cwd, the same fallback `@deepseek-ai/dsh-sandbox-policy` uses for a
   * call without a session cwd. Injectable so the two branches of that message
   * are observable without moving the test's cwd.
   */
  readonly workspaceRoot?: string
  /** Archive writer; defaults to `archiveConsumed` over node:fs. */
  readonly archive?: typeof archiveConsumed
}

/** Result of one install attempt; `installed: false` is what selects the fail-closed guard fallback. */
export interface PreExecuteInstall {
  readonly installed: boolean
  readonly dispose: () => void
  /** Present only when installation failed, so the caller can record WHY rather than assume. */
  readonly diagnostic?: string
}

/**
 * Whether a `tools/execute` result is the runtime's error shape.
 *
 * Structural, like every other dsh surface this package reaches: the real type
 * is `ToolExecutionResult` with an `isError` flag. Anything that is not
 * recognisably an error result counts as a dispatch, so an unfamiliar shape
 * errs toward RECORDING the consumption rather than silently under-counting
 * what went out.
 */
function isErrorResult(result: unknown): boolean {
  if (typeof result !== 'object' || result === null) return false
  return (result as { isError?: unknown }).isError === true
}

function defaultReadManifest(path: string): string | undefined {
  try {
    return readFileSync(path, 'utf8')
  } catch {
    return undefined
  }
}

/**
 * Resolve one egress command against the run's outbound evidence manifest.
 *
 * Exported for direct testing: a decision function reachable only through two
 * registered waterfalls is a decision function whose fails nobody can observe.
 * @returns the pre-execute decision plus, when the manifest validated, the
 * manifest itself so the dispatch seam can archive exactly what authorized it.
 */
export function decideEgress(
  engine: AutopilotEngine,
  rootSessionId: string,
  command: string,
  options: PreExecuteOptions = {},
): { readonly decision: PreDecision; readonly manifest?: OutboundManifest } {
  const snapshot = engine.peek(rootSessionId)
  // No run, or a finished run: the harness does not gate (CC fail-open parity
  // with the guard, so installing this seam cannot make a non-run stricter).
  if (snapshot === undefined || TERMINAL_PHASES.includes(snapshot.phase)) return { decision: { kind: 'allow' } }

  const runDir = engine.runDirOf(rootSessionId)
  const workspaceRoot = options.workspaceRoot ?? process.cwd()
  const now = (options.now ?? Date.now)()
  // FIRST EXISTING, not first valid: an owner-placed manifest that fails
  // validation must NOT fall through to the agent-writable workspace copy, or
  // the second silently overrides the first. `manifestCandidates` owns the
  // order and the exclusivity of the owner's env pin.
  const candidates = manifestCandidates(runDir, { env: options.env ?? process.env, workspaceRoot })
  const read = options.readManifest ?? defaultReadManifest
  let path: string | undefined
  let raw: string | undefined
  for (const candidate of candidates) {
    const found = read(candidate)
    if (found !== undefined) {
      path = candidate
      raw = found
      break
    }
  }
  if (raw === undefined || path === undefined) {
    return {
      decision: {
        kind: 'deny',
        // The denial names every place it looked, marks which of them this
        // session's sandbox can actually write, and carries a filled-in
        // skeleton — see `missingManifestReason` for why the old one-line form
        // was true and still unusable on the real host.
        reason: missingManifestReason({ runId: snapshot.runId, command, runDir, candidates, workspaceRoot, now }),
      },
    }
  }

  const parsed = parseManifest(raw)
  if (parsed.manifest === undefined || parsed.problems.length > 0) {
    return {
      decision: {
        kind: 'deny',
        reason: `autopilot outbound gate: manifest at ${path} is invalid: ${parsed.problems.join('; ')}`,
      },
    }
  }

  const problems = validateManifest(parsed.manifest, {
    runId: snapshot.runId,
    command,
    runDir,
    now,
    ...(options.readArtifact === undefined ? {} : { readArtifact: options.readArtifact }),
  })
  if (problems.length > 0) {
    return {
      decision: {
        kind: 'deny',
        reason: `autopilot outbound gate: manifest at ${path} does not authorize this egress: ${problems.join('; ')}`,
      },
    }
  }

  return {
    decision: {
      kind: 'ask',
      // The declared commands AND the command itself are named. The declared
      // classes matter because approving THIS egress approves the manifest, and
      // a manifest authorizes a command CLASS: an owner who only sees the target
      // cannot tell a push-only manifest from one that also covers a publish.
      // The command matters because the classes alone UNDERSTATE a chained line:
      // before the per-segment rule, `git push origin main && npm publish`
      // produced a prompt naming only `[git push]`. The line is now refused
      // unless every egress segment is declared, so the two can no longer
      // disagree — and the owner is shown the text that will run either way.
      reason: `autopilot owner-only egress to ${parsed.manifest.target}: ${parsed.manifest.claims.length} claim(s) each bound to an artifact, authorizing command class(es) [${parsed.manifest.commands.join(' | ')}], for command "${command.slice(0, 300)}", manifest ${path}. Approving dispatches this command and archives the manifest as spent.`,
    },
    manifest: parsed.manifest,
  }
}

/**
 * Install the native egress seam on one agent-scoped context (the root agent's
 * ctx, and the executor child's ctx via the continuable setup).
 *
 * @param host - the agent-scoped context; the listeners it registers receive
 * only that agent's tool calls.
 * @param rootSessionId - the run this scope's egress is charged to.
 * @returns whether the seam installed. A `false` here is what makes the
 * synchronous guard fall back to denying all egress unconditionally, so the
 * caller must not treat it as cosmetic.
 *
 * HONEST CEILING (DESIGN.md §6): `installed: true` means `host.on(...)` did not
 * throw. A cordis event bus accepts any event name and returns a disposer, so
 * this is an EXISTENCE bearer, not an observation that the runtime's
 * pre-execute waterfall will ever dispatch to us. A host that registers the
 * listener and never calls it yields `installed: true`, the guard stands down,
 * and `enforcement.egress` says 'native-ask' for a boundary nothing is
 * enforcing. The genuinely-absent case DOES fail closed (a throwing host gives
 * `installed: false` -> 'guard-deny' -> unconditional denial), which is why the
 * value is still worth recording — but it is recorded for what it is.
 */
export function installPreExecuteGate(
  host: PreExecuteHost,
  rootSessionId: string,
  engine: AutopilotEngine,
  options: PreExecuteOptions = {},
): PreExecuteInstall {
  const disposers: Array<() => void> = []
  // Manifests validated at pre-execute, keyed by callId, so the dispatch seam
  // archives the exact bytes that authorized the call rather than whatever the
  // file happens to hold a moment later.
  const authorized = new Map<string, { manifest: OutboundManifest; command: string }>()

  // The shell-tool set and the egress classifier both come from `./decide.js`:
  // this module used to carry a byte-identical copy of SHELL_TOOLS, and two
  // copies of a boundary list is how one seam ends up scanning a channel the
  // other does not. Since 2026-08-25 that import also carries the PER-CHANNEL
  // SCAN MODE (`bash`/`pwsh`/`terminal_open` read as shell command lines,
  // `run_code`/`terminal_send` verbatim), which is a second thing two spellings
  // could disagree about: a seam that classified `run_code` under shell rules
  // while the guard classified it verbatim would defer a call the guard denies.
  // Downstream of here `validateManifest` splits with `egressSegments` under
  // the shell-line default; when that yields no segment for an opaque-channel
  // command it falls back to requiring the WHOLE line to be declared, so the
  // two readings can only disagree in the fail-closed direction.
  const egressCommandOf = (exec: PreExecution): string | undefined =>
    egressCommandOfCall(exec.name, exec.arguments)

  /**
   * Whether this scope's run is one the harness gates at all.
   *
   * The SAME question `decideEgress` answers first, asked again on the dispatch
   * side because the two seams must agree: pre-execute fails open for "no run"
   * and for a terminal run (CC parity — installing this seam must not make a
   * NON-run stricter), so a dispatch seam that then refused to let the very
   * call it just allowed through would brick `git push` in every session where
   * the plugin is mounted without a live run, and permanently after any run
   * finishes. A probe that throws reads as GATED, so a broken read cannot turn
   * the outbound boundary into an open one.
   */
  const isGatedRun = (): boolean => {
    try {
      const snapshot = engine.peek(rootSessionId)
      return snapshot !== undefined && !TERMINAL_PHASES.includes(snapshot.phase)
    } catch {
      return true
    }
  }

  /** Remember one validated authorization, evicting the oldest when the cap is reached. */
  const remember = (callId: string, entry: { manifest: OutboundManifest; command: string }): void => {
    if (!authorized.has(callId)) {
      while (authorized.size >= MAX_PENDING_EGRESS_AUTHORIZATIONS) {
        const oldest = authorized.keys().next()
        if (oldest.done === true) break
        authorized.delete(oldest.value)
      }
    }
    authorized.set(callId, entry)
  }

  try {
    disposers.push(host.on('tools/pre-execute', async (exec, next) => {
      const command = egressCommandOf(exec)
      if (command === undefined) return next()
      let resolved: ReturnType<typeof decideEgress>
      try {
        resolved = decideEgress(engine, rootSessionId, command, options)
      } catch (error: unknown) {
        // Fail-CLOSED: unlike the quality gates, a broken outbound boundary
        // must not become an open one.
        return { kind: 'deny', reason: `autopilot outbound gate failed closed: ${errorMessage(error)}` }
      }
      if (resolved.decision.kind !== 'ask' || resolved.manifest === undefined) return resolved.decision

      if (exec.callId !== undefined) {
        remember(exec.callId, { manifest: resolved.manifest, command })
      }

      // A direct-human-turn `owner-approve` is authority the owner already
      // granted in this session; v1's one-approval-per-egress semantics are
      // preserved by consuming it here instead of asking again.
      let consumed: number | undefined
      try {
        consumed = await engine.consumeApproval(rootSessionId, command)
      } catch {
        consumed = undefined
      }
      if (consumed !== undefined) return { kind: 'allow' }
      return resolved.decision
    }))

    disposers.push(host.on('tools/execute', async (exec, next) => {
      const command = egressCommandOf(exec)
      if (command === undefined) return next()
      // No run, or a finished run: pre-execute allowed this call unconditionally,
      // so dispatch must too. See `isGatedRun`.
      if (!isGatedRun()) return next()
      // INDEPENDENT AUTHORITY CHECK. A call that carries a callId and is NOT
      // in `authorized` never passed this scope's pre-execute waterfall (or was
      // evicted from the cap). Re-resolving the manifest from disk for it would
      // let the dispatch seam authorize an egress on its own — the seam's
      // safety would then be owned entirely by upstream `prepareExecution`
      // happening to call pre-execute first, i.e. by another package. The
      // re-resolve fallback survives only for the callId-undefined case, where
      // there is no key to have remembered anything under.
      const pending = exec.callId === undefined ? undefined : authorized.get(exec.callId)
      if (exec.callId !== undefined) {
        authorized.delete(exec.callId)
        if (pending === undefined) {
          throw new Error(`autopilot outbound gate: tool call ${exec.callId} reached dispatch without a pre-execute authorization for this egress; refusing to dispatch unauthorized`)
        }
      }
      const resolvedManifest = pending?.manifest ?? decideEgress(engine, rootSessionId, command, options).manifest
      if (resolvedManifest === undefined) {
        // Reaching dispatch with nothing to archive means the record of what
        // authorized this egress cannot be written. Refusing is the only
        // option that keeps "every egress has an archived manifest" true.
        throw new Error('autopilot outbound gate: the manifest that authorized this egress is no longer resolvable; refusing to dispatch unrecorded')
      }
      // ORDER, and why it is asymmetric. The ARCHIVE is written before
      // `next()`: it is the record of what authorized this dispatch, and a
      // record written afterwards could not exist for a call that already left
      // the machine. So the archive marks an authorized dispatch ATTEMPT
      // (DESIGN.md §6). `outboundConsumed` is bumped only once `next()` has
      // returned a non-error result.
      //
      // WHAT THAT COUNTER ACTUALLY MEANS — narrowed 2026-08-27 after a real-host
      // measurement, because this comment used to overstate it in both
      // directions and a maintainer editing this seam would have preserved the
      // wrong invariant. It is NOT "egresses that actually went out", and an
      // archive without a matching `consume-manifest` event is NOT "exactly the
      // authorized-but-not-dispatched case":
      //   * `isErrorResult` keys on `isError === true`. A shell tool that exits
      //     non-zero without setting that flag counts as a success here — four
      //     failed `git push` calls incremented the counter with no ref moved.
      //   * Conversely, an error result does not mean nothing was dispatched:
      //     `next()` may run the command and reach the remote before a later
      //     wrapper throws or returns an error.
      // So read the pair as "authorized" vs "authorized and the runtime reported
      // an error". Neither is a statement about whether the egress left the
      // machine. `toolAbortedBeforeDispatchResult()` (a cancel landing after the
      // last caller-cancelled check) IS a genuine pre-dispatch case, but the
      // record cannot distinguish it from a post-dispatch failure.
      const archived = (options.archive ?? archiveConsumed)(
        engine.runDirOf(rootSessionId),
        resolvedManifest,
        command,
        { ...(options.now === undefined ? {} : { now: options.now() }) },
      )
      const result = await next()
      if (!isErrorResult(result)) {
        await engine.recordManifestConsumed(rootSessionId, {
          command,
          archivedAt: archived,
          target: resolvedManifest.target,
        })
      }
      return result
    }))
  } catch (error: unknown) {
    for (const dispose of disposers.reverse()) {
      try {
        dispose()
      } catch {
        // A disposer that throws must not mask the install failure.
      }
    }
    return {
      installed: false,
      dispose: () => {},
      diagnostic: `tools/pre-execute seam unavailable: ${errorMessage(error)}`,
    }
  }

  return {
    installed: true,
    // The seam is ONE entry in its caller's unwind (see `installExecutorChildSurface`),
    // so its caller's per-entry try/catch cannot rescue a listener this loop skipped:
    // an unguarded loop that aborted on the first throw would leave the other listener
    // registered and `authorized` populated, while the caller believed the whole seam
    // was released (Codex P2 on PR #6). Attempt every disposer, always clear the map,
    // and only then report — so a failure is still visible without being silently
    // traded for a half-released seam.
    dispose: () => {
      const failures: unknown[] = []
      // `splice(0)` drains: a second dispose() is a no-op instead of re-reversing
      // and re-invoking the same disposers.
      for (const dispose of disposers.splice(0).reverse()) {
        try {
          dispose()
        } catch (error: unknown) {
          failures.push(error)
        }
      }
      authorized.clear()
      if (failures.length > 0) {
        throw new AggregateError(failures, `tools/pre-execute seam release failed for ${String(failures.length)} listener(s)`)
      }
    },
  }
}
