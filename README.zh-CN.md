<p align="right"><a href="./README.md">English</a> · <b>简体中文</b></p>

# dsh-goal-autopilot

[![npm](https://img.shields.io/npm/v/dsh-goal-autopilot?style=flat-square)](https://www.npmjs.com/package/dsh-goal-autopilot)
[![CI](https://img.shields.io/github/actions/workflow/status/My-Denia/dsh-autopilot-public/ci.yml?branch=main&style=flat-square)](https://github.com/My-Denia/dsh-autopilot-public/actions/workflows/ci.yml)
[![License: MIT](https://img.shields.io/badge/license-MIT-blue?style=flat-square)](./LICENSE)

面向 [DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness)（dsh）的目标工作流，完全以配置形式发布：五个 agent 预设承担各个角色，一条 profile 级的 `delegate` 工具把子代理启动到其中一个预设上，一个 skill 告诉主 agent 什么时候、按什么顺序跑目标。

包里没有插件代码：没有自己的工具、没有服务、没有存储、没有客户端 bundle。子代理、目标状态、模型路由和 sandbox 都归宿主。

> npm 上的包名是 `dsh-goal-autopilot`；无作用域的 `dsh-autopilot` 是另一个无关的包。

## 包里有什么

| 部分 | 内容 |
| --- | --- |
| `cordis.patch.yml` | bundle patch：一条 `delegate` 行和五条 `@deepseek-ai/dsh-agent-preset` 声明 |
| `skill/dsh-goal-autopilot/SKILL.md` | 适配 skill：何时适用、开工顺序、角色、评审、完成检查 |
| 预设 | `goal-scout`、`goal-worker`、`goal-executor-lead`、`goal-planner`、`goal-reviewer` |

清单里的 `dsh.bundle.patch` 指向这个 patch，`dsh plugin add` 会把它组合进 profile。

## 安装

0.5.0 面向 dsh `>=0.2.2-rc.5 <0.3.0-0`。跑测试需要 Node 22 或更新；profile 进程的 Node 由宿主决定。

```sh
dsh plugin --profile <name> add dsh-goal-autopilot@0.5.0
```

registry 的 `latest` 仍指向旧版本时，按上面的写法固定版本。

profile 加载后，会话里多出 `delegate` 工具，预设列表里多出五个角色预设。平时对话用的会话保持你原来的预设；角色预设是给子代理用的。

深度上限是刻意设计的。profile 级 `delegate` 设为 `maxDepth: 1`，这是宿主按调用 agent 当前深度执行的绝对上限。深度 1 的子代理继承了这个工具，一旦尝试再分派就会被拒绝，所以 scout、worker、planner、reviewer 都开不出自己的子代理树。只有 `goal-executor-lead` 在自己的预设里挂了另一条 `delegate` 行，上限 2，且只允许三个叶子预设。

skill 是包里的一个文件。bundle patch 只能声明 Loader 行，不能复制文件，所以安装 bundle 不会安装 skill。把目录复制到 `@deepseek-ai/dsh-skill-filesystem` 会扫描的根目录：

```sh
mkdir -p "$DSH_AGENTS_HOME/skills"
cp -r skill/dsh-goal-autopilot "$DSH_AGENTS_HOME/skills/"
```

只给一个仓库用时，放到 `<project>/.dsh/skills/`。没有 skill 时预设和 `delegate` 照样能用，skill 负责告诉主 agent 工作流本身。

## 目标怎么跑

- 开工。主 agent 读项目规则和 issue，把 Outcome、Done、Not in scope 写进 issue 或 PR 描述，在 worktree 里干活。
- 分派。`delegate` 接收简短的 `description`、作为任务书的 `prompt` 和 `agent_preset`。它启动一个托管的子代理并立刻返回子代理名字，子代理的最终答复稍后通过宿主的完成通知到达。
- 角色。主 agent 做决定、整合结果、和用户对话。每个子代理只拿到自己预设的工具：

  | 预设 | 角色 | 工具 |
  | --- | --- | --- |
  | `goal-scout` | 只读搜索、盘点、读日志 | `read`、`read_image`、`glob`、`grep` |
  | `goal-worker` | 一段限定范围的实现 | shell（`bash` 或 `pwsh`）、`jobs`、`read`、`read_image`、`write`、`edit`、`glob`、`grep` |
  | `goal-executor-lead` | 端到端负责一块，可以再启动三个叶子角色 | worker 的工具，加 `list_agents`、`send_message`、`wait_agent` 和自己的 `delegate` |
  | `goal-planner` | 只读诊断，给出决策完整的计划 | `read`、`read_image`、`glob`、`grep` |
  | `goal-reviewer` | 全新上下文里的一次性只读评审 | `read`、`read_image`、`glob`、`grep` |

- 并行。互相独立的任务在同一条消息里启动，主 agent 在它们运行期间继续干活。宿主不比较文件范围，并发写者的不重叠范围要由主 agent 写进各自的任务书。
- 一次独立评审。`goal-reviewer` 在全新上下文里只读运行，通过完成通知返回 `pass` 或 `fail`，以及 blocker、note 级的发现。主 agent 不能代写这个结论；`fail` 修完再评。
- 等待。目标处于 armed 状态时，在回合内用 `wait_agent` 或 `job_output` 等待，不要结束回合去等子代理。
- 收尾。只有当最终树上每个 Done 检查都通过、且评审为 `pass` 时，主 agent 才用 `update_goal` 的 `complete` 收尾。会话恢复后，仍然存在的目标处于 disarmed 状态，要用 `update_goal` 的 `resume` 重新 arm。

## 模型路由

路由来自用户自己的配置。省略 `provider`、`model`、`reasoning_effort` 就走宿主默认；要固定路由就同时给 `provider` 和 `model`，`reasoning_effort` 只在两者都给时才允许，只给 effort 会被宿主拒绝。预设不固定任何模型、provider 或 effort，包里也没有路由表。

`list_subagent_models` 会列出宿主和用户允许的路由与 effort。

## 配置

bundle 没有配置键，也没有代码。要改某一行，就在 profile 自己的 `cordis.patch.yml` 里按 Loader id 覆盖（`delegate`、`preset-goal-scout`、`preset-goal-worker`、`preset-goal-executor-lead`、`preset-goal-planner`、`preset-goal-reviewer`）。被覆盖的行整段替换 `config`，需要的字段要重新写全。

## 支持的宿主

| 项 | 范围 |
| --- | --- |
| dsh | `>=0.2.2-rc.5 <0.3.0-0` |
| Node | `>=22`（测试） |

agent 预设声明、分派工具的 `agentPreset`/`allowedAgentPresets` 以及绝对 `maxDepth` 这些能力，从这个范围起点的 0.2.2 预发布版本开始提供。

profile 需要挂载 agent preset registry（`@deepseek-ai/dsh-agent-preset-registry`）和进程内的 `spawn` 子代理 provider。Web 与 Desktop 的 profile 都挂了；裸的 base profile 没有，缺 preset 服务时 `delegate` 这一行会加载失败，报 `agent preset selection requires the agent-presets service`。

## 开发

Node 22，pnpm 11.17.0。

```sh
git clone https://github.com/My-Denia/dsh-autopilot-public.git
cd dsh-autopilot-public
pnpm install
node --test
dsh plugin --profile dev add .
```

测试用 `yaml` 解析 `cordis.patch.yml`，检查预设声明、分派行、skill frontmatter 和包清单；不需要宿主，也不联网。

## 文档

- [ARCHITECTURE.md](./ARCHITECTURE.md)：为什么产品是配置、宿主负责什么、深度上限的理由
- [docs/reference.md](./docs/reference.md)：预设 id 与工具面、`delegate` 参数、skill、被拒绝的调用形态
- [docs/security.md](./docs/security.md)：bundle 配置了什么，什么仍归宿主
- [skill/dsh-goal-autopilot/SKILL.md](./skill/dsh-goal-autopilot/SKILL.md)：会话内的适配
- [CHANGELOG.md](./CHANGELOG.md)：版本历史与 0.5.0 的破坏性变更
- [docs/release.md](./docs/release.md)：发布门禁、发布与打标签

## 许可证

[MIT](./LICENSE) © 2026 My-Denia
