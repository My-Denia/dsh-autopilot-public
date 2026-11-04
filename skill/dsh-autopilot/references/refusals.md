# Refusals

This file owns what this plugin refuses, and what each refusal requires in advance.

## How to read a refusal

- The **code** is stable machine text (`AP_*`). Tooling and tests match it; it is not reworded for style.
- The **message** is human context. It names the value that failed, and often the remedy.
- The **contract** is the specification: find the code below, read its row.

`test/refusals-contract.test.ts` censuses the codes in both directions. Every
`AP_*` code in `src/` is in the table below; every code in that
table exists in `src/`; and no code in the retired list exists in `src/`.
The single registry in `src/domain/refusals.ts` is the source of the table.

The goal workflow adds no gate to ordinary own-repo work, so none of these is an
approval to chase: each one names a malformed call, a host mismatch or a
corrupt store.

## Refusals in force

Exactly the 20 codes of the registry in `src/domain/refusals.ts`, in registry order.

| Code | Requires |
| --- | --- |
| `AP_LEDGER_CONFLICT` | the ledger revision stored is the one the writer read; on a conflict reload and retry |
| `AP_LEDGER_BUSY` | the ledger stops changing under the write; the bounded retries ran out, so retry the call later |
| `AP_DISPOSED` | the plugin is not shutting down; no new ledger writes are accepted once it is |
| `AP_NO_AGENT` | the tool call carries a calling agent; the host supplied none |
| `AP_ROLE_ROUTE_NOT_ALLOWED` | the route named by the call or by an owner pin is inside the allowed model set |
| `AP_ROLE_ROUTE_INCOMPLETE` | `provider` and `model` are given together, or neither |
| `AP_ROLE_ROUTE_PREFLIGHT_FAILED` | the host preflight accepts the named route and effort; pick a route or effort it accepts |
| `AP_ROLE_ROUTE_ESCALATE_OWNER` | routing could not choose by itself; the owner arbitrates (name a route or fix the ladder) |
| `AP_ROLE_ROUTE_BLOCKED` | routing finds at least one dispatchable route for this role; none was found |
| `AP_ROLE_VERDICT_INVALID` | the reviewer's structured output validates (verdict `pass`, `needs-fix` or `blocked`, findings with severity and summary, a subject); a `pass` that carries a blocker or major finding is invalid |
| `AP_TOOL_SURFACE_INCOMPLETE` | a narrowed tool surface keeps every tool name the role requires (`read` for read-only roles) and one member of each requested family; a child never runs with a surface that cannot do its job |
| `AP_ROUTE_NO_REACHABLE_WORK_CLASS` | a work class whose mapped ladder tiers leave zero reachable authorized routes blocks the dispatch and says so; it never silently inherits a fallback. Remedy: add provider/model members to the mapped tier(s) or retarget `routing.workClasses.<name>.tiers` |
| `AP_STORE_CORRUPT` | every stored record is an object the store can read; restore from backup, do not hand-edit the store |
| `AP_INVALID_ARGUMENT` | every tool argument is present, well-formed and names something that exists |
| `AP_ROLE_NOT_DISPATCHABLE` | only the root agent or an executor-lead dispatches, and an executor-lead dispatches only `scout`, `clerk` and `worker` |
| `AP_WRITE_PATHS_REQUIRED` | a `worker` dispatch declares the paths it may write (`writePaths`) |
| `AP_WRITE_PATHS_CONFLICT` | the declared `writePaths` do not intersect those of another writer still running (`starting` or `running`) under the same root; a writer that has settled, idle included, frees its paths |
| `AP_UNKNOWN_CHILD` | the child id names a delegation that exists under this root |
| `AP_DISPATCH_FAILED` | the host starts the child; if it refuses, the delegation is recorded as `failed` with the host reason |

## Legacy reader

Runs created before 0.3.0 keep their event streams. `src/legacy` folds them
read-only so the card and `autopilot_status` can still show them. That reader
is frozen and uses its own `LEGACY_` codes, which never reach a live call; a
stream that trips one is shown as unreadable instead of being repaired. Do not
hand-edit `events.jsonl`; restore it from backup.

## Retired codes

These codes belonged to mechanisms removed in 0.3.0 (run phases and gates,
triage, usage ids, auditors, closeout, carryover, the outbound manifest, the
init requirement, the escalation proposal tools, and the 0.2.x event-stream
checks). None of them is among the codes above. They are not raised any more,
and the census fails if one reappears in `src/`. Search results and old logs
may still mention them.

