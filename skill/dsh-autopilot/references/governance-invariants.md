# Governance invariants

This file owns the host-neutral rules this plugin enforces or expects: risk and
audit shape, the audit invariants, task sizing, evidence sufficiency, and
closeout discipline. It is a port of the shared governance layer that the
Claude Code, Codex and Grok goal-autopilot adapters consume
(`agent-core/core/skills/agent-core/references/`), kept host-neutral on purpose.

It does NOT own the DSH tool protocol. Tool names, parameter shapes, phase
transitions, run storage and the refusal codes are in
[reference.md](../../../docs/reference.md), [refusals.md](./refusals.md) and
[DESIGN.md](../../../DESIGN.md).

The adapter is [SKILL.md](../SKILL.md):
it supplies the DSH bindings and routes here for the rules themselves.

## What "enforced" means in this file

Each invariant below is labelled with what actually holds it, because the three
are not interchangeable:

- **engine** — the state machine refuses the transition. A violation cannot be
  written; `events.jsonl` replay re-checks it.
- **test** — a census in `test/` fails the build when the invariant stops
  holding across the repository.
- **discipline** — nothing mechanical observes it. It is a contract on the
  agent and the auditor, and saying so is the honest label.

An invariant labelled **discipline** is not weaker policy. It is a weaker
*instrument*, and the audit layer is where it gets checked.

## Risk levels

| level | shape |
| --- | --- |
| `low` | local, reversible, single concern, straightforward validation |
| `medium` | shared behavior, a validation-sensitive change, or a user-visible workflow change |
| `high` | broad runtime or orchestrator change, real-machine validation, data mutation, external effects |
| `critical` | irreversible, destructive, credential, payment, public release, production, or safety-sensitive |

File count and user visibility raise or lower a level; neither decides it alone.
A tracked, reversible edit may complete at low with deterministic validation and
self-review. Medium and above cannot complete from self-check.

This engine requires a resolved risk at `autopilot_init`. There is no `auto`
state to carry into planning — the Codex GAH keeps `auto` as a temporary value
that may not pass a plan gate; here the equivalent refusal happens one step
earlier and is labelled accordingly.

## Audit modes

| mode | who reviews | legal when |
| --- | --- | --- |
| `independent` | a dispatched isolated-context auditor (`autopilot_audit`) | always |
| `external` | an owner-countersigned review recorded by `autopilot_external_audit` | always, on a direct human turn |
| `self-check` | the same context, labelled | lightweight + low only |

A required independent review cannot be replaced by self-narration. An audit
pass is never owner authorization. The engine enforces the mode/risk pairing at
`autopilot_init` (`AP_TRIAGE_INVALID`) and re-checks provenance at completion —
an `independent` run whose required role closes on a `self-check` record is
refused, because provenance is part of the verdict. **enforced: engine**

## Checker-Resolution Invariant

Before a checker's pass is believed, it must be shown to observe the
corresponding fail and to distinguish every state value it claims to
distinguish. Zero observation is the extreme case; resolution that merely drops
below the claimed distinction fails the same way.

- quantifying over a list also requires a cardinality floor
- comparing two captures fails loudly if either parsed zero rows
- depending on a field as an anchor errors when it is absent, never skips
- "no matches found" first proves the matcher can match something
- an N-valued outcome asserts on the value, not a boolean collapse of it

The instrument deployed must be the one tested. An instrument that has never
emitted is unobserved, not calm.

Mechanized where the engine quantifies: completion requires a non-empty
acceptance list and a non-empty evidence list before it iterates either
(`evaluateCompletion`), and the outbound manifest matcher is exercised against
a known-positive before it is trusted. **enforced: engine (floors) + discipline
(auditor).**

## Moving-Anchor Invariant

An assertion must not be anchored to a value that can move. A fixture that uses
a value *because* it is invalid or unknown must, in the same place, assert that
the value is still outside the known set. A claim that quotes an external count
must pin the revision it was measured at.

