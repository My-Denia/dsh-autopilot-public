# Changelog

Host and packaging bounds that outlive a single release are in
[docs/compatibility.md](docs/compatibility.md).

## 0.2.0 — unreleased

Adapts the plugin to DeepSeek Harness (`dsh`) 0.2.0, the CLI and the Desktop
app's bundled `dsh` command. Measured on WSL2 against a real `dsh`
0.2.0-rc.2 with a local mock model; Desktop itself was not run. Details:
[docs/compatibility.md](docs/compatibility.md),
[DESIGN.md §8.4](DESIGN.md).

### Fixed

- Installable on dsh 0.2. The `@deepseek-ai/dsh-tools` peer now also allows
  `>=0.2.0-rc.1 <0.2.1-0`; dsh 0.1.7+ refuses plugins whose dsh peers do not
  match the running version, and refused 0.1.1.
- Needs-fix executor resume. It called `subagents.followup`, which no
  published dsh has (0.1.2-rc.1 through 0.2.0-rc.2); it now uses
  `subagents.sendMessage`.
- Executor child recognition on dsh 0.2. Reading `ctx.agent` on the child
  context throws there, so the executor ran without
  `autopilot_submit_packet`, egress guard, or seam. Recognition now uses the
  agent announced by `agent/created`.
- The stop reminder no longer exits dsh 0.2. Its message source kind is now
  `dsh-autopilot`; session format v4 refuses the retired `kind: 'plugin'`.
- The run card follows PTC calls on dsh 0.1.7+, which renamed
  `tool/code-dispatch(-start)` to `tool/ptc-dispatch(-start)`. Both names
  are accepted.

### Changed

- Test/build pins: `@deepseek-ai/dsh-*` `0.2.0-rc.2`, cordis `4.0.4`,
  schemastery `3.18.4`.
- New tests check the installed subagent manager surface, the dsh 0.2 child
  context shape, the reminder source kind, and the renamed PTC events.

### Not verified

Desktop on macOS/Windows, Windows in general, a full run with a real model
through closeout, executor re-recognition after a cold-resumed child, and
the card rendering in a browser.

## 0.1.1 — 2026-09-13

Packaging / runtime compatibility release. Parent of the version bump is
`ff7ccaef` (keep `dsh-tools` a host-provided peer).

0.1.0 shipped `@deepseek-ai/dsh-tools` in runtime `dependencies`; that is the
defect this release repairs. No separate 0.1.0 changelog date is recorded
here.

### Fixed

- Stop shipping `@deepseek-ai/dsh-tools` in runtime `dependencies`.
- That second copy split the module-instance `TOOL_RUNTIME_SCHEDULER` Symbol
  and crashed host `skill` (`scheduler.prepare` undefined).
- Bounded peer kept as `0.1.2-rc.1 || >=0.1.5-rc.1 <0.1.6`. The test/build
  pin stays in `devDependencies`.

### Compatibility (WSL2, `dsh` `0.1.5-rc.1`)

Verified: npm install, compose/mount, skill install/load, autopilot entry,
plan/replan/audit through the plan gate.

Not verified: full write lifecycle. The tested headless model does not currently follow the host sandbox escalation contract for ordinary workspace-write calls. That mismatch is a host/model contract issue, not this plugin's 0.1.1 scope.
