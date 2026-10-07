<p align="right">
  <strong>English</strong> · <a href="./README.zh-CN.md">简体中文</a>
</p>

<p align="center">
  <a href="#how-it-works"><img src="./assets/hero.svg" width="100%" alt="dsh-autopilot: Governed plan-execute-audit harness for DeepSeek Harness"></a>
</p>

<p align="center">
  <a href="https://www.npmjs.com/package/dsh-goal-autopilot"><img src="https://img.shields.io/npm/v/dsh-goal-autopilot?style=flat-square&color=0ea5e9&labelColor=1e293b" alt="npm version"></a>
  <a href="./LICENSE"><img src="https://img.shields.io/badge/license-MIT-6366f1?style=flat-square&labelColor=1e293b" alt="MIT License"></a>
  <a href="./docs/compatibility.md"><img src="https://img.shields.io/badge/DSH-0.2.0%20%7C%200.1.x-10b981?style=flat-square&labelColor=1e293b" alt="DSH 0.2.0 &amp; 0.1.x"></a>
  <a href="https://github.com/My-Denia/dsh-autopilot-public/actions/workflows/ci.yml"><img src="https://img.shields.io/github/actions/workflow/status/My-Denia/dsh-autopilot-public/ci.yml?branch=main&style=flat-square&labelColor=1e293b" alt="CI Status"></a>
  <a href="#status--verification"><img src="https://img.shields.io/badge/status-developer%20preview-f59e0b?style=flat-square&labelColor=1e293b" alt="Developer Preview"></a>
</p>

<p align="center">
  <a href="#why-dsh-autopilot"><b>Why dsh-autopilot</b></a> &nbsp;·&nbsp;
  <a href="#how-it-works"><b>How It Works</b></a> &nbsp;·&nbsp;
  <a href="#quick-start"><b>Quick Start</b></a> &nbsp;·&nbsp;
  <a href="#core-capabilities"><b>Capabilities</b></a> &nbsp;·&nbsp;
  <a href="#status--verification"><b>Status &amp; Limits</b></a> &nbsp;·&nbsp;
  <a href="#documentation"><b>Documentation</b></a>
</p>

---

