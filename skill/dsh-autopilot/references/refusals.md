# Refusals

This file owns what this plugin refuses, and what each refusal requires in advance.

## How to read a refusal

- The **code** is stable machine text (`AP_*`). Tooling and tests match it; it is not reworded for style.
- The **message** is human context. It names the value that failed, and often the remedy.
- The **contract** is the specification: find the code below, read its row.

`test/refusals-contract.test.ts` censuses the codes in both directions. Every
`AP_*` code in `src/` is in one of the two tables below; every code in those
tables exists in `src/`; and no code in the retired list exists in `src/`.

The goal workflow adds no gate to ordinary own-repo work, so none of these is an
approval to chase: each one names a malformed call, a host mismatch or a
corrupt store.

## Refusals in force

| Code | Requires |
| --- | --- |
| `AP_DISPOSED` | the engine is not disposed |
| `AP_ESCALATION_NOT_EXECUTOR` | only a live, running child of the caller may record an escalation proposal; it never writes anything else |
| `AP_EXECUTOR_MISMATCH` | the caller is the live registered child the ledger names |
| `AP_EXECUTOR_NOT_RUNNING` | a message or result for a child needs that child to be running |
| `AP_INVALID_ARGUMENT` | the named argument is present and has its stated shape |
| `AP_NOT_LIVE_ROOT` | ledger writes come from the live registered top-level agent |
| `AP_NOT_ROOT` | the caller is top-level (no parent session) where the tool is main-agent only |
| `AP_NO_AGENT` | the tool call carries a calling agent |
| `AP_NO_EXECUTOR` | the operation names a child the ledger knows |
| `AP_OWNER_AUTHORITY_REQUIRED` | an owner-explicit ledger action (such as clearing a legacy archive) runs on a direct human turn |
| `AP_ROUTE_NO_REACHABLE_WORK_CLASS` | a work class whose mapped ladder tiers leave zero reachable routes blocks the dispatch and says so; it never silently inherits a fallback. Remedy: add provider/model members to the mapped tier(s) or retarget `routing.workClasses.<name>.tiers` |
| `AP_STORE_CORRUPT` | every stored record and key is well-formed and self-consistent; restore from backup, do not hand-edit the store |
| `AP_STORE_KEY` | an event key holds a positive integer revision within the fixed key width |
| `AP_SUBAGENT_SURFACE` | child start uses a host subagent method that exists (`startActivation` and the matching drain, or the older `start`/`startContinuable`). A missing method is a host mismatch, not a retry |
| `AP_TOOL_ALLOW_UNAPPLIED` | the child's tool allow-list is applied before its prompt runs; an unapplied list refuses the start |
| `AP_TOOL_SURFACE_INCOMPLETE` | a narrowed dispatch surface keeps every required name and one member of each requested family; a child never runs with a surface that cannot do its job |
| `AP_UNREACHABLE` | defensive default arm; report it with the input that reached it, it is not a caller input error |

## Legacy reader

Runs created before 0.3.0 keep their event streams. The reader folds them
read-only so the card and `autopilot_status` can still show them. These codes
are raised only while reading such a stream, never for new work, and a stream
that trips one is shown as unreadable instead of being repaired. Do not
hand-edit `events.jsonl`; restore it from backup.

