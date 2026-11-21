---
name: dsh-goal-autopilot
description: >-
  Goal workflow for DeepSeek Harness. Use when the user states a goal, asks for
  autopilot, or hands over sustained multi-stage work: several stages, parallel
  pieces, a branch to land. Questions, small reversible edits and ordinary
  read-only reviews stay in the main thread, with no goal call and no delegation.
---

# dsh-goal-autopilot

This skill runs a goal on tools the host already owns. The package ships no
code: five agent presets carry the roles (`goal-scout`, `goal-worker`,
`goal-executor-lead`, `goal-planner`, `goal-reviewer`) and one `delegate` tool
starts a child on one of them. The host owns the children, the goal, the routes
and the sandbox.

## When it applies

Use the workflow when the user states a goal, says autopilot, or hands over work
that clearly needs several stages: more than one piece, parallel pieces, a
branch or pull request to land.

Everything else is ordinary work: do it directly, delegate nothing you do not
need, and make no `create_goal` call. A question, a small reversible edit or a
read-only review stays in this conversation.

## Start

1. Read the project rules and the repository as it is now. If someone else
   already claimed the work, stop and tell the user.
2. Before changing anything, write three things down where the work is recorded
   (the issue, or the pull-request description when there is no issue):
   - **Outcome** — what is true when this is finished, in one or two sentences.
   - **Done** — the commands or observations that prove it, each one able to fail.
   - **Not in scope** — what this goal will not touch.
3. Work in a git worktree on a branch from the current default branch, unless
   the user named a branch or asked you not to.
4. Read the current goal with `get_goal`. When none is current, call
   `create_goal` with the Outcome as the objective. The host accepts it from the
   user's direct turn, which is where you are when the goal is stated.

## Roles

The main agent keeps the goal: it decides, integrates results, requests the
review and talks to the user. Every other role is a child started with
`delegate`:

```json
{ "description": "Audit the retry path", "agent_preset": "goal-scout", "prompt": "…" }
```

Always name `agent_preset`. Omitting it makes the child inherit the parent's
preset, which is not a goal role. The call starts the child and returns at once
with its name; the child's final answer arrives later in the host's completion
notice.

| preset | role | tools |
| --- | --- | --- |
| `goal-scout` | read-only search and inventory; returns findings with paths and line numbers | `read`, `read_image`, `glob`, `grep` |
| `goal-worker` | one bounded implementation piece | shell (`bash` or `pwsh`, per platform), `jobs`, `read`, `read_image`, `write`, `edit`, `glob`, `grep` |
| `goal-executor-lead` | one chunk end to end; may start the three leaf roles | the worker's tools, plus `list_agents`, `send_message`, `wait_agent`, and its own `delegate` |
| `goal-planner` | read-only diagnosis and a decision-complete plan | `read`, `read_image`, `glob`, `grep` |
| `goal-reviewer` | one-shot read-only review in a fresh context | `read`, `read_image`, `glob`, `grep` |

The brief is the `prompt`: outcome, the files and paths the child may touch, what
it may not touch, the checks it must run, and the result you expect. A child gets
its preset's tools only, so a read-only role cannot write even when the brief
asks it to.

Split the work yourself: one owner per piece, disjoint file scopes written into
the briefs. The host starts children but does not compare file scopes, so two
concurrent writers on one file are your mistake to prevent.

## Independent review

Before the goal is declared done, request exactly one review from a fresh
context:

```json
{ "description": "Review the retry fix", "agent_preset": "goal-reviewer", "prompt": "Claim: …\nDiff: …\nCommands: …" }
```

Give it the claim and the diff — the files as they are now, the commands that
were run, and what the change is supposed to prove. Do not hand it the author's
reasoning or an argument for why the change is right.

The call returns immediately; the verdict arrives in the completion notice. Ask
the reviewer for a `pass` or `fail`, with findings marked `blocker` or `note`
(file and line when known) and a short summary. You cannot write or overrule
that verdict. A `fail` is a finding to fix; request a new review after the fix,
and do not re-review without a change.

## Parallel work and waiting

Start independent children in one message and keep working while they run. A
settled child notifies you, and that notice starts your next turn.

While a goal is armed, do not end the turn to wait for a child. Wait inside the
turn with `wait_agent` (inbox wait) or `job_output` (a background command or CI
watcher), where the composition provides them, and poll nothing on a schedule.
`list_agents` shows the tree; `send_message` steers one child.

The delegation depth cap is absolute. The profile-level `delegate` is capped at
depth 1, so a child at depth 1 is refused when it tries to delegate. Only
`goal-executor-lead` carries a `delegate` row with a depth-2 cap and the three
leaf presets, and its leaves are back under the depth-1 cap.

## Route

The route comes from the user's own configuration. Omit `provider`, `model` and
`reasoning_effort` to inherit the host default, or name `provider` and `model`
together, with `reasoning_effort` only when both are present. The host rejects a
`reasoning_effort` on its own. Never invent a provider or model id; when you need
to know which routes the user configured, call `list_subagent_models`.

## Done

- Check the goal's Done list on the final tree: every command and every
  observation must pass, not be promised.
- The review must be `pass`, or its blockers fixed and re-reviewed.
- Then call `update_goal` with `action: 'complete'`, the exact `goal_id` and
  `revision` from `get_goal`, and report to the user: what changed, the Done
  commands and their results, the review verdict, and anything left out of scope.
- If a Done check cannot pass, say so and keep the goal open. Do not complete a
  goal on a plan, a promise or a partially green tree.

After a session resume or a host restart an armed goal is disarmed. When the
user says continue, read it with `get_goal` and rearm it with `update_goal`
`resume`; a text reply alone does not rearm it.