> [!IMPORTANT]
> **Project Identity & Distribution:** The project logical name is **dsh-autopilot**. The official npm distribution package is [**`dsh-goal-autopilot`**](https://www.npmjs.com/package/dsh-goal-autopilot). An unscoped `dsh-autopilot` on npm belongs to an independent, unrelated package; always install as **`dsh-goal-autopilot`**.

## Why dsh-autopilot?

Autonomous LLM agents inside coding hosts are powerful, but ungoverned execution often leads to subtle errors: agents write code before validating requirements, self-approve unverified diffs, drop context across review rounds, or execute irreversible mutations (`git push`, publish) without explicit owner consent.

**dsh-autopilot** ports the governance model of Claude Code's `goal-autopilot-harness` into native [DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness) (dsh) plugin seams. Instead of fragile prompt hints, governance is enforced by **executable structural invariants**:

| Ungoverned Agent Behaviors | Governed by dsh-autopilot |
| :--- | :--- |
| **Premature file mutations**<br>Agent starts writing code immediately upon prompt without validating requirements. | **Structural Plan Gate**<br>File writes and edits are blocked at the engine level; OS-level sandbox enforces `read-only` mode until an independent plan audit passes. |
| **Self-congratulatory audits**<br>Agent reviews its own code: *"I checked my changes and everything looks clean."* | **Independent Subagent Audits**<br>One-shot isolated subagents with read-only tools and a strict schema verdict. No passing structured verdict means no gate flip. |
| **Context loss on review failure**<br>Review failure spawns a new agent from scratch, discarding historical reasoning. | **Delegated Executor &amp; CAS Resume**<br>Single continuable child agent with CAS generation counter. On `needs-fix`, the same executor resumes where it left off. |
| **Silent destructive actions**<br>Agent runs `git push`, modifies remote tags, or publishes packages autonomously. | **Owner-Only Egress Guard**<br>Fail-closed pre-execution interception on `git`, `gh`, and `npm publish`. Requires a hash-verified `manifest.json` and explicit owner approval. |
| **Unsubstantiated completion claims**<br>Agent announces *"Done!"* without recording evidence or coverage. | **Evidence-Bound Closeout**<br>`completed` state is rejected until dual gates pass, required roles match, and every acceptance criterion has a 1:1 bearer artifact. |

---

## How It Works

<p align="center">
  <img src="./assets/workflow.svg" width="100%" alt="dsh-autopilot Governed Execution Loop">
</p>

A standard run follows an event-sourced state machine (`planning` → `plan-reviewing` → `executing` → `execution-reviewing` → `completed`):

1. **Natural Language Goal Dispatch**  
   The user triggers a run via natural language. The engine creates the goal run under `goal-runs/<slug>/` and locks mutations by placing the session sandbox in `read-only` mode.
2. **Phase 1: Planning &amp; Usage Declaration**  
   The lead agent crafts a compact contract (goal, scope, non-goals, risk level, milestones, and acceptance criteria) and declares human-observable boundary states via `autopilot_usage`.
3. **Plan Gate (Independent Audit)**  
   A one-shot auditor subagent is spawned with read-only tools and `maxDepth: 1`. The plan gate flips to `pass` only when a structured JSON verdict (`verdict: 'pass'`) is received and all usage declarations are bound.
4. **Phase 2: Delegated Execution &amp; Same-Executor Resume**  
   A dedicated continuable child executor implements the plan under a CAS generation counter. If an audit returns `needs-fix`, the same child resumes execution rather than stranding orphaned processes.
5. **Phase 3: Execution Gate &amp; Evidence-Bound Closeout**  
   An independent execution auditor verifies the deliverables against the contract. The engine rejects `completed` until both gates have passed and each acceptance criterion has a verified bearer artifact on disk.
6. **Continuous Egress Interception**  
   Any mutating shell action (`git push`, `gh release`, `npm publish`) is intercepted before execution. The engine verifies `<run>/outbound/manifest.json` against on-disk hashes and halts for explicit owner approval.

---

## Quick Start

Requires **[dsh](https://github.com/deepseek-ai/deepseek-harness)** `0.2.0` (or `0.1.2-rc.1` / `0.1.5-rc.1`) and **Node 22+**.

### 1. Install Plugin

#### DeepSeek Harness Desktop
In the Desktop sidebar, navigate to **Settings → Plugins → Add plugin**, enter:
```text
dsh-goal-autopilot@0.2.0
```
Click **Install**, then select **Enable now**. If prompted, restart the desktop app.

#### CLI / Headless / Web
Install directly into your target profile from npm:

```sh
# For your active profile (e.g., 'web' or custom profile)
dsh plugin --profile <name> add dsh-goal-autopilot@0.2.0
```

### 2. Run a Governed Goal

In any chat session on that profile, dispatch in natural language:

```text
Use dsh-autopilot to implement <goal> and verify the result.
```

The plugin automatically initializes the run, enforces the sandbox, coordinates independent auditor subagents, and binds evidence before closing. Operators who want manual control of `autopilot_*` tools can consult the [Operator Reference](./docs/reference.md).

---

## Core Capabilities

- 🛡️ **Mechanical Plan Gate**  
  Standard runs cannot mutate files until an independent plan audit passes. PreToolUse guards block write/edit tools, and the OS-level sandbox enforces `read-only` mode during planning.
- ⚖️ **Isolated Subagent Audits**  
  Auditors are strictly isolated with read-only tools and `maxDepth: 1`. Audits return in-band structured verdicts (`pass`, `needs-replan`, `blocked`). The engine never derives or guesses a pass.
- 🔄 **Same-Executor Resume (`needs-fix`)**  
  Fixes are assigned back to the same running executor subagent, maintaining context and preventing unbounded fan-out or orphaned child tasks.
- 🛑 **Fail-Closed Owner Egress Guard**  
  Mutating remote operations (`git push`, `gh release`, `npm publish`) require a cryptographic evidence manifest (`manifest.json`) and explicit owner authority. If approval is missing, execution deterministically fails closed.
- 📜 **Evidence-Bound Closeout**  
  The engine rejects completion unless both gates have passed, required roles are satisfied, and every acceptance criterion is backed by an on-disk bearer artifact.
- ⏱️ **Turn Reminder &amp; Usage Governance**  
  A bounded 3x nudge prevents agents from silently stopping mid-execution. Every run must declare observable usage states before mutations are unlocked.

---

## Status &amp; Verification

| Dimension | Current Fact |
| :--- | :--- |
| **Maturity** | **Experimental developer preview** (not a production release). |
| **npm Distribution** | [`dsh-goal-autopilot@0.2.0`](https://www.npmjs.com/package/dsh-goal-autopilot) |
| **Host Support** | `dsh` 0.2.0 line, `0.1.5-rc.1`, `0.1.2-rc.1` (0.1.7 and 0.2.1 are outside the peer range). |
| **WSL2 + 0.2.0-rc.2** | **Verified:** Plugin install, mount, skill registration, plan audit, delegated executor, and needs-fix resume measured with a local mock model. |
| **Real-Model Full Closeout** | **Unverified:** Natural-language write → live model execution audit → full closeout not yet verified with a real model. |
| **Desktop (macOS / Windows)** | **Unverified:** Desktop UI packaging is not run in this test environment. |
| **Windows Native** | **Unverified:** Windows native environment is not tested and not claimed as supported. |
| **Browser Card Rendering** | **Unverified:** PTC card rendering and cold-resume executor re-recognition remain unverified. |
| **Distribution Channels** | **npm is the package distribution channel.** GitHub Releases are notes-only (no attached tarballs). |
| **Security Scope** | Quality gates, sandboxing, and fail-closed egress. Does not claim complete isolation against untrusted arbitrary code. |

For detailed compatibility notes and host verification traces, see [docs/compatibility.md](./docs/compatibility.md).

---

## Documentation

| Document | Focus |
| :--- | :--- |
| **[DESIGN.md](./DESIGN.md)** | Core architecture, CC GAH mapping, state machine, invariants, and design roadmap. |
| **[docs/compatibility.md](./docs/compatibility.md)** | DSH version matrix, Desktop notes, 0.2.0 adapter details, and sandbox residual. |
| **[docs/security.md](./docs/security.md)** | Approval mechanisms, egress interception, sandbox assumptions, and non-goals. |
| **[docs/reference.md](./docs/reference.md)** | Complete tool protocol (`autopilot_*`), run state schema, and usage classes. |
| **[CHANGELOG.md](./CHANGELOG.md)** | Detailed release history and migration notes. |

---

## Local Development

```sh
# Clone repository
git clone https://github.com/My-Denia/dsh-autopilot-public.git
cd dsh-autopilot-public

# Install dependencies and build bundles
pnpm install
npm run build

# Run typechecks and unit tests
npm run check
npm test

# Link plugin to a local DSH profile for testing
dsh plugin --profile dev add .
```

---

## License

[MIT](./LICENSE) © 2026 My-Denia.
