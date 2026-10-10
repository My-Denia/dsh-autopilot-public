# Refusals

This file owns what this plugin's engine refuses, and what each refusal requires in advance.

## How to read a refusal

- The **code** is stable machine text (`AP_*`). Tooling and tests match it; it is not reworded for style.
- The **message** is human context. It names the value that failed, and often the remedy.
- The **contract** is the specification. Find the code in the index at the end, then read its section: that is the whole rule, stated before the refusal, not one clause reconstructed from a collision.

Some rules are observable only at replay, and some only at write. Where that asymmetry exists the section says so. Event-stream format stamps, not the build doing the reading, decide which arm a stream gets.

## 1. Event-stream integrity and replay

The canonical state is the event stream, not the snapshot projection. `applyEvent` in `src/domain/fold.ts` validates every event against the committed prefix before accepting it, so an illegal stream is rejected loudly instead of folding into a silently wrong state. The engine writes through the same rules.

Requires:

- `event.v` is exactly `1`.
- The first event is `init`; a stream carries exactly one `init`.
- The `init` snapshot is the canonical start: revision `1`, phase `planning`, both gates `pending`, empty `audits`, no `executor`, no `routingPins`.
- Revisions are gapless and monotonic: `event.revision` is `prior.revision + 1`, and `snapshot.revision` equals `event.revision`.
- `runId` is stable; `plan.revision` never decreases; `triage` is byte-identical after `init`.
- Audit history is append-only: it never shrinks, and a committed record is never modified (compared with `JSON.stringify`, so key order counts).
- No event follows a terminal phase (`completed`, `blocked`).

Why: a hand-edited file, a buggy writer, or an older build must not fold clean and become the live snapshot on a cold resume.

Remedy: fix the writer or restore the stream; do not hand-edit `events.jsonl`. If an engine op produced the illegal event, report the event and the prior snapshot as a bug.

Codes: `AP_EVENT_VERSION`, `AP_FIRST_NOT_INIT`, `AP_INIT_REVISION`, `AP_INIT_PHASE`, `AP_INIT_GATES`, `AP_INIT_AUDITS`, `AP_INIT_EXECUTOR`, `AP_INIT_ROUTING_PINS`, `AP_ALREADY_INITIALIZED`, `AP_AFTER_TERMINAL`, `AP_REVISION`, `AP_RUN_ID`, `AP_PLAN_REVISION`, `AP_TRIAGE_MUTATED`, `AP_AUDITS_SHRANK`, `AP_AUDITS_MODIFIED`.

## 2. Phase legality

The `LEGAL_OPS` table in `src/domain/fold.ts` is the phase machine. Every op is legal in exactly the phases the table names, and audit phases are narrower still.

Requires:

- The op is a member of `LEGAL_OPS[prior.phase]` (replay arm).
- The engine op is called in a phase that permits it (write arm): `submit-plan` from `planning`/`replanning`; executor start, resume, packet, and evidence from `executing`; closeout from `closing`; owner-resolve from `needs-owner-decision`; replan from any non-terminal phase except `needs-owner-decision`.
- A plan audit runs from `planning`/`replanning` and only after `plan.revision >= 1`; execution-class audits run from `execution-reviewing`/`closing`.

Why: a stream that accepts an op in the wrong phase persists a transition no consumer expects; the same table is the only phase rule both writer and replay share.

Remedy: read the current phase (`autopilot_status`), then drive the legal transition first: submit a plan before auditing it, reach `execution-reviewing` before an execution audit, and use owner-resolve only from `needs-owner-decision`.

Codes: `AP_ILLEGAL_OP`, `AP_WRONG_PHASE`, `AP_NO_PLAN`.

## 3. Bearer base

`bearerBase` is the absolute directory a run's `path` evidence canonicalizes against. `resolveBearerBase` resolves it once from the session working directory and `init` stamps it.

Requires:

- When present, `bearerBase` is non-empty.
- When present, it is absolute-shaped after slash-fold: POSIX `/...`, UNC `//host/share`, or Windows `X:/...`. The write arm fires when the session cwd cannot resolve to an absolute path; the replay arm fires when the stamped value is not absolute-shaped.
- It never changes after `init`.

Why: without a stable absolute base, `./report.txt` and `/workspace/report.txt` cannot be compared, and reverse Single-Bearer can be defeated by spelling.

Remedy: run from an absolute working directory, or set an absolute `storeRoot`/`DSH_AUTOPILOT_HOME`. Do not pass a relative base, and do not edit it after `init`. A run that predates `bearerBase` stays base-less and keeps its legacy reading.

