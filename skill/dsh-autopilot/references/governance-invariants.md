# Invariants that still hold

This file owns the host-neutral rules the DSH adapter still relies on:
checker resolution, evidence, review findings and delegation. The goal workflow
itself is in [SKILL.md](../SKILL.md); it is the DSH adapter of agent-core's
`goal-workflow`.

The run state machine this file used to describe (risk levels, audit modes,
plan and execution gates, closeout, partial delivery, owner gates) is retired
in 0.3.0. The reason and what carries each problem now are in
[DESIGN.md §8.10](../../../DESIGN.md). Rules that only existed to feed those
gates were deleted, not kept as prose.

It does NOT own tool names or parameters. Those are in
[reference.md](../../../docs/reference.md); the refusal codes are in
[refusals.md](./refusals.md).

## What "enforced" means in this file

- **test**: a census in `test/` fails the build when the invariant stops holding.
- **discipline**: nothing mechanical observes it. It is a contract on the agent
  and the reviewer, and saying so is the honest label.

## Checker-Resolution Invariant

Before a checker's pass is believed, it must be shown to observe the
corresponding fail and to distinguish every state value it claims to
distinguish. Zero observation is the extreme case; resolution that merely drops
below the claimed distinction fails the same way.

- quantifying over a list also requires a cardinality floor
- comparing two captures fails loudly if either parsed zero rows
- "no matches found" first proves the matcher can match something
- an N-valued outcome asserts on the value, not a boolean collapse of it

The instrument deployed must be the one tested. An instrument that has never
emitted is unobserved, not calm. **enforced: discipline, with cardinality floors
in the censuses under `test/`.**

## Moving-Anchor Invariant

An assertion must not be anchored to a value that can move. A fixture that uses
a value because it is invalid or unknown must, in the same place, assert that
the value is still outside the known set. A claim that quotes an external count
must pin the revision it was measured at. **enforced: discipline.**

## Evidence Sufficiency

Every verifiable claim needs direct, traceable, sufficient evidence that could
have shown the claim false. Multiple artifacts may jointly support one claim
when each names its coverage: what it can and cannot observe. Name the emitter
beside each artifact; when the harness and the subject emit the same class of
evidence, an unlabelled artifact credits the subject with the harness. If
evidence is missing or coverage is unnamed, say it is unverified. A mock run, a
status read or a passing test is not a real-host observation. **enforced:
discipline.**

## Statement-Artifact Sync Rule

Any count or status a document must state has to be mechanically censused per
site, and a site that stops matching is an error. Prefer deleting a name that
will rot over leaving a false label. Correct a claim at every site, found by
concept rather than by the wording just changed.

`test/refusals-contract.test.ts` censuses the `AP_*` codes in both directions
against the list in `src/`; `test/references-contract.test.ts` owns the list of
invariants this file must state. **enforced: test.**

## Stated-Contract Invariant

A refusal that can happen must state what it requires before it refuses, in the
layer its reader is routed to. A contract discoverable only by tripping the
refusal is unstated. The routed statement is [refusals.md](./refusals.md),
reached from [reference.md](../../../docs/reference.md) and from the skill. A
refusal that is introduced or changed states its contract in the same change.
**enforced: test (the census) + discipline.**

## Delegation

Delegation is task-shaped. Name the benefit before spawning: parallelism,
specialized access, or context isolation (every independent review is this
case). "There are many steps" is not one of them, and simple work stays in the
main thread.

- The main agent owns the goal, the decisions, the integration and the talk with
  the owner. A child implements or investigates within its contract.
- A delegation names: outcome, context, read/write ownership (`writePaths`),
  forbidden surfaces, validation and return format, and the model and effort it
  runs on.
- A child never widens its own authority, and an escalation starts a fresh child
  on the same contract; it does not change the role.
- Parallel writers own disjoint `writePaths`; the plugin refuses an overlap
  before starting the second one.
- A lost child is replaced by a new one started from the brief on the issue and
  the PR; the main agent does not take over its work.

**enforced: ledger (writePath overlap, role tool filters) + discipline (the
delegation decision).**

## Review Findings

A reviewer reports what breaks, what gets lost, what leaks and what is reported
wrongly. Those are blockers; every other note is non-blocking and goes to the
backlog. The reviewer is independent: a fresh context, given the diff and the
claim, from a different model family than the change's author. When no other
family is reachable, the verdict says "reduced independence" and why. The main
agent fixes blockers and verifies the fix itself; it does not go another round
unless the fix was large. **enforced: discipline (the verdict is returned by the
reviewer child and recorded in the ledger).**

## Red flags

- "The tests pass" with no command, cwd or exit status recorded.
- "This is basically done" while a Done check has no evidence.
- "I reviewed my own change carefully" where an independent review is needed.
- "The PR is green, so the goal is complete."
- "There was no output, so nothing was wrong."
- "The child probably finished; I will proceed on that."
- A mock run or a status read reported as a real-host result.
- A reviewer from the same family reported as independent.
- Ending a goal round to wait, instead of blocking on the child or job.