This repository's own history is the worked example: DESIGN.md §1 records
counts that were true when written and false one round later, and §8 records
what each measurement was actually taken against. **enforced: discipline, with
test-level cardinality floors where a count is load-bearing.**

## Evidence Sufficiency

Every verifiable claim needs direct, traceable, sufficient evidence that could
have shown the claim false. Multiple artifacts may jointly support one claim
when each names its coverage — what it can and cannot observe. Do not treat two
incomplete witnesses as sufficient if neither could observe the fail. Name the
emitter beside each artifact. When the harness and the subject emit the same
class of evidence, an unlabelled artifact credits the subject with the harness.
If evidence is missing or coverage is unnamed, record UNPROVEN.

The engine mechanizes two of the consequences: an acceptance criterion with no
evidence entry is refused, a criterion with more than one entry is refused
(Single-Bearer), and one proven bearer may not carry two criteria. `unproven`
is a first-class status, not a failure — an honest gap is not a claim. What the
engine cannot see is whether the bearer actually covers the claim; that is the
auditor's job. **enforced: engine (shape) + discipline (coverage).**

## Audit-Packet Rule

An audit packet embeds every required role's latest verdict **read directly from
the run state, verbatim, with non-passes shown explicitly**. The dispatcher does
not summarise or characterise them. Nothing in this rule forces a dispatcher to
run the emitter.

`autopilot_status` returns `latestAuditRecords`: one entry per role that has a
record, carrying the record's own fields rather than a verdict word. Read them
from there; do not retype a verdict from memory. **enforced: engine (supplies
the verbatim records) + discipline (the dispatcher embeds them).**

## Concurrent-Audit Rule

A dispatch that writes the working tree must isolate that write from concurrent
audit measurement. Choose an isolation that actually works at this risk: a clone
or worktree when the writer would otherwise mutate the tree under audit; a
recorded snapshot of the candidate bytes at audit start when the work is already
an uncommitted tree. Measurements taken while an audit may be in flight are
trusted only after the files equal that snapshot — not the last committed
revision, which would reject legitimate uncommitted work. A clone does not by
itself stop a script from opening the original path. Isolation is the fix;
detection is the backstop.

The engine helps only at the edges: it is single-writer (one live root per run),
and the delegated executor is a separate child. It does not isolate the tree for
you. Between an audit dispatch and its verdict, do not mutate the files the
auditor was given. **enforced: discipline.**

## Statement-Artifact Sync Rule

Any count or status a document must state has to be mechanically censused per
site, with the site count recorded, and a site that stops matching is an error.
Prefer deleting a name that will rot over leaving a false label. Correct a claim
at every site, found by concept rather than by the wording just changed.

This repository applies it directly: `test/refusals-contract.test.ts` censuses
the `AP_*` codes in both directions (every code in `src/` is in
`references/refusals.md`, and every code in the doc exists in `src/`), and
`test/references-contract.test.ts` owns the list of invariants this file must
state. **enforced: test.**

## Stated-Contract Invariant

A gate that can refuse must state what it requires **before** it refuses, in the
layer its reader is actually routed to. A contract discoverable only by tripping
the gate is unstated: every caller pays a collision to learn it, and the refusal
teaches only the clause it happened to reach first.

- the precondition lands where the router points, not only in the enforcing code
  or in a governance document this task does not load
- a refusal names the specification and the remedy
- one rule per refusal is the symptom, not the design: state the whole contract
  once
- a gate introduced or changed states its contract in the same change set
- an enforced requirement with no routed statement is a finding against the
  rules layer, not a strong default

Here the routed statement is [refusals.md](./refusals.md), reached from
[reference.md](../../../docs/reference.md) and from the skill. **enforced: test (the
census) + discipline (keeping it true as gates change).**

## Sizing and replanning

| change | what it needs |
| --- | --- |
| Reordering routine steps | nothing |
| Splitting already-audited work into disjoint packages | nothing, while approved assumptions, risk, scope and acceptance paths are unchanged |
| Material plan revision | the applicable independent re-audit, before the affected execution |
| Change to owner authority or scope | the smallest necessary owner decision |