Codes: `AP_BEARER_BASE_EMPTY`, `AP_BEARER_BASE_RELATIVE`, `AP_BEARER_BASE_MUTATED`.

## 4. Gate prerequisites and freshness

Gates are the run's two authorizations: `planGate` (may execution start, and may inline evidence be submitted) and `executionGate` (may the run close). Both are structural, and both are re-derived on replay rather than trusted from the writer.

Requires:

- `planGate === 'pass'` before `start-executor` or `submit-evidence`.
- A `planGate` flip to `pass` leaves no unanswered usage evidence: `usageDeclarationProblems` is empty, at the write (verdict handling) and on replay.
- An `executionGate` flip to `pass` has a latest `execution`-role audit whose verdict is `pass`.
- `planGatePassedAt` is stamped once and never restamped; it is the freshness anchor usage artifacts are measured against.
- A new plan clears stale execution state: `submit-plan` leaves no `executionPacket` and resets `executionGate` to `pending`.
- No executor exists before a `planGate` pass.

Why: the gate is the only place the run says this is authorized. If it can open while a required declaration is missing, or with a stale artifact riding along, the authorization is false.

Remedy: for `AP_PLAN_GATE_NOT_PASS` and `AP_EXECUTOR_BEFORE_GATE`, obtain a plan-audit pass (answering usage if prompted) before starting; for `AP_GATE_WITHOUT_AUDIT`, run an execution audit to a `pass` at the current execution revision; for the replay codes the stream was written wrong, so re-derive it through the engine rather than editing it.

Codes: `AP_PLAN_GATE_NOT_PASS`, `AP_GATE_WITH_UNDECLARED_USAGE`, `AP_GATE_WITHOUT_AUDIT`, `AP_GATE_STAMP_MUTATED`, `AP_STALE_EVIDENCE`, `AP_EXECUTOR_BEFORE_GATE`.

## 5. Completion integrity

`completed` is validated, not asserted. `evaluateCompletion` in `src/domain/types.ts` is the rule; `submit-closeout` runs it with filesystem settlement, and `applyEvent` runs it structurally on every stream that claims the phase.

Requires, to enter `completed`:

- Both gates `pass`; a closeout present; at least one acceptance criterion and at least one evidence entry.
- Every criterion has exactly one evidence entry; every proven entry has a non-empty bearer; one proven bearer bears exactly one criterion (reverse Single-Bearer, keyed by kind plus canonical bearer); every proven entry has a valid kind.
- Closeout `summary`, `workspaceCleanup`, and `drift` are non-empty.
- Every required audit role's latest verdict is `pass`, with provenance consistent with `auditMode`; a delegated run's executor is `completed`.
- Partial-delivery contract (streams stamped `closeoutHandoff: 1`): the outcome label is derived, never trusted — `partial` iff any criterion is unproven; an unproven criterion requires a handoff whose `openItems` map every unproven criterion exactly once; an openItem names a real acceptance criterion; a complete delivery carries no handoff. Unstamped (legacy) closeouts keep the old reading: unproven criteria legal, no handoff required, no outcome recorded.
- The usage question is answered for every entry.
- At the write only: every declared usage artifact settles on disk (exists, non-empty, inside the run directory, not future-stamped, carries the labels it claims), and every external `reviewRef` exists inside the run directory.

Why: a gate that completes without checking the claim is the claim. The structural check is what makes `completed` mean the same thing on replay as at the moment of closeout.

Remedy: `AP_COMPLETION_REFUSED` names every problem in its message; fix each, usually a missing audit role, a criterion without evidence, a reused bearer, a missing artifact, or an unanswered usage entry. `AP_INCOMPLETE_COMPLETION` is the replay arm: the stream reached `completed` without the structure, so it was hand-edited or written by a buggy or older writer; re-derive it. The disk half deliberately does not run on replay, so a run whose artifacts were later deleted still replays.

Codes: `AP_COMPLETION_REFUSED`, `AP_INCOMPLETE_COMPLETION`, `AP_HANDOFF_INVALID`, `AP_HANDOFF_STAMP_INVALID`.

Remedy for the handoff codes: map every unproven criterion to exactly one openItem (state + non-empty note), drop handoffs on complete deliveries, and never hand-write an `outcome` — the engine derives it. The stamp code fires on replay only: a `submit-closeout` that carries a `closeoutHandoff` stamp other than the integer 1 is a corrupt stamp, not an old stream.

## 6. Audit provenance and freshness

An audit verdict is evidence only if it came from a dispatched auditor or a valid countersign, in the mode the run declared, about the revision it claims to review.

Requires:

