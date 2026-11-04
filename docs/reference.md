# Operator reference

First-time users should start from the [README](../README.md). This page is for
operators: the tools the plugin registers, the ledger it keeps, the DSH tools
the workflow relies on, and configuration. The tool list the host shows in a
session is authoritative if it ever differs from this page.

Who owns what:

- `skill/dsh-autopilot/SKILL.md` is the in-session adapter: when the workflow
  applies and the order of operations.
- This page owns tool names, parameters, the ledger and configuration.
- [../skill/dsh-autopilot/references/model-routing.md](../skill/dsh-autopilot/references/model-routing.md)
  owns work classes, the ladder, escalation and the routing contract.
- [../skill/dsh-autopilot/references/governance-invariants.md](../skill/dsh-autopilot/references/governance-invariants.md)
  owns the invariants that still hold (evidence, review findings, delegation).
- [../skill/dsh-autopilot/references/refusals.md](../skill/dsh-autopilot/references/refusals.md)
  owns every remaining `AP_*` refusal and its remedy.

There is no init step and no run phase. A goal is started by the owner through
the host's goal tools; the plugin tools below only start, follow and record
children.

## Plugin tools

Four tools, registered per agent scope. The root agent gets `autopilot_status`,
`autopilot_delegate` and `autopilot_agents`; a delegated `executor-lead` gets
`autopilot_delegate`, `autopilot_agents` and `autopilot_escalate`; every other
delegated child except `reviewer` gets `autopilot_escalate` only; a `reviewer`
gets none. There is no list, message or stop tool: the host's own `list_agents`,
`send_message` and `interrupt_agent` do that.

### `autopilot_delegate`

Starts one role child. Callable by the root agent and by an `executor-lead`.
Parameters:

| parameter | meaning |
| --- | --- |
| `role` | `scout`, `clerk`, `worker`, `executor-lead`, `planner` or `reviewer` |
| `task` | the brief: outcome, files, what the child may not touch, a checkable result |
| `writePaths` | files or prefixes (`src/parser/**`) the child may write. Required for `worker`; ignored for read-only roles |
| `provider`, `model` | optional explicit route; give both or neither. Beats a profile pin and the ladder |
| `effort` | optional explicit reasoning effort |
| `workClass` | optional override of the role's default work class (`mechanical`, `simple`, `hard`, `audit`, `extreme`) |
| `replaces` | child id this dispatch replaces (escalation): same role, generation + 1 |
| `reviewedChildIds` | reviewer only: the delegations under review (default: every settled write delegation) |

Give no `provider`, `model` or `effort` to let routing choose.

Which allowed-route list wins: the durable per-session model-selection policy
(the `subagent/model-selection-policy` the host records when a top-level session
is composed) remains the only authority for automatic route choice. The host's
`subagentModelSelection` user setting is read on every dispatch and only
restricts, never grants. When it is enabled with a non-empty list, an explicit
route (dispatch arguments or an owner pin) outside the list is refused with
`AP_ROLE_ROUTE_NOT_ALLOWED`, and automatic selection draws only from the session
policy's routes that are also in the list. A session with no recorded policy
gets no selection authority from the setting: the child inherits the host
default unless a route is named explicitly. A route must satisfy both. When the
setting is off, absent, unreadable or malformed, routing behaves as if it did
not exist.

Roles (from `src/roles`):

