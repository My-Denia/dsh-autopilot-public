# Changelog

Host and packaging bounds that outlive a single release are in
[docs/compatibility.md](docs/compatibility.md).

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
