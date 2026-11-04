# Compatibility

This page records **measured** host and packaging bounds for
`dsh-goal-autopilot`. It is not a wish list.

## 0.3.0 (unreleased)

Source version `0.3.0`, the goal-workflow adapter. Pre-releases up to
`0.3.0-rc.3` are on npm `next`; `latest` is still `0.2.0`.

- **Target host:** dsh `0.2.1-rc.5` only (npm `@deepseek-ai/dsh` `latest` was
  `0.2.1-rc.5` on 2026-10-29; that is the Windows desktop build). The plugin is
  tested on no other host. The `engines.dsh` range in `package.json` is
  `>=0.2.1-rc.5 <0.3.0-0`, and the `@deepseek-ai/dsh-tools` peer range is the
  same. A host outside it refuses the install.
- **Environments:** the Windows desktop app (profile `desktop`) and the WSL CLI
  (profile `autopilot-rc`) are each treated as a native environment. The WSL CLI
  has no run history; the Windows desktop profile has 45 legacy run streams.
- **Old hosts:** `0.1.x` and `0.2.0` hosts stay on `dsh-goal-autopilot@0.2.0`,
  the last version for them.
- **WSL rollback:** back up the profile, then
  `npm i -g @deepseek-ai/dsh@0.1.5-rc.1`.

Nothing in this section is a measurement of 0.3.0 behavior. What has and has not
been observed is below.

## Verified on a real host

Plugin 0.3.0-rc.1 on Windows, DeepSeek Harness `0.2.1-rc.5`, headless profile
(base + headless + plugin), `deepseek-official` provider only, with the packed
tarball installed through `dsh plugin add`. Tests, mock runs and status reads are
not counted here; these were observed in real model sessions.

- The plugin loads. The session tool list contains `autopilot_status`,
  `autopilot_delegate` and `autopilot_agents`, and the retired tools are absent.
- Simple work stays out of the goal flow: a single-file edit made 0
  `autopilot_*` calls and 0 `create_goal` calls.
- Goal work: `create_goal` was called; two scouts ran concurrently; an
  `executor-lead` started a `worker` (depth 2); a role effort pin (`max`) was
  seen in the request headers; the reviewer returned a structured verdict that
  the ledger recorded with independence "reduced", because only one provider
  family was reachable. Every delegation recorded observed route equal to
  selected route (8 of 8 in one run, 6 of 6 in a later one).
- Own-repo outbound: `git push` and `gh pr create --draft` ran with no refusal.
  The goal stayed active through a CI wait with 0 idle rounds, because the agent
  waited inside the turn.
- Restart recovery: after the host was killed mid-worker and resumed, the worker
  showed as lost and auto-continue was released. The owner's "continue" led to
  `update_goal` resume, a new worker, and completion.
- Same session, goal A then goal B: A's records were unchanged.
- Two concurrent headless processes on one profile: both ledgers were complete
  (one file per session), and the legacy domain file was byte-identical.
- A goal completion appeared in the ledger within milliseconds (the
  goal-changed listener).
- Legacy data: 47 legacy runs (45 file, 2 domain) fold and project with 0
  rejected, and the legacy store was left untouched. A legacy session clamped to
  read-only was restored to its prior `workspace-write` mode, and a write
  succeeded.
- WSL: the plugin installs and loads on dsh `0.2.1-rc.5`. No model task ran
  there, because the WSL environment had no credentials.

Isolated Web Session host, agent-sent API prompts (dsh `0.2.1-rc.5`, web
composition, not a person typing in a client):

- A `schedule_create` reminder was delivered after a host restart; `deliveredAt`
  was 2.3 s after boot.
- After the restart no goal round ran until the agent explicitly called
  `update_goal` with `action: resume`. An owner-style "continue" message alone
  did not lead the agent to resume in one of two runs, so the goal stayed disarmed.
- When the agent called resume and then ended its turn, a goal round started
  immediately.
- When the agent called `schedule_create` and ended its turn with the goal
  active and armed, the driver queued about one no-op round per second (48 rounds
  in about 57 s), heading for the 256-round cap. The skill now says to wait
  inside the turn.
- The ledger route returned 200.

Owner's daily Windows desktop app, plugin `0.3.0-rc.1`: the native goal round
started stage 2 by itself. The prompt was pasted into the desktop GUI by an
agent, not typed by the owner.

Owner's daily Windows desktop app, dsh `0.2.1-rc.5`, plugins `0.3.0-rc.2` and
`0.3.0-rc.3`, one provider family (`deepseek-official`). In each run an agent
pasted one prompt into the desktop GUI; the session holds exactly one
human-turn message.

- Scouts were dispatched through `autopilot_delegate` and their run intervals
  overlapped (47.0 s on rc.2, 17.7 s on rc.3). Observed route equalled selected
  route.
