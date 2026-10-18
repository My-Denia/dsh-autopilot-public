# Compatibility

This page records **measured** host and packaging bounds for
`dsh-goal-autopilot`. It is not a wish list.

Source version: **0.2.1-rc.1**, a pre-release. It adapts the plugin to dsh
`0.2.1-rc.2` and keeps the earlier host ranges. It is **not** npm `latest`.
The published stable package remains **0.2.0** (the 2026-10-16 registry
check stands; it is not evidence that 0.2.1-rc.1 has been published).
Earlier: **0.1.1**, a packaging / runtime compatibility fix.

## Host matrix

| Host `dsh` | How it was established | Install / mount | Lifecycle |
| --- | --- | --- | --- |
| `0.2.1-rc.2` CLI | WSL2, 2026-10-17, isolated `DSH_HOME`, local Anthropic-messages mock on 127.0.0.1, no credentials | The installed client matches the 2026-10-17 tarball. A saved install log with the exit code was not kept. `engines.dsh` is what this host checks first. `pnpm peers check` inside a profile directory lists `@deepseek-ai/dsh-tools` and `schemastery` as missing; those are host-provided | **verified with the mock, on the 2026-10-17 tarball:** plugin tools loaded; plan audit; delegated executor; packet rev 1; execution audit needs-fix; resume; packet rev 2; closeout of goal A; `autopilot_init` of goal B in the same session; B completed; A's run stayed `completed` with its own executor; B had no executor and a different objective. Restart with `--session-id` then `autopilot_status` returned B (`…r2`, phase `completed`). That tarball's `lib/index.js` matches the 2026-10-18 package. Its `lib/client.js` does not contain `priorRuns`. |
| `0.2.1-rc.2` CLI, tarball `b967e627…` | WSL2, 2026-10-18, a different isolated home, local mock on 127.0.0.1. sha256 `b967e62729f9b492415a9238c8f3a3f035f156bbd5d4014564cbd86c310f3e62`, packed from `567b7a7`. Later doc commits are not inside that file | The installed client matches this tarball | Mock lifecycle through a second goal; restart status stayed on that goal. This does not replace the 2026-10-17 tarball. Extracted `lib/client.js` keeps the earlier run id in `priorRuns` and the live id on the later run. The 20 bundle assertions do not cover that fold. A web page on this home rendered the card for the live goal only; the card does not list `priorRuns`. **Not verified:** Desktop, and a real model. Headless calls stopped with HTTP 503 before any autopilot tool. |
| `0.2.0-rc.2` CLI | WSL2, 2026-10-07, isolated `DSH_HOME` + local mock model, no credentials | **verified:** `dsh plugin add` without exemption, mount, 12 `autopilot_*` tools, skill install; web profile serves the client bundle | **verified with a scripted mock model:** plan audit → delegated executor → packet → execution audit needs-fix → resume of the same executor → packet rev 2. **Not verified:** a real model, closeout |
| `0.2.0-rc.1`, `0.2.0` | in the declared range; host's own compatibility check says compatible | not re-run for 0.2.1-rc.1 | not re-run |
| `0.1.7-x`, other `0.2.1` prereleases | **outside** the declared range; dsh refuses the install | — | — |
| `0.1.5-rc.1` | WSL2 live CLI, 2026-09-13 (0.1.1) | **0.1.1 peer-layout:** compose/mount + skill load + `autopilot_init` | **not verified:** write lifecycle. 0.2.0's code changes were checked against the published 0.1.5 packages, not re-run on a 0.1.5 host |
| `0.1.2-rc.1` | Original package pin / earlier real-host work | claimed by this snapshot's design notes | earlier host traces in [DESIGN.md §8](../DESIGN.md) (not re-run) |
| Windows Desktop 0.2.0-rc.2 (app, real account) | **run 2026-10-10**, profile `desktop`, candidate tarball | **verified:** plugin mount; the shipped system-prompt section renders against the LIVE catalog (`m7/desktop-onboarding-section.md` in the run store); the routing config on the profile patch is what the host mounts, and the session's own run stayed visible (`enforcement.store=file`) after a restart | **partially verified:** run persistence across a host restart (needs the packaged `storeKind: file` pin repeated in the profile patch — see below); the composed-config dump is a HEADLESS artifact (the managed `desktop` profile refuses `--dump-config`), so the desktop side is backed by the on-disk patch plus the restarted session's own run state; **not verified:** full write lifecycle / closeout on Desktop, macOS |
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

### Profile patch hazard: re-declaring the plugin id drops the packaged store pin

The plugin ships its own bundle layer (`cordis.patch.yml`) which pins
`storeKind: file`. A profile's patch layer **replaces** the config of the entry
it targets rather than merging into it, so an owner who adds

```yaml
- id: autopilot
  name: dsh-goal-autopilot
  config:
    routing: { … }
```

silently loses that pin: `storeKind` falls back to the schema default `auto`,
the host picks the `storageDomain` backend, and every run this session already
recorded in the file store becomes invisible (`autopilot_status` answers
`{"initialized":false,"note":"no autopilot run on this session"}`).
**Measured on Windows Desktop 0.2.0-rc.2, 2026-10-10**: two runs created after
such a patch landed in `$DSH_HOME/storages/dsh_autopilot.json` (the domain
table) while four earlier file-backed runs stayed under
`$DSH_HOME/storages/dsh-autopilot/runs/` — the split-brain the packaged layer's
own comment warns about. Repeat `storeKind: file` in any patch entry for this
id.

Windows Desktop **was** run for the 0.2.0-rc.2 candidate on 2026-10-10 with a
real account and the live model catalog: the plugin mounted, the onboarding
system-prompt section rendered against the live catalog, and the run store
stayed file-backed once the packaged `storeKind: file` pin was repeated in the
profile patch (see "Profile patch hazard" below). Not verified there: the full
write lifecycle to closeout, and macOS. On a host outside the range dsh offers an exact-version exemption
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

## Host capability map (measured, 0.2.0-rc.2)

Which host capabilities this plugin rides on, and which it must carry
itself — established against the published `@deepseek-ai/*` 0.2.0-rc.2
packages and the Windows Desktop app (2026-10-10/12):

| Capability | Host status | Plugin stance |
| --- | --- | --- |
| LLM catalog (`ctx.llm.listProviders` / `listModels` / `resolveModelInfo`) | present | **used** — work-class reachability and routing selection read the live catalog; no parallel model list exists in the plugin |
| Custom-provider discovery (`discoverModels`) | present | **not called** — the plugin reads the live catalog directly (the row above); owner-added custom models surface there because the host's own provider config feeds it, never through plugin-side re-entry |
| Subagent route authorization (`subagentModelSelection` session policy) | present | **used** — the session's allowed-model lock bounds every routing selection (see the policy-triad rule above) |
| Reasoning effort (`reasoningEffort` at dispatch, `defaultEffort` per model) | present | **used** — the dispatch packet names the pinned effort; a route with none means the fixed setting IS the ceiling and the plugin never invents one |
| Token cost / usage metering | **absent** | the price seed in `references/model-routing.md` is a dated, provenance-labelled tie-break seed, never a live fact |
| Host-native goal-autopilot surface | **absent** | this plugin IS the DSH GAH; there is no host system to defer to or duplicate |
| Skill registry | present | **used** — the adapter ships as a skill installed through the host's own registry |
| Run storage backends | `file` / `storageDomain` | both supported; Desktop needs the shipped `storeKind: file` pin (see the profile-patch hazard above) |

The rule behind the table: a host capability that EXISTS is ridden, not
rebuilt; one that is absent is named absent, not wished into the docs.

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
