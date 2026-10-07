# Compatibility

This page records **measured** host and packaging bounds for
`dsh-goal-autopilot`. It is not a wish list.

Current release: **0.2.0** (adapts the plugin to `dsh` 0.2.0; prepared
locally, see [CHANGELOG](../CHANGELOG.md)). Earlier: **0.1.1**, a packaging /
runtime compatibility fix.

## Host matrix

| Host `dsh` | How it was established | Install / mount | Lifecycle |
| --- | --- | --- | --- |
| `0.2.0-rc.2` CLI | WSL2, 2026-10-07, isolated `DSH_HOME` + local mock model, no credentials | **verified:** `dsh plugin add` without exemption, mount, 12 `autopilot_*` tools, skill install; web profile serves the client bundle | **verified with a scripted mock model:** plan audit → delegated executor → packet → execution audit needs-fix → resume of the same executor → packet rev 2. **Not verified:** a real model, closeout |
| `0.2.0-rc.1`, `0.2.0` | in the peer range; host's own compatibility check says compatible | not run | not run |
| `0.1.7-x`, `0.2.1-x` | **outside** the peer range; dsh refuses the install | — | — |
| `0.1.5-rc.1` | WSL2 live CLI, 2026-09-13 (0.1.1) | **0.1.1 peer-layout:** compose/mount + skill load + `autopilot_init` | **not verified:** write lifecycle. 0.2.0's code changes were checked against the published 0.1.5 packages, not re-run on a 0.1.5 host |
| `0.1.2-rc.1` | Original package pin / earlier real-host work | claimed by this snapshot's design notes | earlier host traces in [DESIGN.md §8](../DESIGN.md) (not re-run) |
| Desktop (macOS / Windows) | **not run** | **not verified** | **not verified** |
| Windows | out of scope | **not verified** | **not verified** |

Windows is **not** a supported platform in this snapshot. Do not read the
PowerShell skill-copy fallback as Windows support.

### dsh Desktop

dsh 0.2.0-rc.2 Desktop bundles the `dsh` command (menu bar → "Manage dsh
command") and has a plugin manager. Both use the same compatibility check as
the CLI, so the peer range above is what decides whether Desktop accepts the
plugin. Install from the Desktop plugin manager by package name
`dsh-goal-autopilot`, or with the bundled command:

```sh
dsh plugin --profile <name> add dsh-goal-autopilot@0.2.0
```

Desktop itself was not run for this release (not verified on macOS or
Windows). On a host outside the range dsh offers an exact-version exemption
(`dsh plugin --profile <name> allow-version …`); that accepts an untested
combination, it does not make one supported.

On a 0.1.5 profile, `dsh plugin add` may print a pnpm **peer WARN** because
`dsh-tools@0.1.2-rc.1` still wants 0.1.2-era peers. The add still exited 0 in
the WSL measurement; `pnpm peers check` lists the missing names. That WARN
alone is not a signal to downgrade the host CLI.

## What 0.2.0 fixed

dsh 0.1.7 added an install/start compatibility check on plugin peers, and the
0.1.7 session format and runtime changed four seams this plugin uses. Details
and measurements: [DESIGN.md §8.4](../DESIGN.md).

- **Peer range** `0.1.2-rc.1 || >=0.1.5-rc.1 <0.1.6 || >=0.2.0-rc.1 <0.2.1-0`.
  0.1.1 is refused by dsh 0.2 ("installation rejected").
- **Executor resume** now uses `subagents.sendMessage`. The old
  `subagents.followup` call does not exist on any published dsh (0.1.2-rc.1
  through 0.2.0-rc.2), so a needs-fix resume could not have worked on a real
  host. That is read from the published packages; the host run here reached
  resume only after the fix.
- **Executor recognition** uses the agent announced by `agent/created`. On
  0.2 the child context throws on `ctx.agent`, and the executor got no
  `autopilot_submit_packet`, egress guard, or seam.
- **Stop reminder** source kind is `dsh-autopilot`. Session format v4 refuses
  `kind: 'plugin'`, and the first reminder exited dsh.
- **Run card** accepts `tool/ptc-dispatch(-start)` as well as the old
  `tool/code-dispatch(-start)` names.

## What 0.1.1 fixed

`@deepseek-ai/dsh-tools` is a **host-provided peer**, range
`0.1.2-rc.1 || >=0.1.5-rc.1 <0.1.6`. The test/build pin stays in
`devDependencies`.

0.1.0 shipped `dsh-tools` in runtime `dependencies`. That second copy split
the module-instance `TOOL_RUNTIME_SCHEDULER` Symbol and crashed host `skill`
(`scheduler.prepare` undefined). 0.1.1 keeps a single host copy.

`@deepseek-ai/cordis` is a **devDependency only** — no file in `src/` imports
it, so it is not declared as a peer. `@deepseek-ai/schemastery` is the other
peer (for the `Config` export).

## Minimum host line (0.1.2)

The 0.1.2 CLI remains the **minimum** line this source was written against.
dsh 0.1.2 removed `Session.events` (the plugin reads `snapshotEvents()`), the
`@deepseek-ai/dsh-client-runtime` package, and
`ctx.subagents.registerContinuableSetup`. The executor child's surface is now
installed from the plugin's `agent/created` listener.

If you keep an older dsh tree side by side, never run profiles from both CLIs
at once: the shared `$DSH_HOME/profiles/node_modules` is re-pointed by
whichever CLI boots last. Measurements: [DESIGN.md §6](../DESIGN.md).

## Skill publication

On mount, `apply()` copies `skill/dsh-autopilot/SKILL.md` into the skill-scan
root (`$DSH_AGENTS_HOME/skills/dsh-autopilot/SKILL.md`, default
`~/.agents/skills`) if the dest is absent. Identical bytes are a no-op. A dest
that differs is a drift warning naming that path, never an overwrite
(`skillInstall: 'off'` skips this).

Publication goes through a **hard link** from a fully written temp file. On a
skill home whose filesystem does not support hard links the install is
`unsupported` — a warning naming the destination, and this call writes nothing
to it. The mount still succeeds; copy the file by hand to install
it. Manual copy commands live in [reference](reference.md).

## Verified on WSL2 + `dsh` `0.1.5-rc.1` (0.1.1)

Verified: npm install, compose/mount, skill install/load, autopilot entry,
and plan/replan/audit through the plan gate.

**Not verified:** the full write lifecycle. The tested headless model does not
currently follow the host **sandbox escalation** contract for ordinary
workspace-write calls. That host/model mismatch is outside this plugin's
0.1.1 scope. Residual: the model sends redundant
`sandbox_permissions=workspace-write`.

The domain store backend has been driven to `autopilot_init` and no further
on that path; artifact settlement and some store-error arms are file-backend
evidence only. See [DESIGN.md §6](../DESIGN.md).

## Client half

The client types and bundle tests itself against a dsh source tree at the
same version as the pins. Set `DSH_SRC` (default `~/dsh`) before
`check:client` and `build:client`, and `DSH_STORE` (default
`~/dsh/node_modules/.pnpm`) before `test:client-bundle`. For 0.2.0 the
declarations came from the published 0.2.0-rc.2 packages arranged in the
expected layout; a built 0.2.0-rc.2 checkout works the same way.
GitHub Actions CI covers the **host** half only; the client half is omitted
on purpose because those commands need a local dsh tree.

## See also

- [DESIGN.md](../DESIGN.md) — architecture, honest limits, verification record
- [security.md](security.md) — sandbox / egress assumptions
- [CHANGELOG.md](../CHANGELOG.md) — release notes