- The dispatch op matches `triage.auditMode`: `autopilot_audit` only on `independent`, `autopilot_self_check` only on `self-check`, `autopilot_external_audit` only on `external`.
- The child returns structured output; a run with no verdict cannot gate.
- The verdict is in the role's legal set: the plan verdicts for a plan audit, the execution verdicts otherwise.
- The baseline captured at dispatch is unchanged when the verdict arrives: run and plan revision for every audit, plus the executor's `executionRevision` for execution-class audits.
- An external countersign is structurally valid: non-empty reviewer; a run-relative `reviewRef`; `treeHash` absent or 7-64 lowercase hex characters. This is enforced at the write and on replay.
- A countersigned record appears only when `auditMode` is `external` (replay).
- The graded-findings contract (records that carry `findings`): non-empty; every finding has a non-empty summary and a valid `severity`/`layer`; `needs-replan` requires at least one `{severity: 'blocking', layer: 'plan'}` finding — an execution- or rules-layer defect is executor-fixable and belongs in `needs-fix`; `blocked` requires at least one blocking finding; `pass` may carry non-blocking findings. Enforced at the write (pre-commit, so nothing lands) and on presence-gated replay.
- With `governance.maxAuditRoundsPerRole` configured, dispatching the same role beyond the cap is refused — a brake on audit storms that never escalates to the owner by itself.

Why: a self-review recorded as independent, or a verdict about revision N gating revision N+1, is false evidence. Replay rejects the shape because the writer-only version of this rule was already defeated once.

Remedy: re-dispatch the audit at the current revision; use the op that matches the run's mode; supply a well-formed countersign. `self-check` is never legal for medium risk or above and never satisfies an `independent` or `external` run.

Codes: `AP_AUDIT_NO_VERDICT`, `AP_AUDIT_INVALID_VERDICT`, `AP_STALE_AUDIT`, `AP_WRONG_AUDIT_MODE`, `AP_EXTERNAL_INVALID`, `AP_EXTERNAL_WRONG_MODE`, `AP_AUDIT_FINDINGS_INVALID`, `AP_AUDIT_ROUND_CAP`.

Remedy for the findings code: re-dispatch with the verdict the findings actually support — `needs-fix` (carrying the findings) when the defect is executor-fixable, `needs-replan` only with a blocking plan-layer finding named. For the round cap: resolve with the findings recorded, escalate deliberately, or raise the configured cap.

## 7. Executor lifecycle and packet CAS

On a delegated run the executor child is the only writer of the implementation packet, and the packet is bound to exactly one executor generation and revision.

Requires:

- Only `delegated` runs have executor children; inline runs submit evidence directly (and a delegated run may not submit inline evidence).
- `start-executor` requires `planGate` pass and no live executor; an executor in `starting` or `running` cannot be replaced.
- Only a `start-executor` event creates an executor record.
- Executor identity (`childId`, `generation`, `executionRevision`, `route`) is stable; state changes only to a lifecycle terminal; a `replan` may only revoke; completing via an audit requires an `execution`-role `pass` appended in the same commit.
- `start-executor` from a predecessor or from `starting`, and `resume-executor`, carry exactly the `executionRevision`, `generation`, and `childId` the transition allows; resume is `running` to `running` at revision plus one.
- `resume-executor` and `submit-packet` require a live executor in state `running`.
- Only the registered executor child may submit the packet, and only once per revision.
- `submit-packet` declares an integer `executionRevision`; on a current-format stream (a `bearerBase` is present) it also carries `generation` and `childId`. The stamp equals the live executor's, and the folded snapshot retains it.
- Resume is the `needs-fix` channel only: `executionGate` is `needs-fix`, and the latest `execution`/`rules` audit is a `needs-fix` at the current `executionRevision`.

Why: a packet is the executor's claim about the work. Binding it to a generation and revision stops a delayed packet from a revoked generation being accepted by its replacement.

Remedy: for a live-slot or state refusal, wait for the audit cycle to revoke or complete the executor, or resume it through a `needs-fix`; for a revision refusal, resend the packet with the executor's current revision. The replay codes mean the stream contradicts the lifecycle the engine can write.

Codes: `AP_EXECUTOR_OP`, `AP_EXECUTOR_REVISION`, `AP_EXECUTOR_EXISTS`, `AP_EXECUTOR_MUTATED`, `AP_EXECUTOR_NOT_RUNNING`, `AP_NO_EXECUTOR`, `AP_EXECUTOR_MISMATCH`, `AP_PACKET_EXISTS`, `AP_PACKET_REVISION_REQUIRED`, `AP_PACKET_REVISION_MISMATCH`, `AP_PACKET_REVISION_MUTATED`, `AP_RESUME_REQUIRES_NEEDS_FIX`, `AP_WRONG_EXECUTION_MODE`.