- The reviewer was dispatched through `autopilot_delegate` and its structured
  verdict was recorded in the ledger.
- After stage 1 the native goal round started stage 2 with no human message,
  and the goal completed.
- The card renders at turn level (rc.2 fix confirmed) and its fields match the
  ledger, except that the rc.2 review label added a "same provider family"
  prefix the ledger did not support. On rc.3 the independence label is the
  recorded independence note.
- rc.2 finding: a reviewer called without `reviewedChildIds` linked nothing,
  because the scouts were read-only. Fixed in rc.3: the same call linked both
  scouts by default. Independence stayed "reduced" with `excludedFamilies`
  `[deepseek-official]`, because only one provider family is configured.
- rc.3 finding, not fixed: the reviewer delegation's `routeWhy` and the
  review's independence note give different reasons for falling back to the
  unfiltered ladder.
- Model config note for users: dsh `0.2.1-rc.5` rejects a `models` key under
  `llm-deepseek-account`, and the desktop's account provider then fails to
  load. Use `modelOverrides` or remove the key. With the key removed, the
  "DeepSeek 账号" group appears in the model picker.

npm: `0.3.0-rc.3` is on `next` (`0.3.0-rc.1` was published earlier); `latest`
is still `0.2.0`. The registry integrity matched the audited tarball.

## Not verified on a real host

None of the following has been observed on dsh `0.2.1-rc.5`.

- Installing the plugin from the desktop Plugins page (the rc.2 and rc.3
  installs used `dsh plugin add` with a tarball).
- A cross-family reviewer. It needs a second provider family; the test machine
  had only one configured.
- A session whose sandbox mode the user changed after the old clamp stays
  unchanged. The candidate session needs a preset that headless refuses.
- A model task on WSL.
- DSH-side Linear access.
- Connector tools for `clerk`. They are not wired into delegation, so `clerk`
  is read-only today.
- The card in a live web client for a session whose only goal activity is a
  native goal call.
- Whether children started by the plugin's runtime get native settlement
  notices and can be driven by the host's `send_message`, `list_agents` and
  `interrupt_agent`. The plugin ships no list, message or stop tool
  (`autopilot_agents` has only `wait`).
- Whether the host's `subagentModelSelection` setting is honoured end to end.
  Only fakes have covered it.

## Measured for plugin 0.2.x (history)

Everything below this line was measured, or written, for plugin 0.2.x and
earlier on other hosts (`0.2.0-rc.2`, `0.2.1-rc.2`, `0.1.5-rc.1` and so on). It
is history. It does not say 0.3.0 works on those hosts, and the hosts in it are
outside the 0.3.0 target. The tool names, run phases and gates mentioned in
those measurements belong to the retired 0.2.x design.

Source version of that line: **0.2.1-rc.1**, a pre-release adapted to dsh
`0.2.1-rc.2`. The published stable package for it remains **0.2.0**.

## Host matrix

