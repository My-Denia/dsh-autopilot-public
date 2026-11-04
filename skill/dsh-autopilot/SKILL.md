---
name: dsh-autopilot
description: >-
  DSH adapter of the goal workflow. Use only when the owner explicitly states a
  goal, asks for autopilot, or gives sustained multi-stage work (several
  stages, parallel pieces, a PR to land). Small reversible edits, questions and
  ordinary read-only reviews stay in the main thread with no goal and no
  autopilot tool calls.
---

# dsh-autopilot (DSH adapter of goal-workflow)

A goal has an owner, roles, an independent review and a record on the issue and
the PR. There is no run state machine, plan gate, sign-off or closeout packet.
This file binds that workflow to DSH tool names; the plugin adds only role
delegation with explicit model and effort (inheriting the host route, recorded as such, when routing is off or has no catalog), and a small ledger of who was
started, with what route, and how it ended.

| read this | it owns |
| --- | --- |
| [references/model-routing.md](references/model-routing.md) | which work class and model route each role gets, effort, escalation, the owner's ladder |
| [references/governance-invariants.md](references/governance-invariants.md) | the invariants that still hold: evidence, review findings, delegation |
| [references/refusals.md](references/refusals.md) | every `AP_*` code that still exists and what it requires |
| `docs/reference.md` (in the package, not the installed skill) | tool parameters, ledger, configuration |

## When it applies

Only when the owner states the goal, says autopilot, or hands over work that
clearly needs several stages. Then call `get_goal`; if none is current, call
`create_goal` with the Outcome as the objective. The host accepts it only from
the owner's direct turn, and a delegated child cannot call it.

Everything else is simple work: do it directly, delegate nothing you do not need
to, and make no `create_goal` or `autopilot_*` call.

## Start

1. Read the project rules, the issue with its comments, and the repository as
   they are now. If someone else claimed the work, stop and tell the owner.
2. Write three things before changing anything: Outcome (what is true when
   finished), Done (commands or observations that prove it, each able to fail)
   and Not in scope. Post them on the issue, or in the PR description when there
   is no issue. If the goal is one small change, one line is enough.
3. Work in a worktree on a branch from the current default branch. Side findings
   go on the backlog, not into this change.

The issue and the PR are the record. `autopilot_status` shows the plugin ledger
(delegations, routes, reviewer verdicts, links). It is a display aid, not a
second todo list and not a completion judgement.

## Roles

The main agent owns the goal: it decides, integrates, reviews results and
talks to the owner. Start every other role with `autopilot_delegate`
(`role`, `task`, `writePaths`, optional `model` and `effort`; only you and an
`executor-lead` may call it):

- `scout`: read-only search, inventory, log reading. Returns compressed findings.
- `clerk`: external reads and writes through the connector tools that exist in
  this session; returns a digest or a write readback and decides nothing. With
  no connector present it says so instead of guessing.
- `worker`: one bounded piece with explicit `writePaths`. Give it the outcome,
  the files, what it may not touch and a checkable result.
- `executor-lead`: owns one chunk end to end; may start scout, clerk and worker
  children, integrates, validates and reports a short summary. It does not
  review itself.
- `planner`: read-only plan or diagnosis for hard or unclear work.
- `reviewer`: one-shot, read-only, fresh context; returns a structured verdict.

Launch independent delegations together in one turn, not one after another.
Parallel workers need disjoint `writePaths`; an overlap is refused before
anything starts. Hand implementation, test runs and fixes to a worker and
searches to a scout; do a step yourself only when it is a few short calls whose
result you need at once.

`autopilot_agents` has one action, `wait`. To list children, message them or
stop them, use the host's own `list_agents`, `send_message` and
`interrupt_agent`. A delegated child that stalls calls `autopilot_escalate`
(`reason`); that only records the request, and you decide and re-dispatch. A
reviewer cannot escalate.

### Model and effort

Which work class a role belongs to, and how a route is chosen, is in
[references/model-routing.md](references/model-routing.md). An explicit `model`
or `effort` in the call, or a pin in the profile, beats the plugin's choice.
Every dispatch reports the selected route and the observed one; read both and
believe the observed one. Raise capability by giving a sufficient model more
effort first, and move up a class only for a fresh child on the same contract.
Escalation never widens what the role may do.

## Review

Every change that is not trivial gets one independent review from `reviewer`,
given the diff and the claim, not your reasoning. Use a different model family
from the one that produced the change. If no other family is reachable (a
provider is down), a same-family reviewer is allowed, but record "reduced
independence" with the reason on the issue or PR. Never present it as
independent.