## 8. Usage-evidence declaration

Each change id declares how it was actually operated. An `undeclared` entry blocks the plan gate and completion.

Requires:

- A declaration passes `validateUsageEntry`: `gui`, `cli`, and `api-behavior` need at least two boundary states with at least one from `BOUNDARY_MENU`, and at least one artifact; `harness` needs a `test-run` artifact; `unsupported` needs a non-empty `unsupportedReason` and a non-empty `attempted` list; every artifact needs a non-empty `ref`, a non-empty `covers`, labels of at least three trimmed characters, a parsable `capturedAt`, and an `inheritedFrom` of the form `run-id/ref` with no `..`.
- `undeclared` is refused at the plan gate and at executor start.
- Usage is append-or-replace: evidence never disappears and an id is never dropped.
- A present-but-empty `usage` is not legacy-exempt; only an absent dimension is.

Why: `we did not run it` and `we could not run it` must be distinguishable, and a run must not answer the question by deleting it.

Remedy: call `autopilot_usage` for each seeded id until it passes; use `internal` or `docs` when no operation is required; `unsupported` is an honest terminal only with a reason and an attempt list.

Codes: `AP_USAGE_INVALID`, `AP_USAGE_UNDECLARED`, `AP_USAGE_SHRANK`. The gate-flip arm of the same rule is `AP_GATE_WITH_UNDECLARED_USAGE` in section 4.

## 9. Evidence-kind contract

Every proven closeout evidence entry declares what its bearer is, because the shape heuristic that guessed it flipped twice and the writer is the only side that knows.

Requires:

- A proven entry carries `kind: 'path' | 'command'`. `path` folds through `canonicalBearer` against `bearerBase`; `command` is compared trimmed and verbatim.
- The write path requires it: the tool schema requires `kind` on every item, and `submit-closeout` refuses before building the snapshot.
- Replay requires it only for a stream that stamped `evidenceKinds: 1` on its `submit-closeout` event. A stream without the stamp is legacy and a missing kind is legal there; an unknown kind string is refused either way.
- The stamp itself, when present, must be the integer `1`.

Why the asymmetry: replay must not hold an older stream to a rule that did not exist when it was written. The writer states its promise on the event, and replay holds it to exactly that promise.

Remedy: let the engine stamp `evidenceKinds: 1` at closeout; set `kind` on every evidence item (`path` for filesystem artifacts, `command` for commands). Do not set the stamp by hand.

Codes: `AP_EVIDENCE_KIND_REQUIRED` (write always; replay only under `evidenceKinds: 1`), `AP_EVIDENCE_KIND_INVALID` (write and replay, any stamp), `AP_EVIDENCE_KIND_STAMP_INVALID` (replay only).

## 10. Routing records and pins

A `detail.routing` decision on `audit` or `start-executor` is authorization-bearing state, and `routingPins` derive from it through one shared function.

Requires:

- A routing decision is strictly shaped: only the known keys; `role` matches the op; a non-empty `why` list; canonical (trimmed, non-empty) provider, model, and effort fields; a known `authorizationSource`; `unreachable-inherit` is pinless; a pin requires an authorization source; `candidates` entries use the closed vocabularies, and when a pin is present exactly one candidate is `selected` and matches the pin (replay).
- `routingPins` equal `applyRoutingDecision(prior.routingPins, detail.routing)` on a dispatch op, and do not change on any other op (replay).
- A routing detail agrees with the audit or executor record the same commit appends: one dispatch, one role, one route (replay).
- Routing that cannot resolve on the write path pauses the run: it commits a `set-owner-decision` and refuses the dispatch.

Why: a pin authorizes one route and must dispatch that same route. A fabricated or contradictory decision is a hand-edited or foreign stream and is rejected loudly.

Remedy: do not hand-author routing detail; the engine writes it. The replay codes mean the stream is not one this engine wrote. For `AP_ROUTING_ESCALATION`, the run is now `needs-owner-decision`: use `autopilot_signal` owner-resolve to arbitrate.

Codes: `AP_ROUTING_DETAIL`, `AP_ROUTING_PINS`, `AP_ROUTING_PINS_MUTATED`, `AP_ROUTING_RECORD_MISMATCH`, `AP_ROUTING_ESCALATION`.

## 11. Store integrity

The store is the only medium the canonical stream lives on; a record that cannot be read exactly is corruption, not a value to skip.

Requires:

- Every event key is `runId#` plus a fixed-width positive revision that fits the key width.
- Every stored record is an object with `v: 1`, `op`, `revision`, and a `snapshot`; the key's revision equals the record's; every `events.jsonl` line parses as JSON; a domain table record is an object.