| Host `dsh` | How it was established | Install / mount | Lifecycle |
| --- | --- | --- | --- |
| `0.2.1-rc.2` CLI | WSL2, 2026-10-17, isolated `DSH_HOME`, local Anthropic-messages mock on 127.0.0.1, no credentials | The installed client matches the 2026-10-17 tarball. A saved install log with the exit code was not kept. `engines.dsh` is what this host checks first. `pnpm peers check` inside a profile directory lists `@deepseek-ai/dsh-tools` and `schemastery` as missing; those are host-provided | **verified with the mock, on the 2026-10-17 tarball:** plugin tools loaded; plan audit; delegated executor; packet rev 1; execution audit needs-fix; resume; packet rev 2; closeout of goal A; the 0.2.x init call of goal B in the same session; B completed; A's run stayed `completed` with its own executor; B had no executor and a different objective. Restart with `--session-id` then `autopilot_status` returned B (`…r2`, phase `completed`). That tarball's `lib/index.js` matches the 2026-10-18 package. Its `lib/client.js` does not contain `priorRuns`. |
| `0.2.1-rc.2` CLI, tarball `b967e627…` | WSL2, 2026-10-18, a different isolated home, local mock on 127.0.0.1. sha256 `b967e62729f9b492415a9238c8f3a3f035f156bbd5d4014564cbd86c310f3e62`, packed from `567b7a7`. Later doc commits are not inside that file | The installed client matches this tarball | Mock lifecycle through a second goal; restart status stayed on that goal. This does not replace the 2026-10-17 tarball. Extracted `lib/client.js` keeps the earlier run id in `priorRuns` and the live id on the later run. The 20 bundle assertions do not cover that fold. A web page on this home rendered the card for the live goal only; the card does not list `priorRuns`. **Not verified:** Desktop, and a real model. Headless calls stopped with HTTP 503 before any autopilot tool. |
| `0.2.0-rc.2` CLI | WSL2, 2026-10-07, isolated `DSH_HOME` + local mock model, no credentials | **verified:** `dsh plugin add` without exemption, mount, 12 `autopilot_*` tools, skill install; web profile serves the client bundle | **verified with a scripted mock model:** plan audit → delegated executor → packet → execution audit needs-fix → resume of the same executor → packet rev 2. **Not verified:** a real model, closeout |
| `0.2.0-rc.1`, `0.2.0` | in the declared range; host's own compatibility check says compatible | not re-run for 0.2.1-rc.1 | not re-run |
| `0.1.7-x`, other `0.2.1` prereleases | **outside** the declared range; dsh refuses the install | — | — |
| `0.1.5-rc.1` | WSL2 live CLI, 2026-09-13 (0.1.1) | **0.1.1 peer-layout:** compose/mount + skill load + the 0.2.x init call | **not verified:** write lifecycle. 0.2.0's code changes were checked against the published 0.1.5 packages, not re-run on a 0.1.5 host |
| `0.1.2-rc.1` | Original package pin / earlier real-host work | claimed by this snapshot's design notes | earlier host traces in [DESIGN.md §8](../DESIGN.md) (not re-run) |
| Windows Desktop 0.2.0-rc.2 (app, real account) | **run 2026-10-10**, profile `desktop`, candidate tarball | **verified:** plugin mount; the shipped system-prompt section renders against the LIVE catalog (`m7/desktop-onboarding-section.md` in the run store); the routing config on the profile patch is what the host mounts, and the session's own run stayed visible (`enforcement.store=file`) after a restart | **partially verified:** run persistence across a host restart (needs the packaged `storeKind: file` pin repeated in the profile patch — see below); the composed-config dump is a HEADLESS artifact (the managed `desktop` profile refuses `--dump-config`), so the desktop side is backed by the on-disk patch plus the restarted session's own run state; **not verified:** full write lifecycle / closeout on Desktop, macOS |
| Windows | out of scope | **not verified** | **not verified** |

The "Windows | out of scope" row above is the 0.2.x position. For 0.3.0 the
Windows desktop app is a target environment. The headless profile on Windows is verified (see above); the desktop GUI is not.

### dsh Desktop

dsh 0.2.0-rc.2 Desktop bundles the `dsh` command (menu bar → "Manage dsh
command") and has a plugin manager. Both use the same compatibility check as
the CLI, so the peer range above is what decides whether Desktop accepts the
plugin. Install from the Desktop plugin manager by package name
`dsh-goal-autopilot`, or with the bundled command:

```sh
dsh plugin --profile <name> add dsh-goal-autopilot@0.2.0
```

### Profile patch hazard: re-declaring the plugin id drops the packaged store pin (0.2.x history; retired store key)

Still true in general: a profile patch layer replaces the config of the entry it
targets instead of merging into it. In 0.3.0 `storeKind` is a removed key that
is accepted and ignored, so this exact loss of file-backed runs is a 0.2.x
matter; legacy runs are read from whichever backend holds them. The text below
is the 0.2.x measurement.

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

## What 0.2.0 fixed (history)

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
  executor packet tool, egress guard, or seam.
- **Stop reminder** source kind is `dsh-autopilot`. Session format v4 refuses
  `kind: 'plugin'`, and the first reminder exited dsh.
- **Run card** accepts `tool/ptc-dispatch(-start)` as well as the old
  `tool/code-dispatch(-start)` names.

## What 0.1.1 fixed (history)

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

## Verified on WSL2 + `dsh` `0.1.5-rc.1` (plugin 0.1.1, history)

Verified: npm install, compose/mount, skill install/load, autopilot entry,
and plan/replan/audit through the plan gate.

**Not verified:** the full write lifecycle. The tested headless model does not
currently follow the host **sandbox escalation** contract for ordinary
workspace-write calls. That host/model mismatch is outside this plugin's
0.1.1 scope. Residual: the model sends redundant
`sandbox_permissions=workspace-write`.

The domain store backend has been driven to the 0.2.x init call and no further
on that path; artifact settlement and some store-error arms are file-backend
evidence only. See [DESIGN.md §6](../DESIGN.md).

## Host capability map (measured for plugin 0.2.x, 0.2.0-rc.2)

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
| Host-native goal-autopilot surface | **absent** in 0.2.0-rc.2 | 0.2.x stance. 0.3.0 targets a host that has native goal tools and a goal round driver, and uses them; what was observed is in the verified list above, and what was not is in the not-verified list |
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
- [security.md](security.md) — what the plugin does and does not gate
- [CHANGELOG.md](../CHANGELOG.md) — release notes
