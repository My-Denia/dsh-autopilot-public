---
name: dsh-goal-autopilot
description: >-
  Goal workflow for DSH. Use when the user states a goal, asks for autopilot, or
  hands over sustained multi-stage work (several stages, parallel pieces, a branch
  to land). Small reversible edits, questions and ordinary read-only reviews stay
  in the main thread with no goal and no autopilot tool calls.
---

# dsh-goal-autopilot

This skill binds a goal workflow to DSH tool names. The plugin adds three tools
and nothing else: it does not choose models, keep a plan gate, store state on
disk or render a card.

The plugin keeps an in-memory record of the children this session started (role,
the route each was given, how each ended) for the life of the mount. A host
restart loses it, and the children it described are gone with it: start new
work instead of reading old rows. `autopilot_agents` is the only way to read
that record, and it is not a gate.

## When it applies

Use this workflow only when the user states a goal, says autopilot, or hands
over work that clearly needs several stages. Then call `get_goal`; if no goal
is current, call `create_goal` with the Outcome as the objective. The host
accepts `create_goal` only from the user's direct turn, and a delegated child
cannot call it.

Everything else is simple work: do it directly, delegate nothing you do not
need, and make no `create_goal` or `autopilot_*` call.

## Start

1. Read the project rules and the repository as it is now. If someone else
   already claimed the work, stop and tell the user; otherwise claim it where
   the project records claims and read the claim back.
2. Before you change anything, write three things down where the work is
   recorded (the issue, or the pull-request description when there is no
   issue):
   - **Outcome** — what is true when this is finished, in one or two sentences.
   - **Done** — the commands or observations that prove it, each able to fail.
   - **Not in scope** — what this goal will not touch.
   A one-line change gets a one-line version; do not skip it.
3. Work in a git worktree on a branch from the current default branch, unless
   the user named the branch or asked you not to. Side findings go on the
   backlog, not into this change.
4. Check the goal's Done list before you finish. The user's approval is not a
   substitute for a Done check that passed.

## Roles

The main agent owns the goal: it decides, integrates, reviews results and talks
to the user. The main agent is the only caller of `create_goal` and
`update_goal`, and it requests the one review.

Start every other role with `autopilot_delegate`. Only the main agent and an
`executor-lead` may call it. Each dispatch names the role, the task, the
`writePaths` for a write role, and optionally `provider` + `model` (both, or
neither) and `effort` (only with provider and model). Omitting the route means
the host default applies; the result says which route you got and whether it
came from the call or was inherited. Never invent a provider or model name.

- `scout` — read-only search, inventory, log reading. Returns compressed
  findings with paths and line numbers.
- `worker` — bounded implementation. Must declare `writePaths`; edits nothing
  outside them; runs the checks it was given and reports exact commands and
  exit results.
- `executor-lead` — owns one chunk end to end. May start `scout` and `worker`
  leaves, integrates their results, and reports. It cannot start a `planner`,
  a `reviewer` or another lead, and it does not declare the goal done.
- `planner` — read-only diagnosis and a plan for hard, unclear or failed work.
- `reviewer` — one-shot, read-only, fresh context. See *Review* below.

A dispatch returns immediately with the child id, the route it was given, the
source of that route, and the record's generation. The child reports through
the host's settlement notice; use the native `list_agents` and `send_message`
tools to see and steer it.

If a child is stuck, it can call `autopilot_escalate` with what stalled and its
evidence. The request lands on its record; the parent decides. To act on it,
re-dispatch the work with `replaces: <child id>`, the same role, a stronger
route or a tighter task; the replacement is generation + 1. Escalation never
widens a role's permissions.

## Parallel delegation

Dispatcher: the main agent, or an `executor-lead` for its own leaves.

1. Split the work into disjoint pieces and give each piece one owner. Keep the
   small, directly-checkable steps for yourself rather than splitting for its
   own sake.
2. Concurrent writers must have **disjoint** `writePaths`. A dispatch whose
   paths intersect a live writer's is refused; wait for that writer with
   `autopilot_agents` or change the split. Read-only roles ignore `writePaths`.
3. Start the independent pieces before waiting on any of them. Then wait once
   with `autopilot_agents` (`action: 'wait'`), naming `childIds` when you only
   care about some of them, and a `timeoutSeconds` up to 600.
4. A timeout is not a failure: the returned records say `starting`, `running`,
   `idle`, `completed`, `failed` or `cancelled`. Handle what is still running
   (wait again, or take the work yourself), and read every child's report
   before declaring the piece done.

## Review

Exactly one independent review before the goal is declared done, requested by
the main agent with `autopilot_delegate` and `role: 'reviewer'`.

- The reviewer gets a fresh context and a read-only tool surface. Give it the
  claim and the diff — the files, the commands that were run, and what the
  change is supposed to prove. Do not hand it the author's reasoning or an
  argument for why the change is right.
- The call waits and returns the structured verdict in-band: `pass` or `fail`,
  findings with severity `blocker` or `note` (plus `file`/`line` when known),
  and an optional summary. No other agent can write that verdict.
- A `pass` with a `blocker` finding is rejected as invalid. A `fail` is a
  finding to fix, not a vote: fix the subject, then request a new review.
- The reviewer's route is whatever the call or the host gives it. Same-model
  review is normal; there is no vendor or family policy.

Do not ask the reviewer to re-review without a change, and do not overrule its
verdict. If you disagree, say so to the user and show the evidence.

## Waiting and finishing

- While the goal is armed, do not end the turn to wait for a child: call
  `autopilot_agents` inside the turn. The host resumes the main agent on its own
  for a goal round; you do not need `schedule_create` or a poll loop.
- A goal is done when every Done check passes on the final tree and the review
  is `pass` (or its blockers are fixed and re-reviewed). Then call
  `update_goal` with the completion, and report to the user: what changed, the
  Done commands and their results, the review verdict, and anything left out of
  scope.
- If a Done check cannot pass, say so and keep the goal open. Do not mark it
  complete on a promise, a plan, or a partially green tree.
- If the user takes over, stops the goal, or the work turns out to be out of
  scope, stop cleanly: report the state and leave the working tree honest.

## Tool surface

| tool | who has it | what it does |
| --- | --- | --- |
| `autopilot_delegate` | main agent, `executor-lead` | starts one role child; waits for a reviewer's verdict |
| `autopilot_agents` | main agent, `executor-lead` | waits for children to settle; returns their records |
| `autopilot_escalate` | every delegated child except the reviewer | records an escalation request for the parent |

The plugin never replaces the host's own tools: use `list_agents`,
`send_message`, `interrupt_agent` (where the composition enables it), `job_output` and the file/shell tools as
usual. `writePaths` is a coordination promise between writers, not a sandbox;
the host's approval and sandbox rules still apply to every child.
