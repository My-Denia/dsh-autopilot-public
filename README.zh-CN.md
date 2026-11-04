<p align="right"><a href="./README.md">English</a> · <b>简体中文</b></p>

# dsh-autopilot

[DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness)（dsh）上的 goal-workflow 适配器。owner 说出一个目标后，主代理保留判断和沟通，把其他工作交给显式指定模型和 effort 的角色子代理，取得独立评审，并持续推进到 Done 检查全部成立。记录以 issue 和 PR 为准；插件只保留一份小账本，记下启动了谁、走了哪条路线、结果如何。

[![npm](https://img.shields.io/npm/v/dsh-goal-autopilot?style=flat-square)](https://www.npmjs.com/package/dsh-goal-autopilot)
[![CI](https://img.shields.io/github/actions/workflow/status/My-Denia/dsh-autopilot-public/ci.yml?branch=main&style=flat-square)](https://github.com/My-Denia/dsh-autopilot-public/actions/workflows/ci.yml)
[![License: MIT](https://img.shields.io/badge/license-MIT-blue?style=flat-square)](./LICENSE)

> [!NOTE]
> npm 包名是 **`dsh-goal-autopilot`**。npm 上无作用域的 `dsh-autopilot` 是无关的另一个包。

## 安装

这份源码是 `0.3.0`（`0.3.0-rc.1` 和 `0.3.0-rc.3` 已发布到 npm，`next` 指向 `0.3.0-rc.3`，正式版未发布）。只面向 dsh `0.2.1-rc.5`，没有在其他宿主上测试过。需要 Node 22+。Windows 桌面版和 WSL CLI 各自按原生环境处理，不互相代替。

早于 `0.2.1-rc.5` 的宿主（`0.1.x`、`0.2.0`）请继续用 `dsh-goal-autopilot@0.2.0`，这是它们的最后一个版本。目前 npm `latest` 仍是 `0.2.0`，正式版 `0.3.0` 没有发布，可安装 `next` 预发布版，或用这份源码打出的 tarball。

```sh
# 0.1.x 或 0.2.0 宿主
dsh plugin --profile <name> add dsh-goal-autopilot@0.2.0
```

WSL CLI 的 profile 需要退回旧宿主时，先备份 profile，再执行 `npm i -g @deepseek-ai/dsh@0.1.5-rc.1`。

## 什么时候启动

只有 owner 说出目标、要求 autopilot，或交来明显需要多个阶段的工作（多阶段、可并行的部分、要合入的 PR）时，技能才生效。这时代理调用 `get_goal`，没有当前目标就用 Outcome 作为目标内容调用 `create_goal`。

提问、小而可逆的修改、普通的只读评审留在主线程，不创建目标，也不调用任何 `autopilot_*` 工具。

## 目标怎么运行

- 开始：读项目规则和 issue，把 Outcome、Done、Not in scope 写在 issue 或 PR 上，在 worktree 里工作。
- 角色：主代理负责判断、整合和同 owner 沟通。`autopilot_delegate` 启动 `scout`（只读检索）、`clerk`（目前只读，工具集与 scout 相同；连接器工具尚未接入，外部系统的读写暂由主代理负责）、`worker`（带独立 `writePaths` 的有界实现）、`executor-lead`（负责一个工作块的完整交付，可再启动 scout、clerk、worker）、`planner`（只读规划或诊断）和 `reviewer`。跟踪子代理用 `autopilot_agents`（只有 `wait` 一个动作）以及宿主自带的 `list_agents`、`send_message`、`interrupt_agent`；卡住的子代理调用 `autopilot_escalate`。
- 并行委派：互相独立的子代理在同一轮一起启动。`writePaths` 有重叠的 worker 会在启动前被拒绝。
- 独立评审：`reviewer` 一次性、只读、全新上下文，只看 diff 和结论。能找到不同模型家族时用不同家族；找不到则允许同家族，并记录为「降低独立性」。
- 模型与 effort：每次派发都写明模型和 effort（路由关闭或没有目录时除外：子代理沿用宿主路线，账本记为 inherit/host-default）。调用里的显式值或 profile 里的固定值优先于插件的选择。账本和卡片同时显示选定路线和实际观察到的路线。
- 目标持久：目标存放在 dsh 自带的 `get_goal` / `create_goal` / `update_goal` 中，由宿主的 goal round driver 续推。阶段完成、开 PR、CI 变绿都不等于目标完成，只有 Done 检查全部成立才由代理标记完成。等待子代理或后台任务时在本轮内等待（`autopilot_agents` 的 `wait`、带 `wait` 的 `job_output`）。
- 重启之后：运行中的子代理已丢失，目标保持未启用，直到 owner 说「continue」。`schedule_create` 设的提醒会在重启后送达，但不会重新启用目标。
- 旧运行：0.2.x 写下的运行仍可读取，在卡片上只读显示，不会被续跑。

工具参数、账本和配置见[操作参考](./docs/reference.md)。

## 状态

开发者预览版，`0.3.0-rc.3` 在 npm 的 `next` 标签上，`latest` 仍是 `0.2.0`。[已在真实宿主上验证](./docs/compatibility.md#verified-on-a-real-host)一节是在 Windows、dsh `0.2.1-rc.5`、单一模型厂商下观察到的行为，覆盖 headless profile、owner 的日常桌面应用（提示由 agent 经界面粘贴）和隔离的 Web Session 宿主（提示由 agent 经 API 发送）；[未验证](./docs/compatibility.md#not-verified-on-a-real-host)一节是没有观察到的（跨厂商 reviewer，需要第二个模型厂商；WSL 上的模型任务；DSH 侧 Linear；clerk 的连接器工具尚未接入）。测试通过、mock 运行和状态读取都不算观察。[docs/compatibility.md](./docs/compatibility.md) 里更早的测量针对插件 `0.2.x`。

## 文档

- [docs/reference.md](./docs/reference.md)：工具、账本、配置
- [docs/compatibility.md](./docs/compatibility.md)：宿主、历史、尚未验证的部分
- [docs/security.md](./docs/security.md)：插件管什么、不管什么
- [skill/dsh-autopilot/SKILL.md](./skill/dsh-autopilot/SKILL.md)：会话内的适配器
- [skill/dsh-autopilot/references/model-routing.md](./skill/dsh-autopilot/references/model-routing.md)：工作类别、梯度、升档
- [skill/dsh-autopilot/references/refusals.md](./skill/dsh-autopilot/references/refusals.md)：仍然存在的 `AP_*` 拒绝
- [DESIGN.md](./DESIGN.md)：架构和设计历史
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