| Code | Requires |
| --- | --- |
| `AP_AFTER_TERMINAL` | no event may follow a terminal phase (`completed` or `blocked`) |
| `AP_ALREADY_INITIALIZED` | a stream carries exactly one `init` event |
| `AP_AMEND_PLAN_INVALID` | `amend-plan` advances the plan revision by 1, keeps gates/packet, requires `planGate` pass |
| `AP_AMEND_REAUDIT_REQUIRED` | evidence and closeout wait for a plan-role pass at or after the amended revision |
| `AP_AMEND_STATE_INVALID` | `planAmendedAtRevision` follows its fold derivation (armed by amend, cleared by delta pass or full replan) |
| `AP_AMEND_STATE_MUTATED` | `planAmendedAtRevision` changes only via `amend-plan` and plan-role passes |
| `AP_AUDITS_MODIFIED` | a committed audit record is never modified (`JSON.stringify` equality) |
| `AP_AUDITS_SHRANK` | audit history never shrinks |
| `AP_AUDIT_FINDINGS_INVALID` | findings (when present) satisfy the graded contract; `needs-replan` names a blocking plan-layer finding |
| `AP_BEARER_BASE_EMPTY` | `bearerBase`, when present, is non-empty |
| `AP_BEARER_BASE_MUTATED` | `bearerBase` is write-once after `init` |
| `AP_BEARER_BASE_RELATIVE` | `bearerBase` is absolute-shaped (`/`, `//`, or `X:/` after slash-fold) |
| `AP_CARRYOVER_INVALID` | `carryover` (when declared) has non-empty `fromRunId`/`note` and a non-empty `inherits` array |
| `AP_EVENT_VERSION` | `event.v` is exactly `1` |
| `AP_EVIDENCE_KIND_STAMP_INVALID` | the `submit-closeout` `evidenceKinds` stamp is the integer `1` |
| `AP_EXECUTOR_BEFORE_GATE` | `start-executor` runs only with prior `planGate` pass |
| `AP_EXECUTOR_DISPATCH_COUNT` | `executorDispatches` equals this run's own dispatch count — one per NEW child id, the executor rotation ordinal |
| `AP_EXECUTOR_EXISTS` | no live (`starting` or `running`) executor exists at `start-executor` |
| `AP_EXECUTOR_MUTATED` | executor identity is stable and state changes only to a lifecycle terminal |
| `AP_EXECUTOR_OP` | only a `start-executor` event creates an executor record |
| `AP_EXECUTOR_REVISION` | start and resume carry the exact `executionRevision`, `generation`, and `childId` the transition allows |
| `AP_EXTERNAL_INVALID` | an external countersign is structurally valid (reviewer, run-relative `reviewRef`, optional 7-64 lowercase hex `treeHash`) |
| `AP_EXTERNAL_WRONG_MODE` | a countersigned audit record appears only when `auditMode` is `external` |
| `AP_FIRST_NOT_INIT` | the first event is `init` |
| `AP_GATE_SOURCE_INVALID` | `gateSources` equals the fold's derivation (owner decisions by generation and ordinal; audit/self-check verdicts otherwise) |
| `AP_GATE_SOURCE_SHRANK` | `gateSources` never disappears once recorded |
| `AP_GATE_STAMP_MUTATED` | `planGatePassedAt` is stamped once and never restamped |
| `AP_GATE_WITHOUT_AUDIT` | an `executionGate` flip to `pass` has a latest `execution`-role audit `pass`, or an in-force owner pass for this generation |
| `AP_GATE_WITH_UNDECLARED_USAGE` | a `planGate` flip to `pass` leaves no unanswered usage evidence |
| `AP_HANDOFF_INVALID` | the partial-delivery contract holds: outcome derived, unproven criteria bijectively handed off |
| `AP_HANDOFF_STAMP_INVALID` | the `submit-closeout` `closeoutHandoff` stamp is the integer `1` |
| `AP_ILLEGAL_OP` | the op is a member of `LEGAL_OPS[prior.phase]` |
| `AP_INCOMPLETE_COMPLETION` | a snapshot claiming `completed` passes the structural completion check on replay |
| `AP_INIT_AUDITS` | the `init` snapshot has an empty `audits` list |
| `AP_INIT_EXECUTOR` | the `init` snapshot has no `executor` |
| `AP_INIT_GATES` | the `init` snapshot has both gates `pending` |
| `AP_INIT_PHASE` | the `init` snapshot is in phase `planning` |
| `AP_INIT_REVISION` | the `init` event and snapshot are at revision `1` |
| `AP_INIT_ROUTING_PINS` | the `init` snapshot carries no `routingPins` |
| `AP_OWNER_GATE_INVALID` | a gate action names exactly one gate, in a phase and shape that allow it, without moving the other gate |
| `AP_OWNER_GATE_NOT_PASSED` | `owner-gate-withdraw` targets a gate the owner actually passed and has not already withdrawn |
| `AP_OWNER_GATE_PRECEDENCE` | an owner pass stands against a later audit objection: the objection is recorded, the gate does not move |
| `AP_OWNER_GATE_RESURRECTED` | a withdrawn owner decision cannot come back into force; only a higher ordinal may read `owner` again |
| `AP_OWNER_RESUME_INVALID` | `owner-resolve(resume-execution)` restores a stamped `pausedFrom` without touching state |
| `AP_PACKET_REVISION_MISMATCH` | the packet stamp equals the live executor's `executionRevision`, `generation`, and `childId` |
| `AP_PACKET_REVISION_MUTATED` | the folded snapshot retains the stamped `executionRevision` |
| `AP_PACKET_REVISION_REQUIRED` | `submit-packet` declares an integer `executionRevision`, plus `generation` and `childId` on current-format streams |
| `AP_PAUSE_STATE_INVALID` | `pausedFrom` is stamped on entering `needs-owner-decision`, kept while paused, cleared on leaving |
| `AP_PLAN_REVISION` | `plan.revision` never decreases |
| `AP_REVISION` | `event.revision` is `prior.revision + 1` and `snapshot.revision` equals `event.revision` |
| `AP_ROUTING_DETAIL` | dispatch `detail.routing` matches the strict routing-decision shape |
| `AP_ROUTING_PINS` | `routingPins` equal `applyRoutingDecision(prior.routingPins, detail.routing)` on a dispatch op |
| `AP_ROUTING_PINS_MUTATED` | `routingPins` change only via `audit` or `start-executor` `detail.routing` |
| `AP_ROUTING_RECORD_MISMATCH` | `detail.routing` agrees with the audit or executor record the same commit appends |
| `AP_RUN_ID` | `runId` is stable across the stream |
| `AP_STALE_EVIDENCE` | `submit-plan` leaves no `executionPacket` and resets `executionGate` to `pending` |
| `AP_TRIAGE_MUTATED` | `triage` is byte-identical after `init` |
| `AP_USAGE_SHRANK` | usage entries are append-or-replace and ids are never dropped |