Why: skipping a malformed key or record would drop an event out of a canonical stream and let the fold accept a gap-free-looking prefix of a broken run.

Remedy: restore the stream from backup or start a new run; do not hand-edit the store. A key-width overflow is a protocol ceiling, not a fixable input.

Codes: `AP_STORE_CORRUPT`, `AP_STORE_KEY`.

## 12. Run lifecycle and initialization

One session carries one run, and a finished run does not recycle.

Requires:

- `init` only when the session has no run, or its run is terminal (`completed`/`blocked`): a non-terminal run refuses as active, a terminal run refuses as exhausted.
- Every engine op requires an initialized run.
- The engine is not disposed.
- `validateTriage` passes at init: a non-empty objective, at least one acceptance criterion, `self-check` only for `lightweight` plus `low`, no self-review at medium risk or above, and `lightweight` always `inline`.

Why: the one-run-per-session rule is what keeps `runId` a stable identity and the stream the single writer's record.

Remedy: finish or abandon the active run and start a new session for a new run; call `autopilot_init` first; fix the named triage combination.

Codes: `AP_ALREADY_ACTIVE`, `AP_RUN_EXHAUSTED`, `AP_NOT_INITIALIZED`, `AP_DISPOSED`, `AP_TRIAGE_INVALID`.

Carryover (governance pragmatics v1): a run may declare at init that it continues a COMPLETED predecessor's authorized work.

Requires:

- `carryover.fromRunId`, `carryover.note` non-empty; `carryover.inherits` a non-empty array of non-empty strings (shape, enforced at init and on replay).
- At the write only: the predecessor run exists in the store (`AP_CARRYOVER_UNKNOWN`) and its phase is `completed` (`AP_CARRYOVER_NOT_COMPLETED`) — the filesystem question is settled once, at init; replay checks shape only, so it never depends on another run's directory surviving.

Why: carryover is a claim about ancestry, and triage is immutable after init — the fold's byte-identical triage rule is what keeps a run from retconning its predecessor mid-flight.

Remedy: point `carryoverFromRunId` at a completed run in the same store, or drop the carryover declaration.

Codes: `AP_CARRYOVER_INVALID`, `AP_CARRYOVER_UNKNOWN`, `AP_CARRYOVER_NOT_COMPLETED`.

## 13. Root, agent, and owner authority

The topology is fixed: one top-level root per run, and an executor child that hangs directly off it. Owner actions are reserved for a human turn on the root.

Requires:

- A tool call carries a calling Agent.
- The caller is the live registered root and has no parent session.
- An executor child is the live registered child, with a parent session whose agent is registered and top-level.
- Owner-only ops (`autopilot_external_audit`, `owner-approve`, `owner-resolve`) run in the root's current turn window with a `user/message` whose source kind is `user`.

Why: the engine is single-writer per run. An agent-generated turn or a nested caller cannot be distinguished from a delegated action, so owner authority has to be observable in the log.

Remedy: call the tools on the real top-level root; run owner ops from a human turn; do not hand an owner op to a subagent.

Codes: `AP_NO_AGENT`, `AP_NOT_LIVE_ROOT`, `AP_NOT_ROOT`, `AP_NO_PARENT`, `AP_PARENT_NOT_FOUND`, `AP_PARENT_NOT_ROOT`, `AP_OWNER_AUTHORITY_REQUIRED`.

## 14. Outbound manifest

Egress is authorized by a manifest, and a consumed manifest must be recorded as spent before the command is allowed.

Requires:

- A consumed manifest is archived under `outbound/consumed/` in the run directory; if the archive write fails, the egress is refused.

Why: archive-first-then-allow. Otherwise a manifest authorizes an egress that nothing records as spent, and the no-replay ceiling is unobservable.

Remedy: fix run-directory writability or permissions. The dispatch is not authorized until the archive lands.

Codes: `AP_OUTBOUND_ARCHIVE`.

## 15. Tool surface and argument validity

The dispatch surface and the named arguments are checked before work starts, so a child never runs with a surface that cannot do its job and a malformed argument never reaches the engine.

Requires:

- A narrowed dispatch surface keeps every required name and at least one registered member of each requested tool family. A name the deployment does not register is dropped with a recorded diagnostic, but a required name or a whole family refuses. An unknown registry passes the request through unchanged.
- Named arguments satisfy their stated shape: plan text, audit prompt, and log text are non-empty; an `escalate` checkpoint carries a note; an external countersign carries a note; an approval target is non-empty; `ownerDecision` is an enum member; a tool action is a declared action.
- Every verdict the engine receives is handled; the default arm is a bug, not a caller input error.