| role | what it is | tools | default work class |
| --- | --- | --- | --- |
| `scout` | search, inventory, log reading; returns compressed findings | `read`, `glob`, `grep`, `read_image`, `web_fetch`, `web_search` | `mechanical` |
| `clerk` | external reads and writes through connector tools present in the session; says so when none are | the scout set plus the connector tools that exist | `mechanical` |
| `worker` | one bounded piece; `writePaths` required | no allow-list (inherits the profile's tools) | `simple` |
| `executor-lead` | owns one chunk end to end; may start `scout`, `clerk` and `worker` only | no allow-list, plus `autopilot_delegate` and `autopilot_agents` | `hard` |
| `planner` | read-only plan or diagnosis | `read`, `glob`, `grep`, `read_image` | `hard` |
| `reviewer` | independent one-shot review, fresh context, structured verdict | `read`, `glob`, `grep`, `read_image` | `audit` |

A read-only role whose `read` tool is not registered is refused
(`AP_TOOL_SURFACE_INCOMPLETE`) rather than started blind. Other requested names
the deployment does not register are dropped, and the dispatch result says so.

Depth: a child of the root is depth 1 and gets `maxDepth` 1; an `executor-lead`
gets 2, so its own children are depth 2 and cannot start children. A
`maxDepth` of 2 is what the plugin sends; the host enforces its own limit, and
the ledger records whether the host setting was readable.

Delegation is refused (not queued) when the caller may not dispatch the role
(`AP_ROLE_NOT_DISPATCHABLE`), a `worker` has no `writePaths`
(`AP_WRITE_PATHS_REQUIRED`), or the `writePaths` intersect those of an active
writer under the same root (`AP_WRITE_PATHS_CONFLICT`). The overlap check is a
conflict guard between concurrent writers, not a permission system: a worker has
no tool filter, so staying inside its `writePaths` is up to the brief.

Every call returns at once with the child id, the route chosen and where it
came from; the child reports through the host's settlement notice. The
reviewer is the exception: the call waits and returns the verdict in-band.
The main agent cannot write a verdict into the ledger. The reviewer is given a
model family different from the change when one is reachable; otherwise the
record says "reduced independence".

### `autopilot_agents`

One action: `wait`. Parameters: `action: 'wait'`, optional `childIds`, optional
`timeoutSeconds` (default 300, at most 600). It blocks until the listed children
(default: all your active ones) settle or the timeout fires, and returns
`timedOut` and the delegation records. It is not a gate. Callable by the root
agent and by an `executor-lead`.

### `autopilot_escalate`

`reason` (required). A delegated child other than the reviewer asks its parent
for a stronger model, more effort or a different split. The call records the
request on the child's delegation and returns; the parent decides and
re-dispatches with `autopilot_delegate` and `replaces`. It never widens what the
role may do.

### `autopilot_status`

Shows the ledger for the current session: delegations, routes, reviewer
verdicts, links, whether auto-continue is available, legacy runs of this
session, and one-time notes (such as a retired config key that was written).
Read-only, except for the optional `link` parameter `{kind: 'issue' | 'pr',
ref, url?}`, which records an issue or PR link on the ledger (idempotent on
`kind` and `ref`). A session with no ledger answers `ledger: null`.

### Removed tools

0.3.0 removed every tool of the 0.2.x run state machine (init, plan, audit,
evidence, closeout, usage, log and the executor and escalation-proposal tools).
A script or prompt that still calls one of them fails, and there is no
replacement for the run state machine they wrote. The names are listed in the
[CHANGELOG](../CHANGELOG.md) and in [DESIGN.md §8.10](../DESIGN.md).

## Ledger

The issue and the PR are the record. The ledger is a display aid for execution,
cancel, resume and history. It is not a todo list and not a completion
judgement. Each delegation record holds:

| field | meaning |
| --- | --- |
| `role` | the role it was started as |
| child id | the host's id for the child |
| generation | the child's generation; a replacement child gets the next one |
| selected route, source | the model and effort the plugin or the call chose, and why: pin, ladder, call argument or adapter default |
| observed route | the model and effort the host reports the child actually ran on |
| `state` | `starting`, `running`, `idle` (settled a turn, can be messaged), `completed`, `failed` (the host refused the start, or the child failed), `cancelled`, or `lost` (it was `starting` or `running` when the plugin reloaded after a host restart; never restarted automatically) |
| parent, depth | the dispatching agent (the root session or an `executor-lead`) and the depth below the root |
| `writePaths` | the paths declared at dispatch |
| escalation | the reason and time of an `autopilot_escalate` request, when the child made one |
| reviewer verdict | the verdict text and the model family, as evidence of independence |
| links | the issue and PR the goal belongs to |

The ledger also carries the goal id and revision it was started under and
markers for legacy runs.

Legacy runs written by plugin 0.2.x stay readable. They are shown read-only on
the card, are not continued, and no new event is written to their streams. The
`autopilot_status` view lists them.

## DSH tools the workflow uses

These belong to the host, not the plugin.

| tool | use |
| --- | --- |
| `get_goal` | read the current goal with its `goal_id` and `revision` |
| `create_goal` | create the goal with the Outcome as its objective. Needs the owner's direct top-level turn |
| `update_goal` | `complete` or `blocked` (also allowed in an autonomous goal round), `resume`, edit, pause. Needs the exact `goal_id` and `revision` from `get_goal`; all but `complete`/`blocked` need the owner's direct turn |
| `job_output` | `job_id`, optional `wait` and `timeout_ms` (default wait 30 s, cap 10 minutes) for a background command or CI watcher |
| `list_agents`, `send_message` | the host's own view of and channel to agents |
| `schedule_create` | set a delayed reminder (`after_seconds` and related). Only the main agent may call it; a child is refused (`subagent_session`) |

A goal stays disarmed after a session resume, fork or host restart until the
owner says "continue" (`update_goal` with `action: resume`). A reminder from
`schedule_create` is delivered into the session after a restart but does not
re-arm the goal. The goal round cap defaults to 256 and ends in the blocker
code `round-limit`.

## Configuration

`routing.*` keeps working: mode, preference, roles, ladder and work classes.
See
[model-routing.md](../skill/dsh-autopilot/references/model-routing.md) for the
shape and how roles map to work classes. `skillInstall` (`auto` or `off`) and
`storeRoot` are kept; `DSH_AUTOPILOT_HOME` overrides the store root and accepts
a leading `~`.

Retired keys are accepted and ignored, so a profile written for 0.2.x loads
without error; `autopilot_status` names the ones actually written, once. They
are exactly `RETIRED_CONFIG_KEYS` in `src/config.ts`:

- `gate.sandboxCoupling`, `gate.toolDeny`, `gate.egressDeny`,
  `gate.stopReminder`, `gate.strictShell`, `gate.restoreMode`
- `governance.maxAuditRoundsPerRole`, `governance.unattended`
- `storeKind`, `auditProvider`, `executorProvider`
- `executor.persona`, `executor.toolAllowList`, `executor.agentOptions.maxTokens`
- `auditors.<plan|execution|rules>.provider` and
  `auditors.<plan|execution|rules>.agentOptions.maxTokens`
- `crossFamily.enabled`, `crossFamily.minRisk`, `crossFamily.pool`

Some 0.2.x keys are still read (`LEGACY_KEYS_STILL_READ`):

- `executor.agentOptions.{provider,model,reasoningEffort}` becomes the
  `routing.roles.executor` lock, so it pins the route of `worker` and
  `executor-lead`.
- `auditors.<plan|execution|rules>.agentOptions.{provider,model,reasoningEffort}`
  becomes the matching auditor lock, so it pins the `reviewer` route.

Legacy `storeKind` file and domain backends stay readable for history: the
ledger goes to the domain when the host mounts one, else to files.

For a web profile, include the web app bundle and the npm package name:

```json
"dsh": { "profile": { "bundles": [
  "@deepseek-ai/dsh-base",
  "@deepseek-ai/dsh-web-app",
  "dsh-goal-autopilot"
] } }
```

## Skill copy fallback

When the plugin is not loaded, or hard-link publication is `unsupported`:

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

Copying only `SKILL.md` installs an adapter whose routed references are absent:
the adapter's links then point at nothing.
