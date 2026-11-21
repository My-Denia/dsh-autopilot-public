# Changelog

History before 0.4.0 is compressed. The tag `v0.3.0-rc.7-pre-split` keeps the full previous tree: every removed module, the design document and the host compatibility record.

## 0.4.0 (unreleased)

The public package becomes one product: the basic local goal workflow. One skill, three tools, no host-specific facts.

### Breaking changes

- **Legacy 0.2.x history is removed.** The read-only fold, the legacy reader and its card half are gone. A run written by plugin 0.2.x is no longer listed, read or continued, and there is no migration path.
- **The routing engine is removed.** Gone: the ladder, the model catalog, route authorization, coverage reports, first-use onboarding, work classes and the cross-family vendor policy. Routes come from the dispatch call (`provider` and `model` together, optional `effort`) or from the host default; `autopilot_delegate` reports `routeSource: 'call'` or `'inherit'`. The host refuses a route it does not allow, not this plugin.
- **The persisted ledger and the client card are removed.** There is no ledger file, no storage-domain write, no web route, no client bundle and no `./client` export. Delegation records live in memory for one root session and are lost when the host restarts, together with the children they describe. There is no `lost` state and no resume.
- **The connector overlay is removed.** `examples/clerk-connectors.patch.yml`, the `clerk` role and external-system delegation are not part of the public product; the public product works on the local repository only.
- **Configuration is `{ skillInstall?: 'auto' | 'off' }` only.** `routing.*`, `storeRoot`, `DSH_AUTOPILOT_HOME` and every retired 0.2.x and 0.3.0 key have no effect; schemastery ignores unknown keys silently, so delete them from the profile.
- **`autopilot_status` is removed**, including its issue/PR link recording. The tool set is `autopilot_delegate`, `autopilot_agents` and `autopilot_escalate`.
- **The reviewer contract changes.** The verdict is `pass | fail` (0.3.0 used `pass | needs-fix | blocked`), findings are `blocker | note` (0.3.0 used `major | minor`), and there is no `subject` field. A `pass` carrying a `blocker` finding is refused.
- **Role scoping narrows.** An `executor-lead` may start only `scout` and `worker`; it cannot start `clerk` or a nested `executor-lead`.
- **`engines.dsh` is `>=0.2.2-rc.5 <0.3.0-0`**, Node 22 or newer.

### Added

- One adapter skill, `skill/dsh-goal-autopilot/SKILL.md`, with no reference files. `skillInstall: auto` (the default) publishes it through the host skills service, with a file-copy fallback into `$DSH_AGENTS_HOME/skills/dsh-goal-autopilot`.
- Three tools with per-child role scoping, parallel dispatch, a `writePaths` conflict guard, `replaces` generations, one escalation channel and an in-band reviewer verdict. Delegation records also carry the observed route — the model the child's first request actually used — when the host exposes the child session log.
- `autopilot_agents` wait: default 300 s, at most 600 s. Waiting inside the turn is the norm; the wait is not a gate.

### Migration

- Delete `routing.*`, `storeRoot` and the retired keys from the profile.
- Remove anything that imports `dsh-goal-autopilot/client` or reads the old web routes.
- Reinstall the skill. The old `dsh-autopilot` skill folder is a different skill and is not updated in place; delete it if it is still installed.
- A deployment that still needs durable runs, a session card, model tiers or external-system roles keeps them in its own private binding; they are not in this package.

## History before 0.4.0

### 0.3.0 — unreleased (rc.1 and rc.3–rc.7 on npm `next`)

The plugin became the dsh adapter of the goal workflow: native goal use (`get_goal`, `create_goal`, `update_goal`), `autopilot_delegate` / `autopilot_agents` / `autopilot_escalate` / `autopilot_status`, one read-only reviewer in place of three auditors, per-session file ledger, session card, routing engine, legacy 0.2.x read-only runs, and `clerk` with connectors. The final pre-release added native MCP server and resource tools to `clerk`. Never published as stable; `0.2.0` stayed npm `latest`.

### 0.2.1-rc.1 — 2026-10-17

Pre-release for dsh `0.2.1`: child start through `startActivation` and `agent/created`, a scope-aware tool registry for read-only roles, a turn-level card, and resume through `sendMessage`.

### 0.2.0 — 2026-10-07

dsh `0.2.0` support: the peer range that makes the plugin installable on 0.2, `sendMessage`-based executor resume, child recognition through `agent/created`, docs shipped inside the package, and the renamed PTC events.

### 0.1.1 — 2026-09-13

Packaging fix: `@deepseek-ai/dsh-tools` is a host-provided peer, not a runtime dependency. Shipping a second copy split the tool runtime symbol and broke the host's `skill` tool.

`0.1.0` was the first release and has no separate changelog entry.