## Retired codes

These codes belonged to mechanisms removed in 0.3.0 (run phases and gates,
triage, usage ids, auditors, closeout, carryover, the outbound manifest, the
init requirement). They are not raised any more, and the census fails if one
reappears in `src/`. Search results and old logs may still mention them.


- `AP_ALREADY_ACTIVE`
- `AP_AUDIT_INVALID_VERDICT`
- `AP_AUDIT_NO_VERDICT`
- `AP_AUDIT_ROUND_CAP`
- `AP_CARRYOVER_NOT_COMPLETED`
- `AP_CARRYOVER_UNKNOWN`
- `AP_COMPLETION_REFUSED`
- `AP_EVIDENCE_KIND_INVALID`
- `AP_EVIDENCE_KIND_REQUIRED`
- `AP_INLINE_REASON_REQUIRED`
- `AP_NOT_INITIALIZED`
- `AP_NO_PARENT`
- `AP_NO_PLAN`
- `AP_OUTBOUND_ARCHIVE`
- `AP_PACKET_EXISTS`
- `AP_PARENT_NOT_FOUND`
- `AP_PARENT_NOT_ROOT`
- `AP_PLAN_GATE_NOT_PASS`
- `AP_RESUME_REQUIRES_NEEDS_FIX`
- `AP_ROUTING_ESCALATION`
- `AP_STALE_AUDIT`
- `AP_TRIAGE_INVALID`
- `AP_USAGE_INVALID`
- `AP_USAGE_UNDECLARED`
- `AP_WRONG_AUDIT_MODE`
- `AP_WRONG_EXECUTION_MODE`
- `AP_WRONG_PHASE`
