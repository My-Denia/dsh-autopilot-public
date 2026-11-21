# Changelog

History before 0.4.0 is compressed. The tag `v0.3.0-rc.7-pre-split` keeps the full previous tree: every removed module, the design document and the host compatibility record.

## 0.5.0 (unreleased)

The package becomes configuration only: five agent presets, one delegation tool row and one skill. There is no plugin code, no build step and no runtime of its own.

### Breaking changes

- **The plugin is gone.** There is no Loader entry, no exported module and no `lib/`. `main`, `types` and `exports` are removed; `src/`, the TypeScript configs, the vitest suite and every build, typecheck and code-generation script are deleted.
- **The three tools no longer exist.** `autopilot_delegate`, `autopilot_agents` and `autopilot_escalate` are not registered by anything in this package. Delegation is the host's `delegate` tool from `@deepseek-ai/dsh-tool-subagent`; waiting inside a turn is the host's `wait_agent` and `job_output`; steering is `send_message`.
- **Roles are agent presets, not tool arguments.** `goal-scout`, `goal-worker`, `goal-executor-lead`, `goal-planner` and `goal-reviewer` are `@deepseek-ai/dsh-agent-preset` declarations. A child is chosen with `agent_preset`, never with a `role` argument, and its tools come from the preset instead of runtime tool filtering.
- **The in-memory ledger is gone.** There are no delegation records, generations, `replaces` links, escalation records or states. The transcript, the host's completion notice and `list_agents` are the record; a host restart drops the children and nothing is resumed.
- **The reviewer contract changes.** A review is an ordinary child answer rather than a call that waits and returns a validated structured verdict. Nothing enforces the verdict schema.
- **`writePaths` and its conflict guard are gone.** The host does not compare file scopes between concurrent children; the main agent writes disjoint scopes into the briefs.
- **The refusal codes are gone.** `AP_*` codes and the role-scope refusals do not exist; every error is the host's own tool error.
- **The `skillInstall` key and plugin-side skill publishing are gone.** The bundle has no configuration keys. The skill is a file installed by copying it into a skill root.
- **Depth is a host feature now.** The profile-level `delegate` row sets `maxDepth: 1`; `goal-executor-lead` carries its own row at `maxDepth: 2`. Children are refused by the host at the cap.
- `engines.dsh` is unchanged: `>=0.2.2-rc.5 <0.3.0-0`, Node 22 or newer for the tests.

### Added

- `cordis.patch.yml`: one profile-level `delegate` row (`modelSelection`, `modelDiscovery`, the five preset ids as `allowedAgentPresets`, `maxDepth: 1`) and five preset declarations, each composing a persona, the time context and the role's tool rows.
- `test/config.test.mjs`: a dependency-light `node:test` suite that parses the patch, checks the preset declarations and delegation rows, the skill frontmatter, the package manifest and the CI gate list.

### Migration

- Remove the old `autopilot` Loader row, and any config under it, from the profile's `cordis.patch.yml`.
- Install `dsh-goal-autopilot@0.5.0` and keep the main agent's usual preset; the goal roles appear as child presets.
- Replace `autopilot_delegate({ role, task, writePaths })` with `delegate({ agent_preset, prompt, description })`, and put the allowed paths and the checks in the brief.
- Replace `autopilot_agents` waits with `wait_agent` or `job_output`, and plan for the child's answer to arrive in the completion notice.
- Replace `autopilot_escalate` with a message to the main agent (`send_message`) or a new delegation with a stronger route.
- Remove `skillInstall` from the profile, and copy `skill/dsh-goal-autopilot` into a skill root.
- Project instructions, scripts or skills that call `autopilot_*` tools need updating; they now fail as unknown tools.

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