Why: a silently narrowed auditor that read nothing still returns a schema-valid `pass`; refusing the drop is the only honest outcome.

Remedy: widen the deployment registration or the requested surface, or supply the missing argument. `AP_UNREACHABLE` should be reported with the input that reached it; the tool schema rejects unknown actions before that arm, so it is a defensive default.

Codes: `AP_TOOL_SURFACE_INCOMPLETE`, `AP_INVALID_ARGUMENT`, `AP_UNREACHABLE`.

## 16. Governance pragmatics: amendment and pause/resume derivations

Two fold-derived dimensions (governance pragmatics v1) hold the writer to arithmetic the stream can re-check, exactly like `routingPins`.

The amendment dimension (`planAmendedAtRevision`):

- `amend-plan` advances the plan revision by exactly 1, requires `planGate` pass on both sides, preserves `executionGate` and the execution packet, and arms `planAmendedAtRevision` at the new revision (`AP_AMEND_PLAN_INVALID`).
- The binding is cleared ONLY by a plan-role `pass` recorded at or after the amended revision — the delta re-audit — and by the full-replan paths (`submit-plan`, `replan`, `owner-resolve` resume-planning/block); every other op must leave it byte-identical (`AP_AMEND_STATE_INVALID`, `AP_AMEND_STATE_MUTATED`).
- While the binding is armed, `submit-evidence` and `submit-closeout` are refused (`AP_AMEND_REAUDIT_REQUIRED`): a plan change is always re-audited before further execution lands — but the execution state is never wiped. That is the difference between amending and replanning.

The pause dimension (`pausedFrom`, presence-gated like the findings field):

- Entering `needs-owner-decision` stamps the phase being left; staying paused keeps it; leaving clears it (`AP_PAUSE_STATE_INVALID`). Streams that never carry the field — every pre-pause-tracking stream — keep their old reading.
- `owner-resolve` with decision `resume-execution` requires a stamped `pausedFrom` of `executing` or `execution-reviewing`, restores exactly that phase, and must not touch the gates, the execution packet, or the executor record (`AP_OWNER_RESUME_INVALID`).

Why: the m6-live incident recorded a run parked at `needs-owner-decision` by replan-budget exhaustion with every gate still valid — and the only exit destroyed all of it. The derivations make "the pause asked a question; the answer must not destroy still-valid state" checkable from the stream alone.

Remedy: for amendment codes, land the delta re-audit (a plan-role `pass` at the amended revision) before submitting evidence; for resume codes, use `resume-planning` when the ruling actually invalidates the plan, `resume-execution` when it does not.

Codes: `AP_AMEND_PLAN_INVALID`, `AP_AMEND_REAUDIT_REQUIRED`, `AP_AMEND_STATE_INVALID`, `AP_AMEND_STATE_MUTATED`, `AP_PAUSE_STATE_INVALID`, `AP_OWNER_RESUME_INVALID`.

## Index

Every `AP_*` code that appears under `src/**`, its contract, and the one-line precondition. Contract numbers refer to the sections above.