- `AP_AFTER_TERMINAL`
- `AP_ALREADY_ACTIVE`
- `AP_ALREADY_INITIALIZED`
- `AP_AMEND_PLAN_INVALID`
- `AP_AMEND_REAUDIT_REQUIRED`
- `AP_AMEND_STATE_INVALID`
- `AP_AMEND_STATE_MUTATED`
- `AP_AUDITS_MODIFIED`
- `AP_AUDITS_SHRANK`
- `AP_AUDIT_FINDINGS_INVALID`
- `AP_AUDIT_INVALID_VERDICT`
- `AP_AUDIT_NO_VERDICT`
- `AP_AUDIT_ROUND_CAP`
- `AP_BEARER_BASE_EMPTY`
- `AP_BEARER_BASE_MUTATED`
- `AP_BEARER_BASE_RELATIVE`
- `AP_CARRYOVER_INVALID`
- `AP_CARRYOVER_NOT_COMPLETED`
- `AP_CARRYOVER_UNKNOWN`
- `AP_COMPLETION_REFUSED`
- `AP_ESCALATION_NOT_EXECUTOR`
- `AP_EVENT_VERSION`
- `AP_EVIDENCE_KIND_INVALID`
- `AP_EVIDENCE_KIND_REQUIRED`
- `AP_EVIDENCE_KIND_STAMP_INVALID`
- `AP_EXECUTOR_BEFORE_GATE`
- `AP_EXECUTOR_DISPATCH_COUNT`
- `AP_EXECUTOR_EXISTS`
- `AP_EXECUTOR_MISMATCH`
- `AP_EXECUTOR_MUTATED`
- `AP_EXECUTOR_NOT_RUNNING`
- `AP_EXECUTOR_OP`
- `AP_EXECUTOR_REVISION`
- `AP_EXTERNAL_INVALID`
- `AP_EXTERNAL_WRONG_MODE`
- `AP_FIRST_NOT_INIT`
- `AP_GATE_SOURCE_INVALID`
- `AP_GATE_SOURCE_SHRANK`
- `AP_GATE_STAMP_MUTATED`
- `AP_GATE_WITHOUT_AUDIT`
- `AP_GATE_WITH_UNDECLARED_USAGE`
- `AP_HANDOFF_INVALID`
- `AP_HANDOFF_STAMP_INVALID`
- `AP_ILLEGAL_OP`
- `AP_INCOMPLETE_COMPLETION`
- `AP_INIT_AUDITS`
- `AP_INIT_EXECUTOR`
- `AP_INIT_GATES`
- `AP_INIT_PHASE`
- `AP_INIT_REVISION`
- `AP_INIT_ROUTING_PINS`
- `AP_INLINE_REASON_REQUIRED`
- `AP_NOT_INITIALIZED`
- `AP_NOT_LIVE_ROOT`
- `AP_NOT_ROOT`
- `AP_NO_EXECUTOR`
- `AP_NO_PARENT`
- `AP_NO_PLAN`
- `AP_OUTBOUND_ARCHIVE`
- `AP_OWNER_GATE_INVALID`
- `AP_OWNER_GATE_NOT_PASSED`
- `AP_OWNER_GATE_PRECEDENCE`
- `AP_OWNER_GATE_RESURRECTED`
- `AP_OWNER_RESUME_INVALID`
- `AP_PACKET_EXISTS`
- `AP_PACKET_REVISION_MISMATCH`
- `AP_PACKET_REVISION_MUTATED`
- `AP_PACKET_REVISION_REQUIRED`
- `AP_PARENT_NOT_FOUND`
- `AP_PARENT_NOT_ROOT`
- `AP_PAUSE_STATE_INVALID`
- `AP_PLAN_GATE_NOT_PASS`
- `AP_PLAN_REVISION`
- `AP_RESUME_REQUIRES_NEEDS_FIX`
- `AP_REVISION`
- `AP_ROUTING_DETAIL`
- `AP_ROUTING_ESCALATION`
- `AP_ROUTING_PINS`
- `AP_ROUTING_PINS_MUTATED`
- `AP_ROUTING_RECORD_MISMATCH`
- `AP_RUN_ID`
- `AP_STALE_AUDIT`
- `AP_STALE_EVIDENCE`
- `AP_STORE_KEY`
- `AP_SUBAGENT_SURFACE`
- `AP_TOOL_ALLOW_UNAPPLIED`
- `AP_TRIAGE_INVALID`
- `AP_TRIAGE_MUTATED`
- `AP_UNREACHABLE`
- `AP_USAGE_INVALID`
- `AP_USAGE_SHRANK`
- `AP_USAGE_UNDECLARED`
- `AP_WRONG_AUDIT_MODE`
- `AP_WRONG_EXECUTION_MODE`
- `AP_WRONG_PHASE`