Having many steps is not a reason to open a governed run or add agents; neither
does it select a delegation mode. `size` is a harness label that decides which
gate set applies, not how the work is staffed.

## Delegation

Delegation is task-shaped, not size-mandated. Name the benefit before spawning —
parallelism, specialized access, or context isolation (every independent audit
is this case). "There are many steps" is not one of them.

- The main context owns the goal contract, plan, run-state writes, audit
  dispatch and closeout. A delegated executor implements within the contract and
  never writes run state or audits itself.
- A child packet names: responsibility, context, read/write ownership,
  prerequisites, forbidden surfaces, validation, return format.
- A child may never mutate run state, approve its own gate, or inherit authority
  the parent did not have.
- Parallel writers own disjoint surfaces or are explicitly sequenced.
- `needs-fix` resumes the same canonical executor and generation.

Medium and above default to a delegated executor in the Codex GAH. This adapter
does not: `executionMode` is chosen at `autopilot_init` and `delegated` is
refused for a lightweight run, while `inline` stays legal at every risk because
this engine cannot observe whether an "executor lead" would have been better.
An inline medium+ run still takes the independent reviews its risk requires.
**enforced: engine (mode legality) + discipline (the delegation decision).**

## State and evidence

Use one state owner for one task. Never rewrite an existing serialized run into
another host's shape, and never create a second record that also claims
authority over the same work. Historical evidence is immutable; corrections are
appended.

Three separate questions, never collapsed into one:

- Is this evidence authentic?
- Does it apply to this task?
- Is it sufficient for the claim being made?

Missing evidence is unknown. It is not failure and it is not success. Store
noisy raw output as an artifact; read the decisive evidence yourself rather than
trusting a worker's summary of it.

The engine's append-only event stream makes the history rule structural — audit
records and gate history cannot be edited in place, and replay refuses a
shrunken or modified audit list. **enforced: engine.**

## Closeout

Closeout is stage-scoped while authorized work remains. Report the next ready
action or the bound wait and continue it; do not treat a stage, a PR or a
merge-ready state as overall completion. Overall completion requires the full
contract acceptance and the applicable independent gates.

Every closeout reports: changes made, validation mapped to each acceptance
criterion, required audit decisions, unresolved work, limitations, workspace
cleanup, and prompt/workspace drift (`none found` or exact facts).

Source-ready is not installed. Installed is not activated. Do not report one as
another.

This engine's `autopilot_submit_closeout` completes *the run*. A run that is
one stage of a larger blueprint must still not be opened as if it were the
blueprint — but since governance pragmatics v1 the stage boundary is
mechanical, not prose: unproven criteria force a structured handoff and an
honest `partial` outcome (see Partial Delivery and Carryover below), and the
next stage opens as its own run with `carryover` naming this one.
**enforced: engine (handoff/outcome derivation) + discipline (the engine
cannot see your blueprint).**

## Audit Findings Grading

An audit verdict is a gate decision; findings are its content. Auditors graded
findings in practice (P1/P2/P3 prose) long before the engine could carry them,
and the binary verdict space forced every finding into `pass` (finding lost) or
`needs-replan` (a round burned). The structured channel fixes both ends:

- Every finding carries `severity` (`blocking` / `non-blocking`) and `layer`
  (`plan` / `execution` / `rules`) — how bad, and who owns the fix.
- `pass` may carry non-blocking findings: suggestions ride along without
  burning a round or blocking the gate.
- `needs-replan` requires a blocking plan-layer finding; an execution- or
  rules-layer defect is executor-fixable and belongs in `needs-fix`, where it
  resumes the same executor instead of resetting the run.
- `blocked` requires a blocking finding.

**enforced: engine (pre-commit refusal `AP_AUDIT_FINDINGS_INVALID`; the fold
re-checks the same contract on presence-gated replay).**

## Minimum-Sufficient Admission

