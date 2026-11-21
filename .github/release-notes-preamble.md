> This GitHub Release is notes-only: no tarball is attached. The installable
> package is on npm as `dsh-goal-autopilot`; the registry is the only install
> channel.

0.4.0 is the single outbound product: the basic local goal workflow for DeepSeek
Harness. One skill, three tools (`autopilot_delegate`, `autopilot_agents`,
`autopilot_escalate`), an in-memory delegation ledger, and one independent
review. It targets dsh `0.2.2-rc.5` (`engines.dsh` `>=0.2.2-rc.5 <0.3.0-0`).

This release removes the 0.2.x run state machine and its legacy reader, the
routing engine, the persisted ledger and session card, the connector overlay and
the `clerk` role. Routes come from the dispatch call or the host default. See
CHANGELOG.md for the full break and migration notes.
