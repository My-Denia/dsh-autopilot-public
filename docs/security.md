# Security and boundaries

`dsh-goal-autopilot` is a developer preview. It is not a sandbox, not a permission system, not a scanner and not a connection to any external system. What it enforces is narrow, and saying so is the point of this page.

## What the plugin gates

- **Role tool surfaces.** *Mechanical.* A delegated child's tool set is restricted when the host announces the child: `scout`, `planner` and `reviewer` see only `read`, `glob`, `grep`, `read_image` (scout also `web_fetch`, `web_search`). A read-only role whose `read` is missing is refused rather than started blind. `worker` and `executor-lead` are not filtered; they inherit the session's tools, which is what lets them write.
- **Who may delegate.** *Mechanical.* Only the root agent and an `executor-lead` may call `autopilot_delegate`, and an `executor-lead` may start only `scout` and `worker`. A `reviewer` gets no plugin tool and cannot delegate. `autopilot_escalate` records a request; it never widens a role.
- **Concurrent writers.** *Mechanical, advisory between writers.* A `worker` must declare `writePaths`, and a dispatch whose paths intersect a writer still `starting` or `running` under the same root is refused before the child starts.
- **The reviewer's verdict.** *Mechanical.* The reviewer is one-shot and read-only, its verdict comes back in-band from its own call, the main agent cannot write one, and a malformed or contradictory verdict is refused.

## What the plugin does not gate

- **Sandbox and approval.** The host's approval and sandbox settings apply to every tool call, including a worker's writes and a root `git push`, exactly as they do without this plugin. The plugin neither adds a check nor loosens one; a pending or refused approval is a question for the user.
- **Write paths are not permissions.** A worker has the inherited tool surface and is not stopped from writing outside its declared paths. The overlap check only compares declarations, only among writers under the same root in the same process; a declaration is an exact file or a prefix, and any other glob is read conservatively as the prefix before its first wildcard, so the check can over-report an overlap but cannot miss one. It does not inspect the filesystem, resolve symlinks, or see another dsh process or another session. Keeping inside the brief is the worker's job and the root's review.
- **Outbound content.** Nothing scans or redacts a commit message, a PR body or an issue comment. Commit, push, pull request and merge in the repository are ordinary work. Redaction before posting is an instruction in the skill and a review item, not a gate.
- **External systems.** The package has no MCP client, no connector overlay, no network call of its own and no external-system role. It sees only the tools the host registers in the session.
- **Routes.** The plugin does not grant, filter or rank model routes. It passes an explicit `provider`/`model` pair to the host, or lets the child inherit the host default, and the host validates what it is given.
- **Storage.** There is no ledger file, no storage-domain write, no web route and no client card. Delegation records exist only in plugin memory for one root session and are gone after a host restart.

## What the records are and are not

- The route sent with a dispatch and its source say what the plugin asked for; `observed`, when the host exposes the child session log, is the route the child's first request actually used. Neither proves the work is right.
- A reviewer verdict is evidence of one independent look, not proof that the change is correct.
- `writePaths` is a statement of intent at dispatch time, not a boundary the filesystem enforces.
- `idle` in a record means a child settled a turn and can be messaged, not that its work is finished or correct.

## Non-goals

- A sandbox, a permission system or a policy layer for the session.
- Redaction or scanning of outbound payloads.
- Remote delivery, durability or exactly-once behaviour.
- A cross-family or vendor guarantee for reviews.
- Compatibility with plugin 0.2.x runs, tools or configuration.