A gate admits work, it does not certify perfection. The plan gate asks one
question: is this plan sufficient to execute safely and verifiably against the
declared objective? Process-completeness preferences — more locked values, more
named artifacts, stronger rollback prose than the risk requires — are
non-blocking findings on a pass, not needs-replan rounds. The record is the
counter-evidence: needs-replan findings skewed toward process completeness
across the run history, including a one-file marker task.

The same standard runs at the execution gate: an executor-fixable defect is a
`needs-fix`, and repeated non-converging audits are a cost problem, not a
verdict problem (see Audit-Packet Rule for the diff-against-previous duty).
**enforced: discipline (the admission judgment) + engine (the findings channel
that carries it without burning rounds).**

## Plan Amendment and Delta Re-audit

A plan evolves during execution without destroying execution state.
`autopilot_amend_plan` bumps the plan revision, keeps gates, packet and
executor, and arms a delta re-audit: further evidence and closeout are refused
until a plan-role pass at the amended revision lands. A delta audit that
returns `needs-replan` (with its blocking plan-layer finding) still takes the
full replan path. The objective, scope and acceptance criteria are immutable —
triage is frozen at init — so an amendment re-plans HOW, never WHAT.

A re-audit packet shows what changed since the last audited revision, not the
whole plan again. **enforced: engine (`AP_AMEND_PLAN_INVALID`,
`AP_AMEND_REAUDIT_REQUIRED`; fold-derived `planAmendedAtRevision`).**

## Partial Delivery and Carryover

Delivery states are named, not smoothed over: verified-done (proven),
implemented-unverified, not-implemented, known-limitation. A closeout with any
unproven criterion is a PARTIAL delivery: the engine derives the outcome label,
requires a handoff mapping every unproven criterion to exactly one open item,
and persists the next authorized action. Nothing is lowered — the same gates,
the same single-bearer evidence rules — the gap is carried, not hidden.

The follow-up run declares `carryover` at init: the predecessor must exist and
be completed; what is inherited is named. Historical evidence is inherited, not
re-fabricated: a prior run's settled artifacts are cited with
`inheritedFrom`, and re-proving what a predecessor already proved is waste,
not rigor.
**enforced: engine (`AP_HANDOFF_INVALID`, `AP_CARRYOVER_*`; stamped
`closeoutHandoff: 1` streams only — legacy closeouts keep their reading).**

## Owner-Decision Boundaries

The owner channel exists for questions only the owner can answer: granting
authorization the run does not hold (egress, publishing, new scopes),
arbitrating a policy conflict, ruling on risk the run cannot accept. It does
NOT exist as a mechanical escape for budget exhaustion, audit-round limits, or
test failures — those are engineering problems with engineering remedies.

- Replan-budget exhaustion keeps the run in its replanning lane with the
  exhaustion visible; escalation is a deliberate choice, never automatic.
- An owner pause records where the run was paused from; `resume-execution`
  restores that phase with gates and evidence untouched. A ruling that
  invalidates the plan takes `resume-planning` and the full reset it means.
- After 2 consecutive non-converging needs-replans, EXPLICITLY consider the
  owner channel or split the plan smaller — consider, then decide; do not let
  the meter decide for you.

**enforced: engine (no forced owner escalation; `pausedFrom` derivation;
`AP_OWNER_RESUME_INVALID`) + discipline (the boundary judgment).**

## Red flags

- "The tests pass" with no command, cwd or exit status recorded.
- "This is basically done" while an acceptance condition has no evidence.
- "I reviewed my own change carefully" where an independent review is required.
- "The audit passed, so I can commit / push / publish."
- "There was no output, so nothing was wrong."
- "I rewrote the run state into the shape this host expects."
- "I will spawn a manager to coordinate the workers" where no package justifies
  a lead.
- "The child probably finished; I will proceed on that."
- Declaring a user-visible change `internal` because nothing observes it.
- "The outcome is complete" while a criterion is unproven and un-handed-off.
- A needs-replan that cannot name the blocking plan-layer defect it is for.
- Escalating to the owner because a budget hit zero, not because a question
  only the owner can answer is open.
