# Reference

This page covers plugin version 0.4.0: the three tools, their parameters and refusals, configuration, skill installation, the DSH host tools the workflow uses, and goal disarm/resume behaviour. The tool list the host shows in a session is authoritative if it differs from this page.

## Roles

A role is chosen at dispatch and decides the child's tool surface, depth and whether it may delegate.

| role | tool surface | maxDepth | may delegate | plugin tools |
| --- | --- | --- | --- | --- |
| root agent | inherits the session surface | — | every role | `autopilot_delegate`, `autopilot_agents` |
| `executor-lead` | inherits the session surface | 2 | `scout`, `worker` | `autopilot_delegate`, `autopilot_agents`, `autopilot_escalate` |
| `worker` | inherits the session surface | 1 | no | `autopilot_escalate` |
| `scout` | `read`, `glob`, `grep`, `read_image`, `web_fetch`, `web_search` | 1 | no | `autopilot_escalate` |
| `planner` | `read`, `glob`, `grep`, `read_image` | 1 | no | `autopilot_escalate` |
| `reviewer` | `read`, `glob`, `grep`, `read_image` | 1 | no | none |

`worker` and `executor-lead` inherit the calling session's tools, so they can write and run commands. The read-only roles are restricted to the names above, applied when the host announces the child; names the registry does not show are dropped. A read-only role that cannot see `read` is refused rather than started blind.

Depth is capped by the plugin: a child of the root gets `maxDepth` 1, an `executor-lead` gets 2 so its own children can exist but cannot start children.

## `autopilot_delegate`

Starts one role child. Callable by the root agent and by an `executor-lead`.

| parameter | type | meaning |
| --- | --- | --- |
| `role` | `'scout' \| 'worker' \| 'executor-lead' \| 'planner' \| 'reviewer'` | required; the role to start |
| `task` | string | required; the brief: outcome, files, what may not be touched, a checkable result. Empty is refused. The role's persona brief is prepended to the prompt |
| `writePaths` | string[] | required for `worker`; optional for `executor-lead`; ignored for the read-only roles. Paths or prefixes (`src/parser/**`) the child intends to write |
| `provider`, `model` | string | optional explicit route. Give both or neither |
| `effort` | string | optional reasoning effort. Requires `provider` and `model`; the host rejects an effort on its own |
| `replaces` | string | the child id this dispatch replaces. The replacement must have the same role and gets generation + 1 |

Returns immediately, except for a reviewer:

| field | meaning |
| --- | --- |
| `childId` | the host's id for the child |
| `role` | the role it was started as |
| `state` | `starting`, `running`, `idle`, `completed`, `failed` or `cancelled` |
| `generation` | 1 for a fresh dispatch; a replacement gets the next generation |
| `route` | `{ provider, model, effort? }` when the call named a route, otherwise `null` |
| `routeSource` | `call` when `provider` and `model` came from the call; `inherit` when the child uses the host default |
| `observed` | optional `{ provider, model, effort? }`: the route the child's first request header actually used, read from the child session when the host exposes its log |
| `writePaths` | the declared paths, when any |
| `tools` | the restricted names, or `inherit` for `worker` and `executor-lead` |
| `maxDepth` | the depth budget sent to the host |

The reviewer's call waits for the child to settle and adds two fields, `review` and `observed`, in-band from the same call:

```json
{
  "verdict": "pass",
  "findings": [
    { "severity": "note", "file": "src/parser.ts", "line": 42, "note": "…" }
  ],
  "summary": "…"
}
```

`verdict` is `pass` or `fail`; `findings[].severity` is `blocker` or `note`; `file` and `line` are optional. A `pass` that carries a `blocker` finding is invalid. The main agent cannot write a verdict. Give the reviewer the diff and the claim in `task`, not the author's reasoning.

There is no vendor or model-family policy. The caller or the host default chooses the reviewer route, a same-model review is normal, and the result records the route that actually ran as `observed` when the host exposes the child's log.

## `autopilot_agents`

One action, `wait`. Callable by the root agent and by an `executor-lead`.