| Code | Contract | Precondition |
| --- | --- | --- |
| `AP_AFTER_TERMINAL` | 1 | no event may follow a terminal phase (`completed` or `blocked`) |
| `AP_ALREADY_ACTIVE` | 12 | `init` requires that the session has no non-terminal run |
| `AP_ALREADY_INITIALIZED` | 1 | a stream carries exactly one `init` event |
| `AP_AMEND_PLAN_INVALID` | 16 | `amend-plan` advances the plan revision by 1, keeps gates/packet, requires `planGate` pass |
| `AP_AMEND_REAUDIT_REQUIRED` | 16 | evidence and closeout wait for a plan-role pass at or after the amended revision |
| `AP_AMEND_STATE_INVALID` | 16 | `planAmendedAtRevision` follows its fold derivation (armed by amend, cleared by delta pass or full replan) |
| `AP_AMEND_STATE_MUTATED` | 16 | `planAmendedAtRevision` changes only via `amend-plan` and plan-role passes |
| `AP_AUDIT_FINDINGS_INVALID` | 6 | findings (when present) satisfy the graded contract; `needs-replan` names a blocking plan-layer finding |
| `AP_AUDIT_INVALID_VERDICT` | 6 | the verdict is in the audit role's legal set |
| `AP_AUDIT_NO_VERDICT` | 6 | a dispatched audit returns structured output |
| `AP_AUDIT_ROUND_CAP` | 6 | same-role dispatches stay within `governance.maxAuditRoundsPerRole` when configured |
| `AP_AUDITS_MODIFIED` | 1 | a committed audit record is never modified (`JSON.stringify` equality) |
| `AP_AUDITS_SHRANK` | 1 | audit history never shrinks |
| `AP_BEARER_BASE_EMPTY` | 3 | `bearerBase`, when present, is non-empty |
| `AP_BEARER_BASE_MUTATED` | 3 | `bearerBase` is write-once after `init` |
| `AP_BEARER_BASE_RELATIVE` | 3 | `bearerBase` is absolute-shaped (`/`, `//`, or `X:/` after slash-fold) |
| `AP_CARRYOVER_INVALID` | 12 | `carryover` (when declared) has non-empty `fromRunId`/`note` and a non-empty `inherits` array |
| `AP_CARRYOVER_NOT_COMPLETED` | 12 | the carryover predecessor's phase is `completed` (write path) |
| `AP_CARRYOVER_UNKNOWN` | 12 | the carryover predecessor run exists in the store (write path) |
| `AP_COMPLETION_REFUSED` | 5 | completion passes the full structural and on-disk settlement check |
| `AP_DISPOSED` | 12 | the engine is not disposed |
| `AP_EVIDENCE_KIND_INVALID` | 9 | an evidence kind is exactly `path` or `command` (any stamp) |
| `AP_EVIDENCE_KIND_REQUIRED` | 9 | a proven entry carries a kind; write always, replay only under `evidenceKinds:1` |
| `AP_EVIDENCE_KIND_STAMP_INVALID` | 9 | the `submit-closeout` `evidenceKinds` stamp is the integer `1` |
| `AP_EVENT_VERSION` | 1 | `event.v` is exactly `1` |
| `AP_EXECUTOR_BEFORE_GATE` | 4 | `start-executor` runs only with prior `planGate` pass |
| `AP_EXECUTOR_EXISTS` | 7 | no live (`starting` or `running`) executor exists at `start-executor` |
| `AP_EXECUTOR_MISMATCH` | 7 | the caller is the live registered executor child the run names |
| `AP_EXECUTOR_MUTATED` | 7 | executor identity is stable and state changes only to a lifecycle terminal |
| `AP_EXECUTOR_NOT_RUNNING` | 7 | `resume-executor` and `submit-packet` require executor state `running` |
| `AP_EXECUTOR_OP` | 7 | only a `start-executor` event creates an executor record |
| `AP_EXECUTOR_REVISION` | 7 | start and resume carry the exact `executionRevision`, `generation`, and `childId` the transition allows |
| `AP_EXTERNAL_INVALID` | 6 | an external countersign is structurally valid (reviewer, run-relative `reviewRef`, optional 7-64 lowercase hex `treeHash`) |
| `AP_EXTERNAL_WRONG_MODE` | 6 | a countersigned audit record appears only when `auditMode` is `external` |
| `AP_FIRST_NOT_INIT` | 1 | the first event is `init` |
| `AP_GATE_STAMP_MUTATED` | 4 | `planGatePassedAt` is stamped once and never restamped |
| `AP_GATE_WITH_UNDECLARED_USAGE` | 4 | a `planGate` flip to `pass` leaves no unanswered usage evidence |
| `AP_GATE_WITHOUT_AUDIT` | 4 | an `executionGate` flip to `pass` has a latest `execution`-role audit `pass` |
| `AP_HANDOFF_INVALID` | 5 | the partial-delivery contract holds: outcome derived, unproven criteria bijectively handed off |
| `AP_HANDOFF_STAMP_INVALID` | 5 | the `submit-closeout` `closeoutHandoff` stamp is the integer `1` |
| `AP_ILLEGAL_OP` | 2 | the op is a member of `LEGAL_OPS[prior.phase]` |
| `AP_INCOMPLETE_COMPLETION` | 5 | a snapshot claiming `completed` passes the structural completion check on replay |
| `AP_INIT_AUDITS` | 1 | the `init` snapshot has an empty `audits` list |
| `AP_INIT_EXECUTOR` | 1 | the `init` snapshot has no `executor` |
| `AP_INIT_GATES` | 1 | the `init` snapshot has both gates `pending` |
| `AP_INIT_PHASE` | 1 | the `init` snapshot is in phase `planning` |
| `AP_INIT_REVISION` | 1 | the `init` event and snapshot are at revision `1` |
| `AP_INIT_ROUTING_PINS` | 1 | the `init` snapshot carries no `routingPins` |
| `AP_INVALID_ARGUMENT` | 15 | the named argument is present and satisfies its stated shape |
| `AP_NO_AGENT` | 13 | the tool call carries a calling Agent |
| `AP_NO_EXECUTOR` | 7 | the op requires an executor record (resume or submit) |
| `AP_NO_PARENT` | 13 | the executor child has a parent session |
| `AP_NO_PLAN` | 2 | a plan audit runs only after `plan.revision >= 1` in `planning` or `replanning` |
| `AP_NOT_INITIALIZED` | 12 | the op requires an existing run on the session |
| `AP_NOT_LIVE_ROOT` | 13 | the caller is the live registered root |
| `AP_NOT_ROOT` | 13 | the root is top-level (no parent session) |
| `AP_OUTBOUND_ARCHIVE` | 14 | a consumed manifest archives successfully before the egress is allowed |
| `AP_OWNER_AUTHORITY_REQUIRED` | 13 | the owner-only op runs on a direct human turn in the root's current turn window |
| `AP_OWNER_RESUME_INVALID` | 16 | `owner-resolve(resume-execution)` restores a stamped `pausedFrom` without touching state |
| `AP_PACKET_EXISTS` | 7 | no `executionPacket` is already present for this revision |
| `AP_PACKET_REVISION_MISMATCH` | 7 | the packet stamp equals the live executor's `executionRevision`, `generation`, and `childId` |
| `AP_PACKET_REVISION_MUTATED` | 7 | the folded snapshot retains the stamped `executionRevision` |
| `AP_PACKET_REVISION_REQUIRED` | 7 | `submit-packet` declares an integer `executionRevision`, plus `generation` and `childId` on current-format streams |
| `AP_PAUSE_STATE_INVALID` | 16 | `pausedFrom` is stamped on entering `needs-owner-decision`, kept while paused, cleared on leaving |
| `AP_PARENT_NOT_FOUND` | 13 | the executor child's parent is a registered agent |
| `AP_PARENT_NOT_ROOT` | 13 | the executor child's parent is top-level |
| `AP_PLAN_GATE_NOT_PASS` | 4 | `planGate` is `pass` before an executor starts or inline evidence is submitted |
| `AP_PLAN_REVISION` | 1 | `plan.revision` never decreases |
| `AP_RESUME_REQUIRES_NEEDS_FIX` | 7 | resume requires `executionGate` `needs-fix` and a latest `execution`/`rules` `needs-fix` at the current `executionRevision` |
| `AP_REVISION` | 1 | `event.revision` is `prior.revision + 1` and `snapshot.revision` equals `event.revision` |
| `AP_ROUTING_DETAIL` | 10 | dispatch `detail.routing` matches the strict routing-decision shape |
| `AP_ROUTING_ESCALATION` | 10 | unresolvable routing pauses the run to `needs-owner-decision` instead of dispatching |
| `AP_ROUTING_PINS` | 10 | `routingPins` equal `applyRoutingDecision(prior.routingPins, detail.routing)` on a dispatch op |
| `AP_ROUTING_PINS_MUTATED` | 10 | `routingPins` change only via `audit` or `start-executor` `detail.routing` |
| `AP_ROUTING_RECORD_MISMATCH` | 10 | `detail.routing` agrees with the audit or executor record the same commit appends |
| `AP_RUN_EXHAUSTED` | 12 | `init` requires a session that does not already carry a finished run |
| `AP_RUN_ID` | 1 | `runId` is stable across the stream |
| `AP_STALE_AUDIT` | 6 | the audit baseline (run and plan revision; `executionRevision` for execution-class) is unchanged since dispatch |
| `AP_STALE_EVIDENCE` | 4 | `submit-plan` leaves no `executionPacket` and resets `executionGate` to `pending` |
| `AP_STORE_CORRUPT` | 11 | every stored record and key is well-formed and self-consistent |
| `AP_STORE_KEY` | 11 | an event key holds a positive integer revision within the fixed key width |
| `AP_TOOL_SURFACE_INCOMPLETE` | 15 | a dispatch surface keeps every required name and at least one member per requested family |
| `AP_TRIAGE_INVALID` | 12 | triage satisfies the combination rules at `init` |
| `AP_TRIAGE_MUTATED` | 1 | `triage` is byte-identical after `init` |
| `AP_UNREACHABLE` | 15 | every verdict is handled by the engine (defensive; not a caller input error) |
| `AP_USAGE_INVALID` | 8 | a usage entry satisfies the rules of its class |
| `AP_USAGE_SHRANK` | 8 | usage entries are append-or-replace and ids are never dropped |
| `AP_USAGE_UNDECLARED` | 8 | `start-executor` and the plan gate require every usage entry answered |
| `AP_WRONG_AUDIT_MODE` | 6 | the audit op matches `triage.auditMode` |
| `AP_WRONG_EXECUTION_MODE` | 7 | executor children exist only on delegated runs; inline `submit-evidence` only on inline runs |
| `AP_WRONG_PHASE` | 2 | the write op is called in a phase that permits it |

