# Architecture

`dsh-goal-autopilot` is a thin adapter between a goal workflow and DeepSeek Harness. It ships one skill, three tools and the per-role delegation mechanics. It has no service, no storage, no web route, no client bundle and no compatibility layer.

## Division of labour with the host

| concern | owner |
| --- | --- |
| agent and subagent lifecycle | DSH: `ctx.subagents`, `startActivation`, settlement notices, `list_agents` / `send_message` |
| goal state, revision and continuation | the DSH goal service and its tools: `get_goal`, `create_goal`, `update_goal` |
| approval, sandbox and file policy | DSH host and profile settings |
| tool registry and model-facing schemas | DSH `ctx.tools` and `defineTool` |
| workflow order, role briefs, role scoping | this plugin |
| delegation records and write conflicts | this plugin, in memory |

The plugin does not read or store goal state. The goal tools and the host's goal service own the objective, the phase and the round budget; a delegation record is tied to the root session that dispatched it, not to a goal revision.

## What the package registers

- The skill `dsh-goal-autopilot`: when the workflow applies and the order of operations.
- `autopilot_delegate`: start one child in one role, with an optional explicit route and, for writers, declared `writePaths`.
- `autopilot_agents`: wait for the caller's children, default 300 s, at most 600 s.
- `autopilot_escalate`: let a child ask its parent for a different route or split.

There is no status, list, message, stop, plan, audit, evidence or closeout tool. Reading the tree is `list_agents`; talking to a child is `send_message`; both belong to the host.

## The in-memory ledger

Each root session owns a map of delegation records. A record holds the child id, role, parent, depth, generation, the `replaces` link when it replaced a child, the brief title, the state, the declared `writePaths`, the route sent with the dispatch and its source, the observed route when the host exposes the child session log, the tool surface, `maxDepth`, start and settlement times, an optional host diagnostic, and the escalation reason when the child asked for one. The reviewer's verdict is not stored in the ledger: it comes back in-band from the reviewing call.

States are `starting`, `running`, `idle`, `completed`, `failed`, `cancelled`. `idle` means the child settled a turn and can still be messaged; it is not finished.

The ledger is process memory: no file, no storage domain, no web route, no client card. A second dsh process on the same profile sees none of it. A host restart disposes the children and drops the map, so there is no `lost` state and nothing is resumed: a record that no longer exists cannot be read as lost. The dispatch result already in the transcript is the only trace, and work that must continue is dispatched again.

## Role tool scoping

| role | tool surface | maxDepth | may delegate |
| --- | --- | --- | --- |
| root agent | inherits the session surface | — | yes, every role |
| `executor-lead` | inherits the session surface | 2 | yes, `scout` and `worker` only |
| `worker` | inherits the session surface | 1 | no |
| `scout` | `read`, `glob`, `grep`, `read_image`, `web_fetch`, `web_search` | 1 | no |
| `planner` | `read`, `glob`, `grep`, `read_image` | 1 | no |
| `reviewer` | `read`, `glob`, `grep`, `read_image` | 1 | no |

The host starts the child from the brief; when it announces the child through `agent/created`, the plugin applies the role's allow-list with `ctx.tools.restrict`. Only names the tool registry actually shows are requested, so a profile that hides a tool never gets a start that silently lacks it. A read-only role whose `read` is missing is refused with `AP_TOOL_SURFACE_INCOMPLETE` rather than started blind. `worker` and `executor-lead` get no filter: they inherit the parent's session surface, which is what lets them write files and run commands.

Scoping happens per child rather than in a preset because a preset is deployment-wide: a reviewer must be read-only in a session whose root is not.

## `writePaths` is a conflict guard, not a permission system

A `worker` must declare `writePaths`; the dispatch is refused with `AP_WRITE_PATHS_REQUIRED` otherwise. The paths of a new writer are compared with those of every writer under the same root that is still `starting` or `running`; an intersection refuses the dispatch with `AP_WRITE_PATHS_CONFLICT` before the child starts. A declaration is an exact file or a prefix; any other glob is read conservatively as the prefix before its first wildcard, so the check can over-report an overlap but cannot miss one. Read-only roles ignore `writePaths`.

What this guarantees: two concurrent writers in one process, under one root, do not both declare the same paths, so an independent parallel split is checkable before any work starts. What it does not do:

- It does not stop a writer from touching a path it did not declare. Workers have the inherited surface; staying inside the brief is the worker's job and the root's review.
- It does not see other sessions, other processes or other roots.
- It does not inspect the filesystem, resolve symlinks or check whether a path exists.

The plugin has no sandbox of its own. Host approval and sandbox settings still apply to every call, including a worker's writes.

## Refusal codes

The codes are a single registry in the package; every refused call throws one. See [docs/reference.md](docs/reference.md#refusals) for the remedy for each.

| code | raised when |
| --- | --- |
| `AP_NO_AGENT` | a tool was called with no calling agent |
| `AP_INVALID_ARGUMENT` | empty `task` or `reason`, unknown role, bad `action`, `effort` without `provider` and `model`, malformed `replaces`, bad timeout |
| `AP_ROLE_NOT_DISPATCHABLE` | the caller may not dispatch that role |
| `AP_WRITE_PATHS_REQUIRED` | a `worker` dispatch declared no `writePaths` |
| `AP_WRITE_PATHS_CONFLICT` | declared paths intersect an active writer's under the same root |
| `AP_UNKNOWN_CHILD` | `replaces` or `childIds` names no delegation under this root, or the caller of `autopilot_escalate` is not a delegated child |
| `AP_TOOL_SURFACE_INCOMPLETE` | a read-only role cannot start because `read` is not registered |
| `AP_DISPATCH_FAILED` | the host refused to start the child; the record is `failed` with the host's reason |
| `AP_ROLE_VERDICT_INVALID` | a reviewer's structured verdict failed validation; returned in-band |

Every refusal except `AP_DISPATCH_FAILED` and `AP_ROLE_VERDICT_INVALID` is decided before the host is asked to start a child. `AP_DISPATCH_FAILED` reports that the host refused the start; `AP_ROLE_VERDICT_INVALID` reports that the reviewer's in-band result failed validation.

## Why there is no routing engine

Route choice depends on facts that live with the deployment, not with this package: which providers are configured, which accounts are usable, what a model costs and can do, and what the user has allowed. A packaged ladder, catalog or work-class table would go stale between releases and would second-guess the host's own configuration.

DSH already owns route authority. A child inherits the host default unless the caller names `provider` and `model`; the host's session policy and user settings validate the result. The plugin can only add the record: the route the call named (`routeSource: 'call'`) or the inherited host route (`inherit`), plus the route the child's first request header actually used when the host exposes the child session log. `effort` is sent only together with `provider` and `model`, because the host rejects an effort on its own.

There is no cross-family or vendor rule. Whether a review should come from another model family is a user and host decision; a same-model review is normal, and the reviewer result records the route that actually ran.

## Boundary to a private binding

A deployment that wants more than this package ships — durable run state, a session card, model tiers, external-system roles, a history of earlier plugin generations — can add its own binding over the same host services: its own skill, its own tools, its own storage and configuration. That binding is a separate product. This package does not import it, test against it or know it exists, and facts that change with one deployment's environment stay out of this repository.
