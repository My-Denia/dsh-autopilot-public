# Changelog

Host and packaging bounds that outlive a single release are in
[docs/compatibility.md](docs/compatibility.md).

## Unreleased

Realigns the plugin with the current goal-autopilot-harness design, where a host
adapter stays thin and the host-neutral rules live in one reference layer.

### Added (governance pragmatics v1)

- Graded audit findings: auditors may return `findings`
  (`blocking`/`non-blocking` × `plan`/`execution`/`rules`); a `pass` may carry
  non-blocking findings without burning a round; a `needs-replan` without a
  blocking plan-layer finding is refused pre-commit (`AP_AUDIT_FINDINGS_INVALID`)
  and executor-fixable defects are steered to the existing `needs-fix` lane.
- `autopilot_amend_plan` — amend the passed plan mid-execution without
  destroying execution state; a plan-role delta re-audit at the amended revision
  re-opens evidence/closeout (`AP_AMEND_REAUDIT_REQUIRED` while pending,
  fold-derived `planAmendedAtRevision`).
- Partial delivery: unproven criteria at closeout require a structured handoff
  (`handoffOpenItems` bijectively mapping every unproven criterion, optional
  `handoffNextAuthorizedAction`); the engine derives the `complete`/`partial`
  outcome label, stamped `closeoutHandoff: 1`; legacy closeouts keep their
  reading.
- Cross-run carryover: `autopilot_init` accepts `carryoverFromRunId` +
  `carryoverNote` + `carryoverInherits`, validated against the store (the
  predecessor must exist and be completed).
- Owner-decision narrowing: replan-budget exhaustion no longer forces
  `needs-owner-decision` (visible diagnostic instead; escalation is
  deliberate); `owner-resolve` gains `resume-execution`, restoring the
  paused-from phase with gates/evidence untouched (`pausedFrom` derivation).
- `governance.maxAuditRoundsPerRole` config (default off): refuses same-role
  dispatches beyond the cap (`AP_AUDIT_ROUND_CAP`) — a brake on audit storms
  that never invents an owner question.
- Governance docs: five new invariant sections (Audit Findings Grading,
  Minimum-Sufficient Admission, Plan Amendment and Delta Re-audit, Partial
  Delivery and Carryover, Owner-Decision Boundaries) with heading census;
  refusals.md documents the 13 new codes in a new section 16 with the
  bidirectional census; docs/reference.md and SKILL.md tool sequences updated;
  DESIGN.md §8.5 records the decisions and their honest limits.

### Added

- `skill/dsh-autopilot/references/governance-invariants.md` — the host-neutral governance rules
  (risk and audit shape, the audit invariants, evidence sufficiency, sizing,
  delegation, closeout), each labelled with what actually enforces it. Shipped
  in the npm package.
- `skill/dsh-autopilot/references/refusals.md` — the single routed owner of what the engine refuses:
  the contracts behind all `AP_*` codes, with the remedy for each.
- `autopilot_status` now returns `latestAuditRecords`: the latest audit record
  per role, verbatim, so an audit packet can be built from the run state instead
  of from a verdict word retyped by hand.
- `skill/dsh-autopilot/references/model-routing.md` — the routed owner of the DSH
  routing contract: the authority order (owner explicit config > latest host or
  fetched facts > the generated cost seed > unknown), the pass/fail thresholds
  versus the ranking axes, the owner's ladder, the recorded boundaries, and the
  cost seed's provenance.
- `routing.ladder` — the owner's classification: fixed `economy`/`standard`/
  `reserve` tiers, `auditTier`, an owner-declared `speedOrder`, and
  `costOverrides` written `provider/model=inputPerM/outputPerM` (a malformed entry
  is refused, never dropped). Sufficiency thresholds pass or fail, and only the
  survivors are ranked — on price, then on the owner's declared speed. Unknown
  never ranks; price is not capability, and context window is not capability.
- The cost seed (`seed-cost@2026-10-09`) — one price column generated from the
  harness's own provider catalogs and keyed by model identity rather than route,
  with the matching step labelled (`route` / `model` / `model-case-folded`) and an
  unmatched route recorded as `unknown` rather than proxied.
- Tier coverage (`coverageReport`) — a `'tier-coverage'` verdict over the models a
  live catalog actually observed, with five outcomes so an unobserved,
  unconfigured or incompletely listed catalog can never read as coverage.

### Changed

- `skill/dsh-autopilot/SKILL.md` is now a thin adapter. It supplies the DSH
  bindings and routes to the reference layer for the rules, instead of restating
  them.
- `docs/reference.md` no longer claims to be a second copy of the skill; the
  two now have distinct, stated owners.
- DESIGN.md §1.2 records the routing boundaries: the `requirements` threshold input
  has no production producer and is inert in production; a role holding a live pin
  does not re-select, so engine-level automatic rotation is not delivered; a
  `balanced` default and an explicitly written `balanced` are indistinguishable,
  so the axis path cannot yet be the default; and coverage is tier coverage of
  observed models, not work-class reachability. The section's work-class table is
  marked as a design target, and §9 adds roadmap items for the explicit
  preference source (A2), a real work-class input (A5), safe engine-level
  re-selection (A4), and wiring the ladder into dispatch membership.

### Fixed

- 69 of the 78 engine refusal codes were stated nowhere a caller is routed to.
  `test/refusals-contract.test.ts` now censuses the codes in both directions so
  a new gate cannot ship without its contract.

## 0.2.0 — 2026-10-07

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
- The npm package now ships `docs/` and `CHANGELOG.md`. The README links
  to them, and in an installed package those links were dead.
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
