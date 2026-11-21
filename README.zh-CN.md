<p align="right"><a href="./README.md">English</a> · <b>简体中文</b></p>

# dsh-goal-autopilot

[![npm](https://img.shields.io/npm/v/dsh-goal-autopilot?style=flat-square)](https://www.npmjs.com/package/dsh-goal-autopilot)
[![CI](https://img.shields.io/github/actions/workflow/status/My-Denia/dsh-autopilot-public/ci.yml?branch=main&style=flat-square)](https://github.com/My-Denia/dsh-autopilot-public/actions/workflows/ci.yml)
[![License: MIT](https://img.shields.io/badge/license-MIT-blue?style=flat-square)](./LICENSE)

[DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness)（dsh）的 goal 工作流适配器。目标提出后，主代理保留判断和沟通，把范围明确的工作交给宿主原生子代理按角色执行，取得一次独立评审，并且只在 Done 检查全部成立时完成目标。issue 和 PR 是记录；插件只保留委派这一层。

> [!NOTE]
> npm 包名是 **`dsh-goal-autopilot`**。npm 上无作用域的 `dsh-autopilot` 是另一个无关的包。

## 安装

0.4.0 可能还不是 registry 的 `latest`。如果 `add` 解析到更旧的版本，请指明这一版：

```sh
dsh plugin --profile <name> add dsh-goal-autopilot
dsh plugin --profile <name> add dsh-goal-autopilot@0.4.0   # 指定预发布版
```

本包面向 dsh `0.2.2-rc.5`，`engines.dsh` 为 `>=0.2.2-rc.5 <0.3.0-0`。需要 Node 22 或更高版本。更旧的宿主无法加载 0.4.0：0.3.0 的预发布版面向 dsh `0.2.1-rc.5`，dsh `0.1.x`、`0.2.0` 的最后一个版本仍是 `0.2.0`。

## 什么时候启动

当用户说出目标、要求 autopilot，或交来明显的多阶段工作（多个阶段、可并行的部分、要合入的 PR）时，适配技能生效。代理用 `get_goal` 读取当前目标，没有目标时以 Outcome 为 objective 调用 `create_goal`。

提问、小而可逆的修改和普通的只读评审留在主线程，不调用 goal 工具，也不调用任何 `autopilot_*` 工具。

## 目标怎么运行

- **开始。** 代理读项目规则和 issue，把 Outcome、Done、Not in scope 写在 issue 或 PR 上，并在 worktree 里工作。
- **角色。** 主代理负责判断、整合和与用户沟通，用 `autopilot_delegate` 启动角色子代理：

  | 角色 | 做什么 | 工具 |
  | --- | --- | --- |
  | `scout` | 只读检索、盘点、读日志；返回压缩后的发现 | `read`、`glob`、`grep`、`read_image`、`web_fetch`、`web_search` |
  | `planner` | 只读的规划或诊断 | `read`、`glob`、`grep`、`read_image` |
  | `worker` | 一个范围明确的实现；必须声明 `writePaths` | 继承会话的工具集 |
  | `executor-lead` | 端到端负责一个工作块；可以再启动 `scout` 和 `worker` 子代理 | 继承会话的工具集，另有委派工具 |
  | `reviewer` | 全新上下文里的一次性只读评审；返回裁决 | `read`、`glob`、`grep`、`read_image`；不能委派 |

- **并行委派。** 互相独立的子代理在同一轮一起启动。同一 root 下，新 writer 的 `writePaths` 与仍在运行的 writer 重叠时，新 writer 会在启动前被拒绝。
- **一次独立评审。** `reviewer` 一次性、只读、在全新上下文中运行。它在 `task` 里拿到 diff 和结论，而不是作者的推理过程，并在同一次调用里以结果形式返回 `pass` 或 `fail` 以及 `blocker`、`note` 级别的发现。主代理不能替它写裁决。路线由调用指定或由宿主默认值提供；同模型评审是正常情况，宿主暴露日志时结果里会记录实际运行的路线。
- **等待。** `autopilot_agents` 的 `action: 'wait'` 会阻塞到列出的子代理结束或超时（默认 300 秒，最多 600 秒）。后台任务和 CI 监视用宿主的 `job_output` 带 `wait` 等待。等待发生在当前轮内；等待工具不是关卡。
- **完成。** 只有当 Done 检查全部成立时，代理才用 `update_goal` 的 `action: 'complete'` 完成目标。阶段结束、开出 PR 或 CI 变绿都不算完成。宿主会在轮与轮之间继续推进已启用的目标。
- **重启之后。** 运行中的子代理已经丢失，活动目标处于未启用状态。不会有任何东西自动恢复：用户说继续之后，代理用 `get_goal` 读取目标，再用 `update_goal` 的 `resume` 重新启用。

## 工具

| 工具 | 调用者 | 做什么 |
| --- | --- | --- |
| `autopilot_delegate` | root 代理、`executor-lead` | 启动一个角色子代理并立即返回：子代理 id、它拿到的路线、路线来源（`call` 或 `inherit`）以及 generation |
| `autopilot_agents` | root 代理、`executor-lead` | 只有 `action: 'wait'`：阻塞到列出的子代理结束或超时，返回 `timedOut` 和委派记录 |
| `autopilot_escalate` | 除 `reviewer` 之外的任何被委派子代理 | 记录一次请求，要求更强路线、更多 effort 或不同的拆分；父代理决定后用 `replaces` 重新派发。它从不扩大角色的权限 |

## 配置

只有一个键：

| 键 | 值 | 含义 |
| --- | --- | --- |
| `skillInstall` | `auto`（默认） | 通过宿主的技能服务发布适配技能；该服务不可用时，把 `skill/dsh-goal-autopilot/SKILL.md` 复制到 `$DSH_AGENTS_HOME/skills/dsh-goal-autopilot` |
|  | `off` | 两个渠道都关闭；不安装技能 |

没有模型固定值、梯度、目录或工作类别。路线来自派发调用（`provider` 和 `model` 一起给，可选的 `effort`）或来自宿主默认值。

## 刻意不做什么

- **没有模型路由策略。** 没有梯度、模型目录、工作类别、覆盖率报告、首次使用提示，也没有跨厂商策略。插件不能授予、过滤或排序路线；它记录请求的路线、路线来源，以及在宿主暴露子代理日志时实际运行的路线。
- **没有持久化账本。** 委派记录只存在一个 root 会话的内存里。宿主重启后这些记录丢失，记录里的子代理也不在了；没有恢复，也没有 `lost` 状态。
- **没有会话卡片、客户端 bundle 或 web 路由。** 没有列表、状态或链接工具；宿主的 `list_agents` 和 `send_message` 覆盖代理树，记录由 issue 和 PR 承载。
- **没有外部系统角色。** 0.2.x 的 `clerk` 角色、连接器配置样例和 MCP 写入路径都不属于这个包。委派的工作是本地仓库工作；`scout` 可以用宿主的 `web_search`、`web_fetch` 做调研，但不存在连接器或写入外部系统的通道。
- **没有 0.2.x 旧历史。** 它不读取、不折叠、不显示也不续跑插件 0.2.x 写下的运行，也不保留旧工具或旧配置键的兼容层。
- **没有自己的沙箱。** 宿主的审批和沙箱设置对每次调用都有效；`writePaths` 是并发写入者之间的冲突保护，不是权限系统。见 [docs/security.md](./docs/security.md)。

## 文档

- [ARCHITECTURE.md](./ARCHITECTURE.md)：插件与宿主如何分工
- [docs/reference.md](./docs/reference.md)：完整的工具参数、拒绝码、配置和宿主工具
- [docs/security.md](./docs/security.md)：插件管什么、不管什么
- [skill/dsh-goal-autopilot/SKILL.md](./skill/dsh-goal-autopilot/SKILL.md)：会话内的适配器
- [CHANGELOG.md](./CHANGELOG.md)：发布历史和 0.4.0 的破坏性变更

## 开发

Node 22 和 pnpm 11.17.0。

```sh
git clone https://github.com/My-Denia/dsh-autopilot-public.git
cd dsh-autopilot-public
pnpm install
pnpm run build
pnpm run check
pnpm test
dsh plugin --profile dev add .
```

## 许可

[MIT](./LICENSE) © 2026 My-Denia