The reviewer looks for normal work breaking, work being lost, a secret leaking
and a result reported wrongly. Those block; other notes go to the backlog. Fix
the blockers and verify them yourself.

## Waiting

- With children or background jobs pending inside a goal round, do not end the
  turn. Block in it: `autopilot_agents` with `action: wait` for children, `job_output` with
  `wait: true` for a background command or CI watcher, at most 10 minutes per
  wait (the host clamps longer waits). Ending the turn early only spends goal
  rounds, and the round cap ends in a blocker.
- While the goal is active and armed, never end the turn to wait for a
  `schedule_create` reminder. A pending reminder is not pending work: the goal
  driver queues a new round immediately each time the main agent goes idle while
  the goal is armed (it waits for children to settle, not for background jobs or
  reminders), so the turn-end burns rounds toward the 256-round cap (a
  `round-limit` blocker). Wait inside the turn instead, repeating the
  10-minute waits above for as long as CI or children need. If a wait is longer
  than in-turn waiting reasonably allows, tell the owner so and let them pause
  the goal (pausing needs the owner's direct turn), then the owner resumes it in
  the client when the wait is over; do not spend rounds.
- Reminders are for waits outside an active goal, or after the owner has paused
  it. Only the main agent may set one (children are refused). A reminder
  delivers a message into the session after a restart; it does not re-arm a
  paused or disarmed goal.
- After a host restart running children are gone, and the goal stays disarmed.
  When the owner says "continue" (or "继续") after a restart (the goal is
  active but disarmed), do not just answer in text: call `get_goal`, then `update_goal` with
  `action: resume` and the exact current `goal_id` and `revision` (the owner's
  message is the direct turn it needs). Then start a new `executor-lead` or
  `worker` from the brief on the issue and the PR. Do not take over its work in
  the main context, and do not ask the owner to start over.
- A paused goal is different: the model's resume is refused
  (`GOAL_TOOL_RESUME_PAUSED`, "the user must resume it"), even in a direct owner
  turn. Tell the owner to resume it in the client; do not call `update_goal` for it.
- End the turn after a stage only when nothing is pending (no child, no
  background job, no CI you are waiting on), so the driver can start the next
  round.

## Authority and outbound

Commit, push, pull request and merge in the repository you are working on are
ordinary work; the plugin adds no gate to them. The host's own approval
settings still apply, and a pending or refused approval is a question for the
user, not something to route around. Deploys, deletions of native content and
anything spending money or changing an external account need the owner's order
for that action.

Before anything leaves the workspace (PR body, issue comment, upload), remove
credentials, tokens and private paths that carry a user name.

## Done

A stage ending is not the goal ending. Opening a PR, green CI or merge-ready
never calls `update_goal` with `complete`. Call it only when all of these hold:

- Each Done check ran on the final commit, and you read its result and exit status.
- An independent review ran and its blockers are fixed; otherwise say the change
  is unreviewed, not done.
- The PR is merged with CI green, or the owner has been told exactly why not.
- Anything installed or deployed was checked in the real place, not only in tests.
- The issue records what changed, the evidence, and what is still unverified.
- Your worktrees and branches are gone.

If a check cannot run, say so. Never report more than the evidence covers. When
the goal is complete, continue with the next authorized work in the same session.

## Installing this skill

`apply()` publishes the bundled skill into the skill-scan root
(`$DSH_AGENTS_HOME/skills/dsh-autopilot/`, default `~/.agents`): `SKILL.md`
plus `references/`. A destination that already differs is a warning, not an
overwrite (`skillInstall: 'off'` skips the copy); a filesystem that cannot
hard-link is `unsupported` and writes nothing, with the manual remedy in
`detail`. After upgrading the plugin, refresh a drifted copy by hand.

Manual copy is the fallback when the plugin is not loaded:

```sh
# macOS / Linux, fallback only
mkdir -p ~/.agents/skills/dsh-autopilot/references
cp skill/dsh-autopilot/SKILL.md ~/.agents/skills/dsh-autopilot/SKILL.md
cp skill/dsh-autopilot/references/*.md ~/.agents/skills/dsh-autopilot/references/
```

```powershell
# Windows PowerShell, fallback only
New-Item -ItemType Directory -Force "$HOME\.agents\skills\dsh-autopilot\references" | Out-Null
Copy-Item skill\dsh-autopilot\SKILL.md "$HOME\.agents\skills\dsh-autopilot\SKILL.md"
Copy-Item skill\dsh-autopilot\references\*.md "$HOME\.agents\skills\dsh-autopilot\references\"
```
