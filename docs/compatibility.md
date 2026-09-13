# Compatibility

This page records **measured** host and packaging bounds for
`dsh-goal-autopilot`. It is not a wish list.

Latest published package: **0.1.1**. That release is a **packaging / runtime
compatibility** fix. It does not add features and does not claim a verified
full write lifecycle.

## Host matrix

| Host `dsh` CLI | How it was established | Install / mount | Full NL run to closeout |
| --- | --- | --- | --- |
| `0.1.2-rc.1` | Original package pin / earlier real-host work | claimed by this snapshot's design notes | earlier host traces in [DESIGN.md §8](../DESIGN.md) (not re-run this round) |
| `0.1.5-rc.1` | WSL2 live CLI, 2026-09-13, **not downgraded** | **0.1.1 peer-layout:** compose/mount + skill load + `autopilot_init` without a nested `dsh-tools` runtime. **0.1.0** installed a second runtime and broke host `skill`. | **not verified:** write lifecycle. Tested headless model sends redundant `sandbox_permissions=workspace-write` |
| Windows | out of scope this round | **not verified** | **not verified** |

Windows is **not** a supported platform in this snapshot. Do not read the
PowerShell skill-copy fallback as Windows support.

On a 0.1.5 profile, `dsh plugin add` may print a pnpm **peer WARN** because
`dsh-tools@0.1.2-rc.1` still wants 0.1.2-era peers. The add still exited 0 in
the WSL measurement; `pnpm peers check` lists the missing names. That WARN
alone is not a signal to downgrade the host CLI.

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

The client types and bundle tests themselves against a **built** dsh source
checkout at the same version as the pins. Set `DSH_SRC` to that tree (default
`~/dsh`) before `check:client`, `build:client`, and `test:client-bundle`.
GitHub Actions CI covers the **host** half only; the client half is omitted
on purpose because those commands need a local dsh checkout.

## See also

- [DESIGN.md](../DESIGN.md) — architecture, honest limits, verification record
- [security.md](security.md) — sandbox / egress assumptions
- [CHANGELOG.md](../CHANGELOG.md) — 0.1.1 notes
