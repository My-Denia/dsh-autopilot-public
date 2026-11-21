> This GitHub Release is notes-only: no tarball is attached. The installable
> package is on npm as `dsh-goal-autopilot`; the registry is the only install
> channel.

0.5.0 is configuration only: five agent presets (`goal-scout`, `goal-worker`,
`goal-executor-lead`, `goal-planner`, `goal-reviewer`), one profile-level
`delegate` delegation row capped at depth 1, and one skill. There is no plugin
code, no `lib/`, and no service. It targets dsh `0.2.2-rc.5`
(`engines.dsh` `>=0.2.2-rc.5 <0.3.0-0`).

This release removes the three `autopilot_*` tools, the in-memory delegation
ledger, runtime role scoping, the `writePaths` guard, the reviewer wait and the
plugin's skill publishing. Roles are presets now, delegation is the host's
`delegate` tool, and the skill is a file you copy into a skill root. See
CHANGELOG.md for the full break and migration notes.