| parameter | type | meaning |
| --- | --- | --- |
| `action` | `'wait'` | required; any other value is refused |
| `childIds` | string[] | optional; the children to wait for. Default: every child this caller dispatched |
| `timeoutSeconds` | number | optional; default 300, at most 600 |

Blocks until every listed child settles or the timeout fires, then returns `{ timedOut, delegations }`. Each record carries the route sent with the dispatch, its source and, when the host exposes the child session log, `observed`: the route the child's first request actually used. It does not cancel a child and is not a gate: a `timedOut: true` result leaves the children running. An id that no delegation under this root owns is refused.

## `autopilot_escalate`

Callable by any delegated child except `reviewer`.

| parameter | type | meaning |
| --- | --- | --- |
| `reason` | string | required; what the child needs and why |

Records `escalation: { reason, at }` on the caller's delegation record and returns `{ guidance }`. The parent decides and re-dispatches with `replaces`. Escalation never widens the role's tool surface or permissions.

## Refusals

Every refusal is one code from a single registry.

| code | raised when | remedy |
| --- | --- | --- |
| `AP_NO_AGENT` | a tool was called with no calling agent | call it from an agent session |
| `AP_INVALID_ARGUMENT` | empty `task` or `reason`, unknown role, bad `action`, `effort` without both `provider` and `model`, malformed `replaces`, bad timeout | fix the argument |
| `AP_ROLE_NOT_DISPATCHABLE` | the caller may not dispatch that role | only the root and an `executor-lead` delegate; an `executor-lead` may dispatch only `scout` and `worker` |
| `AP_WRITE_PATHS_REQUIRED` | a `worker` dispatch declared no `writePaths` | declare the paths or prefixes the worker will write |
| `AP_WRITE_PATHS_CONFLICT` | the declared paths intersect an active writer's under the same root | wait for the writer to settle or split the paths |
| `AP_UNKNOWN_CHILD` | `replaces` or `childIds` names no delegation under this root, or `autopilot_escalate` came from a non-child | use an id returned by this root's dispatches |
| `AP_TOOL_SURFACE_INCOMPLETE` | a read-only role cannot start because `read` is not registered | use a profile or preset that registers `read` |
| `AP_DISPATCH_FAILED` | the host refused to start the child; the record is `failed` with the host's reason | read the reason; fix the profile or retry |
| `AP_ROLE_VERDICT_INVALID` | the reviewer's structured verdict failed validation, returned in-band | re-dispatch the review |

The 0.3.0 ledger, route and store refusals (`AP_LEDGER_*`, `AP_ROLE_ROUTE_*`, `AP_ROUTE_*`, `AP_STORE_CORRUPT`) no longer exist.

## Delegation records

A record is created per dispatch under the root session that owns the caller. It holds the child id, role, parent, depth, generation, the `replaces` link, the brief title, state, `writePaths`, the route sent with the dispatch and its source, the observed route when the host exposes the child session log, the tool surface, `maxDepth`, start and settlement times, an optional host diagnostic, and the escalation reason. The reviewer's verdict is not part of the record; it is returned by the reviewing call.

States are `starting`, `running`, `idle`, `completed`, `failed`, `cancelled`. `idle` means the child settled a turn and can still be messaged.

The records live in the plugin's memory for one root session: no file, no storage domain, no web route, no client card, and nothing is visible from a second dsh process. A host restart drops them; running children are gone with them. There is no `lost` state and no resume: dispatch again. The plugin has no status tool, so the record is read from the delegate result and from `autopilot_agents`.

## Configuration

One key:

| key | values | default | meaning |
| --- | --- | --- | --- |
| `skillInstall` | `'auto'` or `'off'` | `'auto'` | `auto` installs the adapter skill; `off` disables both installation channels |

There are no route, model, store or skill-name keys. The config schema ignores unknown keys, so a profile written for 0.3.0 still loads, but its `routing.*`, `storeRoot` and retired keys do nothing; remove them.

The bundle mounts the plugin as loader entry `id: autopilot`. Override its config in the profile's `cordis.patch.yml` by targeting that id:

```yaml
- id: autopilot
  config:
    skillInstall: off
```

## Skill install

`skillInstall: auto` uses two channels in order:

1. The host skills service, when present: the plugin registers `skill/dsh-goal-autopilot/SKILL.md` as a provider at a rank that lets a real file copy win a duplicate.
2. Otherwise a file copy into `$DSH_AGENTS_HOME/skills/dsh-goal-autopilot/SKILL.md` (`~/.agents` when the variable is unset). An existing copy is never overwritten, so local drift stays.

`skillInstall: off` uses neither channel. The skill is a single file; there is no `references/` directory to copy.

Manual copy, when the plugin is not loaded or you want the skill without the plugin:

```sh
mkdir -p "$DSH_AGENTS_HOME/skills/dsh-goal-autopilot"
cp skill/dsh-goal-autopilot/SKILL.md "$DSH_AGENTS_HOME/skills/dsh-goal-autopilot/SKILL.md"
```

```powershell
New-Item -ItemType Directory -Force "$env:DSH_AGENTS_HOME\skills\dsh-goal-autopilot" | Out-Null
Copy-Item skill\dsh-goal-autopilot\SKILL.md "$env:DSH_AGENTS_HOME\skills\dsh-goal-autopilot\SKILL.md"
```

## DSH host tools the workflow uses

These belong to the host, not the plugin.

| tool | parameters | use in the workflow |
| --- | --- | --- |
| `get_goal` | none | read the current goal with its `id` and `revision`; returns `{ goal: null }` when none is current |
| `create_goal` | `objective`, optional `max_goal_rounds` (default 256) | create the goal from the user's Outcome. Needs a direct human turn in a top-level agent |
| `update_goal` | `goal_id`, `revision`, `action`, optional `objective`, `max_goal_rounds`, `blocked_reason` | `complete` or `blocked` when the goal round has authority (a direct human turn also allows them); `resume`, `edit` and `pause` need a direct human turn. Requires the exact id and revision from `get_goal` |
| `job_output` | `job_id`, optional `wait`, `timeout_ms` | wait for a background command or CI watcher inside the turn. Default wait 30 s, cap 10 minutes. Returns output and a `[status: ...]` line |
| `list_agents` | none | see the agent tree with names and live status |
| `send_message` | `agent`, `message` | message a child by name from `list_agents`; an inactive child is resumed by the message |
| `interrupt_agent` | `agent` | optional stop control. 0.2.2 ships it off in the base and Web presets, so the workflow does not depend on it |
| `schedule_create` | `title`, `prompt`, `rrule`, `target` | host reminders. This adapter does not use it; see below |

`schedule_create` is a host tool, not part of the workflow. A reminder is delivered into the session after it fires, but it does not arm a goal, and ending a turn to wait for one while a goal is armed makes the goal driver queue a new round each time. While a goal is active, wait inside the turn with `autopilot_agents` or `job_output` instead.

## Goal disarm and resume

The goal is durable in the host; whether continuation is armed is process-local. After a session resume, a fork or a host restart, an active goal is disarmed: the agent does not continue on its own, and a reminder does not re-arm it.

When the user says continue, in any wording, the agent reads the goal with `get_goal` and rearms it with `update_goal` and `action: 'resume'`. A text reply alone does not re-arm it.

A durable **paused** goal is the user's: the model's `resume` is refused with `GOAL_TOOL_RESUME_PAUSED`, and the user resumes it from the client. `edit`, `pause` and `resume` require a direct human turn; `complete` and `blocked` also accept the exact current goal round. An autonomous `blocked` needs the same condition to have persisted for at least 3 consecutive rounds by default, and a non-empty `blocked_reason`.

The round cap defaults to 256 and bounds automatic continuation; reaching it stops the goal in the host, not in this plugin.

## Removed in 0.4.0

- `autopilot_status` and its issue/PR link recording.
- The routing engine and its config: ladders, catalog, work classes, onboarding, coverage, cross-family policy, route authorization.
- The persisted ledger, storage-domain writes, web routes, client bundle and session card.
- The `clerk` role, the connector overlay and external-system delegation.
- The legacy 0.2.x run history, tools and compatibility shims.

See [CHANGELOG.md](../CHANGELOG.md) for the full break.
