<p align="right"><a href="./README.md">English</a> · <b>简体中文</b></p>

# dsh-autopilot

[DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness)（dsh）的「计划 → 执行 → 审计」插件。它把 goal-autopilot harness（GAH）工作流移植到 dsh 插件钩子上：先做计划，独立子代理审计计划，委派执行器干活，第二轮审计检查结果，每条验收标准都有证据才能收尾。

[![npm](https://img.shields.io/npm/v/dsh-goal-autopilot?style=flat-square)](https://www.npmjs.com/package/dsh-goal-autopilot)
[![CI](https://img.shields.io/github/actions/workflow/status/My-Denia/dsh-autopilot-public/ci.yml?branch=main&style=flat-square)](https://github.com/My-Denia/dsh-autopilot-public/actions/workflows/ci.yml)
[![License: MIT](https://img.shields.io/badge/license-MIT-blue?style=flat-square)](./LICENSE)

> [!NOTE]
> npm 包名是 **`dsh-goal-autopilot`**。npm 上无作用域的 `dsh-autopilot` 是无关的另一个包。

## 安装

需要 dsh `0.2.0`（或 `0.1.2-rc.1` / `0.1.5-rc.1`）和 Node 22+。

**桌面版：** 设置 → Plugins → Add plugin，输入 `dsh-goal-autopilot@0.2.0`，点 Install，再 Enable。

**CLI / 无头 / Web：**

```sh
dsh plugin --profile <name> add dsh-goal-autopilot@0.2.0
```

## 使用

在该 profile 的对话里：

```text
Use dsh-autopilot to implement <goal> and verify the result.
```

手动调用 `autopilot_*` 工具见 [操作参考](./docs/reference.md)。

## 工作方式

<p align="center"><img src="./assets/workflow.svg" width="100%" alt="dsh-autopilot 运行流程"></p>

一次运行依次经过 `planning` → `plan-reviewing` → `executing` → `execution-reviewing` → `completed`，状态存放在 `$DSH_HOME/storages/dsh-autopilot/runs/<sessionId>/`。

- **计划门禁**：计划审计通过前，写文件和编辑被拦截，并请求只读沙箱。计划写明目标、范围、非目标、风险、里程碑和验收标准，并用 `autopilot_usage` 声明可观察的使用状态。
- **独立审计**：审计者是一次性子代理，只读工具、`maxDepth: 1`，返回 `pass`、`needs-replan` 或 `blocked`。
- **同一执行器续跑**：由一个可续跑的执行器完成工作；`needs-fix` 时由同一个执行器继续。
- **出站拦截**：`git push`、`gh release`、`npm publish` 会被拦截，需要有效的证据清单（`<run>/outbound/manifest.json`）和 owner 批准。
- **证据收尾**：两道门禁都通过、每条验收标准都有落盘产物之前，不允许 `completed`。
- **轮次提醒**：代理中途停下时最多提醒三次。

设计细节见 [DESIGN.md](./DESIGN.md)。

## 状态

开发者预览版。

| | |
| --- | --- |
| 已测试 | WSL2 + dsh 0.2.0-rc.2，本地 mock 模型：安装、挂载、技能注册、计划审计、委派执行、needs-fix 续跑 |
| 客户端包 | 2026-10-18 按当前 `src/client` 重新构建。同一会话里的后一个目标会留在卡片的历史里。包检查 20 项通过。还没有在浏览器或桌面里打开过 |
| 尚未测试 | 真实模型完整运行、macOS/Windows 桌面版、原生 Windows、浏览器卡片渲染 |
| 宿主范围 | dsh 0.2.0 系列、0.1.5-rc.1、0.1.2-rc.1（0.1.7 与 0.2.1 不在 peer 范围内） |
| 分发 | npm；GitHub Releases 只有说明，不附包 |

见 [docs/compatibility.md](./docs/compatibility.md) 和 [docs/security.md](./docs/security.md)。

## 文档

- [DESIGN.md](./DESIGN.md)：架构、GAH 映射、状态机
- [docs/compatibility.md](./docs/compatibility.md)：dsh 版本、桌面版说明、沙箱
- [docs/security.md](./docs/security.md)：批准、出站拦截、沙箱
- [docs/reference.md](./docs/reference.md)：`autopilot_*` 工具、运行状态、使用类别
- [CHANGELOG.md](./CHANGELOG.md)

## 开发

```sh
git clone https://github.com/My-Denia/dsh-autopilot-public.git
cd dsh-autopilot-public
pnpm install
npm run build
npm run check
npm test
dsh plugin --profile dev add .
```

## 许可

[MIT](./LICENSE) © 2026 My-Denia
