# dsh-autopilot 设计文档

dsh-autopilot 是把 Claude Code 侧 `goal-autopilot-harness`（下称 CC GAH）的治理设计
重建为 DeepSeek Harness（dsh）原生插件套件的实现。CC GAH 在 Claude Code 上只能靠
提示词纪律 + 外挂 hook 脆弱地逼近的机制，dsh 的插件化架构可以做成**可执行的结构性
不变量**。这份文档记录设计决策、CC→dsh 机制映射、不可机械化的不变量、以及路线图。

## Documentation map

Visitor landing page: [README.md](README.md).

- [Compatibility](docs/compatibility.md) — host versions, WSL/Windows, 0.1.1 runtime
- [Security](docs/security.md) — approval, egress, sandbox assumptions
- [Operator reference](docs/reference.md) — `autopilot_*` tools and run state
- [Changelog](CHANGELOG.md)

## 1. 设计前提与决策

- **蓝本**：CC GAH（`~/.claude/skills/goal-autopilot-harness/SKILL.md`）的
  计划-执行-审计门禁、单写者状态、证据契约、收尾纪律。
- **不依赖 dsh 树内实验包**：dsh 源码树自带私有实验包 `@deepseek-ai/dsh-experimental-gah`
  （`ctx.gah`）。本项目按用户决定独立重建，但**复用其被验证过的模式**：
  全快照事件 + 单调 revision、精确活体 root 校验、一次性审计子代理 + 结构化裁决
  schema、CAS 世代号执行器、drain-before-replace。命名完全隔离
  （`autopilot_*` 工具 / 独立存储），两者可在同一 profile 共存。
- **部署形态**：单包 out-of-tree bundle（`dsh.bundle.patch`）。当前安装走 npm
  包名 `dsh-goal-autopilot`（`dsh plugin --profile <name> add dsh-goal-autopilot`）。
  从本仓库路径 `add`（pnpm link）仍可用于开发。项目逻辑名仍是 dsh-autopilot；
  未加 scope 的 npm 名 `dsh-autopilot` 属于另一个独立项目，本仓库不使用该名。
- **不运行时依赖任何 dsh 服务包**：`src/` 只 import 两个非相对**包**，其余非相对
  value import 全是 `node:` 内建（实测 2026-08-25：16 个 src 文件里 15 条非相对
  value import ＝ 13 条 node 内建 + 2 条包）。两个包都是纯函数/协议表面而不是
  服务——`@deepseek-ai/dsh-tools` 的 `defineTool`
  （`peerDependencies`，由宿主提供单例。0.1.0 把它放进 `dependencies`
  会装出第二份 runtime，分裂模块实例局部 `TOOL_RUNTIME_SCHEDULER` Symbol，
  宿主 `skill` 因此崩溃。0.1.1 起不再装第二份。不是“双副本无害”。）
  与 `@deepseek-ai/schemastery`
  （`peerDependencies`，只为导出 `Config`；宿主只碰
  `['~standard'].validate` 这个 Standard-Schema 结构性契约，从不碰类身份）。
  其余 dsh 表面——`agents` / `subagents` / `tools` / `systemPrompt` /
  `sandbox` / `approval` / `storageDomain` / cordis 本身——全部通过 `ctx`
  注入 + 本地结构性类型（structural subset interfaces）访问，这才是"跨副本服务
  身份问题"被避免的地方。
  （本条 2026-08-24 第五轮改写：原文写的是"唯一运行时依赖是 dsh-tools，其余
  表面全部通过 ctx 注入"。前半句作为对 `dependencies` 的陈述可辩护，后半句是
  假的——入口在加载期静态 import 了第二个包，而 README 一直写的是两个 peer。
  同一仓库里两份文档对同一事实说了互斥的话，且 §6 的 `extends Service` 取舍
  理由建立在假的那一份上；该理由现已改挂在幸存的那条理由上。
  2026-08-25 第六轮再改一次：第五轮换上的那句"非相对 value import 恰好两条"
  **本身也是假的**——实测 15 条。想说的是"非相对**包**恰好两条"，那句为真且值得
  说；写成一个精确计数而代码可观察地与之矛盾，正是 §8 对用例计数禁止的那种锚。
  同一轮把三处仍在断言被撤回那句话的源码注释（`src/service.ts`、
  `src/store/domain.ts`、`src/gate/preexecute.ts`）改挂到幸存的类身份理由上——
  §1 上一轮宣称"理由现已改挂"，而当时那句话对工件为假：只有 `src/config.ts`
  被改过。）
  版本锁定 `0.1.2-rc.1`（2026-09-04 自 `0.1.1-rc.2` 升级，见 §8 本轮条目），与本机
  side-by-side 的 rc.1 源码 checkout（`DSH_SRC`）一致。

## 2. CC 机制 → dsh 原生机制映射

| CC GAH 机制（Claude Code 上的形态） | dsh-autopilot 原生形态 | 强度变化 |
|---|---|---|
| `state.json` + "单写者纪律"（模型自觉 + helper 脚本） | 引擎单写者：每个公开方法校验精确活体 root Agent（同一对象引用 + 无 parentSession）；全部转移先过 fold 校验再落盘 | 纪律 → 结构性不可能伪造 |
| 使用证据（「用户可见改动被操作过」从未被验证） | v2：`usage` 维度：init 按 id 播种 `undeclared` 条目（standard run；lightweight 无此维度，与 plan gate/sandbox 同一豁免）；`autopilot_usage` 按 id last-wins 声明；plan gate 收到 pass 裁决时若仍有未声明条目，**裁决被记录**、**门禁翻转在落盘前被拒**；write / edit / str_replace_editor(非 view) 在有未声明条目时被 guard 无条件拒绝，
shell 类工具走与 plan gate 同一条阶梯（sandbox `active` 放行、`strictShell` 拒绝、
否则 `allow-degraded` 并如实记原因）；钳制按 `snapshot.usage` 是否存在生效而不是按
`size`，因为 `autopilot_usage` 没有 size 闸、lightweight run 也能把维度声明出来；
`startExecutor` 在授权新执行器子代理前再问一次（门禁只在翻转那一刻成立）；
`evaluateCompletion` 与 fold 在收尾处**再问一次**同一个问题（门禁只能替翻转那一刻已存在的条目回答，执行期新增或被改回 `undeclared` 的条目由这一问兜住）；收尾按磁盘结算工件 | 无 → 结构性拒绝；但类别与条目数仍是自报（§6） |
| PreToolUse 计划门禁 hook（Bash 写文件是有记录在案的盲区） | `tools.guard` 拒绝 write/edit/str_replace_editor(非 view) + **init 时 `session.append('sandbox/mode','read-only')` OS 级钳制**，plan gate 通过后恢复原模式 | 盲区从"已知绕过"变为 OS 层关闭；sandbox 后端不可用时降级为 `degraded` 并如实记录（fail-open 有据） |
| 审计裁决出处取证（SubagentStop trail 行、GBK 事故、role/decision 绑定、schema8 硬化） | `ctx.subagents.start({ outputSchema, toolFilter: 只读, maxDepth: 1 })`，裁决**带内返回**（`result.structured`），审计记录由引擎在收到裁决的同一操作里写入 | 整套取证机器不再需要——出处天然结构化 |
| 审计者独立性（提示词约定"不要泄露预期结论"） | 只读工具过滤 + 深度上限 1 由平台强制；无结构化裁决/停止原因非 completed/schema 不符 → **永不翻门禁** | 约定 → 平台强制 |
| Stop hook 执行门禁提醒（8 次平台熔断，3 次自释放） | `agent/turn-stopping` 监听 + `agent.followup`（plugin 来源，不伪造 user 权限），协议常量 3 次自释放 | 等价，原生实现 |
| validate_goal_run.py 收尾校验脚本 | `completed` 是唯一需要通过 `evaluateCompletion` 的状态转移：closeout 已提交 + 双门禁 pass + 必需角色 latest-wins 全 pass + 模式一致的出处（independent 拒绝 self-check 记录）+ 每条验收标准恰好一个 bearer | 事后扫描 → 事前结构性拒绝 |
| outbound 出站证据清单 hook（Bash/PowerShell matcher 补丁史） | v2：命令类匹配仍在 guard，但**决定**移到 `tools/pre-execute`（异步、可 `ask`）：读 `<run>/outbound/manifest.json` → 校验（runId / 命令覆盖 / 6h 新鲜度 / 每 claim 一个 bearer / 工件存在非空且在 run 目录内 / 出站文本里的计数逐条比对）→ 无效则 deny；有效时若存在一条其 `target` **本身就是出站命令类**、**且按 shell token 边界命中本次命令**的未消费 `owner-approve` 则消费它直接 allow（2026-08-24 第五轮修：此前是取第一条未消费的批准、完全不比对文本，等于批准是可互换的令牌，而 seam 又在 ask 之前消费，人根本看不到提示），否则 `ask` 交给 `ctx.approval`；`tools/execute` 里**授权即归档**、**非 error 结果才计数**（归档写在 `next()` 之前，`enforcement.outboundConsumed` 只在 `next()` 返回非 error 结果后加一；注意这不等于「派发成功」——shell 工具非零退出不置 `isError`，2026-08-27 实测四条失败命令仍加满计数，语义与代价见 §6）。seam 装不上时 guard **无条件拒绝**全部出站（fail-closed，比 v1 更严） | hook matcher → 平台 seam + 证据清单；一次一批准语义保留在 native 通道内 |
| 出站批准通道（CC 只有提示词层的「先暂停、要用户确认」，没有机械通道） | v2：`tools/pre-execute` 返回 `ask`，由运行时经 `ctx.get('approval')` 解析；批准服务缺席时**运行时自身**把 ask 降级为 deny（fail-closed，不需要本插件补一层）；会话 approval 策略为 `'never'` 时确定性 `rejected`。init 时 `observeApproval` 读三档（无服务 / 有服务但策略 `'never'` 或零监听器 / 有监听器），只有最后一档记 `enforcement.approval: 'native'`，其余记 `'signal-only'`（只有 direct-human-turn 的 `owner-approve` 能授权） | 提示词暂停 → 平台批准通道；但记的是「有没有人订阅」，不是「有没有人应答」（§6，2026-08-25 收窄后仍未关闭） |
| run 状态存储（CC 的 `goal-runs/<slug>/` 文件目录） | v2：`RunStoreLike` seam，文件后端与 `ctx.storageDomain` 原生数据域后端并存，由 `storeKind` 选择（`auto` 探测），**实得后端**记进 `enforcement.store`。两个后端共用同一个 run 目录路径，只有权威事件流搬家——否则已记录的工件 ref 会随后端切换集体失效 | 单一文件目录 → 可选原生后端 + 实得值如实记录（domain 后端默认只在挂了 storage 行的部署里被走到，一条 `--patch` 覆盖即可在 headless 上翻过来，已实测，§6） |
| 有界升级（2 轮 needs-replan，第 3 轮升 owner） | `MAX_REPLAN_ROUNDS=2` 协议常量，fold 内簿记 `consecutiveReplans`，第 3 轮自动 `needs-owner-decision` | 等价，机械化 |
| 分诊（size/risk/execution_mode/audit_mode 组合规则） | `validateTriage` 在 init 拒绝非法组合（self-check 仅 lightweight+low；medium+ 强制 independent；lightweight 恒 inline） | 约定 → 入口拒绝 |
| 四格姿态检查点（--cell on-plan\|detour\|grind\|escalate） | `autopilot_log` stance 枚举 + escalate 强制 note + log.md 人类工件 | 等价 |
| Owner-only 边界（暂停等 owner） | `needs-owner-decision` 非终态 + `owner-resolve`（direct-human-turn 校验，复用 dsh goal 工具的权限判定模式）| 等价并可恢复 |

## 3. 状态机

阶段：`planning → plan-reviewing → executing → execution-reviewing → replanning → closing → completed | blocked | needs-owner-decision`。

与 CC / 实验包的差异点：

- **`closing` 阶段是新增的**：executionGate pass 只进 closing；`completed` 必须由
  一次通过完整校验的 closeout 提交触发。实验包里 execution audit pass 直接
  completed——那正是 CC 收尾契约要堵的洞。
- **`needs-owner-decision` 不是终态**：owner 可 `resume-planning`（重置 replan 预算）
  或 `block`。`completed`/`blocked` 是仅有的终态。
- **审计角色三分**：`plan` / `execution` / `rules`（触碰操作层或 risk high/critical
  时必需）。rules pass 仅记录；rules 非 pass 与 execution 同权重驱动状态机。
- **inline / delegated 双执行模式**：inline 由 root 直接实现并 `submit-evidence`；
  delegated 走 continuable 执行器子代理 + `submit-packet`（CAS 世代号 + 执行修订号）。

事件溯源：每次操作追加一行全快照事件到 `events.jsonl`（`{v, op, revision, time,
snapshot, detail?}`），提交前必须通过 `applyEvent` 严格校验（首事件必须 init、
revision 恰好 +1、triage 不可变、审计历史 append-only、start-executor 前置
planGate pass、executionGate pass 必须有对应最新 execution 审计 pass、completed
必须过完整校验、终态后拒绝一切事件）。`snapshot.json` 与 `log.md` 是投影，
`events.jsonl` 是唯一权威。

## 4. 为什么用文件存储而不是 Session 事件（上游限制，重要）

dsh 的持久 Session 事件词表（`KNOWN_SESSION_EVENT_TYPES`）目前对树外插件是封闭的，
`ignorable` 标志与外部事件注册面在上游被明确标记为 deferred。树外插件追加自定义
事件类型可能导致**会话冷恢复被拒绝重建**。因此 v1 的 run 状态存放在
`$DSH_HOME/storages/dsh-autopilot/runs/<rootSessionId>/`，与 CC 的
`goal-runs/<slug>/` 工件模型同构。run 以 root session id 为身份，会话 resume 后
状态自动重新绑定。上游一旦开放事件词表注册，迁移路径是把同一套 fold 换到
`session.append('autopilot/change', …)` 上（事件形态已按此设计）。

**这条主张是实测的**，钉在测量当天（2026-08-24，本机 dsh 源码树
`C:\Users\<user>\dsh\packages\core\session\src\known-event-types.ts`，文件头注释，
逐字）：

> Downstream (out-of-repo) plugin events are outside this list by construction;
> a registration surface for them is deferred until such a consumer exists.

同一段注释还说明了后果（以下为中译要点，非逐字）：持久化读路径**拒绝解释**含表外
类型的日志，除非事件带 `ignorable` 信封标记——理由是那种日志多半出自更新版本的
harness，静默跳过一个必需事件会重建出错误的会话。该常量本身由
`scripts/gen-persistence-catalog.ts` 生成、由 `verify-persistence-catalog`
校验新鲜度，即词表是构建产物而不是可运行时扩展的
注册表——所以「等上游开放注册面」不是措辞婉转，而是这个文件的结构决定的。

因此路线图 §9.4 仍是路线图，不是待办：在上游给出注册面之前，树外插件把 run 状态
写进 Session 事件是**已知会坏冷恢复**的做法，v2 没有尝试，也不应该尝试。本条结论
的有效期截止到下一次实读该文件；换 dsh 版本后请重读再断言。

多进程共享同一 run 不在契约内（与 CC state.json 相同），由 fold 校验失败显式暴露。

## 5. 不可机械化的不变量（承自 CC，写给使用者与审计者）

以下规则无法由本插件强制，属于教义层（policy 区段只放可执行摘要，全文在此）：

- **Checker-Resolution 不变量**：一个 checker 的 pass 在它被证明能观察到对应 fail
  之前不承载信息。量词要配基数下限；N 值结果按值断言，不做布尔坍缩。
  （本仓库自身实践：gate 测试按决策 kind 精确断言；`evaluateCompletion` 对空
  验收清单/空证据清单显式报错。）
- **Moving-Anchor 不变量**：断言不得锚定会移动的值。"因为无效才选用"的 fixture
  必须就地断言它仍在已知集合之外；引用外部计数必须钉住测量时的 commit。
- **Single-Bearer 规则**：每条可验证声明恰好一个能观察其为假的工件；两个弱工件
  不能分摊一条声明；没有合格 bearer 就诚实记 UNPROVEN。
  （closeout 的 evidence 结构把这条字段化了，但 bearer 的**真实性**仍是审计层职责。）
- **审计包纪律**：派遣语境不叙述自身状态——给审计者的包只放工件（契约、计划、
  diff、原始验证输出），永不放推理链或预期结论。

**审计过程自身的 Checker-Resolution 失效**（2026-08-25 首轮真机验证暴露；记在
这里而不是 §8，是因为它不是一条代码缺陷，而是本节四条不变量在**审计过程**上被
违反了一次）：

事实：§8.1 的头条此前写着“本交付物从未在真实 dsh host 里运行过”，理由是“本环境
没有 dsh 运行时，且网络/安装命令被禁止”。第二句是**假的**。八个对抗透镜、两轮
裁定、以及此后每一轮收尾都逐字重述了它，没有任何一次去问它是否为真；拆穿它的
是一句人类的反问“本机不是有 dsh 吗”。实测：dsh 0.1.1-rc.2 就装在
`C:\Users\<user>\dsh`，`autopilot-headless` profile 早已把本仓库链了进去，驱动它
一次既不需要网络也不需要安装。

更难堪的是拆穿它并不需要跑任何命令：§8 自己在 2026-08-24 就记着一次真机
headless run（那是 v1 流、7 事件，见 §8.1 的 `.smoke/` 条目，所以它不与“v2 从未
跑过”直接冲突），而那条记录成立的前提**正是本机有 dsh 运行时**。推翻那句理由的
bearer 一直躺在同一节里，隔二十几行。八个透镜都读过 §8。

诊断，用本节自己的词汇：这是一次 Checker-Resolution 失效，发生在**审计过程**这
一层。“没有 host”是一条 checker——审计据它把一整类主张判为不可测量——而这条
checker 的 pass **从未被证明能观察到它自己的 fail 面**：没有任何一个透镜跑过
`dsh --version`、找过 profile、或者尝试过一次 boot。一条没人试过让它变红的前提，
在报告里与一条被证实的前提长得一模一样，于是它被零成本地复制了十次。复制次数
不是证据强度：十份共享同一条未检前提的报告是**一个** bearer，不是十个——这是
Single-Bearer 规则的直接推论，“八个透镜都这么说”在这里恰好等于“八个透镜都
没查”。它同时也是一次 Statement-Artifact Sync 失效：与该前提冲突的工件就在同
一份文档里，没有任何机制去对账。

由此固化为规则：

- 一条 UNPROVEN 记录必须写明**为什么现在不可证**，且只能取三种形状之一：
  **本轮未尝试** / **尝试过但不确定**（附实际观察到了什么） / **被某个具体事实
  挡住**（附那个事实）。只写“环境不允许”而不给出一次观察，等于把一条未检前提
  提升成结论。§8.1 已按这条重写。
- 环境性前提（有没有 host、有没有网络、有没有某个二进制、某个工具在不在这台机器
  的工具集里）与代码主张同权：它们同样需要一个能观察其为假的 bearer，而这类
  bearer 的成本通常低到没有任何理由跳过——本轮拆穿它花了一条命令。
- 派发给审计者的包不得携带上一轮的环境结论。“没有 host”是**推理链**，按审计包
  纪律本就不该进包；它进了包，于是每一个透镜都从同一个错误起点出发，而透镜之间
  的独立性正是这条审计链唯一的价值来源。

**第二次失效**：测试不是弱，是停在 mock 边界（2026-08-25 真机 FIX 轮补记；同样
记在这里而不是 §8，理由与上一条相同——它是一条方法层结论，不是一条代码缺陷）：

事实：真机第一轮登记的 12 条缺陷里有 8 条被判为"高"，而当时的套件是 556 用例全绿。
本轮逐条追下去，**没有一条**是因为断言写得松、量词漏了基数下限、或者夹具选得不
锋利。它们全部落在同一类位置：**测试在真实边界前面停下**，把边界本身换成了一个 mock，
于是被测代码与它真正要对话的那个东西从来没有对过话。四个边界，逐一点名：

1. **工具输出的序列化边界**。`test/tools.test.ts` 把工具定义收进一个 `Map`，直接
   `await def.execute()`。没有 `ToolRuntime`，就没有输出快照，就没有无损 JSON 校验
   ——556 个用例里**一次都没有**评估过这条契约。缺陷 1 因此在每一次 lightweight run
   上必现，而套件全绿。
2. **`toolFilter` 与 `restrict()` 的词表边界**。`test/helpers.ts` 的
   `stubSubagents.startContinuable` 直接丢掉 `spec.request.toolFilter`，全树没有任何
   一处调用 `tools.restrict()`。引擎构造的过滤器只被拿来和它自己对断言——**一份 allow list 里的名字有没有人认得**，从来没有被问过。缺陷 2、3、4 都在这里。
3. **子代理组合的边界**。`test/child-setup.test.ts` 手搭一个 `childCtx`，从不调用
   dsh 的 `applyChildComposition`——而那恰恰是真机上**先跑**的那个函数，也是真正把
   过滤器施加上去的那个函数。手搭 childCtx 证明的是"如果回调跑了会发生什么"，
   真机上的问题是**回调根本没跑到**。
4. **挂载次序的边界**。没有任何东西驱动过一次真正的 `ctx.plugin()`，所以"宿主在
   `apply` resolve 之后观察到什么"这个问题在套件里连提都没提过。缺陷 6 因此不是被
   测漏了，是不在被测集合里。

**这四条与"审计不够狠"是两种病**。变异测试、更强的断言、更多的对抗透镜，原理上
都只能加强对**已有规则**的检验；它们无法显示"缺了一条必要规则"，更无法显示"这条
规则的对手方从来没到场"。本节第一条讲的是审计过程复制了一条未检前提；这一条讲的
是**测试套件复制了一整套未检的替身**。两者的共同形状是同一个：一个从未被证明能
观察到自己 fail 面的 checker，被当成了证据。

由此固化为规则，并已在本轮落地：

- **一个 mock 是一条声明**：`stubSubagents` 说"派遣会这样发生"，手搭 childCtx 说
  "子上下文长这样"，直调 `execute()` 说"返回值就这样交出去"。按 Single-Bearer 规则，
  每一条这样的声明都需要**至少一个跨过该边界的 bearer**；一整层 mock 共享零个
  bearer 时，那层 mock 覆盖的全部结论是**一个** UNPROVEN，不是 N 个 PASS。
- **哪一层承重必须写在文件里**，不能靠读者猜。 本轮新增
  `test/boundary.test.ts`——按构造，它是本仓库**唯一**一个跨过这些边界的测试文件，
  这个"唯一"本身是可观察的：任何第二个跨界文件都必须导入下面这批真实符号之一。
  它**导入并驱动真实符号**：
  cordis 的 `Context`、dsh-tools 的 `ToolRuntime`（真注册表、真 `execute` 管线、真
  输出校验器）、dsh-session 的 `snapshotJsonValue`（运行时实际调用的那个无损 JSON
  函数）、dsh-subagent 的 `SubagentRuntime` / `applyChildComposition` /
  `NO_START_CAPABILITIES`、dsh-llm 的 `CallId`，外加 `SystemPrompt` 与 `createScope`
  ——后两个不是顶层可解析的（它们是 `dsh-tools` 在 pnpm 虚拟仓里的同级），该文件用
  `createRequire` 从 `realpathSync(node_modules/@deepseek-ai/dsh-tools/package.json)`
  解析，**加载的因此是已安装的 `ToolRuntime` 注入的那份物理副本**；解析失败直接抛，
  不降级成 skip。它刻意**不 import `test/helpers.ts`**。
- **替身必须自报代价**。 该文件头部列出仅有的三处替身，并逐条写明各自换掉了什么：
  agent 是结构性作用域键（`AgentRuntime` 需要 LLM 与会话存储；但凡"上下文"重要的
  地方用的都是真的 `createScope(...).ctx`）；dsh 全局工具集是**名字忠实**的替身，
  名字逐条转录自上游 `defineTool` 调用点并附路径——对 `restrict()` 这个只校验名字、
  从不碰函数体的边界是**精确**的，对任何执行它们的用途是**无价值**的，而这里没有
  任何东西执行它们；`startContinuable` 被替换，但执行器过滤器是从引擎**真实请求**
  上截下来再推过真的 `applyChildComposition` 的。审计者过滤器不需要替身——它是从一次
  经过真 `SubagentRuntime` 的派遣里截下来的。
- **一个未来的读者必须能判断某条结论靠哪一层站着**。 读法固定为：
  `test/boundary.test.ts` 里的四组（`§1` 工具输出穿过真无损 JSON 校验器、`§2` 引擎
  的过滤器对真注册表、`§3` 宿主眼中的插件挂载、`§4` 真 cordis 子上下文上的
  continuable 子代理 setup）是**对真机承重**的那一层；其余每一个测试文件都是
  **领域层与纠缠层的高分辨率检验**，它们对"规则写对没有"承重，对"规则的对手方存在且认得这些
  名字"**不承重**。任何一条结论如果只有后一层的 bearer，它在真机上的地位是 UNPROVEN
  而不是 PASS。该文件另带两条 **UPSTREAM CANARY** 用例（自有 `undefined` 属性不是
  无损 JSON；cordis await 异步 `apply` 而不 await 异步 `effect`），它们的作用是让
  上游语义一旦改变就**在这里**变红，而不是在下一次真机 run 上变红。
- **本轮没有做到的那半句照记**：boundary 层证到的是"这些名字在一个真注册表里认得、
  这些返回值过得了真校验器、这个子上下文真的收得到那个工具"。它**没有**证到 dsh 全部
  真工具的行为、没有真 LLM、没有真会话存储；跨部署的那一维仍然只有一台机器一个
  profile（§8.1）。承重层存在，不等于承重层覆盖全部。

## 6. 诚实上限（不是缺陷清单的省略）

v1 起就存在、v2 没有挪走的边界：

- **Web 路由的围栏是宿主的，插件只是套用**（2026-09-04，dsh 0.1.2 升级轮）：
  rc.1 的 `webServer.register` 本身不做任何鉴权（`packages/host/webserver/src/index.ts`），
  树内 `client-connection` 插件给自己的 `/api` 前缀套的是 `connection.requestRejection(req)`
  （Host/Origin 信任栅栏 + 浏览器会话认证，`packages/client/connection/src/index.ts`）。
  `GET /api/autopilot/*` 现在每次请求都弱查找 `connection` 服务并先问它；**fail-closed**：
  有 `webServer` 却没有 `connection` 服务的宿主组合下两条路由答 `503 no-connection-service`，
  不再裸露。真机实测：裸 curl 两条路由 401，已认证的浏览器页面内 fetch 200。
- **side-by-side 宿主布局的运行约束**（2026-09-04 owner 裁决）：本机 `~/dsh`（0.1.1-rc.2）
  与 `~/dsh-0.1.2-rc.1` 并存；`~/.dsh/profiles/node_modules` 是**所有 profile 共享**的
  回退目录，每次真实启动都由**当时启动的 CLI** 按自己的安装锚点重指
  （`healProfilesModuleFallback`；实测 rc.1 CLI 只在真实启动时触发它、`--dump-config`
  不触发，而 0.1.1-rc.2 CLI 在模块加载时就触发、连 `--dump-config` 也会翻链接）。所以
  旧 CLI 与新 CLI 的 profile **不得并发运行**，否则活着的旧进程会懒加载进 rc.1 树；
  本轮收尾用旧 CLI 启动一次把共享链接翻回 `~/dsh`。旧树独有的包（`dsh-client-runtime`、
  `experimental/gah`、`tool-gah`）的链接在新 CLI 启动后仍指向旧树、未被删除——
  是"存在但未被本插件使用"，不是悬空。owner 级 `agent-presets.default: gah` 在 rc.1 树下
  不可挂载，因此 `autopilot-dev` 在新 CLI 下**建新会话失败**（打开旧会话正常）；这是
  布局的后果，不在本插件范围内。
- **子代理作用域的安装点是 `agent/created`，不再是注册表**（dsh 0.1.2）：上游删除了
  `ctx.subagents.registerContinuableSetup`（activation-setup 注册表整体消失，子代理管理器
  改为把私有 `setup` 传给 `agents.create()`）；社区升级卡片未收录，真机首启才暴露。
  插件改在 `agent/created`（对包括子代理在内的每个 agent 都会宣告；rc.1
  `packages/core/agent-loop/src/index.ts` 的发布顺序是 setup → `session/created` →
  `agent/created` → `agent/session-start` → 首次 prompt 组装，即在 setup 与
  `session/created` 之后、`agent/session-start` 与首次 prompt 之前）用 `agent.ctx` 安装 packet 工具、出站守卫与
  原生 seam。**监听器的契约**（2026-09-04 owner 裁决，回应 PR #6 上 Codex P2 3933411711
  "失败被吞掉、部分注册残留"）：与本 run 无关的子代理是无害 no-op，什么都不装、也不会抛出，
  因此绝不会否决一个无关 agent 的发布；被识别为本 run 活体执行器的子代理**事务性**安装——
  seam → packet 工具 → 出站守卫，任一步抛出即按逆序回滚已装好的每一步（每个 disposer 各自
  try/catch，清理失败附在原错误的不可枚举 `rollbackFailures` 上、绝不遮蔽原错误），然后把
  **原始错误**从监听器里抛出去；rc.1 的 `AgentRegistry.announce()` 对同步抛出的监听器
  **否决发布**（`test/host-publication.test.ts` 用真 rc.1 注册表实测），于是
  `startContinuable` 拒绝、引擎把执行器记为 `revoked` 并把失败写进启动诊断——fail-closed，
  而不是一个永远交不出 packet 的 `running` 执行器。`childInstalled` 只在整套面装完后才
  登记；`agent/disposed` 先删条目再逐个尝试每个 disposer，一个失败不影响其余、也不会留下
  条目（`test/child-setup.test.ts` (a)–(f)、`test/apply.test.ts` (g)–(j)）。
  **明写的残留**：插件**重新挂载**时若已有活体执行器（持久化的 run 记着 `running` 与匹配的
  childId），挂载扫描会识别到这个既存子代理，但此时已无发布可否决、插件也没有把执行器
  改成 `revoked` 的 API，所以该路径上的安装失败只能告警（带 run id 与 child id）、执行器
  记录不会被纠正——P2 描述的状态在这一条路径上仍可能出现。同样未收录、真机才暴露的
  第二处：客户端 `inject` 里的 `conversationEvents` 随 client-runtime 一起消失，rc.1 的
  定义注册表是 `ctx.uiConversation.events`。
- **出站命令类的覆盖范围是枚举的**：脚本内 subprocess 调用、改名的 git
  二进制、未枚举的通道不在覆盖内（与 CC hook 的已知洞同类）。审计层负责。
  （标题 2026-08-24 第五轮改写：原标题"是命令类匹配，不是证据清单"作为对 v2 的
  陈述已经过时——v2 出的正是一份证据清单，而这条上限里仍然为真的那半句由
  下面 v2 那条"出站命令类匹配有下限但仍是文本匹配"承载，一条上限不需要两个
  bearer。同一轮还补上了三处**已枚举通道内部**的漏网：`gh api` 带
  `-f/-F/--field/--raw-field/--input/graphql` 时会隐式改成 POST、
  `gh workflow run` / `gh secret set` / `gh variable set`、以及被反斜杠续行
  拆开的 `git … push`——这三类不在本条上限里，它们是覆盖缺陷，已修。）
- **sandbox 钳制依赖 dsh 的平台后端**（Windows ACL / Landlock / Seatbelt）。
  `enforcement.sandbox: 'active'` 的 bearer 是"mode 事件已追加 **且** 上下文可观察到
  confine 服务"（2026-08-24 独立审计发现原实现仅凭 append 即记 active——一个代码
  无法观察其为假的声明，已修复：探测不到服务一律记 `degraded` 并注明 shell 未受
  OS 钳制）。探测仍是存在性检查，后端在不支持的 OS 上静默 no-op 的残余由
  `gate.strictShell: true` 兜底。
- **guard 是质量门禁不是权限系统**，但出站那一支不是：guard 自身异常时对
  plan gate / usage 钳制 / executor-bypass 三支 fail-open——坏掉的质量门禁不该
  锁死机器。出站是唯一的例外：`applyDecision` 第一步就是 `engine.peek`，它会
  在 `events.jsonl` 有半行时抛 `AP_STORE_CORRUPT`（`RunStore.commit` 先 append
  权威事件再 tmp+rename 投影，进程在这个窗口被杀就正好留下这个残留），而
  `egressSeam: 'guard-deny'` 按定义就是"没有 pre-execute seam、这个 guard 是
  唯一防线"的那一档——2026-08-24 第五轮实测：那一档下"无条件拒绝"变成了放行。
  现在 catch 是分开的：出站类调用（只看工具名与参数，因为快照读正是刚刚失败的
  那一步）返回拒绝理由，其余仍然 fail-open。
- **turn-stopping 提醒依赖 followup 唤醒语义**：若上游语义变化，提醒退化为无害
  no-op（协议上限 3 次，不会困死会话）。
- **`external` 审计模式在 v1 被 init 拒绝**（诚实终点，避免半实现）。
- **引擎的 `init` 对 standard run 不强制 usage 播种**：把 `usageSeeds` 传
  `undefined` 的 standard run 根本没有 usage 维度，而那正是 legacy 流的免检
  形状。强制播种的那条不变量只活在工具层的一个三元表达式里
  （`src/tools.ts`），不活在状态机里。这是**刻意保留**的：`test/legacy.test.ts`
  与 `test/usage-gate.test.ts` 都按"无 usage 维度的 standard run 照常通过"
  断言，因为 v1 的真实流就是这个形状，把它变成 init 拒绝会让重放与新建两条
  路径对同一形状给出不同答案。代价写在这里：经由引擎 API（而不是
  `autopilot_init`）创建的 standard run 可以完全不带这个维度。

v2 新增的诚实上限：

- **出站清单校验的边界**：manifest 校验证明的是"清单说了什么"，不是"清单说的
  是真的"。它证明每条
  claim 有一个存在、非空、在 run 目录内的唯一 bearer 工件，该工件文本里出现它
  自己声明的每个 `covers` 标签，并对 claim 文本里的计数短语逐条比对。它**不**
  验证非计数型 claim 的自然语言内容，也不能判断工件本身是否伪造：`covers` 只是
  作者选的标签，"标签出现在工件里"不等于"claim 为真"。真实性仍是审计层职责
  （Single-Bearer 规则的老边界，没有被 v2 挪走）。
  （2026-08-24 第四轮审计发现 `covers` 此前被 `parseManifest` 强制要求，却不被
  任何规则读取——一个"必填但没人看"的字段，等于清单声称绑定却什么都没绑。已按
  `settleUsageArtifacts` 的同一规则落实，并把本条从"承载该 claim 文本"改写成
  实际被证明的内容。）
- **出站命令类匹配有下限但仍是文本匹配**：一条 `commands[i]` 至少两个 token，
  且必须落在 shell token 边界上（`cd x && git push` 仍匹配，`'it push'` 落在
  `git push` 中间不再匹配）。这挡住了"一条 manifest 用 `['s']` 通吃 push 与
  publish"的越权，但仍不理解命令语义：脚本内 subprocess、改名二进制、未枚举通道
  依旧在覆盖之外（与本节第一条 v1 上限同类）。
- **出站命令类是逐段授权的**，但分段本身仍是文本切分（2026-08-25 第六轮新增，
  同轮修掉了它背后的真缺陷）。真缺陷是：授权此前问的是"声明的条目有没有出现在
  这条命令里"，而不是"这条命令的每一个出站元素是不是都被覆盖"。于是一份
  push-only 的 manifest 加一条 push-only 的 owner 批准，授权了
  `git push origin main && npm publish`——第二段 egress 属于另一个命令类、
  没有任何证据、owner 从未被问过，而 `manifest.ts` 自己的注释、README 与 §2 都
  写着"授权是按命令类的，不是通吃的"。实测驱动到 `{kind:'allow'}`，批准被记为
  `consumedBy: 'git push origin main && npm publish'`。修法是
  `egressSegments`：先按 shell 分隔符（`&&` `||` `;` `|` `&` 换行，反斜杠续行先
  合并）切开，再要求**每一个**被判定为出站类的段都被 manifest 的某条 `commands[i]`
  与 owner 批准的 `target` 各自按 token 边界覆盖；非出站段（`cd repo`、`pnpm build`）
  不需要声明，所以 `cd repo && git push` 照旧可用。单个 `&` 也在分隔符集里：
  `git push origin main & npm publish` 一样是两条命令，而 git-push 模式的 gap
  把换行、`&`、`|`、`;` 都排除在外——它在 `&` 处就停了，所以整行仍然只匹配
  push 那条声明，publish 就跟着过去了（实测 2026-08-25，已按夹具钉住）。
  留下的上限就是这一句：分段是**文本切分**，不是 shell 解析，两个方向都有代价。
  多切的一侧**通常**是 fail-closed：引号里的分隔符照样切（`echo "a && b"` 变成
  两段），最多是多要一条声明。这句话有一个已实测的例外，见下面"gap 排除了分隔符"
  一条——把**一条**命令从中间切开时，多切是 fail-OPEN。少切的一侧是真洞，而且
  已实测：**命令替换不带任何分隔符**，
  所以 `git push origin main $(npm publish)` 只被切出一段，一份 push-only 的
  manifest 就覆盖了它（实测 2026-08-25，已按夹具钉在 `test/gate.test.ts` 与
  `test/outbound.test.ts`，记的是当前行为而不是期望行为）。反引号、`xargs`、
  脚本内 subprocess 同理。要机械化地修这一类，需要的是一个真 shell 解析器，
  不是再加几个分隔符；在那之前它与本节第一条 v1 上限（出站通道是枚举的）是同一
  条边界的两半，由审计层负责。整行判定为出站而逐段都不判定时，整行被当作一段
  要求完整覆盖（fail-closed 兜底）。
- **出站匹配是命令形状的文本匹配**，两个方向各有自己的上限（2026-08-25 第七轮
  重写；上一版条目已被本轮的修复证伪，见 §8）。上一版写的是"过度包含是刻意保留
  的方向"，理由是任何"跳过引号内容 / 跳过 `#` 注释"的收紧都对 owner-only 边界
  fail-OPEN，并把六条命令钉成拒绝夹具。本轮实测（2026-08-25，经 `decideTool`、
  `egressSeam: 'guard-deny'`）：那六条里四条现在**放行**——
  `git commit -m "prep for git push"`、`grep -rn "git push" .`、
  `echo "remember to git push later"`、`echo "do not git push" | tee notes.md`；
  只有 `run_code` 的 `# TODO: git push after review` 与 `terminal_send` 的
  `# git push is gated here` 仍然拒绝。产品自己的行为与本条上限相反，等于本条
  上限没有被记录，所以本轮改的是这一条，不是代码。当前的读法与它各自的上限：
  - `bash` / `pwsh` / `terminal_open` 的参数按各自的契约就是一条命令行，所以先
    做一次引号感知的扫描：丢掉未被引号包住的 `#` 之后的内容，丢掉引号字符本身，
    并把**引号内部**的空白熔成 `_`。熔而不是删是全部要害——shell 的引号只决定
    空白是否分词，`git push "origin" main` 仍然是一次 push，而 `"git push"` 作为
    一个参数永远不会是 `git` 的子命令；`_` 是 `\w` 字符，所以 `\bgit\b` 匹配
    不进 `git_push`。
  - 这条读法在整行出现"能执行一个字符串"的程序时作废，退回逐字匹配
    （`bash -c` / `sh -c` / `ssh` / `python` / `xargs` / `eval` 等）。这份名单是
    **枚举**，于是本轮新增一条上限：不在名单上、却会执行一个引号参数的程序
    （`mytool --run "git push"`、包装脚本、改名的 shell）现在被放行，而收紧之前
    是被拒的。实测 2026-08-25：`mytool --run "git push origin main"` 为 false，
    `bash -c "git push origin main"` 为 true。这与本节第一条 v1 上限（出站通道是
    枚举的）是同一条边界。
  - 不带引号的提及仍然被拒，这是保留下来的过度包含：`cat notes/git-push.md`、
    heredoc 体里的 `git push`、`sudo git push` 在文本上无从区分，而能区分它们的
    "命令位置"规则对 `xargs git push`、`env X=1 git push`、
    `find . -exec git push \;` 全是 fail-OPEN 的，所以没有采用。
  - `run_code` 的 `code` 与 `terminal_send` 的 `text` **不是命令行**：前者是
    某种语言的源码（`"git push"` 在被交给 `shell=True` 之前是惰性字符串），
    后者是键入一个前台进程未知的 PTY 的按键（`#` 是不是注释取决于那头是 shell、node REPL
    还是 `cat`）。这两条通道保留逐字匹配，因此保留完整的过度包含——提及即拒。
  四点都在 `test/gate.test.ts` 有夹具（`mentions` 与 `performed` 两个方向各带
  基数下限，外加三条 `RECORDED CEILING`）。
- `git … push` 模式的 gap **排除了** `&` / `|` / `;`，所以这三个字符出现在 `git`
  与 `push` 之间时整条命令漏放（2026-08-25 第七轮新增；这是**既有**洞，不是本轮
  收紧引入的）。`\bgit\b[^\n&|;]*\bpush\b` 把分隔符排除在 gap 外，理由是
  不让两条不相关的命令熔成一次匹配；代价是分隔符出现在一个**带引号的选项值**
  里时匹配也一起没了，而引号在那里恰恰说明它不是分隔符。实测 2026-08-25，五条形状
  `isEgressCommand` 全为 false、`egressSegments` 全为空数组、经 `decideTool` 在
  `guard-deny` 下判 `allow`：`git -C "a;b" push origin main`、
  `git -c "core.x=a|b" push origin main`、`git -c "core.x=a&b" push origin main`、
  `git -c http.extraHeader="Cookie: a=1; b=2" push origin main`、
  `git -c credential.helper='!f() { echo pw; }; f' push origin main`。分段器在这里
  不救场：它按同一批分隔符切，引号里的分隔符照样切，于是 `git` 与 `push` 被切进
  两段，两段各自都不属于出站类——这就是上一条里那句"多切是 fail-closed"的例外。
  同日实测这不是收紧带来的回归：把同样 8 条形状同时喂给逐字读法（`opaque-text`，
  即收紧前的 `RegExp.test`）与当前读法，两边都漏同样 5 条，差集为空。机械化修法
  是先做引号感知的切分、再在**段内**限制 gap，而不是继续在字符类里排除分隔符；
  在那之前记在这里，与本节第一条 v1 上限同属审计层职责。
- **run 目录名的一字符一映射挡住了塌缩碰撞**，挡不住与字面 `_` 的碰撞
  （2026-08-25 第七轮新增）。`sanitize` 把每个不安全字符换成一个 `_`，所以 `a/b`
  与 `a//b` 确实分开（这正是它不写成 `/[^…]+/g` 的理由），但任何含不安全字符的
  id 都与"把该位置直接写成 `_`"的另一个 id 撞在一起——实测 2026-08-25，`s:1` 与
  `s_1` 都解析到 `runs/s_1`。后果与塌缩碰撞相同：两条 run 共用一个目录，
  `events.jsonl` 交错，`snapshot.json` / `log.md` / usage 工件 / 出站清单全部同名。
  本轮把两个后端各自一份的这条规则合并成一个导出的 `runDirFor`（两份逐字相同的
  副本只能靠测试拴在一起，而测试只能采样输入空间），所以两侧不会再各自漂移；
  留下的上限是这条规则本身，不是它的副本数。另记一处措辞：`src/store/file.ts` 里
  `sanitize` 的注释把 injectivity 写成它欠调用者的义务，而实现只对塌缩那一族
  兑现了这条义务——属于 §5 的"对人断言了代码观察不到其为假的话"同型，本轮的
  写域不含 `src/`，记在这里等下一轮处理。
- **`covers` 标签的特异性下限（2026-09-01 已机械落实）**：`MIN_COVERS_LABEL_LENGTH = 3`
  （trim 后字符）。`commands[i]` 的两 token 下限挡住 `['s']` 通吃出站类；covers
  现在有对称的下限，所以 `covers: ['a']` / `['at']` 在 usage 声明、usage 结算、
  outbound 清单三处都被拒绝，而文档示例 `covers: ["tsc"]` 仍合法。剩余上限只是：
  长度够的标签仍可能碰巧出现在无关文本里——那是审计层职责，检查器现在至少能
  对 `a`/`at` 变红。历史测量（2026-08-24/25，修前 `['a']`/`['at']` 结算干净）
  留在 `test/usage.test.ts` 与 `test/outbound.test.ts` 的拒绝夹具里。
  （2026-08-25 第六轮曾把本条从只写出站扩到 usage 结算，当时两处都还是洞；
  2026-09-01 两处同时加上限，历史测量不再描述当前行为。）
- **usage 工件的 `capturedAt` 是纯自报值**：两侧都完全不看文件系统时间
  （`grep mtime|stat src/domain/*.ts` 无命中），所以 `capturedAt` 说什么就是什么。
  这条上限**本身没有被本轮挪走**，但它的上半句变了：原文写"没有上界"，2026-08-25
  真机 FIX 轮把上界实现进了 `settleUsageArtifacts`（可选 `settledAt`，
  `capturedAt` 晚于它即拒），于是"没有上界"作为对**领域函数**的陈述已经过时。
  那条"上界在生产路径上是死代码"的缺陷已在 2026-08-25 收尾复核里结清：
  `submitCloseout` 现在传 `settledAt`；`fold.ts` 的重放路径仍然不传，因为重放
  确定性的理由只成立于重放。补上之后立刻暴露第二件事——硬性
  `capturedAt <= settledAt` 会被普通时钟抖动误杀（实测一次真实收尾里工件比结算
  时钟早约 1 秒即被拒），所以上界改用与它同胞（出站 manifest 的 `createdAt`
  上界）**同一个** `FUTURE_SKEW_MS` 容差，两份重复常量合并进
  `src/domain/types.ts`。仍然属于上限的只剩这一句：`capturedAt` 依旧是自报值，
  容差之内的向前戳无法被观察为假。
- **external 附署无法被验证真的发生过**（2026-08-25 随通道一并记入）：`independent`
  的出处是结构性的——审计者是本引擎派遣的，模型说什么都伪造不了。`external` 不是：
  一个人在本进程之外读了东西然后签字。本仓库能机械化的只有一件事——拒绝一次
  **什么都没附上**的附署：`reviewRef` 必须落在 run 目录内、收尾时必须非空，和
  usage 工件同一套结算。**不能**机械化的是：评审是否真的发生、是否由 `reviewer`
  署的那个人写的、是否针对这棵树。所以一次 external pass 在证据强度上**低于**
  一次派遣审计，记录里两者刻意保持可区分（`AuditRecord.external` 的有无、事件流
  里独立的 `external-audit` op），而不是压平成同一个 `route.provider`。任何下游
  读者把二者等同看待，就是在把这条上限读没。

- **归档不是重放保护**：`<runDir>/outbound/consumed/` 没有任何代码读取——
  `validateManifest` 不打开它，manifest 文件在归档时既不删除也不改名。一份
  manifest 因此可以在整个 6 小时窗口内授权它所声明命令类的**任意多次**出站，
  每次都单独问一次 owner、每次都单独归档。本条 2026-08-24 第五轮新增，因为
  `archiveConsumed` 的文档此前明确写着"重放保护是归档标记，不是文件消失"——
  那是一句代码无法观察其为假的断言，已从注释里删掉。同一轮修掉的是它的一个
  真缺陷：文件名的两半（消费时刻 + `sha256(manifest+command)`）对"同一份
  manifest 被同一条命令消费两次"是完全相同的，第二次会静默覆盖第一次，两次
  被授权的派发只留下一个归档文件；现在文件名里混入一个每次消费独立的 nonce。
- **一条 proven bearer 不许同时承载多条验收标准**（2026-09-01 已机械落实；此前该缺口开着）：
  `evaluateCompletion` 现在两个方向都拒绝——一条标准不许有两个 evidence 条目，
  一个 `status: proven` 的 bearer 也不许承载两条标准。`unproven` 的空 bearer
  不占这个 map。历史测量（修前反方向干净通过）留在 `test/fold.test.ts`。
  （2026-09-04 更新：**"两条 bearer 是不是同一件东西"改由写入方声明，不再靠猜。**
  `EvidenceEntry.kind` 取 `'path'` 或 `'command'`：`path` 走
  `canonicalBearer(raw, snapshot.bearerBase)` 折叠，`command` 只 `trim()` 后逐字比较、
  永不折叠。此前是形状启发式 `isPathShapedBearer`，而 `git status` 与一个真叫
  `git status` 的文件在字符串形状上完全一样——该启发式在评审中被来回改了两次，
  每次都把真实 closeout 在"接受"与"判为复用"之间挪动一次。启发式没有删除，
  降级为**遗留分支**：只在条目没有声明 `kind` 时才跑。
  当前格式的判据是 **事件上的格式戳**，不是 `bearerBase`：`bearerBase` 自 PR #4
  起就在盖，今天 main 上已完成的 closeout 全都有 base、没有 kind，用它当判据会让
  这些历史流停止重放。`engine.submitCloseout` 在 `submit-closeout` 事件上写
  `detail: { evidenceKinds: 1 }` 并以 `requireKind: true` 求值；`applyEvent` 读这个戳：
  无戳 ⇒ 按遗留分支重放，戳为整数 1 ⇒ proven 条目缺 `kind` 报
  `AP_EVIDENCE_KIND_REQUIRED`、`kind` 为未知字符串报 `AP_EVIDENCE_KIND_INVALID`，
  戳存在但不是整数 1 ⇒ `AP_EVIDENCE_KIND_STAMP_INVALID`。该检查排在
  `phase === 'completed'` 的结构复核**之前**，否则失败码会退化成
  `AP_INCOMPLETE_COMPLETION`——正确但没有信息。未知 `kind` 在 `requireKind` 两侧都拒：
  既不是 `path` 也不是 `command` 的字符串是损坏条目，不是旧条目。
  **三层契约的严格度刻意不同**（PR #5 评审 CodeRabbit 要求 unproven 也必须带
  `kind`，owner 裁决不改运行时语义、只把边界写清）：工具 schema 对**每一条** item
  要求 `kind`，是较严格的调用界面；引擎与重放只对 **proven** 条目要求 `kind`——
  unproven 条目不承载任何工件、没有需要分类的 bearer，逼它虚构 `path`/`command`
  只会让数据语义变差；`evidenceKinds: 1` 的含义是"proven evidence kind validation
  v1"，不是"所有 item 都带非空 kind"。`test/engine.test.ts` 钉住这条边界：
  直接调引擎提交一条无 `kind` 的 unproven 条目被接受并照常盖戳。
  反向 Single-Bearer 的 map 键带 kind 命名空间（PR #5 评审 Codex 3932312241）：
  一条 `command` 的逐字文本恰好等于某条 `path` 的折叠结果时，两者是不同的工件，
  不判为复用；复用只在同一 kind 内检测。遗留无 `kind` 条目按启发式归入 `path` 或
  `command` 命名空间。
  遗留快照的 UNC 读法保留（Codex 3932312256）：没有 `bearerBase` 的旧快照以空 cwd
  求值，此时 bearer 上的前导 `//` 仍按 UNC 读——这些流写入时就是这样折叠的，
  一条同时引用 `//server/share/x` 与 `/server/share/x` 的合法旧 closeout 不能因本轮
  规则变化而停止重放；有 base 的快照才走 POSIX 折叠。空 cwd 等价于"无 base"：fold
  拒绝空 base（`AP_BEARER_BASE_EMPTY`），`resolveBearerBase` 从不盖空串。
  同一轮还修了两处折叠本身的洞：POSIX base 下 `//workspace/report.txt` 曾被当作
  UNC 保留、与 `/workspace/report.txt` 分成两件（Node 在 POSIX 上把两者解析成同一个
  文件），现在 UNC 只在**已确立 Windows 语义**时才读——盘符/UNC 的 cwd、盘符开头或
  反斜杠开头的 bearer；POSIX base 下前导 `//` 折成 `/`。以及 `bearerBase` 的
  尾随空白：`collapseBearer` 无条件 `trim()` 输入，而 `canonicalBearer` 用
  `collapseBearer(cwd, cwd)` 拼接 cwd，所以真正裁掉 cwd 空白的是这里、不是
  `resolveBearerBase`；现在 cwd 那条路径以 `trimInput: false` 逐字使用，
  `resolveBearerBase` 也只用 `trim()` 判空、盖原串，于是 `/workspace/project `
  下 `report.txt` 与 `/workspace/project /report.txt` 折叠为同一件。
  **本轮未处理的残留（明写，不是遗漏）**：`hasWindowsPathSemantics` 里 cwd 驱动的那条
  子句保留着——cwd 折斜杠后以 `//` 开头即判定 Windows 语义。于是当 `bearerBase`
  **本身**以 `//` 开头时（如手写 header `//workspace/project`），该 base 下仍走 UNC 读法，
  `//workspace/project/report.txt` 与 `/workspace/project/report.txt` 不折叠为同一件——
  实测后者变成 `//workspace/project/workspace/project/report.txt`（UNC 共享根相对规则把
  `/foo` 重写成 `{uncShare}/foo`）。没有一并修掉是因为这条子句正是 UNC 工作区的
  bearerBase 赖以成立的判据，动它属于改设计而非改缺陷；且 Linux `getcwd()` 不会返回
  `//` 前缀，触发它需要一个手写的 session header。留作已知残留，下一轮处理。）
- 归档记的是 **被授权的派发尝试**，不是"已派发"：`tools/execute` 里归档写在
  `next()` 之前——egress 一旦出去就再也写不了"是谁授权的"这条记录，所以顺序不能
  反。代价是：派发本身失败时，归档文件已经落盘。
  配对**只能部分区分**这一类，2026-08-27 真机实测收窄（先前此处写的是"区分方式
  是配对"，那句话过强）：`enforcement.outboundConsumed` 确实只在 `next()` 返回非
  error 结果后才加一，但 `isErrorResult` 认的是 `isError === true`，而 dsh 的
  shell 工具对**非零退出不置该标志**——四条 `git push` 全部 exit 1、没有任何 ref
  移动，计数器照样加到 4。所以计数器承载的是「**已派发且运行时没把它标成 error**」，
  不是「egress 确实出去了」。**反方向同样弱**（2026-08-27 复审补正，先前写成
  "有归档无事件即已授权未派发"，那句仍然过强）：`isError` 为真只说明 `next()`
  返回了错误结果，而 `next()` 完全可能已经执行了命令、已经联系过远端才报错，
  所以"有归档、无 `consume-manifest`"也**不能**判定为未派发。这一对信号只能读作
  「已授权」与「已授权且运行时报了错」，两者都不是关于 egress 是否离开机器的陈述。要让计数器承载原本那个断言，需要在这个
  seam 上另有退出码来源，本包目前没有。
- `enforcement.egress: 'native-ask'` 的 bearer 只是 **注册没抛异常**：
  `installPreExecuteGate` 只能观察到 `host.on('tools/pre-execute', …)` 是否抛
  异常；cordis 的事件总线接受任意事件名并返回 disposer，所以"注册成功"不等于
  "运行时真的会把决定权交给我们"。真正缺席的那一侧是 fail-closed 的（抛异常 →
  `installed: false` → `guard-deny` → 无条件拒绝），但"装上了"这一侧是存在性
  探测，与 §6 里 `enforcement.sandbox` 的伪 active 同类，只是这条无法在不引入
  运行时依赖的前提下升级为观察性探测。
- **`enforcement.approval: 'native'` 是"有没有监听器"的探测**，不是"有没有人会答"
  （2026-08-25 真机 FIX 轮**收窄后重写**；上一版写的是"只确认 `ctx.approval` 可见"，
  那一版已经过时，但上限本身没有被关掉）。现在的 `observeApproval` 读三档：无服务
  `'absent'`；服务在但会话策略为 `'never'`、或 `'approval/request'` 上一个监听器都
  没有，`'unanswerable'`；有监听器 `'answerable'`——只有最后一档记 `'native'`，其余
  两档一律 `'signal-only'`。这条收窄是真的、并且是**活读**：对着真 cordis 4.0.1
  Context 实测，注册一个监听器让 `EventsService._hooks['approval/request']` 从 0 变
  1、读数随之翻，dispose 之后翻回来（详见 §8 本轮"收窄但没关掉的一条"）。
  **仍然为真的上限**，而且是**不安全的那个方向**：一个注册了、却对每次 ask 返回
  undefined 的监听器读作 `'answerable'`，run 会记 `'native'`，而上游
  `ApprovalService.decide` 在那种部署上仍然瀑布到 fail-closed 的
  `() => 'unavailable'` 默认值——标签说有 owner 通道，实际一次也批不过。探针能证明的
  是**有人订阅**，永远不是**有人应答**，而"有人应答"只有在真的问过一次之后才可观察。
  另有两处安全方向的误判也已实测：cordis 的 `_hooks` 是私有字段，宿主换实现或隐藏
  它会让真的应答者读作 `'unanswerable'`（多记一次 `'signal-only'`，不放松边界）；
  approval 对象的 config getter 抛异常时读作 `'answerable'`（刻意如此——字段读不到
  不是"策略为 never"的证据）。升级路径不变：真正关掉它需要在 init 时问一次而不是
  看一眼，那要么引入一次真实的 ask，要么等上游给出一个可查询的应答者计数。
- **usage 工件的 `inheritedFrom` 是结算豁免**：非空 `inheritedFrom` 让
  `settleArtifact` 直接返回——不查 containment、新鲜度、存在性、大小、covers。
  v2 之后声明期会校验它读起来确实是 `<run-id>/<ref>` 且不含 `..`，但"被引用的
  那个 run 里真的有这个工件"从本函数的输入里观察不到。快照里 `inheritedFrom`
  字段本身是可见的，读记录的人能看出哪些工件走了豁免；判断引用是否成立是审计层
  职责。
- **二进制 usage 工件只结算格式签名**：`screenshot` / `screencast` 在 magic
  bytes 检查后直接返回，`covers` 里的边界态标签从不与内容比对（没有 OCR）。也就
  是说，恰恰是这个维度最在意的可见类别，其边界态声明没有任何机械证据——一张合法
  的 PNG 就能结算掉 `covers: ['offline', 'error-path']`。这是审计层义务，不是
  机械义务。
- **无 pre-execute seam 时出站一律拒绝**（相对 v1 更严，是刻意的行为变更）：
  v1 的同步 guard 会消费一条已存在的 `owner-approve` 放行出站。v2 的 guard
  无法读取和校验出站清单，因此在 `enforcement.egress: 'guard-deny'` 下无条件
  拒绝所有出站命令类——即使 owner 已批准。native 通道（`tools/pre-execute` +
  `ctx.approval`）是唯一能放行出站的路径，`owner-approve` 的一次一批准语义在
  该通道内保留。
- **usage 工件结算读文件系统**，因此不在 fold 内：`applyEvent` 只校验结构性
  声明，结算在 `submitCloseout` 那一刻由引擎执行。代价是：一条已 completed 的
  旧流在工件被归档删除后仍能重放（这是要的），但重放**不**重新证明工件当时存在。
  证明发生在写入 completed 的那一次，且只发生那一次。
- **domain 后端的记录 schema 不是 zod**：上游把 `valueSchema` 类型标注为 zod
  `ZodType`，而 `zod` 不是本包依赖。`AUTOPILOT_DOMAIN_SPEC` 携带本地结构性
  `DomainRecordSchema`。这条偏离 2026-08-25 首轮真机验证已经**量到了**：真机上
  `facility.open(AUTOPILOT_DOMAIN_SPEC)` 39 次零失败（§8 探针 E），不再只是读
  上游源码推出来的——对声明了 tables 且无 `global` 的 spec，`DomainFacility.open`
  唯一调用的 schema 方法是 `valueSchema.parse(raw)`（storage-domain
  `parseRecord`）；`safeParse` 只在 `defineDomain` 的 global 可空性检查里出现，
  本 spec 无 global。若上游后续用到更多 zod 表面，修法是加依赖并换一个常量。
  原文的理由里还有半句“在离线环境无法安装”，那半句**未经证实且存疑**：实测
  `zod@4.4.3` 已经物化在本机那份 dsh 检出的 pnpm store 里，而本轮不允许跑安装
  命令，所以既没有证明能装、也没有证明装不上。该半句从理由里撤回，理由只保留
  “不是本包依赖”那一半。
- **usage 的类别与条目数全部自报**，没有任何一层能校验它诚实：
  `usageClass` 由声明者自己选，而不同类别的义务差了一个数量级——`gui` /
  `cli` / `api-behavior` 要 >=2 个边界态加 >=1 个工件，`internal` / `docs`
  什么都不要，`unsupported` 是自报的诚实终点（只要给出 `unsupportedReason`
  与非空 `attempted`）。把一个真正改了 GUI 的改动声明成 `internal`，整条
  声明合法通过，机械层看不到任何异常。同理，条目**数量**也是自报的：
  `autopilot_init` 的 `usageIds` 缺省只播种一个 `m1`，一次改了三处用户可见
  行为的 run 只要答完那一个条目就满足了全部规则。最外层的豁免也是自报的：
  `size: 'lightweight'` 直接让 init 不播种 usage（快照里**没有** `usage` 这个键；
  2026-08-25 真机 FIX 轮之前工具层会把它渲染成一个取值 `undefined` 的自有属性，
  那是 §8 的缺陷 1，已修），
  而那正是 legacy 流的免检形状——分诊字段本身没有任何机械对账。这三层都是
  「问题被机械地问了」，不是「答案被机械地验证了」；答案的真实性是审计层职责
  （与 Single-Bearer 规则同一条边界）。
- **domain 后端的默认可达性由 bundle 的行列表决定**，不由 profile 决定
  （2026-08-25 首轮真机验证改写；原文的两句话都被证伪）。没变的部分：
  `ctx.storageDomain` 由 web-app bundle 挂载（实测 2026-08-24，
  `packages/bundle/web-app/cordis.patch.yml`），而 `headless` bundle 的默认行列表
  （`packages/bundle/headless/cordis.patch.yml`）里没有 storage 那三行，所以在
  **不加覆盖**时 `storeKind: auto` 于 headless 上解析为 `file`。被证伪的是原文
  写的“**必然**解析为 `file`”与“domain 后端从未对上游真实 `DomainFacility` 跑过
  一次真机 run”：实测在 `autopilot-headless` 上用一条 `--patch` 覆盖补上那三行
  之后，`enforcement.store` 记 `"domain"`（`auto` 与严格 `domain` 同结果），
  `facility.open` 39 次零失败，事件与 run 记录由 dsh 自己写进
  `storages/dsh_autopilot.json`，跨进程 `load()` 重放回正确快照（§8 探针 E）；
  而 `--patch` 是 CLI 支持的组合路径，不是绕过。**仍然为真的上限**：两个后端的
  证据强度不对等——文件后端现在有完整的端到端记录（真机上跑到 `completed`，
  §8 本轮 (3)），domain 后端只被驱动到 `autopilot_init`，完整流程、结算、溢出守卫
  与损坏路径都没走到（§8.1）。domain 侧的结算尤其未测：它的事件在领域库里，而
  `log.md` 与 usage 工件仍在文件系统接缝上，这个组合从没被驱动过一次。
  **本轮关掉的那一半**：上一版此处记的竞速（`facility.open` 的异步 I/O 与会话创建
  抢跑，输了就整套 autopilot 工具静默缺席）**已修并复验**——`apply` 改成 async 并
  直接返回 disposer，宿主的 `loader.await()` 因此真的等到了 store；21 次 domain
  启动 21 次携带全部 11 个工具（§8 本轮 (8)）。它不再是本节的条目。
- **两个 profile 共用一个 run 根**、却可能用**两套权威介质**（2026-08-27 实测并按
  部署决策收口）。事实先摆出来：两个进程都把 run 根解析到
  `~/.dsh/storages/dsh-autopilot`，但 web profile 挂了 storage-domain，于是
  `storeKind: auto` 在那边选 domain、在 headless 那边选 file；本机当时的实测是
  **41 个文件 run 与 5 个 domain run 互相看不见**。这不是路由缺陷，是 `auto`
  的部署属性——但它对使用者是有害的，因为两边都自称"默认根"。
  **domain 后端不能当共享介质**，这一条是结构性的而不是偏好：它的 json 后端是
  open 时整体读入、写时整份重发布，两个 dsh 进程压在同一个 unit 上是互相**覆盖**
  而不是交错。文件后端相反——每个事件一行 append，投影 tmp+rename 发布，所以第二
  个进程读得安全。于是本包的 `cordis.patch.yml` 现在把 `storeKind: file` **钉在
  bundle 层**（profile 层仍可按 id 覆盖，这不是上限）。代码里 `auto` 的语义**没有
  改**：它仍然是"探测，并把实得后端如实记进 `enforcement.store`"，翻转一个 v2
  交付物的语义不在本轮范围内。
  同一轮修掉的第二半是**读路径**：`engine.current()` 按 run id 记忆化且没有任何
  失效条件，所以一个只负责服务的进程会把它第一次折叠到的那个 revision 永远端给
  GET。现在只读面（`ctx.autopilot` 及其之上的 web 路由）走
  `peekFresh`：先比对存储已发布的 revision，落后才重放。写路径**故意不变**——
  `peek` 仍是记忆化的那一个，否则 `transact` 里的校验会把另一个进程的写入吸进本
  进程的事务中间，把单写者设计变成 lost-update 竞态。新鲜度信号取
  `snapshot.json` 而不是 `events.jsonl` 的 mtime，是因为 commit 先 append 权威
  事件再 rename 投影，所以投影的 revision 一旦动了就意味着那次 append 已经完成；
  这正是读者可以不加锁重放的理由。
  **仍然未证明**：以上两条都只有单测承载（第二个 `RunStore` out-of-band 写入，
  见 AC1 的 bearer），真机上两个 profile 同时开着的验证属于 M7，不在本轮。
- **外部会签的 `treeHash` 是声明**，**不是验证**（2026-08-27 新增）。它与
  `triage.baseline` 属于**同一个信任等级**：本包 `src/` 里没有 `child_process`
  也没有 git，run 记录里根本没有工作树，所以引擎**无法测量**任何树哈希，存进去的
  永远是一个人打出来的字符串。能机械化的只有三件事，也只声称这三件：形状底线
  （7–64 位小写十六进制，缺省合法，非字符串拒绝——`/^[0-9a-f]{7,64}$/.test(1234567)`
  为真，所以那条 `typeof` 守卫是承重的）、空串按缺省处理（`autopilot_usage`
  那一类回归），以及**两个声明之间**的一致性：会签的 `treeHash` 与
  `triage.baseline.commit` 不一致时，在该次审计的 route 诊断上如实说出来。
  那条诊断**永远不是拒绝**，这是刻意的——run 在执行期间树本来就会动，execution
  角色的会签与 init 时的 baseline 不一致才是常态，在这上面设门禁会让这个字段恰好
  在最有信息量的地方不可用，也会把"两个未验证字符串的比较"包装成一种权威。
- **`ctx.autopilot` 不是 `class extends Service`**：注册走的是 `Service` 构造器
  本身唯一做的那一次调用（`ctx.reflect.provide(name, self, check)`），并按
  `Symbol.for('cordis.tracker')` 附上同样的 tracker 元数据；未复刻的是
  `[Service.resolveConfig]` 的 intercept 合并与 `[Service.filter]` 的 isolate
  检查。理由与代价写在 `src/service.ts` 头部。取舍理由是**服务类身份跨副本**
  这一条：`extends Service` 需要把 cordis 变成运行时 import，而第二份物理副本
  会给插件一个与宿主不同的类身份。原文把理由挂在 §1 的"唯一运行时依赖"上，
  而那句话本身是假的（见 §1 的改写），所以理由现在挂在幸存的那一条上。
  （2026-08-25 第六轮补做：上一轮宣称"理由现已改挂"时，只有 `src/config.ts`
  被改过，`src/service.ts` / `src/store/domain.ts` / `src/gate/preexecute.ts`
  三处仍在逐字断言被撤回的那句话——本节把理由委派给 `src/service.ts`，而该文件
  的理由 2 恰恰就是那句话，读者顺着 §6 的指针走会落到 §1 宣布为假的地方。
  三处已改写。）
- **`archiveConsumed` 与磁盘 artifact 读取器缺真机测试**：出站测试全部注入
  `archive` 桩。归档路径组成、目录创建参数、归档体、命令截断与同毫秒防碰撞
  （含"同一份 manifest 被同一条命令消费两次"这一例）已被证明；`node:fs` 上的
  真实写入没有。磁盘 artifact 读取器这一侧 2026-08-24 第五轮补齐了：
  `test/usage.test.ts` 现在写真实字节到临时 run 目录并**不注入** `readArtifact`，
  所以 UTF-8/latin1 往返解码走的是生产路径。两轮真机验证都没有改变
  `archiveConsumed` 这一半：真机上出站的正向派发方向一次都没走通（每次 `ask` 都
  因无应答者 fail-closed），所以它在真机上仍然零执行——2026-08-25 真机 FIX 轮复核，
  全机 36 个 run 目录下 `*outbound/consumed*` 命中 0 个归档，10 次 run 的
  `enforcement.outboundConsumed` 全为 0（§8.1）。
- **出站清单现在有一个 agent 可写的候选位置**，而**位置不授予任何权限**
  （2026-08-25 真机 FIX 轮新增；这是本轮唯一一处**放宽**，所以它的代价必须写在
  上限里而不是只写在变更记录里）。`manifestCandidates(runDir, {env, workspaceRoot})`
  的顺序是：owner 的 `DSH_AUTOPILOT_OUTBOUND_MANIFEST` 一旦设置就**独占**；否则
  `<runDir>/outbound/manifest.json` 在前、
  `<workspaceRoot>/.dsh-autopilot/outbound/manifest.json` 在后。加后者的原因是默认
  root 在 `$DSH_HOME` 下，通常落在会话的 workspace-write 根之外，于是**没有 owner
  介入就根本写不出一份清单**——门禁只剩拒绝一个方向，而"能被满足"是一条门禁能被
  观察到 fail 的前提。**为什么这不打开边界**：`validateManifest` 的每一条规则
  （live run id、新鲜度、逐段命令声明、工件严格落在 `runDir` 内、非空、covered 标签
  承载、计数短语一致）与字节从哪来无关；校验干净也只买到一次 owner 要答的 `ask`。
  被搬走的是**主张文书**，不是**证据**：工件 ref 仍然必须解析进 `runDir`，所以一个
  现在能写清单的 agent 仍然造不出承载它的工件。**留下的上限**：一，优先级是
  **先存在**而不是**先合法**——从一份 owner 放置但校验失败的清单掉到 agent 可写的
  位置会让后者静默覆盖前者，所以实现按"第一个存在的候选"停下，代价是 owner 放了一份
  坏清单时 agent 那份也不会被看；二，`manifestPath` 被重定义成"候选表的第一项"，
  于是"该写哪"与"会去哪找"不会漂移，但这条一致性只有一份实现在守，没有第二个 bearer；
  三，本轮真机只驱动过 workspace 候选与"两个候选都没有"两种情形，
  `DSH_AUTOPILOT_OUTBOUND_MANIFEST` 独占那一支仍然只有单测（§8.1）。
- **`resolveToolAllow` 让插件不再声称它不拥有的工具词表**，代价是名单仍是枚举的
  （2026-08-25 真机 FIX 轮新增，同轮修掉了它背后的三条真缺陷）。旧形状把
  `AUDITOR_TOOL_ALLOW` 与 `executor.toolAllowList` 原样交给 `tools.restrict()`，
  而 `restrict` 是全有或全无：名单里出现**一个**这个部署没注册的名字，整次派遣就
  抛错。真机上这条让每一次审计与每一个委派执行器都必死（§8 缺陷 2/3/4）。现在
  `resolveToolAllow(requested, registered, required, label)` 先按注册表过滤，被丢掉
  的名字进一条 `routeDiagnostic`（真机逐字：`tool surface narrowed for executor
  child: this deployment does not register "bash" (kept 9 of 10)`），并按**可互换
  能力家族**保底——同一家族里只要还剩一个注册名就不算能力缺失（真机上丢 `bash`、
  留 `pwsh`）。**留下的上限有三条**：一，家族表是**枚举**的，一个本可互换却不在表里
  的新工具会被当成独立能力，多记一次诊断（安全方向）；二，一个家族里**什么都没注册**
  时按 `AUDITOR_TOOL_REQUIRED` 的规则拒绝派遣，而这条拒绝路径与
  `parseRestrictRejection` 的"学一次已知名字再重试一次"恢复路径在真机上**一次都没
  进过**——本轮只观察到执行器那一支的收窄，审计者那一支两次都是 `routeStatus:
  verified` 且无诊断（§8.1）；三，诊断是**记录**不是门禁：一次被收窄的派遣照常执行，
  收窄的后果（子代理少了一个它本来会用的工具）由读记录的人判断，机械层不判。
- **依赖声明与 lockfile**（2026-08-25 按实测改写；原文说的"残留差异"经测量
  并不存在）：`@deepseek-ai/schemastery` 写入 peerDependencies + devDependencies。
  本机 lockfile 曾由一次非预期的 pnpm 自动安装补齐，那次动作访问了网络。
  事后逐项测量的血溅范围，记在这里以免被后来者按最坏情况重新想象一遍：
  lockfile 的 importers 与 package.json **逐条一致**（1 个 dependency、9 个
  devDependency，specifier 全对得上，无漂移）；事故窗口内进入 store 的包
  **是 0 个**——`node_modules/.pnpm` 下 74 个包目录全部仍是最初安装的时刻，
  窗口内唯一被写的是 pnpm 自己的 `.pnpm/lock.yaml`；补进去的两个 importer
  条目指向的包本来就在树里（`schemastery` 是 `@deepseek-ai/dsh-tools` 的**直接
  依赖**，`cordis` 是它的 peer）。所以那次动作的**结果是对的**，错的是一条看起来
  只读的命令不问自取地做了它——根因是 pnpm 的 `verify-deps-before-run` 默认为
  `install`。
  2026-08-27 做了**端到端证明**，结论与上一版**相反**，且上一版记的"实测"两半
  都是错的。
  这道闸本身是真的：在一个真正过期的沙箱里（package.json 里加一个 lockfile
  中没有的依赖，不安装），设成 `error` 时 `pnpm run <script>` 以
  `ERR_PNPM_VERIFY_DEPS_BEFORE_RUN` 拒绝、脚本一行都没跑；设成 `warn` 时打印
  out-of-sync 警告、脚本照常跑完、什么都没装（事后 lockfile 的 sha256 逐字节
  不变，`node_modules` 里没有新包）。负对照也做了：依赖同步的项目在 `error`
  下正常执行，所以拒绝来自过期而不是来自这个取值本身。
  被推翻的是**位置**：pnpm 11.17.0 **不从 `.npmrc` 读这个键**。同一个沙箱、同一份
  过期条件下，`.npmrc` 里写 `verify-deps-before-run=error` 时 pnpm 照样派生了
  `pnpm install`（栈帧 `runDepsStatusCheck` -> `runPnpmCli`，只是被强制离线拦住
  才没到 registry），而同样的值写进 `pnpm-workspace.yaml`（驼峰
  `verifyDepsBeforeRun: error`）就会拒绝。所以上一版记的"`pnpm-workspace.yaml`
  实测不认这个键、`.npmrc` 是正确位置"两句都反了；那次测试之所以什么也没测出来，
  是因为它用 `touch package.json` 构造过期——那根本不构成过期条件，于是两个位置
  同样是死的、看起来一样。**后果**：从 2026-08-25 到这次测量为止，本仓库对它自称
  已经装了闸的那次事故其实毫无防护。现在闸装在
  `pnpm-workspace.yaml`（`verifyDepsBeforeRun: warn`）。
  仍然**未证明**的一条，写清楚以免被读成更强的结论：这只证到"对一个人为制造的
  缺失依赖，检测与 refuse/warn 语义成立"，**没有**证到它会拦住 2026-08-25 那次
  事故——那次的过期成因不同（importer 条目指向树里本来就有的包，不是 lockfile
  缺包）。store 侧的"没装东西"是按文件计数与 pnpm 自己的 `downloaded 0` 记账
  测的，不是 store 内容哈希；也没有抓包，所以"没走网络"是推断不是测量。
  完整逐条记录在 `evidence/npmrc-probe.txt`（运行记录目录 goal-runs/ 已
  不入库，被文档引用的证据移入受跟踪的 evidence/）。
  代价也记着：`npx` 也读 `.npmrc` 而 npm 不认这个 pnpm 专属键，于是本项目里每条
  npx 命令都会多打一行 unknown-config 警告——而既然那一行现在已知是**无效**的，
  这行警告目前是纯成本。`.npmrc` 里那段自述与该行的清理**没有做**：写
  `.npmrc` 被本机的凭据文件保护规则拒绝（`credential file write blocked`），
  这是权限决定，不由执行方绕过，已作为待办交回所有者。
  `@deepseek-ai/cordis` 2026-08-24 第五轮从 peerDependencies 移除并只留
  devDependency：`src/` 里没有任何一处 import 它（插件触到的 ctx 表面全是结构性
  类型），而 peerDependency 是强加给每个使用者的要求，没有对应 import 的那种
  要求是没有理由的已发布表面。

## 7. 配置

```yaml
# profile 的 cordis.patch.yml 里按 id 覆盖
- id: autopilot
  config:
    auditProvider: spawn        # 一次性审计子代理传输 provider
    executorProvider: spawn     # continuable 执行器传输 provider
    auditors:                   # 按角色路由（跨家族评审的落点）
      plan:      { agentOptions: { provider: deepseek-official, model: deepseek-v4-pro, maxTokens: 32000 } }
      execution: { provider: spawn, agentOptions: { provider: deepseek-official, model: deepseek-v4-pro } }
      rules:     { }            # 缺省继承部署默认模型
    executor:
      agentOptions: { provider: deepseek-official, model: deepseek-v4-flash }
      persona: ''
      # run_terminal 不是任何 dsh 包定义的工具（它只存在于被本插件取代的 v1
      # tool-gah 里），2026-08-24 第五轮已从默认表移除；真实 PTY 表面是
      # terminal_open / terminal_send / terminal_read / terminal_signal /
      # terminal_close，**没有**被替换进来——那会给子代理一个它本来没有的能力。
      # 改动走的是另一个方向：门禁的 SHELL_TOOLS 扫描加上了 terminal_* 名字。
      toolAllowList: [read, glob, grep, read_image, write, edit, str_replace_editor, bash, pwsh, todo_write]
    crossFamily:                # 建造者家族 != 评审家族（策略，不是门禁）
      enabled: true
      minRisk: medium           # 到这个风险起，才去找家族不同的评审者
      pool:                     # 备选评审路由；从中挑一个不属于建造者家族的
        - { provider: openai-compatible, model: gpt-5.6-sol }
    gate:
      sandboxCoupling: true     # standard run init 钳 read-only，plan pass 恢复
      toolDeny: true            # plan gate 前、以及存在未声明 usage 条目时，拒绝 write/edit/str_replace_editor(非 view)
      egressDeny: true          # 出站边界总开关；关掉即 enforcement.egress: 'off'，两个 seam 都不拦
      stopReminder: true        # turn-stopping 提醒（上限 3 次）
      strictShell: false        # sandbox degraded 时 shell 是否拒绝
      restoreMode: workspace-write
    storeKind: auto             # auto：探测到 ctx.storageDomain 就用 domain，否则退回 file（退回是 auto 的语义，实得值记进 enforcement.store）
                                # file：恒用文件后端；domain：要求 ctx.storageDomain，探测不到就拒绝挂载（是要求不是偏好，静默给别的后端才是坏的）
    storeRoot: ''               # 缺省 $DSH_HOME/storages/dsh-autopilot
```

本包自己的 `cordis.patch.yml`（bundle 层）从 2026-08-27 起把 `storeKind: file`
**钉死**在插入行上：

```yaml
- insert:
    - id: autopilot
      name: dsh-autopilot
      config:
        storeKind: file
```

理由是部署事实而不是代码偏好，展开写在 §6 那条"两个 profile 共用一个 run 根"里：
`auto` 会让 web 与 headless 落到两套互不可见的权威介质，而 domain 后端的 json
存储是整份重发布、两个进程互相覆盖，所以它不能当共享介质。profile 层按 id 覆盖
这一行仍然有效——钉的是默认，不是上限。

`storeRoot` 与 `DSH_HOME` 的推导 2026-08-27 补上了 `~` 展开与 `resolve`，与 dsh
自己的 `resolveDshHome`（`resolve(expandHomePath(x))`）逐字对齐。此前本包读的是
原始 `DSH_HOME`：在把它写成 `~/.dsh` 的机器上（dsh 本身接受这种写法），宿主解析
到真实家目录而本插件解析到进程 cwd 旁边一个字面量 `~` 目录，两边都自称"默认根"
却写在不同的树里。

按角色的 `provider` 覆盖 `auditProvider`，`request.provider`（`autopilot_audit`
的入参）再覆盖它——三级优先级：调用参数 > 角色配置 > 全局默认。

三个环境变量不走 profile 配置，属于 owner 通道：`DSH_AUTOPILOT_HOME` 覆盖
store 根目录的默认推导（非空的 `storeRoot` 仍然优先于它），`DSH_HOME` 决定默认根，
`DSH_AUTOPILOT_OUTBOUND_MANIFEST` 把出站清单路径钉到别处（相对路径按进程 cwd
解析而**不**按 run 目录重挂——会跟着 run 走的覆盖不叫覆盖）。

`egressDeny` 在 v2 的语义要说清楚，它不再是「需不需要 owner 批准」这个二选一：
出站的实际执行面由**探测结果**决定，配置只提供总开关。`resolveEgressChannel`
的三个值——`native-ask`（pre-execute seam 装上了，guard 让位给 seam）、
`guard-deny`（seam 没装上，同步 guard 无条件拒绝全部出站命令类）、
`off`（`egressDeny: false`）——按 root 逐个解析并记进 `enforcement.egress`。
把 `egressDeny` 设成 `false` 是关掉整条边界，不是放宽它。

配置有了真正的 Schemastery `Config` 导出（`src/config.ts`）：cordis 通过
`runtime.Config['~standard'].validate(config)` 校验，profile 里写错的键会被
loader 当场拒绝并点名，而不是静默落回默认值。`resolveConfig` 保留，负责引擎侧的
读取默认值——schema 管"能写什么"，`resolveConfig` 管"读到什么"。

两条实测约束写在这里，因为它们是这个 schema 能不能兑现上一句话的前提：

1. **未知键必须显式拒绝**。schemastery 的 object resolver 结尾是
   `if (!strict) merge(result, data)`，即未声明的属性被原样带过、不报 issue，
   而 `strict` 从公开 builder API 到不了。所以已声明键面在 `CONFIG_KEY_SPEC`
   里写一份，由 `Schema.intersect([ConfigShape, UnknownKeyGuard])` 强制——
   `intersect` 用 strict 模式解析各成员，因此 guard 拿到的是原始 fragment，
   这是未声明键唯一还看得见的地方。顶层与嵌套（如 `gate.egresDeny`）都覆盖。
2. **schema 的默认值与 `resolveConfig` 的兜底必须是同一份常量**。
   `Schema.array(Schema.string())` 的默认值是 `[]`，而 `[]` 不是 nullish，
   于是 `?? DEFAULT_EXECUTOR_TOOLS` 在 loader 路径上永远不触发——2026-08-24
   第四轮审计实测：真实部署里每个委派执行器子代理的 toolFilter 只剩
   `['autopilot_submit_packet']`，委派执行模式实际不可用。修法是
   `DEFAULT_EXECUTOR_TOOLS` 移到 `src/config.ts` 由两侧共同引用，并加了一条
   走 `Config['~standard'].validate(...)` → `resolveConfig(...)` 的 loader
   路径用例（此前全部用例都走手写对象，正是缺陷藏身的那条分岔）。

`storeKind: auto` 的异步挂载问题按"不可能脑裂"解：`apply()` 同步而
`DomainRunStore.open()` 异步，所以整套表面（工具、guard、pre-execute seam、
policy 段、服务）都注册在**同一个** async `ctx.effect` 体内（cordis 的 `Effect`
接受 `Promise<Disposable>`）。store 解析完成之前根本不存在 `autopilot_init`，
因此没有任何 run 能落在一个即将被替换掉的后端上；每次挂载只存在一个 store 实例。

角色化 `agentOptions` 天然支持 CC 的"建造者家族 ≠ 评审家族"矩阵：执行器与审计者
可以各配不同 provider/model；路由出处（verified/unverified）记录在每条审计与
执行器记录里。

## 8. 验证记录

**当前回归基线**：`pnpm run check` 无输出退出 0；`pnpm run test` 全绿，测试文件
数 >= 24，用例数 >= 820（下限最近一次实测复核：2026-08-27 v2.1 轮轮询键修复后，
24 文件 / 826 用例全绿）。`check` 现在跑两个 tsconfig：`tsconfig.json --noEmit`
（`src/`，会 emit 的那份配置）加 `tsconfig.test.json`（`src/` + `test/`，只
typecheck）。第二份 2026-08-24 第五轮新增——此前 `tsconfig.json` 的 `exclude`
含 `test`，而 vitest 走 esbuild 转译不做类型检查，于是两道门同时对约 3000 行
测试树失明，盲区里正躺着两个真的 TS2540。这里刻意只写下限而不写"当前是多少"：一个精确计数
在下一次加用例时就变成假话，而仓库里没有任何东西能观察到它已经变假——那正是
Moving-Anchor 不变量禁止的锚（也正是 `src/outbound/manifest.ts` 头部记的
陈旧 "83/83" 事故的形状）。**当前态的权威计数是 `pnpm run test` 的输出本身**。
本节其余条目为历史轮次记录，各自的计数钉在该轮时点，不代表现状
（Statement-Artifact Sync：历史计数随轮次留档）。

**读本节之前先读 §5 末尾那两条**：第一条讲的是第五轮到第七轮的每一条记录都建立在
一个从未被检验的环境前提上（“本环境没有 dsh 运行时”），该前提 2026-08-25 被证伪，
推翻它的是本节倒数第一条轮次记录（“v2 首轮真机验证”）；第二条讲的是那一轮登记的
八条“高”缺陷为什么能与 556 用例全绿共存——它们不是被弱断言放过的，是被**停在 mock
边界**的测试整片漏掉的，本节第一条就是修掉它们的那一轮。历史条目的技术结论不因此
作废，但凡是以“无法在真机测量”为理由下的判断，都必须按后两轮重读。本节按时间倒序；
每条轮次条目内部的“本轮”一律指该条目自己的那一轮，只有第一条是当前轮，历史条目里
残留的“上一轮”同理按写入时点读。

- **dsh 0.1.2-rc.1 升级轮**（2026-09-04，inline 执行，side-by-side 宿主）：把五个
  dsh 钉版从 `0.1.1-rc.2` 升到 `0.1.2-rc.1`（cordis 4.0.2、schemastery 3.18.2、新增
  devDependency `dsh-util-values`），并在本机一棵**并存**的 rc.1 源码 checkout
  （`~/dsh-0.1.2-rc.1`，tag `dsh-v0.1.2-rc.1` = a66e470，`pnpm install && pnpm run build`
  约 3 分钟，corepack 按树内 `packageManager` 切到 pnpm 11.7.0）上真机验证；`~/dsh`
  （0.1.1-rc.2）与 owner 的 `web`/`default` profile 不动（owner 裁决：web profile 链着
  rc.1 已不存在的 `experimental/gah`）。
  **本轮结束时实测**：`pnpm run check` 退出 0；`pnpm run test` 27 文件 / 973 用例全绿
  （新增 `test/host-types.test.ts`）；`DSH_SRC`/`DSH_STORE` 指向 rc.1 树时
  `check:client`、`build`、`test:client-bundle` A1–A18 全绿，A10 外部依赖恰为
  `['react','react/jsx-runtime']`。
  **社区卡片命中的两处**（oh-my-dsh 升级卡片，作为不可信线索、逐条对着打包的 rc.1
  `.d.ts` 核过）：(1) `Session.events` 删除 → 两处读点改 `snapshotEvents()`，结构镜像
  拆成 `SessionReadRef`（真 `Session` 可赋值，`tsc` 承载）+ `SessionRef`（只多一个
  `append('sandbox/mode')`，因该事件类型由 `dsh-sandbox-policy` 合并进 map、本包类型宇宙里
  证不到）；探测：把 `events` 加回镜像 → tsc 5 红（`host-types.test.ts` 三处赋值各一条
  TS2741，加 `test/helpers.ts` 两条假 Session 不再满足镜像；`evidence/host-types.txt`）。
  (2) `dsh-client-runtime` 拆除 → `ClientContext` 取 cordis `Context`，
  `ConversationNodeDefinition` 取 ui-conversation，`isAppendSurfaceEvent` 改用本地镜像作
  **唯一**实现（dsh-session 无浏览器入口）。
  **卡片没收录、真机首启才暴露的两处**：(3) `ctx.subagents.registerContinuableSetup`
  不存在（headless 首启 `plugin tree failed to load`）→ 子代理作用域改在 `agent/created`
  安装；(4) 客户端 `inject` 的 `conversationEvents` 服务不存在（web 首启
  `pending (waiting for service: conversationEvents)`）→ `uiConversation.events`。
  两处都说明：卡片是策展物不是 API diff，真机冷启动是不可替代的一层。
  **A1-08 路由鉴权**：rc.1 的 `webServer.register` 不鉴权；两条 `/api/autopilot/*` 路由
  现在每请求套 `connection.requestRejection`，fail-closed 503；裸 curl 401 / 已认证页面内
  fetch 200 均实测。
  **真机三臂**：headless（新 CLI）一条真实回合 `autopilot_init` → `owner-approve`
  → `autopilot_status`，人类回合上的 approve 被**接受**（`ownerApprovals[0].target =
  "git push"`，这一条要求 rc.1 上 `snapshotEvents()` 真的暴露了 `turn/start` 与
  `user/message{source.kind:'user'}`），init 事件盖 `bearerBase`；web（新 CLI）
  `__DSH_BOOT__.entries` 含 `dsh-autopilot`，运行卡片对该 headless 会话渲染出
  "Autopilot run planning revision 2 …"，录屏 `evidence/host-web.webm`；旧流重放：
  51 个 0.1.1-rc.2 时代的 run 目录经 rc.1 构建的 `lib/store/file.js` 全部折叠、0 错误
  （`evidence/legacy-replay.txt`），加上 web 端对一个 2026-08-28 的旧 run 的 GET 200。
  **共享 node_modules 的翻转**（§6 新条目）：新 CLI 真实启动后 223/226 链接指向 rc.1 树，
  旧 CLI `--dump-config` 一次即翻回 197 条指向 `~/dsh`（29 条 rc.1 独有包保留指向新树）。
  **本轮未做 / 未在 rc.1 真机观测**（截至 a545a51）：执行器子代理经 `agent/created`
  安装的端到端路径（本轮 smoke 是 inline + lightweight）——这一条已在 §8.3 的整改轮
  用真机委派 run 补测，安装契约也在那一轮改成事务化、fail-closed；同一轮 standard run
  顺带走到了 rc.1 上 `sandbox/mode` 的 append 与 `effectiveSandboxMode(snapshotEvents())`
  路径（run-events 里 `enforcement.modeAppended: true`、`priorSandboxMode`）。仍未做：
  旧流的 `migrate-domain-runs` 路径、domain 后端、并发执行器、`//` base 残留（run 2）。R-11 漂移只处理了本包碰到的两个
  （`CallId`→`ToolCallId`、`snapshotJsonValue`→`dsh-util-values`）。
- **v2.1 轮**（2026-08-27，delegated 执行）：主题是把三条已知但没人动过的
  边界收掉——卡片的实时缺口、存储的后端分叉、外部会签说不清"读的是哪棵树"——外加
  两条工程面（.npmrc 那道闸的端到端证明、变异测试与 CI）。
  **本轮结束时实测**：`npx tsc -p tsconfig.json --noEmit`、
  `npx tsc -p tsconfig.test.json`、`npx tsc -p tsconfig.client.json --noEmit`
  三者均无输出退出 0；`npx vitest run` 24 文件 / 826 用例全绿；
  `npx tsc -p tsconfig.json` 出 lib/ 成功；客户端两半（`tsc -p
  tsconfig.client.json` + `wrap-client.mjs`）出 `lib/client.js` 成功，
  `run-bundle.mjs` 19 条断言全绿（原 18，新增 A18：PTC 会话经出厂
  产物渲染出卡片）。用例数从 739 增至 826，测试文件从 23 增至 24
  （新增 `test/migrate.test.ts`）。

  (1) **卡片的实时缺口**。此前卡片对**本会话的工具流量**已经是实时的（每一条
  `autopilot_*` 的 call/result 都会经装配器折叠重渲染），缺的是**没有工具调用**的
  那一档：headless 在跑、浏览器在看。卡片自己的 `stale` 徽标标的正是这个缺口。
  现在卡片在非终态时轮询 `/api/autopilot/run?id=`（间隔 >= 2s，`stale` 只**加速**
  到 2s 而不是当门禁——这条是审计意见吸收的：`stale` 由会话日志算出，会话日志没有
  新事件时它可能**永远不翻**，拿它当门禁等于"只在已经知道自己落后时才去问"）。
  fetch 失败一律静默退回折叠态：浏览器没有自己的 autopilot 状态可退，唯一诚实的
  失败行为就是继续显示会话日志重建出来的那一份——它只会旧，不会错。
  轮询到的值在卡片上**标为 live**，并且 `Observed.seq` 对它们**缺省**：路由的回答
  没有会话序号，编一个（0 或"最后一次的 seq"）就是把宿主路由的答案记到一个从未
  发生过的事件上。顺带修掉一条效率缺陷：`match()` 必然认领**每一条**
  append-surface `tool/result`（信封里没有工具名，只有 `applyResult` 能按 callId
  判别），而 `buildViewNode` 从前每次都新分配一个节点字面量，宿主按引用比较贡献，
  于是任何一个外部工具的结果都会重渲染卡片。现在状态与位置输入都没变时返回**同一个
  节点对象**；位置也进 key，因为 `state.firstLocation` 缺省时会回退到
  `context.start?.location`（审计意见吸收）。
  **本轮没有证到的**：真机上浏览器里看着卡片自己往前走这件事一次都没被观察到——
  §8.1 里那条残余**仍然挂着**，本轮只是把机制建起来并用单测承载，观察属于 M7。

  (2) **存储分叉与读路径陈旧**。见 §6 新增的那条：`storeKind: file` 钉在 bundle
  层，只读面改走 `peekFresh`（比对已发布 revision 再重放，写路径故意不变），
  `defaultStoreRoot` 补上 `~` 展开与 `resolve`。另出一个**按需**的一次性导出脚本
  `src/tools/migrate-domain-runs.ts`（缺省 dry-run，只新建文件、从不删除 domain
  记录、已存在的 run 一律跳过而不合并、不过 strict fold 的流跳过并如实报告）。
  真机 dry-run 实测：本机 5 个 domain run 全部可导出且折叠干净。**没有执行
  `--apply`**——那是写用户 live 的 `~/.dsh`，属于所有者决定，命令写在交付包里。

  (3) **外部会签的 treeHash**。见 §6 那条。工具层新增可选入参、空串按缺省丢弃、
  单一构造点（`engine.ts` 的 `recordExternalAudit`）trim+小写后写入一次、
  形状校验落在 `validateExternalReview` 上因而**重放路径也校验**、不一致只进
  route 诊断不设门禁。`test/external.test.ts` 里 `toEqual(REVIEW)` 那条继续承载
  "不传就真的不写"。

  (4) **.npmrc 那道闸**：见 §6。结论与上一版**相反**——闸是真的，但装错了地方，
  `.npmrc` 里那一行 pnpm 根本不读。已改挂到 `pnpm-workspace.yaml`。

  (5) **变异测试与 CI**。Stryker 10 + vitest runner，作用域限定 `src/domain`
  （纯核心；那里活下来的变异体说的是规则本身，不是接线）。**本轮实测**（在所有
  源码改动结束、门禁全绿之后重跑，因此描述的是提交出去的那棵树）：1119 个变异体，
  杀死 919、超时 4、存活 172、无覆盖 24、错误 0，总分 82.48%，耗时 3 分 09 秒。
  AC 要的是 `killed > 0` 而不是分数，理由在于一次**什么都没杀死**的运行无法区分
  "测试很强"与"runner 根本没跑起来"——本轮第一次尝试正是后者（pnpm 的 symlink
  布局让 Stryker 的默认插件发现失败，0 个变异体被测，报错文案读起来却像
  vitest 3 不兼容）。存活的 172 条**如实记录**、**不去追杀**：其中 84 条是
  StringLiteral（把诊断文案替换成空串，测试断言的是结构与错误码而不是措辞），
  真正读起来像缺口的是 61 条左右的条件/相等类。逐条在
  `evidence/stryker-run.txt`。**不接进** `check`，**也不接进** CI。
  CI 只覆盖宿主那一半（两道 tsc、vitest、`build:host`）；客户端那一半**装不进
  CI**，因为 `tsconfig.client.json` 的 `paths` 经 `${DSH_SRC}` 记号指向一份
  本地 dsh 源码 checkout（`check-client-types.mjs` 展开记号、校验存在、生成
  gitignored 的 `tsconfig.client.local.json` 再交给 tsc——记号化是脱敏 PR 的
  评审逼出来的：字面量路径把开发者身份写进了每份树。变量名特意**不是**
  `DSH_HOME`：那是 dsh 运行时数据目录（`~/.dsh`）的既有变量，本插件的
  store 解析链就在读它——同一条评审抓的撞名，设了正常安装值会打破类型门，
  反向迁就则会重定向运行状态），而 react 与客户端类型
  （dsh 0.1.2 起是 `@deepseek-ai/dsh-client-ui-conversation/client` 的 `.d.ts`；
  0.1.1 时是已被上游拆掉的 `dsh-client-runtime`）
  是宿主提供、故意不做依赖的，runner 上不存在对应 checkout，
  `check-client-types.mjs` 按设计退出 1。workflow 里逐条写明了它因此
  **永远不检查**什么，而不是用 `continue-on-error` 把洞盖住——一个因为没跑而变绿的
  步骤，比一个不存在的步骤更坏。
  顺带修掉一条**跨里程碑**的真实缺陷：Stryker 的 sandbox 是整个项目（含
  `node_modules`）的拷贝，而 `scripts/wrap-client.mjs` 会把 `build/` 下**每一个**
  `.js` 收进客户端 bundle 的模块表。把 Stryker 的临时目录放在 `build/` 下时实测：
  打包器报 **12518 个模块**（正常是 4 个），产物 1.4 MB，里面还嵌了一份
  `lib/client.js`——它自己那句 `window.__ModuleLoader__.load(...)` 会被第二次注册。
  已双向修好：Stryker 改写到 `.stryker/`，`collect()` 同时跳过 `node_modules` 与
  点开头目录（`tsc` 的产物两者都不会有，所以没有任何合法输入被丢掉）。

  (6) M7 真机验证抓到一条**本轮单测不可能抓到的缺陷**：PTC 模式下**卡片完全不显示**。
  这台 host 的驱动模型跑在 PTC（programmatic tool calling）下：模型不直接调
  `autopilot_*`，而是调 `run_code`，由代码体去调 `tools.autopilot_init(...)`。
  于是会话日志里的 `tool/call` 的 `name` 是 `"run_code"`——`readCall` 按规则拒绝
  它，**完全正确**——而真正的工具名只出现在 `tool/code-dispatch-start` 与
  `tool/code-dispatch` 上。后果是 `match()` 一条都不认领、`state.firstSeq` 恒为
  undefined、`buildViewNode` 返回 null：真机实测 session-32d85066 跑了
  `autopilot_init` + `autopilot_submit_plan`，页面上**没有卡片**、**也没有 JSON 兜底**，
  刷新后 `[data-autopilot-run-card]` 依然不存在。
  **缺陷类是"事件面被钉死在一种信封上"**：卡片的整个证据面假设了工具调用只有一种
  记法，而宿主有第二种，两者都在 `KNOWN_SESSION_EVENT_TYPES` 里。它能活过一整轮
  是因为**所有** bearer 喂的都是直接调用的信封——这正是 Single-Bearer 规则要防的
  形状，只不过这次缺的不是第二个 bearer，而是第二种**输入**。所以新用例一律用真机
  抓下来的原始事件（`test/fixtures/card/ptc.json`，9 条逐字切片，其中 8 条在写入前
  已与该会话自己的 `session.jsonl.zstd` 逐字节校验过），不用任何合成夹具。
  两处细节是承重的，都按真实载荷读出来而不是猜的：`code-dispatch-start` 的
  `arguments` **已经是解析好的对象**（对它调 `safeJsonObject` 会得到 undefined，
  整个 triage 块会被静默丢掉），身份要取 `subCallId` 而**不是** `rootCallId`
  （一次 `run_code` 可以派发多个工具，兄弟派发共享 root）。`tool/code-dispatch`
  确实**携带返回值**，在 `data.content[0].text`，比直接路径的
  `message.content[0].content[0].text` 浅一层。PTC 下那条包装用的 `tool/result`
  带的是 root callId，因此天然落不进以 subCallId 为键的 pending 表，一次逻辑调用
  不会被计两次——这一条有单独用例承载。
  两个信封族**共用同一个 fold**（在读取处归一化），不是各写一份：第二份副本只能靠
  测试维持一致，而这条缺陷的成因恰恰是一条没有 bearer 的路径。

  (7) 同一缺陷种系的**第二次发作**：**门禁键在一个通道给不出的信号上**。 第一次是
  plan 审计在上线前抓到的——把轮询门禁挂在 `stale` 上，而 `stale` 由会话日志算出，
  日志没有新事件时它可能永远不翻。第二次是 M7 在真机上抓到的：修好 PTC 之后卡片
  能挂了，但**实时那一半仍然是死的**，因为门禁改挂在 `data.runId` 上，而引擎的
  精简工具结果**根本不带 `runId`**（实测该会话的 init 完成文本就是
  `{"revision":1,"phase":"planning","enforcement":{…}}`）。于是 fold 报"run id not
  reported"、`shouldPoll` 恒为 false、轮询一次都没启动，out-of-band 把存储从
  revision 2 推到 3 之后 15 秒仍未被取到，`live` 属性始终不出现。
  **两次是同一种错误**：门禁挂在一个**证据通道并不保证提供**的字段上；两次都不是
  逻辑写错，而是把"可得性"当成了理所当然。
  修法分两半，且**两半的性质不同**，不要混为一谈：
  - **承重的一半**是卡片改用**会话 id** 作为兜底轮询键。这条是**构造上成立**而不是
    启发式：`engine.ts` 在 init 时绑 `runId: root.id`，即一条 run 的 id **就是**它
    根会话的 id；卡片渲染在该会话自己的视图里，而 `conversation.chat.node` 声明为
    `scope: 'session'`，作用域槽渲染器对每个会话作用域条目都写
    `standard['sessionId'] = info.sessionId` 再 `<Comp {...kit} …/>`——也就是说这个
    prop 一直都在传，只是卡片从来没有声明过它。所以接线量为零：不动 `index.ts`、
    不加 inject、没有需要与宿主保持同步的东西。会话里没有 run 时路由回 404，
    `fetchLiveRun` 把它变成 undefined，安静退回折叠态；子会话（执行器/审计者）同理
    问一次、拿不到、继续安静。fold 报了 runId 时**仍然优先用 fold 的**。
  - **自描述的一半**是让引擎的精简结果带上 `runId`（实测 13 处 `runId:
    snapshot.runId`——12 个返回点加执行器那个 helper；此处原写 11+1，r3 复审
    逐一数过后按测量值改正），这样**以后**的会话日志能自己说清它讲的是哪条 run，fold 的
    "run id not reported" 从常态变成罕见。trim 哲学没有改：仍然是窄投影而**不是**
    整个快照，只是多一个标识字段——一份说不清自己在讲什么的记录不是更小的记录，
    是更含糊的记录。读取侧同步放宽：`runId` 现在从**任何**结果里读，而不再只从
    `autopilot_status` 读，否则宿主这一半对卡片不可见。
  **诚实注记**：本轮之前记下的会话日志**永远**不会自描述——它们的字节已经写死了。
  覆盖它们的正是会话 id 兜底那一半，这也是为什么兜底是承重的、而自描述只是让未来
  变好。用例上，`test/fixtures/card/ptc.json` 正好**就是**那个没有 runId 的真实
  会话（它在引擎带 runId 之前被抓下来），所以这条兜底的 bearer 用的是真机数据而
  不是构造出来的场景。

  **本轮登记为缺陷或未证明的**：真机与浏览器验证（M7）整体未做，因此 (1) 的实时
  更新、(2) 的跨 profile 可见性都只有单测；`.npmrc` 里那段已知为假的自述**没能
  清理**（写该文件被本机凭据保护规则拒绝，已交回所有者）；CI 的 workflow **从未
  执行过**（本地只用 PyYAML 验了语法，没有任何东西拿它对过 GitHub 的 Actions
  schema），绿灯只能在 push 之后才谈得上，本轮不预先声称。

  **追记**（push 之后实测；上面那句**从未执行过**按写入时点原样保留）：CI
  首次在 GitHub（Linux）上跑，826 条里红了**恰好一条**：
  `test/outbound.test.ts` 的"resolves a path whose TAIL does not exist yet"。
  红的是**测试**，不是产品代码：`sandboxWritableRoots` 里的 `'/tmp'` 是
  **硬编码**的（它正确地镜像了上游），而夹具建在 `tmpdir()` 下；
  Linux 上 `tmpdir()` 就是 `/tmp`，于是 `join(real, '..', 'outside.json')`
  落回 `/tmp` 这个**本来就可写**的根里，实现返回 `true` 是对的。
  测试里那个 `'/other-tmp'` 只能换掉 `tmp` **参数**，换不掉硬编码的
  `'/tmp'`——那是上游镜像，不是旋钮。所以这条断言一直**只在 Windows 上
  有意义**，而没人能观察到这件事。同一陷阱还让另一条（"canonicalizes
  THROUGH a link"）在 Linux 上变成**恒真的正断言**：即使祖先遍历完全坏掉，
  它也会因为 `/tmp` 本身可写而通过。两条已一并改掉：夹具搬到仓库工作
  目录下（`.test-tmp/`，已 gitignore），并新增一条**前置断言**把"夹具不在任何
  可写根里"从**假设**变成**被检查的事实**——否则这类失效只会在换了个
  平台之后静静地回来。本机复现过该失败（Windows 上 `resolve('/tmp')` 是
  `C:\tmp`，把夹具放进去就能一模一样复现），并验证新的前置断言在那个
  位置下会**大声失败**而不是静默通过。修复推上去之后的第二次 CI
  （run 33043948462）**全绿**，39s——这条追记到此为止，后续 CI 结果由
  GitHub 的运行页自己承载，文档不再逐次转录。

- **v2 真机 FIX 轮**（2026-08-25，上一轮）：上一轮登记的 12 条缺陷，本轮修掉 7 条并
  在真机上逐条复验，1 条（缺陷 8，approval 标签）**收窄但没关掉**，2 条在源码里
  确认**仍然活着**并按下面同等篇幅登记，其余按事实转入 §8.1 或 §6。与上一轮相反，
  本轮**动了 `src/` 与 `test/`**：六名执行者各占一个不相交的写域，第七名不写代码、
  只在真机上独立重驱动并出题。
  **本轮结束时实测**：`npx tsc -p tsconfig.json --noEmit` 无输出退出 0；
  `npx tsc -p tsconfig.test.json --noEmit` 无输出退出 0；`npx vitest run`
  19 文件 / 648 用例全绿（2.45s）；`npx tsc -p tsconfig.json` 出 lib/ 成功。
  用例数 556 增至 648，测试文件 18 增至 19（新增 `test/boundary.test.ts`，方法层的
  意义写在 §5 末尾）。复验驱动的是**本轮新出的那份 `lib/`**——
  `C:\Users\<user>\.dsh\profiles\autopilot-headless\package.json` 里
  `"dsh-autopilot": "link:<本仓库绝对路径>"`，所以每一次 run 加载的就是刚
  emit 的产物；11 次真机 run 加一次 21 连启动循环，全部工件写在 scratch 目录，
  本仓库与 `C:\Users\<user>\.dsh` 均未被手改。

  **修掉并复验的七条**（每条给出上一轮的症状、修法要害、以及本轮的逐字观察）：

  (1) **缺陷 1**，工具输出无损 JSON——已修并复验。要害不是给 `usage` 一个默认值，
  是**缺席时不产出这个键**：dsh 的 `walkJsonValue` 遍历每一个自有可枚举字符串键，
  `undefined` 不匹配任何一支、于是整个返回值被判非无损，而**没有这个键**从不被
  访问；`JSON.stringify` 分不出这两者，校验器分得出。实测 lightweight
  `autopilot_init` 逐字返回
  `{"revision":1,"phase":"planning","enforcement":{"sandbox":"off","reminders":0,"ownerApprovals":[],"store":"file","approval":"signal-only","egress":"native-ask","service":"registered","outboundConsumed":0}}`，
  `isError:false`。持久层的确认更硬：`runs\session-84174f80-…\events.jsonl` 第一行
  解析后 `'usage' in snapshot` 为 **False**，即键是省略而不是取值 undefined。
  同一条 session 里的反向对照证明工具没有因此变松：一次填错枚举的调用仍然逐字返回
  `Error: invalid arguments: "executionMode" must be one of ["inline","delegated"]`。

  (2) **缺陷 2**，`AUDITOR_TOOL_ALLOW` 里的 `ask_user_question`——已修并复验。
  修法是**删除**而不是收窄，两条各自独立的理由：它在 headless 上根本不注册
  （住在 `packages/interaction/tool-ask-user`），而审计者是 `maxDepth: 1` 的一次性
  子代理、带结构化输出 schema，**没有任何一个交互回合能让答案回来**——那是一条
  派遣形状本身用不上的能力，在任何 profile 上都一样。实测：stock
  `autopilot-headless`、**不带 `--patch`**，`autopilot_audit role=plan` 逐字返回
  `{"verdict":"pass","note":"The plan is complete and directly satisfies the objective…","auditorId":"134803a3-992e-4016-a01f-3a2efa6c452a","route":{"provider":"spawn","routeProvider":"ehh","routeModel":"gpt-5.6-sol","routeStatus":"verified"}}`。
  该 run 两条 audit RouteRecord 都是 `routeStatus: "verified"` 且**没有**
  `routeDiagnostic`，即这个 allow list 在本 profile 上一个名字都不用被砍。

  (3) **一次 standard run 第一次在真机上跑到 `completed`**（关掉 §8.1 的第二条）。
  session-d55ac1cd-… 的持久 op 轨迹逐条为：init(rev1) → declare-usage(2) →
  submit-plan(3) → audit(4，phase `plan-reviewing`) → audit(5，planGate **pass**，
  phase `executing`) → log(6) → submit-evidence(7，`execution-reviewing`) →
  audit(8，execGate **pass**，`closing`) → submit-closeout(9，phase
  **completed**）。落盘交付物 `m7-p2.txt`，16 字节，内容 `STANDARD-OK-M7P2`。
  另有两次独立复现：session-61a05524（委派，13 op）与 session-2e3dbdf4（带工件，
  11 op）同样到达 `completed`，两道门都 pass。在本轮之前，**没有任何一次 v2 run
  在真机上到达过 `completed`**。

  (4) **缺陷 3 与缺陷 4**，执行器的 allow list——已修并复验，同时**订正了上一轮
  对机制的读法**。上一轮把病因记成次序（`applyChildComposition` 先 `restrict`
  后跑 setup 回调）。次序为真，但**不是全部理由**：执行者直接对真 `ToolRuntime`
  做了对照——**先**把 `autopilot_submit_packet` 注册进子作用域自己那一层、**再**
  restrict，依然被拒，因为 `view()` 构造 `restrictableNames` 时显式跳过本层
  （`if (layer === own) continue`）。也就是说，一个作用域自己注册的名字**永远**
  不在可 restrict 词表里，与谁先谁后无关。修法因此是让插件不再声称一份它不拥有的
  词表：`autopilot_submit_packet` 从 allow list 里删掉，子代理照旧拿得到它——靠的是
  上游的本层豁免（`admits()` 过滤之后再并入本层注册，上游注释写着这条豁免存在是
  为了"一份点名子代理可用能力的过滤器，不该把它用来回话的机械本身剥掉"）。实测子
  作用域 restrict 之后可见集为 `['autopilot_submit_packet','pwsh','read']`。
  `bash` 那一半走的是新的 `resolveToolAllow(requested, registered, required, label)`：
  请求里没注册的名字被丢掉并记一条诊断，而不是让整次 restrict 全有或全无地炸掉。
  真机 rev7 的 RouteRecord 逐字带
  `tool surface narrowed for executor child: this deployment does not register "bash" (kept 9 of 10)`
  ——按家族保留的规则在真机上原样触发（丢 `bash`，留 `pwsh`）。

  (5) **委派执行器第一次在真机上端到端跑通**（关掉 §8.1 的头条，也关掉 §6 那条
  "整套委派表面跑不起来"的上限）。session-61a05524-… 的持久轨迹：start-executor
  rev6 `state: "starting"` → rev7 `state: "running"` → **submit-packet rev10** →
  executor `state: "completed"` rev12 → submit-closeout rev13 phase
  `completed`。子代理真的收到了那个私有工具，证据不是推断而是子会话请求头：
  childId `8378f240-032c-478d-84f5-3631fe6096fa`（与执行器记录上的 childId 逐字
  相同）的工具表为
  `['autopilot_submit_packet','edit','glob','grep','pwsh','read','read_image','report','str_replace_editor','todo_write','write']`
  ——packet 工具在，`bash` 不在。全机普查：`runs/` 下 36 个目录里**有且仅有一条
  `submit-packet` 事件**，就是这一条；执行器状态普查为 session-538ea46a
  `['revoked','starting']`、session-2709649d `['revoked','starting']`（两条都是
  修复前的），session-61a05524 `['completed','running','starting']`。交付物
  `m7-p3.txt`，17 字节，`DELEGATED-OK-M7P3`。

  (6) **缺陷 5**，空 `inheritedFrom`——已修并复验，病因是**两处规则不对称**而不是
  少一条规则。`settleArtifact` 早就读 `(artifact.inheritedFrom ?? '').trim()` 并把
  空串当作缺席；`validateUsageEntry` 却按 `!== undefined` 判定。空串的来源是真正的
  写入方：`src/tools.ts` 用 `=== undefined ? {} : {…}` 映射，只在字面 `undefined`
  时丢键，于是一个把每个可选键都填满的模型把 `""` 原样送进领域层。修法是让声明期
  与结算期读同一条规则（`inheritedFrom?.trim() ?? ''`，非空才校验形状），并删掉由此
  不可达的那条 `inheritedFrom is present but blank` 分支——**一条永远不会被观察到
  触发的规则等于没有规则**。空串**不买任何豁免**：工件照旧整套结算，这是两边合流时
  安全的那个方向。实测 session-0ef33595-… 用的正是真机原始失败形状（class
  `harness`、一个 test-run 工件、`inheritedFrom` 故意给空串），逐字被接受：
  `{"revision":2,"usage":{"entries":[{"id":"m1","usageClass":"harness","boundaryStates":["first-run","error-path"],"artifacts":[{"kind":"test-run","ref":"log.md","covers":["M7-P4-HARNESS-EVIDENCE"],"capturedAt":"2026-08-25T03:00:00Z","inheritedFrom":""}],"attempted":[]}]}}`；
  不带该键的 class `cli` 变体同样被接受（revision 3）。

  (7) **收尾工件结算第一次在真机上被证明真的读磁盘**（关掉 §8.1 那条
  `settleUsageArtifacts`）。session-2e3dbdf4-… 先用一个假的 `covers` 标签尝试收尾，
  逐字被拒
  `Error: completion refused: entry m1 artifact log.md: text does not mention covered label: LABEL-THAT-IS-NOWHERE-IN-THE-LOG`；
  换成真实标签后 `{"revision":11,"phase":"completed"}`。即"工件文本承载它自己声明的
  标签"这条规则在真机上既能拒也能过，不是只在单测里能拒。

  (8) **缺陷 6 与缺陷 7**，挂载竞速与裸 `catch {}`——已修并复验，修法是**换接缝**
  而不是调次序。执行者读了 dsh 怎么把插件效应与会话创建排序，发现宿主本来就在
  等——等错了东西：`boot()` 先 `loader.await()` 再拒绝任何非 ACTIVE 条目
  （`assertEntriesActivated`），`EntryTree.await()` 等的是 `entry.fiber?.inertia`，
  而 `inertia` 是 `_reload()`，它 await `_execute(runner)`，runner 字面就是
  `runtime.callback(this.ctx, this.config)`，也就是插件的 `apply`；thenable 走
  `'then' in effect` 那一支。headless runner 更是显式再等一次，注释写着
  "Loader siblings mount concurrently. Await the complete application before
  creating an Agent so its scoped tools and adapters are not half-composed"。
  旧形状返回 `void` 并把 store 藏在内层 `ctx.effect(async …)` 里，**那个 setup
  promise 不在上面任何一条链上**，于是 fiber 在表面为空时就 ACTIVE 了。现在
  `apply` 是 async 并直接返回 disposer，store 把 `inertia` 撑住，三处等待一起覆盖
  它；并且顺带 fail-closed：store 打不开就 `apply` reject、fiber FAILED、`boot()`
  拒绝启动。被明确否掉的替代方案是"先同步注册工具、让 store 落在后面"——那是拿一个
  **可见**的工具表缺失换一个**不可见**的事件流分裂（前几条事件写进一个后端、其余
  写进另一个），更坏。实测：`--patch` 补上 storage 三行（并置 `storeKind: domain`）
  的 20 次启动加 1 次确认启动，共 **21 次里 21 次**携带全部 11 个 autopilot 工具，
  0 次缺失（修复前是 39 次 domain 启动里 3 次整套缺席）。覆盖是真的生效了而不是
  静默退回文件后端：第 21 次调 `autopilot_init` 逐字返回
  `{"revision":1,…,"store":"domain",…}`。缺陷 7 一并修掉：`resolveStore` 的 `auto`
  分支不再吞掉失败，而是带回一条诊断，`store: 'file'` 与"这个部署根本没有
  `storageDomain`"从此可分辨。

  **收窄但没关掉的一条**：

  **缺陷 8**，`enforcement.approval` 标签。它现在在 10 次真机 run 上 10 次记
  `'signal-only'`（普查 `{'signal-only': 10}`），而修复前记 `'native'` 且每一次 ask
  都决议 `"unavailable"`——所以这个值在这台 host 上是**对的**，而且是**活读而不是
  常量**：对着 `node_modules` 里真的 cordis 4.0.1 Context 驱动真的 `lib/index.js`，
  无监听器时 `observeApproval` 为 `'unanswerable'`，`ctx.on('approval/request', …)`
  之后 `EventsService._hooks['approval/request']` 从 0 变 1、读数变 `'answerable'`
  （即会记 `'native'`），dispose 之后回到 0 与 `'unanswerable'`；无服务返回
  `'absent'`，策略 `'never'` 即使有应答者也返回 `'unanswerable'`，子作用域上注册的
  应答者能被看见（共享 `_hooks`）。**但它仍然可以被观察到判错**，而且是**不安全的方向**：一个注册了却对每次 ask 返回 undefined 的监听器读作 `'answerable'`、会记
  `'native'`，而上游 `ApprovalService.decide` 在那种部署上仍然瀑布到 fail-closed 的
  `() => 'unavailable'` 默认值。这正是原缺陷的形状，只是被收窄了没有被关闭：探针
  证明的是**有一个监听器**，从来不是**有人会答**。另有两个安全方向的误判也复现：
  隐藏 cordis 私有字段 `_hooks` 会让真的应答者变成不可见（`'unanswerable'`），而
  config getter 抛异常的 approval 对象读作 `'answerable'`（刻意如此——字段缺席不是
  取值的证据）。§6 那条上限已按此重写，没有删除。

  **本轮仍然坏着的两条**（与上面的修复同等篇幅记录，不是脚注）：

  **(A) 中**：usage 工件新鲜度的上界在生产路径上是**死代码**。 执行者给
  `SettleUsageOptions` 加了 `settledAt` 来堵伪造镜像洞——模型一旦学会 `capturedAt`
  必须晚于门禁时刻，最便宜的伪造就是往**未来**戳。领域函数实现是对的，
  `test/usage.test.ts` 为它带了 15 条 bearer。**但生产调用方一个都不传**：
  `evaluateCompletion` 全树只有两个调用点——`src/domain/fold.ts:141`（重放，连
  options 都不传）与 `src/engine.ts:1135`，后者只传
  `{ runDir: this.store.runDir(root.id), settleUsage: settleUsageArtifacts }`。
  本轮独立在源码里逐字复核过这两处。真机证据：session-2e3dbdf4-… 结算了一个
  `capturedAt` 为 `"2027-01-01T00:00:00Z"` 的工件——比 `planGatePassedAt`
  `"2026-08-25T03:11:30.350Z"` 晚十六个月——照样到达 `completed`。文档字符串里不
  默认取时钟的理由（重放确定性）成立于 `fold.ts`，**不**成立于引擎那条非重放的收尾
  路径，所以修法是一行少一个实参：`engine.ts:1135` 应当带上
  `settledAt: new Date().toISOString()`。严重度中：下界与其余每一条结算规则本轮都被
  证明在真机上活着，只有向前戳这一支没有守卫。本轮的写域不含 `src/`，留给下一轮。

  **(A) 已结清**（2026-08-25 收尾复核，编排者本人执行）：`submitCloseout` 补上了
  `settledAt: new Date().toISOString()`。补上后套件当场红了一条——真实收尾里工件
  比结算时钟早约 1 秒，硬比较把它误杀——于是上界改用与出站 manifest 同一个
  `FUTURE_SKEW_MS` 容差，两份重复常量合并成一份。承载放在哪里才是关键：原缺陷
  恰恰是"领域函数正确 + 15 条 bearer 全绿 + 引擎那一行没传参"，那 15 条全部直接
  调领域函数，没有一条能观察到这个遗漏。所以新 bearer 驱动的是**引擎**
  （`test/usage-gate.test.ts`：一个 400 天后的 `capturedAt` 走 `submitCloseout` 被拒）。
  撤掉引擎那一行，恰好这一条变红；撤掉容差，jitter 那一条变红——两条都当场看着
  它红过再恢复。

  **(B) 低**，记录保真：空的可选日志字段被渲染成"存在"。
  `runs\session-2e3dbdf4-…\log.md` 逐字有一行
  `- [2026-08-25T03:13:06.528Z] [on-plan] M7P4C-EVIDENCE created m7-p4c.txt and read it back, content matches SETTLE-OK-M7P4C note:  -> root-agent (blocks: none)`
  ——一条 on-plan 检查点带着空的 `note:`、一个 `escalationTarget` 和一个
  `blockingScope`，因为驱动模型把每个可选键都填满而 `src/tools.ts` 用
  `=== undefined ? {} : {…}` 把 `""` 原样放行。这正是缺陷 5 的同族（执行者自己的
  present-but-blank 普查里的第 3 项），区别只在于这次是**在真机上被观察到**而不是
  推理出来的。它不腐蚀任何门禁，它让人读的日志把一次 on-plan 步骤误报成带着升级
  对象。

  **(B) 已结清**，且诊断被测试改正了一半（2026-08-25 收尾复核）：先按"空串直通"
  去修，测试立刻报 `invalid arguments: "escalationTarget" must be one of [...]`——
  `defineTool` 会先按 enum 拒掉空串，那两个字段的空串**根本到不了** `execute`，
  照原诊断加的判断是死代码。真机那行里的 `root-agent` 和 `none` 是**合法**枚举值，
  schema 无从拒绝；让它们变得无意义的是**姿态**。所以真正缺的是一条反向耦合：
  引擎早就要求"escalate 必须有 note"，却从不要求"非 escalate 不得携带升级字段"。
  现在 `engine.log` 在非 escalate 姿态上丢弃这两个字段，`blankToAbsent` 只留给
  自由文本的 `note`。bearer 一正一反（on-plan 三样都不该出现 / escalate 三样都必须
  出现），撤掉耦合后前者精确复现真机那一行并变红。

  **本轮的新事实与新表面**：

  - **出站清单多了一个 agent 可写的候选位置**，这是本轮唯一一处**放宽**，理由与
    代价都写在 §6 新增的那条上限里。`manifestCandidates(runDir, {env, workspaceRoot})`
    按序返回：owner 用 `DSH_AUTOPILOT_OUTBOUND_MANIFEST` 钉住时**独占**，否则
    `<runDir>/outbound/manifest.json` 在前、
    `<workspaceRoot>/.dsh-autopilot/outbound/manifest.json` 在后；`manifestPath` 改成
    "候选表的第一项"，于是"文件该放哪"与"门禁会去哪找"结构上不会漂移。优先级是
    **先存在**而不是**先合法**：从一份 owner 放置但校验失败的清单掉到 agent 可写的
    位置，等于让后者静默覆盖前者。
  - **拒绝文案改成算出来的而不是模板**：`missingManifestReason` 点名它查过的每一个
    路径并逐个标注 `[writable by fs/shell tools]` 或
    `[outside this session's workspace-write roots: owner-placed only]`，带一份填好
    live run id、按校验时钟给 `createdAt`、按被拒命令读出 >=2 token 命令类的 JSON
    骨架，并且**只在 `runDir` 真的落在可写根之外时**才附上工件 containment 约束加
    两条可执行出路。真机逐字（run session-7a4a8715-…，节选）：
    `autopilot outbound gate: no readable outbound evidence manifest for run session-7a4a8715-… so this egress is refused. Looked for it, in order, at: …\runs\…\outbound\manifest.json [outside this session's workspace-write roots: owner-placed only] ; …\p6b-egress\.dsh-autopilot\outbound\manifest.json [writable by fs/shell tools]. Write ONE of those as JSON, then retry.`
  - **边界没有被这处放宽打开**，有负对照：run session-a17f7965-… 在同一个 cwd 下把
    上一次 run 的清单留在那个 agent 可写位置，逐字被拒
    `Error: autopilot outbound gate: manifest at …\.dsh-autopilot\outbound\manifest.json does not authorize this egress: manifest runId session-59935f35-… does not govern live run session-a17f7965-…; artifact does not exist or is unreadable: log.md`。
    文件**在**买不到任何东西。正对照：写一份合法清单之后，同一条
    `git push origin main` 的错误文案**变了**，变成
    `Error: tool "pwsh" requires approval, but no approval channel is available`
    ——按 §8.2 的诊断规则，那行属于 dsh 自己的工具层，所以插件这一侧是校验通过、升到
    了 ask，然后因 headless 无应答者 fail-closed。
  - **出站的正向派发方向本轮依然零执行**：10 次 file-store run 的
    `enforcement.outboundConsumed` 全为 0，全机 36 个 run 目录下
    `*outbound/consumed*` 命中 0 个归档。

  **本轮关掉的 §8.1 条目**：头条"harness 能端到端把一次委派 run 门禁住"——**已证明
  并删除**（见 (5)）；"一次 standard run 能在真机上走完 plan gate 到执行到收尾"——
  **已证明并删除**（见 (3)）；"收尾结算 `settleUsageArtifacts`"——**covered 标签
  承载这一支已证明**，其余分支降级重写（见 (7)）；"plan gate 翻过之后 mutation 是否
  真的变合法"——**mutation 那一半已证明**（(3) 的交付物落盘），`restoreSandbox`
  那一半重写保留。另有四条的**理由形状**从"被具体事实挡住"变成"本轮未尝试"，因为
  挡住它们的那个事实（执行器起不来）本轮消失了：single-control-loop 拒绝、
  `startExecutor` 前置条件的可达性、第二个并发执行器、以及单字符 `covers` 标签能否
  过工具 schema。§8.1 已按此重写。

- **v2 首轮真机验证**（2026-08-25，真机第一轮）：本交付物第一次被真实 dsh host 驱动，
  §8.1 的头条由此被证伪。booted：
  `node C:\Users\<user>\dsh\apps\cli\lib\bin.js --profile autopilot-headless`
  （dsh 0.1.1-rc.2，Windows；该 profile 早已把 `C:\Files\dsh-autopilot` 链了进去，
  既不需要网络也不需要安装），五个探针各自独立出题，合计约四十次 run；其中两个
  探针另用 `--patch` 覆盖臂（一条补 web-app bundle 的 storage 三行、一条补
  `@deepseek-ai/dsh-tool-ask-user`），覆盖文件与全部工件都写在各自的 scratch
  目录里，本仓库与 `C:\Users\<user>\.dsh` 均未被手改。本轮
  **只写 DESIGN.md**：`src/` 与 `test/` 一行未动，因此没有新增用例，本条记的是
  测量与推翻而不是增长。发现的缺陷一律按事实登记、本轮不修——修复轮要另起，且每
  条修复必须先有一个能观察其为假的回归用例。

  **编排者在探针之前的自测**：`autopilot_status` 回
  `{"initialized":false,"note":"no autopilot run on this session"}`；随后一次
  lightweight run 走到 revision 3（init / submit-plan / self-check，planGate
  pass），enforcement 记
  `{"sandbox":"off","store":"file","approval":"native","egress":"native-ask","service":"registered","outboundConsumed":0}`；
  同一条 session 日志里有**三对** `approval/asked` + `approval/decided`，outcome
  全是 `"unavailable"`。这一点本身就把 §8.1 那条“`native-ask` 只意味着
  `host.on(...)` 没抛异常”**升级为观察**：`ctx.approval` 真的被调用了，并且在没有
  应答者时 fail-closed。那次 run 没跑完，原因不在本插件，见 §8.2。

  五个探针的结论，成立与不成立同权记录：

  **A 出站门禁**：在真机上**成立**。走的是 dsh 自己的工具管线而不是单测直调
  `decideEgress`。无清单 9 次独立 session 全部拒绝，逐字
  `Error: autopilot outbound gate: no readable outbound evidence manifest at …\outbound\manifest.json…`；
  清单 runId 不匹配拒绝（`manifest runId session-00000000-… does not govern live
  run session-cf5bf859-…`）；清单过期拒绝（`older than the 21600000ms window`）；
  push-only 清单遇上 `git push origin main && npm publish` 时**指名未被声明的那
  一段**拒绝（`egress command matches no declared command substring: npm publish`）
  ——§6 那条 2026-08-25 新增的逐段授权规则在真机上守住了。合法、run-matched 且
  新鲜的清单走到 `ask`：session-cc182967-… 的日志里 `approval/asked` 的 reason 是
  `decideEgress` 的逐字文案，`approval/decided` outcome `"unavailable"`，模型看到
  `Error: tool "pwsh" requires approval, but no approval channel is available`。
  围栏：work/ 的唯一 remote 是旁边的本地 bare 仓，19 次 run 之后
  `git --git-dir=…\bare.git show-ref` 仍然无输出退出 1，什么都没被推出去。
  同时量到一条次序事实：autopilot 的 pre-execute seam 跑在 dsh 自己的沙箱升级
  解析**之前**——同一个 run 里带同样 `sandbox_permissions` 字段的非出站命令报的是
  升级错误，出站命令报的是门禁文案。**代价**写在下面：`outboundConsumed` 全程 0、
  `consumed/` 目录一次都没被创建，正向派发方向从未走通。

  **B plan gate 钳制**：拒绝那一半在真机上成立，“直到计划审计通过”那一半
  **不成立**，而且原因比钳制本身严重。standard run（session-0dd7c126-…）在计划
  审计之前：`str_replace_editor create` 报
  `Error: autopilot plan gate is pending: str_replace_editor "create" is blocked until the plan audit passes (only "view" is allowed).`，
  `write` 报 file-mutations 那条，`view` 放行并读回控制文件；同目录、同参数形状的
  lightweight 对照 run 里同一个 `create` 成功落盘，所以拒绝可归因于分诊而不是
  参数。假的是“**until** the plan audit passes”：这台 host 上 plan audit 永远
  过不去。`autopilot_audit role=plan provider=spawn` 抛
  `Error: tools.restrict() names unknown global tool "ask_user_question"`，
  而 `AUDITOR_TOOL_ALLOW` 里那个名字只由 web 客户端挂载；叠加 `validateTriage`
  不允许 standard run 走 self-check，结论是**在任何只有 node 的 profile 上
  standard run 永久只读**，事件流停在 `submit-plan` rev 3、`audits: []`。同一探针
  给出一条正面结论：`enforcement.sandbox: 'active'` 是诚实的——同一条升级请求在
  lightweight run 里被判“不比当前更宽”、在 standard run 里被判“需要批准”，说明
  `sandboxPolicy.resolve()` 确实返回了 read-only，钳制真的生效；未证明的是 argv
  是否被 OS 钳住，因为这台 host 上没有任何 shell 命令真正执行过（§8.2）。

  **C usage 钳制与 plan gate 联动**：一半成立，一半**证伪的是本轮的出题措辞**。
  成立的一半：lightweight run（session-c46a0099-…）在 `m1` 仍为 `undeclared` 时对
  `autopilot_self_check role=plan verdict=pass` 报
  `Error: plan gate refused: usage evidence must be declared before the plan gate can pass: usage entry m1 is undeclared…`，
  六条事件的 planGate 序列是 pending 五次然后 pass，答完之后才翻。写钳制也在真机
  上带着 usage 理由出现（`autopilot usage gate: 1 usage entry/entries are still
  undeclared (m1)`），并且有一组严格对照：同一个 `create` 在维度存在之前成功、
  声明为 undeclared 之后失败、答成 `docs` 之后再次成功，磁盘上 ctrl-1/2/4 存在而
  ctrl-3 不存在。被证伪的是“被拒的翻转让事件流**逐字节不变**”：被拒的 pass 裁决
  **会被记录**（rev 4，事件流从 3 行 3516 字节长到 4 行 5371 字节），而这正是
  `src/engine.ts` 注释里写明的刻意行为——交付的代码自洽，是那句话错了。真正成立
  的不变量是逐时刻的那条：**没有任何一个 revision 在有未答条目时带过 planGate
  pass**。这条订正的对象是**本轮的出题假设**，不是本仓库的文本：§9 第 2 项写的
  一直是“pass 裁决被记录、门禁翻转在落盘前被拒”，与实测一致。记在这里是为了不让
  下一轮把“事件流不变”当成本仓库的主张再传一次。

  **D 委派执行器**：在真机上**不成立**，而且是一条宿主无关的死路。全机
  `runs\*\events.jsonl` 里没有任何一条 `submit-packet`。两次 run
  （session-2709649d-…、session-538ea46a-…）的执行器记录都是 rev 6
  `stage: starting` 到 rev 7 `stage: revoked`，理由逐字
  `tools.restrict() names unknown global tools "bash", "autopilot_submit_packet"`；
  用覆盖臂去掉 `bash` 之后精确收敛为单名，是一次干净的单变量隔离。机制读的是装好
  的上游包：`applyChildComposition` 先 `childCtx.tools.restrict(...)` 再
  `setupRegistry.apply(childCtx)`，而 `restrict` 只认**继承层**的名字
  （`restrictableNames` 不含本层自己的注册），所以由 setup 回调注册进子上下文的
  `autopilot_submit_packet` **在任何 dsh 部署上都不可能成为一个可 restrict 的
  名字**。同一 run 里 `autopilot_audit` 派出的审计子代理**成功物化**（子会话目录
  存在、返回 `verdict: pass` 且带 `routeStatus: verified`），所以失败不在派遣机制
  而在这份 allow list。后果之一：第五轮修掉的
  `lookupService(childCtx,'agent') ?? childCtx.agent` 那条修复是**对的但够不着**
  ——更早的一次抛错把它整段藏了起来，原缺陷不是“没有复发”，是**不可观察**。

  **E domain 存储后端**：在真机上**成立**，并且推翻了 §6 的两句话。用一条
  `--patch` 覆盖臂补上 web-app bundle 那三行 storage 之后，headless profile 上
  `enforcement.store` 记 `"domain"`，`storeKind` 取 `auto` 与取严格 `domain` 结果
  相同。`facility.open(AUTOPILOT_DOMAIN_SPEC)` 用结构性 `{parse}` schema
  **没有抛异常**：39 次真机 open 零失败，耗时 37-62 ms。持久化由 dsh 自己写在
  `C:\Users\<user>\.dsh\storages\dsh_autopilot.json`（`tables.events` /
  `tables.runs`，revision 键是 12 位补零形状）。跨进程往返也成立：第三个进程里
  `DomainRunStore.load()` 把先前两次 run 的事件重放回正确快照，未知 run 返回
  `undefined`；那次 open 本身就先把先前进程留下的 6 条记录逐条过了一遍
  `recordShape.parse`。据此 §6 那条“从未对上游真实 `DomainFacility` 跑过一次真机
  run”与“`storeKind: auto` 在 headless 上**必然**解析为 `file`”双双改写：后者是
  关于**bundle 默认行列表**的事实，不是关于 profile 或 CLI 的事实，一条 `--patch`
  就能翻过来，而 `--patch` 是 CLI 支持的组合路径。

  **本轮登记的缺陷**（按事实记录，本轮不修）：

  (1) **高**：`autopilot_init` 在**每一次** lightweight run 上都向模型返回硬错误。
  `src/tools.ts` 返回 `usage: snapshot.usage`，而 lightweight 不播种 usage，一个
  取值 `undefined` 的自有可枚举属性过不了 dsh 的无损 JSON 边界，模型收到
  `Error: tool "autopilot_init" returned invalid output: value is not lossless JSON`
  与 `"error":{"name":"ToolOutputError","code":"INVALID_TOOL_OUTPUT"}`。run
  **确实被创建了**，于是模型的状态模型与引擎从第一步就分叉：实测它会重试并撞上
  `Error: an autopilot run is already active on this session`，白烧两步。14 个
  session 里 14 次复现；`size: 'standard'`（usage 有值）返回干净 JSON，是一次干净
  的隔离。本仓库单测看不到它，因为它们直接调 `execute()`，从不穿过 dsh 的工具
  输出校验。
  (2) **高**：`AUDITOR_TOOL_ALLOW` 里的 `ask_user_question` 让**每一次**
  `autopilot_audit` 派遣抛错（探针 B 与 D 各自独立撞到）。同一个常量逐字存在于
  树内实验版（`packages/experimental/gah`），v2 是照抄继承的。
  (3) **高**：`executor.toolAllowList` 后面附加的 `autopilot_submit_packet` 让
  **每一个**委派执行器启动失败（探针 D），且论证是宿主无关的。
  (4) **中**：`DEFAULT_EXECUTOR_TOOLS` 含 `bash`，而 win32 上 dsh 根本不注册
  `bash`。与 (2)(3) 同型：在 restrict 的 allow list 里写了一个部署不一定注册的
  名字，而 `restrict` 是全有或全无。
  (5) **高**：真机上**每一条带工件的 usage 声明都被拒**。本 profile 的模型会把
  schema 里每一个可选键都填满，包括 `inheritedFrom: ""`，而 `inheritedFromProblems`
  把“存在但为空”判为硬拒绝（`entry m1 artifact usage-note.txt: inheritedFrom is
  present but blank`，三个 session 各一次；任务文本明说不要带这个键也没用，而它在
  工具 schema 里确实是可选的）。于是要工件的类别（gui / cli / api-behavior /
  harness）在真机上不可达，模型退回 `docs` / `internal` 这两个什么都不要的类别，
  门禁照过。§6 那条“usage 的类别与条目数全部自报”本轮拿到了一个真机 bearer，而且
  比原文更糟：不是“可以不诚实”，是**诚实的那条路走不通**。
  (6) **高**：domain 后端会让 headless 单发 run **静默丢掉整套 autopilot 工具**。
  注册全在 `apply()` 那个 async `ctx.effect` 体内，而 headless runner 不等它；
  `facility.open` 的几十毫秒真实 fs I/O 输掉这场竞速时，唯一那次请求的工具表里
  一个 `autopilot_*` 都没有（实测 25 工具 / 0 autopilot，健康时 36 / 11），进程
  退出 0、stderr 空、无任何诊断，run 看起来像正常跑完了。39 次 domain 启动里 3 次；
  文件后端 20 次对照 0 次（文件路径没有 await，注册在同一次微任务清空里完成）。
  §7 末尾那条“不可能脑裂”的论证、以及 v2 集成条目里“脑裂窗口为空”的正面断言，
  对**长会话**成立，对**单发**表面不成立：它们证明的是“工具不存在时没有 run 会落
  在错后端上”，不是“工具一定会在第一次请求之前出现”。
  (7) **中**：`resolveStore` 的 `auto` 分支用裸 `catch {}` 吞掉 domain 打开失败，
  不记任何诊断——`store: 'file'` 与“这个部署根本没有 `storageDomain`”不可分辨。
  (8) **中**：`enforcement.approval: 'native'` 记在一台批准永远无法被应答的 host
  上。这条**不是新发现**——§6 早就把它记成一条上限，并预言了“行为上等同于没有
  owner 通道”；本轮给了它第一个真机 bearer，并补上一个 §6 原文没写到的子情形：
  §6 描述的是会话策略为 `'never'` 时每次 ask 确定性返回 `rejected`，而这台 host
  上是根本没有应答者，outcome 为 `"unavailable"`。两条路都 fail-closed，所以这是
  一个假能力标签加一条不可用的 owner 通道，不是敞开的边界。探测器本身的分辨率
  问题照旧：`probeApproval` 只检查服务对象非空，而 `probeSandbox` /
  `probeStorageDomain` 检查的是服务**能不能干活**。
  (9) **中**：`autopilot_audit` 的 `provider` 是无约束自由文本，直接交给
  `subagents.start`；实测模型自己编出一个 `openai/gpt-5.6`，把 run 唯一的审计出处
  通道静默改道（`no subagent provider registered for "openai/gpt-5.6"`）。
  (10) **低**：本仓库测试树从不让任何工具穿过真实 `ToolRuntime`，也从不校验引擎
  构造的 `toolFilter`（`test/helpers.ts` 的 `startContinuable` 直接丢掉
  `spec.request.toolFilter`；`test/child-setup.test.ts` 手搭 childCtx 绕过
  `applyChildComposition`）。上面三条“高”里有三条正好落在这个盲区里——这是历轮
  “全绿套件”能与“真机上根本跑不起来”共存的结构性原因。
  (11) **中**：门禁对 mutation 的拒绝在 run 事件流里**不留痕**，只存在于 dsh 的
  session 日志。按本文件把 `events.jsonl` 称作权威流的读法，审计者看不到 usage
  钳制曾经触发过。
  (12) **低**：plan gate 被拒时写下的 diagnostic 在门禁后来通过之后**不被清除**，
  于是同一份快照上同时出现 `planGate: "pass"` 与“plan gate refused despite a pass
  verdict”。

  **本轮关掉的 §8.1 条目与结论**：头条“从未在真实 dsh host 里运行过”——**证伪并
  删除**，它依据的那句理由从来就是假的，方法层的诊断写在 §5 末尾；
  “`enforcement.egress: 'native-ask'` 只意味着 `host.on(...)` 没抛异常”——**升级为
  观察并删除**，seam 真的跑了、真的 ask 了、无应答者时真的 fail-closed；
  “`DomainRunStore` 从未跑过上游真实的 `DomainFacility`”——**证伪并删除**（探针 E）。
  三条的**反方向**全部转成新的 UNPROVEN 条目：出站的正向派发、`guard-deny` 那一档、
  domain 后端的多 revision 与并发写者。§8.1 已按 §5 新增的那条规则整节重写：每一
  条现在都必须说清它为什么**在有 host 的前提下**仍然未证明。

- v2 Web UI 轮（2026-08-25，本轮）：交付 §9.3 的两半——`autopilot-run`
  会话卡片与 host 侧只读路由——并**零新增依赖**。
  **本轮结束时实测**：`npx tsc -p tsconfig.json --noEmit`、
  `npx tsc -p tsconfig.test.json --noEmit`、`npx tsc -p tsconfig.client.json --noEmit`
  三者均无输出退出 0；`npx vitest run` 21 文件 / 703 用例全绿；
  `npm run build:client` 出 `lib/client.js`（3 个模块，入口 `client/index.js`）；
  `npm run test:client-bundle` 把产物喂进真的模块加载器并用真 react 18.3.1 渲染，
  16 条断言全绿。

  **真机形态证据**（`--profile autopilot-dev`，浏览器实看，四个边界态各有截图）：
  无 run 时卡片正确缺席且会话完好（DOM 探针 `{autopilotCards:0, toolRows:7}`、
  控制台无错）；planning 中、completed、completed+delegated+independent 三态卡片
  各自渲染出 phase、双门禁、计划修订、必需角色、replan 预算、日志数、模式行与
  审计时间线（委派那次两行审计都带 `gpt-5.6-sol` 路由）。另把 reducer 在真实日志
  的递增前缀上折叠，得到 8 个连续卡片状态，其中一态与照片逐字节相同。

  **本轮发现并当场修掉的 HIGH**：路由对 run 的枚举是**缓存问题而不是存储问题**。
  `AutopilotEngine.listRuns` 返回的是 `[...this.cache.keys()]`，`RunStoreLike`
  上根本没有枚举方法，于是冷启动的 web server 对着 5 个 run 的存储返回 `[]`，
  列表只随着逐个 id 被探测而增长。修法是把枚举下沉为存储职责：
  `RunStoreLike.listRuns` 新增；文件后端扫目录树但**不信目录名**（`sanitize`
  把 id 有损映射成目录名且不可逆），改读每个 run 自己的 `snapshot.json` 取
  `runId`，读不出的目录直接略过而不是按残缺路径猜一个；域后端直接取 `runs`
  表的键（键本身就是 run id）。引擎并集缓存与存储。
  bearer 必须是**冷进程**形态——原缺陷在"同一个引擎刚建完 run 就问它"的单测里
  永远不可见，所以新用例造第二个引擎指向同一目录，正负各一条。撤掉修复后恰好
  这一条变红。
  修复后真机复验（冷启动 `autopilot-dev`）：`GET /api/autopilot/runs` → 200、
  `storeKind: domain`、5 个 run 及其完整 StatusView 投影；
  `/api/autopilot/run?id=<真>` → 200，未知 id → 404，`POST` → 405。这同时关掉了
  验收阶段列的两条未证明项（正确配对存储上的路由行为、真 HTTP 上的非 GET 方法）。

  **仍然记为缺陷或未证明的**：卡片不渲染 executor，于是 `mergeExecutor` 折叠
  目前没有消费者（中）；`/runs` 与 `/run` 服务的是 web profile 的域存储，而
  headless 用文件存储，两个 profile 互相看不见对方的 run——这是 `storeKind: auto`
  的部署属性，不是路由缺陷，但必须被使用者知道；卡片的原地实时更新从未被观察到
  （每一张照片都来自一次页面加载）；暗色主题与窄视口从未渲染过。另有一条
  **上游**缺陷：web UI 打开一个正被另一个 dsh 进程写入的会话，会把该会话日志
  写坏且永久打不开——归因证据是 3/3 对 0/1，控制组 n=1，按此强度如实记录。

- v2 跨家族评审派遣（2026-08-25，本轮，由编排者本人执行）：交付 §9.6。路线图至此
  只剩上游阻塞的 §9.4。
  **本轮结束时实测**：三个 tsconfig 均无输出退出 0；`npx vitest run`
  23 文件 / 739 用例全绿。

  规则本身是 CC 血统里那条"建造者家族 != 评审家族"，理由很具体：**一个家族共享的
  盲点会同时穿过两道门**，所以同家族的两次绿灯，独立性比看上去低。实现上有两个
  地方是这条规则的成败所在，各自有变异证明：

  (1) **家族键是 provider 不是 model**。同一个 provider 下的两个模型共享它的训练与
  失效分布；若按 model 判定，配置方用两个同源模型就能"满足"跨家族，而记录声称的
  是独立评审。把家族键改成 model 之后 5 条测试变红。

  (2) **四值而不是布尔**，`unknown-family` 是关键的那一格。任何一侧继承部署默认
  （没配 `agentOptions`）时，本代码根本看不到实际派到了哪个家族，因此不得声称
  `achieved`。让它在这种情况下报 achieved，精确 2 条变红。这一格是本仓库第四次
  为同一类缺陷付账（`enforcement.sandbox` 的伪 active、`enforcement.approval` 的
  伪 native、域存储静默降级），区别是这一次它是生下来就带着的，不是被审计打出来的。

  这是**策略不是门禁**：单 provider 部署是合法部署，拒绝审计比同家族审计并如实
  记下更糟。所以 `same-family` 不阻止任何事，它只是让读记录的人知道那一轮的两道门
  没有互相独立；诊断文案直接写明代价（"a blind spot shared by that family passes
  both gates unchallenged"）。

- v2 external 审计模式（2026-08-25，本轮，由编排者本人执行）：交付 §9.5，路线图
  只剩 §9.6 与上游阻塞的 §9.4。
  **本轮结束时实测**：三个 tsconfig 均无输出退出 0；`npx vitest run`
  22 文件 / 723 用例全绿。

  这条通道的设计难点不在实现而在**不让它变成后门**：其余每一条裁决都由 harness
  自己产出（`audit` 派遣子代理读结构化输出，`self-check` 有自己的 size/risk 围栏），
  只有 external 是一个人在本进程之外断言的。四道约束，每一道都有自己变异证明过
  的承载：
  (1) 工具层 `requireDirectHumanTurn`，与 `owner-approve` 同一道闸——没有它，
      驱动 run 的 agent 就能给自己的工作签字，而记录上写着是人签的，这比
      `self-check` 更糟，因为 self-check 至少诚实地标了自己是什么。去掉后精确 1 红。
  (2) fold 在**重放**路径上校验附署（模式匹配 + `validateExternalReview`）。只在
      写入侧校验正是本仓库付过学费的缺陷类，手改或外来的事件流会直接穿过去。
      去掉后 2 红。文件系统那一半刻意不进 fold——重放不得依赖磁盘状态。
  (3) `evaluateCompletion` 在 external 模式下拒绝自审裁决，同时**接受**派遣审计
      （真派遣比附署强，接受它不是漏洞）；反过来，非 external 模式下携带附署的
      记录也被拒绝，避免一份弱证据坐进它自称不了的模式里。放开后 1 红。
  (4) 收尾结算要求 `reviewRef` 落在 run 目录内且非空，与 usage 工件同一套；只结算
      每个角色的**最新**一条，好让一次修正后的评审仍然可能。不读盘后 3 红。

  顺带在边界层测到一件值得留的事：external 附署走的是与派遣审计**同一条**
  `applyVerdict` 路径，所以它绕不过 usage 门禁——standard run 的未声明条目照样拦住
  附署引发的门禁翻转（实测于 `test/boundary.test.ts` 的 external 床）。

  两处旧断言按事实改写而不是删除：`rejects external audit mode in v1` 变成断言
  它现在被接受（保留原文说明为什么当初拒绝是对的），`rejects medium risk without
  independent audits` 变成按规则本身双向断言（medium+ 自审必拒、independent 与
  external 均放行）。`test/apply.test.ts` 里那条裸的 `toHaveLength(11)` 顺手改成
  断言确切名单——裸计数是动锚，加了工具最省事的修法就是把数字加一，而同一个动作
  在另一个方向上正是"工具悄悄消失了没人发现"。

- v2 Web UI 收口（2026-08-25，本轮，由编排者本人执行）：把上一轮 Web UI 轮留下的
  三条尾巴逐条关掉，两条关成、一条只关掉了属于本仓库的那一半。
  **本轮结束时实测**：三个 tsconfig 均无输出退出 0；`npx vitest run`
  21 文件 / 703 用例全绿；`npm run build` 两半均成；
  `npm run test:client-bundle` 18 条断言全绿（原 16 条）。

  (a) 卡片不渲染 executor、`mergeExecutor` 是孤儿折叠 —— 已修。那个折叠存在的理由
  是把 `childId` 在 `StatusView` 只带 `{generation,state}` 的部分记录之间保住，可在
  渲染出来之前，它的正确性在任何人看得见的地方都无法被观察。现在卡片有一行
  `executor <state> · gen N · exec rN · child <前 8 位>`。bearer 用**真实 fixture**
  （`session-61a05524` 的委派 run），正反各一条：A16 断言委派 run 渲染出 executor
  且含真实 childId（实测 `8378f240`），A17 断言 inline run 不渲染该行。变异证明选
  的是把 `mergeExecutor` 改成盲替换——最后一条观察是部分记录，childId 应当丢失
  ——实测 A16 变红为 `childId: ""` 而 A17 保持绿，说明失败是特定的。

  (b) 窄视口从未渲染过 —— 已关，带对照。把卡片自身压到手机宽度实测：375px 无横向
  溢出（高 249px），320px 无横向溢出（高 390px，栅格正确塌成更少列）。对照：压到
  40px 时 `overflowX: true`（scrollW 162 对 clientW 39），证明这个探针**能**看见
  溢出，于是两个"不溢出"才携带信息。第一版探针压的是父元素，卡片宽度纹丝不动却
  仍报"无溢出"——那是个观察不到失败的检查器，已作废重写。

  (c) 暗色主题 —— 只关掉了本仓库这一半，另一半如实记为未观察。卡片侧决定性通过：
  把四个 `--dsw-alias-*` 令牌翻成暗色值，卡片计算色跟随（bg `rgb(255,255,255)` →
  `rgb(29,36,48)`、前景 `rgb(15,17,21)` → `rgb(233,237,244)`、边框同步）；对照把
  bg 令牌设成 `rgb(1,2,3)` 也跟随，证明探针量的是令牌本身；卡片内联样式不含任何
  字面颜色。**未观察到的是宿主那一半**：设置面板的浅色/深色开关点击两次均未生效
  （`colorScheme` 始终为 `light`），所以"宿主切主题时确实会翻这些令牌"没有被直接
  看到，只是从令牌由宿主定义并向下继承推出来的。页面状态已逐值还原，用户的主题
  设置未被改动。

- v2 收尾复核（2026-08-25，第七轮收尾，由编排者本人执行而非派发）：对第七轮的三条
  结论逐条重测，两条被改写，一条被证伪。
  **本轮结束时实测**：`npx tsc -p tsconfig.json --noEmit` 无输出退出 0；
  `npx tsc -p tsconfig.test.json --noEmit` 无输出退出 0；`npx vitest run`
  18 文件 / 556 用例全绿；`npx tsc -p tsconfig.json` 出 lib/ 成功。

  (a) 出站方向矩阵独立实测（自出题，不复用执行者的 fixture）：18 条只提及出站词
  的良性命令放行 16 条，17 条真出站命令全部拒绝，**零假阴**。收紧没有拿安全换
  可用性这一点由此有了一个独立于执行者的 bearer。剩下的 2 条误报（`xargs`、
  `python -c`）落在 §6 已记的解释器逃逸口内，方向是向拒绝失败，不改。

  (b) `autopilot_signal` 的 `default:` 分支：第七轮把它记成"唯一一条仍然开放的
  幸存变异"，判读**有一半是错的**。实测（沙箱注入探针读拒绝来源）：枚举之外的
  动作串由 `defineTool` 的参数校验先行拒绝，抛 `ToolArgsError` / `INVALID_ARGS`，
  消息为 `invalid arguments: "action" must be one of [...]`，**永远到不了**
  `default:`。所以那次变异存活是正确行为，不是无守卫规则；已在源码里记下这条
  出处与测量日期。真正开放的是另一半：**加进 enum 却忘了加进 switch 的新动作**
  确实可达 `default:`。两条 bearer 补齐并各自证明可失败——前者断言拒绝来自哪一层
  （隔离变异：把 enum 挪进 description 后精确变红 `but got 'unknown action ...'`），
  后者走 enum 自身而非硬编码列表（注入 `owner-defer` 后精确变红）。原 §8.1 条目
  据此删除：它已不再是未证明项。

  (c) 行尾：第七轮记录的 3 CRLF / 32 LF 已统一为全 LF（字节级实测 CRLF 对 = 0）。
  §6 未新增条目——`.gitattributes` 缺席这一点写在第七轮条目里，仍然成立。

- v2 第七轮幸存变异清算（2026-08-25，第七轮）：对上一轮收尾时**仍然存活**的变异
  幸存清单逐条重测并关闭。清单按构造是陈旧的——它测于 `test/tools.test.ts` 与
  `test/policy.test.ts` 落地之前，所以每一条都必须先在各自的沙箱里对**当前**源码
  重放一次，才知道它是"已经被关掉"还是"仍然开放"。五名执行者各占一个不相交的
  写域（gate / tools / store / domain-fold-usage / policy），第六名做独立复核。
  **本轮结束时实测**：`npx tsc -p tsconfig.json --noEmit` 无输出退出 0；
  `npx tsc -p tsconfig.test.json --noEmit` 无输出退出 0；`npx vitest run`
  18 文件 / 555 用例全绿；`npx tsc -p tsconfig.json` 出 lib/ 成功。用例数从 468
  增至 555，测试文件从 17 增至 18（新增 `test/store-file.test.ts`）。

  重测本身就是本轮的第一项发现。44 条幸存条目里 43 条被各自的写域重放：13 条在
  当前源码上**已经变红**（上一轮补的 `tools.test.ts` / `policy.test.ts` 顺带关掉
  的），30 条仍然全绿。第 44 条在写域内被漏掉——某份报告写着"全部 22 条已重测"，
  它的两张表加起来只有 21 条——由独立复核者补测，实测**仍然存活**（即下面变异
  解析度里那 1 次）。把"报告说已关"当成"已关"，正是这条审计链存在的理由，所以
  每条结论都带它自己的证据：已关的给出杀它的那条用例，仍开的给出全绿的套件计数。

  被攻击并**破了**的（每条都先对未修源码跑出对应结果再改）：
  (a) **出站匹配的过度包含是真缺陷**，不是刻意保留的方向。8 条日常命令在门禁 run 上
  实测 8/8 判 `deny-egress`（正对照：6 条真出站 6/6 仍判 `deny-egress`）。上一轮
  把它记成"刻意保留"并在 §6 断言任何收紧都是 fail-OPEN——本轮推翻的是那段推理，
  不只是代码：收紧被限制在两件**可证明不会执行**的东西上（未被引号包住的 `#`
  之后的文本、多词引号参数的内部词边界），再加一个解释器逃逸口把整行交回逐字
  匹配，并按通道分出 `EgressScanMode`（`run_code` 与 `terminal_send` 逐字不变）。
  新的上限与被证伪的旧上限一起重写进 §6。
  (b) `src/tools.ts` 的 closeout evidence 参数上那个 `as never` cast 让整个
  evidence 条目形状**完全不过编译器**。去掉 cast 之后，`criterion` 去掉
  `required`、`bearer` 去掉 `required`、放宽 status enum 三种改动各让
  `npx tsc -p tsconfig.json --noEmit` 退出 2；把 cast 加回去三种都退出 0
  （独立复核在第二个沙箱里实测）。
  (c) 两个 store 后端里两份逐字相同的 `sanitize` 合并成一个导出的 `runDirFor`。
  两份副本只能靠测试拴在一起，而测试只能采样输入空间；一份实现让分歧结构上
  不可能。同一处的 `defaultStoreRoot` 空值判定改成 `trim()` 感知，与
  `outbound/manifest.ts` 的同类规则对齐——这是**行为变更**：
  `DSH_AUTOPILOT_HOME='   '` 此前被当作合法根，会把 run 目录写成相对路径。
  (d) `test/usage.test.ts` 里"run 目录不在自身内部"那条用例的注释声称它测的是
  相等分支，实际上被前缀分支挡住，等号守卫只在 `runDir` 本身以分隔符结尾
  （文件系统根）时才承载。注释已订正并补了隔离夹具。
  (e) 幸存清单自己也有一条低估：S39 说"只有 executor-MISSING 那一半有 bearer"，
  实测两臂都没有——把 missing 那一臂也换成 no-op，套件同样全绿。

  被攻击并**守住了但没有 bearer**的（本轮补的是检查器；每条都先施加它该抓的变异、
  看着它变红、还原，并记下看到的红色计数）：`hasDirectHumanTurn` 的两个循环边界
  与 source-kind 判据；`autopilot_signal` 的 block / owner-decision 分派与
  owner-resolve 的缺省拒绝；`autopilot_init` 的 usage 播种三元式（**两个方向**——
  上一轮 `apply.test.ts` 只顺带杀掉了过度播种那一半）与 `touchesOperatingLayer`
  缺省；`autopilot_usage` 的类别与边界态映射；`autopilot_self_check` 的裁决透传；
  `autopilot_audit` 的角色枚举（从域类型派生而不是手抄）；`autopilot_executor`
  的 start / resume 路由；`autopilot_submit_packet` 的执行器路径；closeout 的
  drift 与 residualRisks 逐字持久化；`installRootTools` 的全或无回滚；
  `RunStore` 的严格重放 / 写序 / `log.md` / `appendLog` 错误传播 /
  `defaultStoreRoot` 四条分支 / run 目录注入性；`evaluateCompletion` 的两条基数
  下限与委派执行器状态两臂；`isInsideRunDir` 的分隔符感知与等号守卫；
  `PHASE_TEXT` 的阶段自称、replan 预算算式、必需角色行的完整性。

  变异解析度（本轮实测）：独立复核者在自己的沙箱里施加 **61 次**变异、每次跑全
  套件、每次还原，**60 次被杀**、**1 次存活**。存活的那条是 `autopilot_signal` 的
  `default:` 分支（把 throw 换成成功形状后 18 文件 / 555 全绿）。该条已在本轮收尾
  时结清，结论与当时的判读不同——见下方的收尾复核条目。
  五份执行者报告里声称的 58 条关闭，复核者逐条复现，58 条全部变红；其中 3 条实测
  的红色计数**高于**执行者声称的数（即 bearer 比声称的更强），1 条低于，差异来自
  复核者写的变异形状与执行者不同，不是 bearer 变弱。

  按**诚实上限**记录而不是修掉的（写进 §6）：出站匹配的当前读法及其四个方向的
  上限（重写了被本轮证伪的那一条）；`git … push` 模式 gap 排除分隔符导致的
  5 条实测漏放（既有洞，实测确认收紧未引入回归）；run 目录名与字面 `_` 的碰撞。
  本轮**没有整条删掉** §6 的任何一条——被证伪的那条是措辞与结论错了，不是它
  描述的洞消失了。

  一条工件层面的观察，由独立复核者提出：`src/gate/decide.ts`、
  `src/gate/preexecute.ts`、`test/gate.test.ts` 三个文件当时是 CRLF，其余 32 个
  `.ts` 是纯 LF，仓库里没有 `.gitattributes`（实测 2026-08-25：3 CRLF / 32 LF /
  共 35 个文件）。写入方重排了这三个文件的每一行，任何基于 diff 的复核都无法把
  范围收敛到真正的改动上。已在本轮收尾时统一为 LF（字节级实测 CRLF 对 = 0，
  35 个文件全 LF）；`.gitattributes` 仍然没有，所以下一个写入方仍可能带回 CRLF。
- v2 第六轮独立修复审计应用（2026-08-25，第六轮）：对上一轮"修复轮"本身做独立审计，
  20 条被裁定坐实的发现逐条修复或按诚实上限记录。**本轮结束时实测**：
  `npx tsc -p tsconfig.json --noEmit` 无输出退出 0；`npx tsc -p tsconfig.test.json`
  无输出退出 0；`npx vitest run` 17 文件 / 468 用例全绿；`npx tsc -p tsconfig.json`
  出 lib/ 成功。用例数从 394 增至 468，测试文件从 15 增至 17
  （新增 `test/tools.test.ts`、`test/policy.test.ts`）。

  被攻击并**破了**的（每条都先对未修源码跑出失败再修）：
  (a) **链式出站授权逃逸**（唯一一条真安全洞，不是文本缺陷）：push-only 的
  manifest 加 push-only 的 owner 批准，授权了
  `git push origin main && npm publish`，owner 从未被问过第二段；实测把
  `decideEgress` 一路驱动到 `{kind:'allow'}` 且批准被消费。修法见 §6 新增的
  "出站命令类是逐段授权的"一条；回归用例在 `test/outbound.test.ts`、
  `test/engine.test.ts`、`test/preexecute.test.ts` 各一组，修前分别实测失败。
  写分段规则时同一条推理又抓到一个同型的口子：单个 `&` 也串联命令，而 git-push
  模式的 gap 在 `&` 处就停，所以 `git push origin main & npm publish` 整行只匹配
  push 那条声明——`&` 已加入分隔符集并有夹具。反过来，`$(...)` 这类不带分隔符的
  串联切不开，按上限记入 §6 并用夹具钉住当前行为。
  (b) `EGRESS_FAIL_CLOSED_REASON` 对人**断言了一句假话**：`grep -rn "git push" .`
  被拒时告诉操作者"this command mutates remote/public state"。文案已改为陈述
  文本匹配，过度包含本身按上限记入 §6 并用六条夹具钉住。
  (c) 三处源码注释仍在断言 §1 已撤回的那句话（`src/service.ts`、
  `src/store/domain.ts`、`src/gate/preexecute.ts`），而 §6 恰好把
  `extends Service` 的理由委派给其中第一处；上一轮"理由现已改挂"对工件为假。
  (d) §1 与 README 换上的替代句"`src/` 里的非相对 value import 恰好两条"**本身
  也是假的**：实测 15 条（13 条 node 内建 + 2 条包）。两处都改成"非相对**包**
  恰好两条"。
  (e) `package.json` 的 `files` 不含 `DESIGN.md`，而 README 有 7 行共 10 处指向
  它（含"归档不是重放保护——见 DESIGN.md §6"与"当前用例计数在 DESIGN.md §8"）；
  对装包的使用者这些指针全部悬空。已加入 `files`。
  (f) `test/engine.test.ts` 里那条名为"approvalAuthorizes: the rule, stated
  where a test can resolve each half"的用例**没有它自称的性质**：删掉条件 1
  全绿，因为两条 half-1 夹具都是过定的（它们同时不满足 half 2）。已补一行
  `approvalAuthorizes('origin main', 'git push origin main')` 隔离条件 1。

  被攻击并**守住了但没有 bearer**的（本轮补的是检查器；每条都用变异证明新用例能
  观察到对应失败）：`applyDecision` 四个决策分支里的三个 deny 与 allow-degraded；
  整个 turn-stop 提醒监听器；`startExecutor` 五个前置条件里的四个；执行器路由与
  `captureRoute` 的 verified/unverified 判据；`resolveEgressChannel` 的
  `undefined` 分支及其两个调用点的接线；`apply()` 的三个 root 准入闸；
  子代理绑定里的执行器**状态**那半个合取；`src/tools.ts` 的
  direct-human-turn owner 权限闸（该文件此前零测试引用）；`src/policy.ts` 的两个
  policy 渲染器（此前只断言过 section 的名字）；归档写在 `next()` 之前这条顺序
  主张在**成功派发**路径上的可分辨性。

  变异解析度（本轮实测）：34 次变异，逐条应用后按 sha256 还原，**34 次全部被杀**。
  其中 2 次第一遍存活，原因不是代码而是**夹具过定**——`apply()` 的
  parentSession 闸被 `roots()` 闸同时挡住，root guard 的 `egressSeam` 接线没有
  任何用例去问 guard 本身的决定。两条夹具按 Checker-Resolution 重做后，两次变异
  都被杀；这两次的诊断价值高于其余 32 次，因为它们正是本轮 (f) 那条缺陷的形状
  在新写的用例里复发。

  按**诚实上限**记录而不是修掉的（写进 §6）：出站分段仍是文本切分而不是 shell
  解析；出站匹配的过度包含方向（六条实测夹具）；`covers` 无特异性下限这条上限
  从"只说了 manifest 一侧"扩大到明确同时覆盖 `settleUsageArtifacts`。

  仍记为**未证明**的：见本节末尾"未证明"小节（本轮重写了变异解析度一条、收窄了
  TS2540 一条、订正了条目计数，并新增六条；上一轮那 11 条一条都没被关掉）。
- v2 第五轮对抗验证应用（2026-08-24，第五轮）：一轮八透镜对抗验证 + 一次裁定，
  28 条被裁定坐实的发现逐条修复或按诚实上限记录。**本轮结束时实测**：
  `npx tsc -p tsconfig.json --noEmit` 无输出退出 0；`npx tsc -p tsconfig.test.json`
  无输出退出 0；`npx vitest run` 15 文件 / 394 用例全绿；`npx tsc -p tsconfig.json`
  出 lib/ 成功。用例数从 308 增至 394。

  被攻击并**破了**的（各自带一条先失败后通过的回归用例，且在应用修复前对未修
  源码实测确认过：47 个用例失败 / 345 通过）：
  (a) 委派执行器子代理表面在真机上什么都不装——`childCtx.get('agent')` 在真实
  cordis 4.0.1 上恒为 undefined，于是委派 run 既无出站 seam 也拿不到
  `autopilot_submit_packet`（即"委派模式能端到端跑通"当时是假的）；
  (b) `guard-deny` 档下 guard 对损坏事件流 fail-OPEN，"无条件拒绝出站"变成放行；
  (c) owner 批准是可互换的令牌——`consumeApproval` 从不比对 `target` 与命令，
  而 seam 在 ask 之前消费，人看不到任何提示；
  (d) 类别义务只由写入方强制，重放与收尾都不校验，一条空壳 `gui` 声明能翻门禁
  并完成；
  (e) `OUTBOUND_STALE_MS` 与 `DEFAULT_EXECUTOR_TOOLS` 两个常量的**值**无 bearer
  （夹具从常量自己派生 / 断言拿 loader 输出跟常量自己比）；
  (f) usage 钳制漏掉 shell 类工具，且按 `size` 而不是按维度存在与否生效；
  (g) loader 路径与 plain 路径仍在 `agentOptions: {}` 上分叉，真机会把空对象
  传给 `subagents.start`；
  (h) `archiveConsumed` 对"同一份 manifest 被同一条命令消费两次"文件名相同、
  静默覆盖，且注释断言了一个代码无法观察其为假的重放保护；
  (i) `gh api` 带字段标志 / `gh workflow run` / `gh secret set` / 反斜杠续行的
  `git … push` 四类在已枚举通道内部漏网；
  (j) `run_terminal` 不是任何 dsh 包定义的工具，真实 PTY 表面
  （`terminal_send{sessionId,text}`）既没被扫描也没被 `commandTextOf` 认出；
  (k) 两道类型门同时对 `test/` 失明，盲区里有两个真的 TS2540；
  (l) `startExecutor` 只看 planGate、不再问 usage；
  (m) `test/legacy.test.ts` 的 `>= 8` 长度下限会被本机唯一一条真实 v1 流
  （7 事件）判负——一个真实样本会失败的下限不是关于该总体的主张；
  (n) `validateManifest` 省略 `ctx.now` 时两条新鲜度分支同时静默失效；
  (o) `tools/execute` seam 没有独立授权检查，安全性由上游调用顺序拥有；
  (p) `closing` 阶段禁止 `declare-usage`，构成一个可恢复但无人指路的活性死角。

  被攻击并**守住了**的（代码本就正确，本轮补的是 bearer 而不是修复；每条都用
  变异证明了新用例能观察到对应的失败）：pre-execute 的 fail-closed catch、
  两个事件名 `tools/pre-execute` / `tools/execute`、seam 侧的 SHELL_TOOLS 列表、
  `isGatedRun` 的 catch 读作 GATED、`DomainRunStore.commit` 的写序、
  `registerAutopilotService` 的四条注册分支、`ctx.autopilot` 的 tracker symbol、
  usage 工件解码的 UTF-8/latin1 往返、`normalizeCount` 的去空白、
  `manifestPath` 的 `process.env` 缺省、两处 containment 相等分支与两处空针
  匹配分支。共 18 次变异，全部被杀。

  按**诚实上限**记录而不是修掉的（写进 §6）：`covers` 无特异性下限、
  `capturedAt` 无上界、归档不是重放保护、一条 bearer 可同时承载多条验收标准、
  引擎 `init` 对 standard run 不强制 usage 播种。

  仍记为**未证明**的（本轮无法关闭）：见本节末尾"未证明"小节。
- v2 文档轮（2026-08-24，第五轮之前）：只改 `DESIGN.md` / `README.md` /
  `skill/dsh-autopilot/SKILL.md`，`src/` 与 `test/` 一行未动。因此**没有新增用例**，
  计数与上一轮相同——本条记的是复核而不是增长：实测 `pnpm run test`
  为 12 个测试文件 / 308 个用例全绿，`pnpm run check`
  （`tsc -p tsconfig.json --noEmit`）无输出退出 0。内容侧本轮落实：§2 补上
  出站批准通道与 run 状态存储两行映射；§4 把「Session 事件词表对树外插件封闭」
  这条主张钉到实读的上游文件与逐字引文上；§6 新增两条诚实上限（usage 的类别 /
  条目数 / 豁免资格全自报、domain 后端只存在于挂了 web-app bundle 的部署且从未
  跑过真机 run）；§7 说清 `egressDeny` 在 v2 是总开关而非批准开关，并记入三个
  owner 通道环境变量；§9 路线图按 v2 实交付重写；SKILL.md 补上安装到
  `~/.agents/skills/` 的命令（路线图 §9.7 的最后一项）。
- 第四轮审计应用（2026-08-24，两名独立审计者各自判定 needs-fix，16 条发现
  逐条复核后修复/记录；本轮结束时实测 `tsc --noEmit` 无输出、`vitest run`
  308/308、`tsc -p tsconfig.json` 出 lib/ 成功）：(a) `tools/execute` 出站
  seam 在"无 run / 终态 run"下与 `decideEgress` 达成一致直接放行（此前两个
  seam 互相矛盾，pre-execute 放行后 dispatch 抛错，等于任何挂载了本插件却没有
  活体 run 的会话——以及任何 run 结束之后的会话——`git push` 永久失效）；
  (b) `Config` schema 的 `toolAllowList` 默认值与 `resolveConfig` 共用
  `DEFAULT_EXECUTOR_TOOLS`，并新增 loader 路径用例（见 §7）；(c) `Config`
  显式拒绝未知/拼错的键（顶层与嵌套）；(d) 出站 manifest 增加命令类下限与
  token 边界匹配、并强制 `covers` 与工件文本对账；(e) `enforcement.outboundConsumed`
  改为只在 `next()` 返回非 error 结果后才加一（归档仍在 `next()` 之前，理由与
  代价见 §6）；(f) `evaluateCompletion` 与 fold 双双补上 planGate/usage 与
  completion/usage 的联动（此前只有引擎方法持有该不变量，冷恢复重放能绕过）；
  (g) `inheritedFrom` 增加 `<run-id>/<ref>` 形状校验；(h) egress 通道探测改为
  按 root 传入 run id（此前是挂载级 last-write-wins 变量）；(i) `ctx.autopilot`
  注册结果记入 `enforcement.service`；(j) 待派发出站授权表加上限并按最旧淘汰；
  (k) `apply()` 的 async effect 体在中途抛异常时关闭已打开的 domain store；
  (l) §6 新增六条诚实上限，§8 基线改为下限+可再生工件。
- v2 集成（2026-08-24，上一轮）：存储 seam 化 + 引擎 commit 异步化、usage 证据
  维度、原生出站 seam、诚实 enforcement 记录、Config schema 与 `ctx.autopilot`
  服务、policy 文案。实测 `tsc --noEmit` 无输出、`vitest run` 275/275、
  `tsc -p tsconfig.json` 出 lib/ 成功。七条新增关键规则各做了一次
  Checker-Resolution 变异探针（禁用规则 → 观察到对应用例失败 → 按 sha256
  逐字节还原）：plan-gate/usage 联动(4 例)、usage 写钳制(2)、usage 追加-only
  fold 规则(1)、planGatePassedAt 写一次(2)、收尾结算(3)、guard-deny 出站兜底(2)、
  出站 manifest 校验(4)、storeKind auto 择优(2)、storeKind domain 拒绝降级(2)。
  挂载本身也有用例：`apply()` 返回后、async effect 体 resolve 之前，工具/守卫/
  policy 段/服务全部为零（脑裂窗口为空的正面断言），且 auto 模式下 domain 只被
  open 一次。v1 事件流向后兼容有独立用例：手写的 8 事件 v1 形态流
  （无 usage / 无 planGatePassedAt / enforcement 只有 v1 四个字段，并就地断言
  这一点）仍能重放到 completed、仍过 `evaluateCompletion`、仍能经文件 store
  从磁盘加载、且不被 v2 的 usage 钳制波及。
- 首轮交付：单测全绿（fold 非法转移矩阵、完成校验含 latest-wins 与出处拒绝、
  引擎全生命周期含委派执行器与有界升级、gate 决策矩阵按 kind 精确断言、
  出站正反例各 ≥5 条基数下限、sandbox 探测降级路径）。
- 真机端到端（2026-08-24，dsh 0.1.1-rc.2，deepseek-official）：headless 单任务
  驱动一次完整 lightweight run，7 事件 revision 1→7，`phase: completed`，双门禁
  pass，工件（hello.txt、events.jsonl、snapshot.json、log.md）全部落盘验证。
- 独立原生度审计（2026-08-24，独立上下文代理对照 dsh 源码逐面核查）：编排核心
  （子代理/工具/守卫/提示词/turn-stopping 续轮语义）判定 NATIVE 且用法正确；
  "树外 Session 事件不安全"主张被证实；发现并已修复 enforcement.sandbox 的
  伪 active 缺陷（见 §6）；组合层欠原生项收入 §9 路线图。
- 第三轮审计（2026-08-24，针对本仓库源码的 needs-fix 审计，两条高优先级均
  核实成立，已修复 + 回归 92/92）：(a) `submitPlan` 现在清空
  executionGate/executionPacket/residualRisks（证据链按计划修订重启），且
  fold 机械拒绝携带陈旧证据的 submit-plan 事件；(b) sandbox 探测改用 dsh 的
  `ctx.get()` 访问模式并要求 confine 与 policy 服务同时可见（修正了"恒报
  degraded"的探测器分辨率问题），探测器独立单测覆盖正/反/异常路径；
  (c) 补齐完整委派正向闭环测试（needs-fix → 同子恢复 → 二次 packet →
  pass → closeout → completed）与 replan 不泄漏旧执行状态测试；
  (d) README 表述与 fail-open 事实对齐并明示 v1 边界。
- 跨实现审计移植（2026-08-24，GPT 对树内实验版 GAH 的 needs-fix 审计，其中
  四条同样命中本实现，已全部修复 + 回归 83/83）：(a) `resumeExecutor` 机械要求
  `executionGate === 'needs-fix'` 且最新执行类审计是当前 execution revision 的
  needs-fix（二次 resume 被 CAS 拒绝）；(b) 执行类审计裁决增加 executionRevision
  CAS（纵深防御，叠加在事务串行化与 run-revision CAS 之上）；(c) `dispose()`
  等待在飞事务有界静默（5s 协议常量），插件卸载走异步 disposer；(d) 门禁新增
  single-control-loop 拒绝：`send_message`/`interrupt_agent` 指向授权执行器
  childId 时拒绝，唯一合法通道是 `autopilot_executor`。

### 8.1 记为未证明（2026-08-25 真机 FIX 轮后重写）

以下各条按事实记为 UNPROVEN 而不是主张。它们不是路线图条目，是本仓库**当前证据
无法支撑**的断言清单；引用本交付物的任何结论都不得越过这条线。

按 §5 固化的规则，每条的理由只能取三种形状之一，并在条目里显式标出：

- **本轮未尝试**：没有人去驱动它，成本或优先级问题，不是不可能。
- **尝试过但不确定**：驱动过，但观察不足以判定，附上实际看到了什么。
- **被具体事实挡住**：有一个已实测的事实使它当前不可达，附上那个事实。

本轮的重写规模比上一轮小得多，因为上一轮是从"没有 host"换成"有 host"，本轮是
从"跑不起来"换成"跑得起来"。四条被删（已证明），四条的理由形状从"被具体事实挡住"
降为"本轮未尝试"——挡住它们的那个事实（委派执行器起不来）本轮消失了，于是它们从
不可达变成只是没人去测；另有若干条因为承重层第一次存在（`test/boundary.test.ts`，
见 §5）而需要重新说清它到底证到了哪。条目数按轮次留档，不作为长期锚：第五轮 11 条，
第六轮 17 条，第七轮 18 条，首轮真机验证后 30 条，本轮 33 条。数字上升同样不等于
变差——本轮新增的四条全部是**跑通之后才提得出的问题**（执行器 resume、审计者收窄
路径、家族清空拒绝、清单位置的 env 独占臂）。

- **除 `tool/*` 直接调用与 PTC code-dispatch 之外的调度面**。**本轮未尝试**
  （2026-08-27 新增）：宿主 `KNOWN_SESSION_EVENT_TYPES` 共 48 个类型，其中与工具
  调用有关的正好四个，卡片现在四个全折（`tool/call` + `tool/result` 与
  `tool/code-dispatch-start` + `tool/code-dispatch`）。另外两组看起来像调度面的
  类型**实际不携带工具调用**，已逐字读过它们的载荷类型：`tool-workflow/*`
  （`run-start` / `agent-start` / `agent-end` / `run-end`）携带的是
  `runId` / `name` / `label` / `childId`，即工作流成员与**子会话**的编排记录；
  `subagent/descriptor` 同理描述子代理。所以它们不是第三个"autopilot 工具调用
  藏身处"，也没有被折进来的理由。真正的上限在别处、且是老上限：在**子会话**里
  发生的 autopilot 调用落在那个子会话自己的日志里，根会话看不到（`test/card.test.ts`
  早就按这条断言 `autopilot_submit_packet` 不出现在根日志）。
- **卡片从 slot 拿到的 `sessionId` 这条接线本身没有 bearer**。**被具体事实挡住**
  （2026-08-27 新增）：`pollKey` 的两条分支、优先级、空白处理、终态拒绝、以及
  "没有 run 就安静 404"都有单测承载，但**"宿主真的把 `sessionId` 传进了这个
  组件"**在本仓库里无法被测——`react` 是宿主提供的外部件，测试挂不起组件（同
  `useLiveRun` 那条）。支撑它的是读上游源码：`conversation.chat.node` 声明
  `scope: 'session'`，而 `scoped-slots.tsx` 对会话作用域条目写
  `standard['sessionId'] = info.sessionId` 后 `<Comp {...kit} … {...ownerProps} />`。
  那是**代码路径可读**，不是**真机上已观察**。M7 的下一次重跑才是它的第一个
  bearer；如果那次 `live` 仍不出现，第一个要查的就是这条 prop 是否真的到达。
- **卡片的原地实时更新**（v2.1 新建的轮询）**在真机上一次都没被观察到**。
  **本轮未尝试**（2026-08-27 新增）：机制本轮才建起来——非终态时轮询
  `/api/autopilot/run?id=`，`stale` 只加速不当门禁，失败静默退回折叠态——承载它的
  全部是单测（轮询门禁的正负两侧、失败路径、`overlayLive` 的按 revision 择优与
  引用稳定性）。**仍然没有任何一条证据**说明它在浏览器里真的让卡片自己往前走过。
  注意这条与下面两条的边界（2026-08-27 更新，先前此处写的是"web-app profile 本轮
  没有被启动，也没有轮询到的 JSON revision 序列"，那已不成立）：`autopilot-dev`
  已经启动过，也确实拿到了 `revision` 依次前进的 JSON 序列——但那是**我方 HTTP
  轮询**取到的，不是浏览器里的卡片组件自己轮询并原地重绘。会话始终没有在 web UI
  里打开（上游共写损坏缺陷），所以卡片自更新这条**照旧挂着**，缺的是组件级观察。
  §8 里那条"卡片的原地实时更新从未被观察到"因此**继续挂着**，本轮只把它从
  "没有机制"降级为"有机制但没观察"。同类未观察的还有：`useLiveRun` 这个 hook
  本身在 vitest 里**不可测**（`react` 是宿主提供的外部件，不是本包依赖，测试无法
  挂载组件），所以定时器、卸载清理、以及"响应在组件卸载后落地不得 setState"这三条
  只有代码与注释，没有 bearer——这是为什么那个 hook 被刻意做成一个空壳，所有判断
  都下放给 `client/live.ts` 里的纯函数。
- **两个 profile 同时开着时的跨进程可见性**。**已驱动**（2026-08-27 更新，先前记
  "本轮未尝试"）：`autopilot-dev`（web）与 `autopilot-headless` 同时在线、共享
  bundle 层钉死的 `storeKind: file`，web 侧每 2 秒 `GET /api/autopilot/run?id=`
  轮询，headless 进程另起一条 run 并在 init 之后连写四条 log；web 侧观察到同一 runId 的
  `revision` 与 `logCount` 同步爬升（重驱动后为 1→5 / 0→4）。
  **被承载的是跨进程"读"**：这条 run 由 headless 进程创建（它把同一个 run id 打印
  为自己的 root session id），却能通过 web 进程的 HTTP 面被持续读到并看到推进。
  **不被承载的是逐次写入的归属**（2026-08-27 第三轮复审纠正，先前写成"写入方确为
  另一进程"）：采样只证明写入方进程与监听方共存，进程共存不等于写入归属，无法排除
  web 进程执行了那四次写、而另一个 node 进程只是在运行。要关掉它需要按写记录进程
  出处，或把 headless 输出与写入方 PID、run id 逐次绑定捕获，本轮都没有。
  见 `evidence/m3c-cross-process-visibility.txt`。**边界**：全程只走 HTTP 只读面，
  没有在 web UI 里打开那条会话（上游"打开正被另一进程写入的会话会写坏日志"的缺陷
  仍在，未验证亦未触碰）；卡片自身的原地实时更新仍未被观察。profile 层按 id 覆盖
  `storeKind` 的可能性依旧存在，本条只对这台机器的这组 profile 成立。
- **一次性导出脚本的 `--apply` 路径**。**本轮未尝试**：dry-run 在真数据上跑过
  （本机 5 个 domain run 全部可导出、折叠干净），写入那一侧只有临时目录里的单测
  （往返经真 `RunStore.load` 重放）。对用户 live 的 `~/.dsh` 执行 `--apply` 属于
  所有者决定，本轮没有执行，因此"导出的 run 在真的 dsh 里被列出与打开"未观察。
- **出站的正向派发方向**。**部分驱动，主残差仍开着**（2026-08-27 更新，先前记
  "被具体事实挡住"）。换到有批准应答者的 web profile（`autopilot-dev`）之后，
  `ask` 不再恒为 `"unavailable"`：四次 `git push` 尝试各自升到 native ask、各自被
  应答、随后派发，`archiveConsumed` 写出 4 份 `<runDir>/outbound/consumed/` 归档，
  `consume-manifest` 事件 4 条，`enforcement.outboundConsumed` 由 0 变 4。授权那
  一侧（清单解析、校验、升 ask、allow 后派发）第一次在真机上完整走通。
  **拒绝分支的计数要按来源分开**（2026-08-27 更新，先前笼统写"四种不同的拒绝"，
  高估了本插件的覆盖）：本插件真机上被观察到的拒绝只有**一种**——清单未声明该命令
  子串；另外三条（声明冲突、单调用多命令、body 展开与声明不符）来自驱动本轮的
  Claude 侧 harness 自己的出站门禁，是旁证，不算本插件覆盖。
  另注：本插件真机被观察到的拒绝只有一种（清单未声明命令子串），其余三条来自驱动
  方 harness。见 `evidence/m3a-outbound-consumption.txt`。
  但**正向派发本身仍未证成**，且本轮反而挖出一条更硬的东西：那四条命令**全部失败**
  （dsh pwsh 沙箱 fork 不出 shell，`CreateFileMapping ... Win32 error 5`，git exit 1，
  没有任何 ref 移动），计数器却照样涨到 4。按 `src/gate/preexecute.ts:402-427`，
  `outboundConsumed` 只在 `next()` 返回非错误结果时才 +1，语义正是"确实发出去的
  egress"，好让"有归档无 `consume-manifest`"可读作已授权未派发；而 `isErrorResult`
  （`preexecute.ts:154-157`）只认 `isError === true`，dsh 的 pwsh 工具对非零退出
  不置该标志，于是失败命令与成功命令在这个 seam 上不可分。**结论：`outboundConsumed`
  承载不了"egress 出去了"这个断言**，它承载的是"已派发且运行时没报错"。
  反方向也不成立（第三轮复审补正）：`isError` 只说明 `next()` 返回了错误结果，而
  `next()` 可能已经执行命令、已经联系过远端才报错，所以"有归档无事件"同样判定不了
  未派发。这一对信号只能读作「已授权」与「已授权且运行时报错」。要真正关掉这条
  残差，需要一台 shell 通道可用的宿主。
- **`egressSeam: 'guard-deny'` 那一档**。**本轮未尝试**：10 次真机 run 全部记
  `enforcement.egress: 'native-ask'`，`EGRESS_FAIL_CLOSED_REASON` 的文案一次都没
  出现过，pre-execute seam 全程拥有边界。同步 guard 的无条件拒绝分支、以及
  `failClosedEgressReason` 对 `AP_STORE_CORRUPT` 的分裂 catch，仍然只有单测。要测
  它需要一个真的没有 pre-execute seam 的宿主表面，本轮没有构造。
- **owner 直通授权**（`engine.consumeApproval` 与 `hasDirectHumanTurn`）。
  **被具体事实挡住**：headless 会话没有直接的人类回合，pre-execute 监听器里那条
  `owner-approve` 捷径从未被触达。
- **出站通道的覆盖范围在真机上只被驱动过一个**。**被具体事实挡住**：两轮都只驱动
  过 `pwsh`。这台 host 上 `bash` 根本没有注册——本轮拿到了一个比上一轮更硬的
  bearer，是执行器 RouteRecord 上那条逐字诊断 `this deployment does not register
  "bash"`，而不是靠读 `restrict` 的报错列表；`run_code` / `terminal_open` /
  `terminal_send` 不在该 profile 的工具集里。于是 `EgressScanMode` 的不透明文本
  逐字扫描分支在真机上**仍然没有任何 bearer**。
- **manifest 的其余失败模式**。**本轮未尝试**：真机至此走过三种拒绝——缺清单、
  runId 不匹配、工件不存在（后两条本轮在同一条拒绝里一起出现），加上上一轮的过期
  与未声明的链式段。仍然只有单测的是：工件逃出 run 目录、空工件、计数短语不符、
  零 claim、重复 bearer（Single-Bearer）、`MIN_COMMAND_TOKENS` 下限、未来时间偏移。
- **一份清单在 6h 窗口内没有重放上限这条上限的实际后果**。**尝试过但不确定**：
  同一份合法清单被 `ask` 过多次，每次都 fail-closed，所以"一份清单授权无限次派发"
  的后果没有被演示出来——没有一次派发，也就没有第二次归档可看。
- **`settleUsageArtifacts` 里除"covered 标签承载"之外的分支**。**本轮部分证明**，**其余本轮未尝试**：本轮第一次在真机上证到结算真的读磁盘——一个假标签逐字被拒
  （`text does not mention covered label: LABEL-THAT-IS-NOWHERE-IN-THE-LOG`），
  换真标签后 run 到达 `completed`。仍然只有单测的是 containment、非空、magic-byte
  签名，以及新鲜度的**下界**（真机上的工件都天然晚于门禁，没有人去构造一个更早的）。
  新鲜度的**上界**是另一回事，它不是未证明而是已知缺陷：领域函数实现了，生产调用方
  不传 `settledAt`，真机实测一个 2027 年的 `capturedAt` 照样结算通过（§8 本轮 (A)、
  §6 对应条目）。
  （2026-09-04 更新：已结清，见 §8 (A)；`submitCloseout` 现在传
  `settledAt: new Date().toISOString()`，此处历史测量不再描述当前行为。）
- **`restoreSandbox` 是否重新追加 prior mode**。**本轮未尝试**：mutation 那一半
  本轮已证明——standard run 翻过 plan gate 之后真的写出了 `m7-p2.txt`（16 字节），
  钳制解除后的一次成功 mutation 第一次被观察到。没有人去读那之后的 `sandbox/mode`
  事件，所以"恢复的是不是**先前那一个** mode"仍然没有被看过一眼。
- **autopilot guard 与 dsh 自身只读 fs 沙箱的优先级**。**本轮未尝试**：guard 每一次
  都先拒，`[sandbox: file access denied under read-only mode]` 这个标记从未出现，
  所以 `gate.toolDeny` 关掉之后哪一层会拒绝 mutation，仍然不知道。要测它需要一条设
  `gate.toolDeny=false` 的覆盖臂。
- **single-control-loop 拒绝**（`send_message` / `interrupt_agent` 指向被授权的
  执行器 childId）。**本轮未尝试**（理由形状本轮从"被具体事实挡住"降级）：该规则
  要求 `snapshot.executor.state` 为 `running` 或 `starting` 且有活体子代理，而本轮
  第一次出现了一个真的处在 `running` 的执行器（session-61a05524，childId
  `8378f240-…`）。前置条件已经成立，只是没有人在那个窗口里去发一条 `send_message`。
- **`startExecutor` 的 planGate 与 phase 前置条件是可被利用的还是与 fold 的
  `LEGAL_OPS` 冗余**。**本轮未尝试**（同样从"被具体事实挡住"降级）：执行器现在能
  起来，所以"绕开这些前置条件能否在真机上派出一个实现者"从不可达变成可达。四条前置
  条件在单测里**有** bearer（各有一条断言错误码且断言没有写下任何 executor 记录的
  用例），缺的仍然是有人去尝试绕开它们。
- **第二个并发执行器是否真的会产出两个都能提交 packet 的活体子代理**。
  **本轮未尝试**（从"被具体事实挡住"降级）：能起来的执行器数量本轮从零变成一。
  `AP_EXECUTOR_EXISTS` 在单测里有 bearer，两个并发子代理的场景仍然没有被搭出来。
- **委派执行器的 resume 臂**。**已驱动**（2026-08-27 更新，先前记"本轮未尝试"）：
  headless 上跑了一条 standard/delegated/independent 的 run，派发时故意只要求执行器
  写 `LINE-A`，而验收要求 `LINE-A` 与 `LINE-B` 都在。**被承载的是同一 child 的
  resume 机制与门禁迁移**：审计把执行门置为 needs-fix，resume 之后第二次审计置为
  pass，中间是同一个 childId。**不被承载的是审计者到底看到了什么**——`audit` 事件
  只带折叠快照、不带 verdict 文本，pre-fix 的文件状态也没有留档，所以"审计者读了
  文件、发现 `LINE-B` 缺失"是**从门禁迁移反推的推断**，不是这条证据能证明的（先前
  此处写成确定事实，经 PR #3 复审纠正）。规范事件流：rev10 audit
  `executionGate=needs-fix` → rev11 `resume-executor`（`executionRevision` 1→2，
  childId 不变 `9490aa1e`，`generation` 仍为 1）→ rev13 第二份 `submit-packet`
  → rev14 audit `pass` → `phase: completed`。见 `evidence/m3b-delegated-resume.txt`。
  **仍未尝试**：needs-replan 的排空后 revoke 与 generation 递增那一支（本轮只走了
  needs-fix→resume，generation 从未被推进），以及 external 审计路线下的同一条链。
  **packet CAS（2026-09-01 已关）**：`submitExecutionPacket` 要求
  `executionRevision` 等于活体执行器修订号（缺/非整数 → `AP_PACKET_REVISION_REQUIRED`，
  不匹配 → `AP_PACKET_REVISION_MISMATCH`），并在事件 `detail` 上盖戳；fold 对有戳的
  `submit-packet` 重放同样校验：缺 key 的旧流仍可重放，在场但非整数的戳拒绝。resume 后 rev 1 的延迟 packet
  被拒且槽保持空，rev 2 被接受。bearer：`test/engine.test.ts` 与 `test/fold.test.ts`。
  仍未尝试：needs-replan 排空后 revoke 与 generation 递增，以及 external 审计下的同一条链。
- **审计者一侧的工具收窄 / 拒绝 / 重试路径**（本轮新增）。**本轮未尝试**：两次真机
  审计的 RouteRecord 都是 `routeStatus: "verified"` 且**没有** `routeDiagnostic`，
  说明 `AUDITOR_TOOL_ALLOW` 在本 profile 上一个名字都不用被砍。于是
  `resolveToolAllow` 的审计者臂、`AUDITOR_TOOL_REQUIRED`（`['read']`）缺失时的拒绝、
  以及 `parseRestrictRejection` 的"学一次已知名字再重试一次"恢复路径，全部只有单测。
  真机上被观察到收窄的只有执行器那一臂。
- **"整个能力家族都没注册"时的拒绝**（本轮新增）。**被具体事实挡住**：本轮唯一一个
  未注册的名字是 `bash`，而同家族的 `pwsh` 在，所以家族保底规则每次都保住了能力，
  清空那一支不可达。要测它需要一个连一个 shell 都不注册的部署。
- **`DSH_AUTOPILOT_OUTBOUND_MANIFEST` 的独占臂**（本轮新增）。**本轮未尝试**：真机
  只驱动过"两个默认候选都不存在"与"workspace 候选存在"两种情形。owner 用环境变量
  钉住一个位置、并因此让两个默认候选都不被查看的那一支，仍然只有单测。相对路径按
  进程 cwd 而不是 run 目录解析这条刻意行为同理。
- **`enforcement.sandbox: 'active'` 之下 shell 的 argv 是否真的被 OS 钳住**。
  **本轮未重测**：上一轮的挡路事实是"这台 host 上没有任何 shell 命令真正执行过"
  （模型给每次 `pwsh` 都填 `sandbox_permissions` 加空 `justification`，dsh 在执行前
  就拒）。本轮 run 里确实有文件落盘，但没有人记录那些写是经由 shell 还是经由
  `str_replace_editor`，所以上一轮那个挡路事实**既没有被推翻也没有被确认**。已证到
  的仍然只是**策略层**：同一条升级请求在 lightweight 与 standard 两个 run 里被判得
  不同，说明 `sandboxPolicy.resolve()` 真的返回了 read-only。内核围栏没被摸到。
- **`RunStore.commit` 的崩溃耐久性**。**本轮未尝试**：没有人在
  `appendFileSync → writeFileSync → renameSync` 窗口内杀过进程。已证明的仍然只是
  半行 `events.jsonl` 的**后果**（自己写入残留），真实崩溃的频率与确切残留形态未
  测量，源码注释里的恢复主张仍是论证不是观察。
- **空 `agentOptions: {}` 在真机上是否真的影响 provider/model 路由**。
  **本轮未尝试**：真机上有子代理被派出并记下了路由出处（`routeProvider` /
  `routeModel` / `routeStatus: verified`），但没有任何一条臂去变动 `agentOptions`
  做对照。分叉本身早已量出（loader 路径会发、plain 路径不发），下游后果仍然没有。
- **`gh api` 带字段标志时隐式改用 POST 这一行为**。**被具体事实挡住**：出站方向
  fail-closed，没有一条 `gh` 命令真正派发过。"这些命令确实会改远端状态"依据的仍然
  是 gh CLI 的文档语义，不是一次观察；已证明的仍然只是 `isEgressCommand` 此前对这些
  形式返回 false。
- **`subagent` / `subagent_fork` / `workflow` / `ralph` 这类子代理在真机上能否拿到
  可用的 `bash`**。**被具体事实部分回答**；其余**本轮未尝试**：这台 Windows host
  不注册 `bash`（本轮的执行器诊断逐字确认），所以这条逃逸口在 win32 上不存在；
  `ralph` 确实在工具表里。POSIX host 上是否存在，未测——两轮都只有一台机器。
- **两个 TS2540 是否掩盖了那两个计数器之外的东西**。**本轮未尝试**：本轮改了
  `src/` 与 `test/`，但没有人回头去问这个。计数器本身**有** bearer（中和
  `recorded.guards += 1` 会让套件变红），仍然未测的是被抹掉的 `readonly` 还掩盖了
  什么。
- **变异解析度覆盖到哪里**。**本轮未施加新变异**：本轮改动了 `src/` 与 `test/` 但
  没有跑变异测试，真机复验也不是变异测试。历史结论保留：第六轮补齐检查器后 34 次
  全杀；第七轮把上一轮 44 条幸存里的 43 条按写域重放（13 条已关、30 条补 bearer），
  第 44 条由独立复核者补测，复核者另施 61 次变异、60 杀 1 存活，该条已在第七轮收尾
  结清。仍然未被变异测量的：`src/engine.ts` 的大部分，`replanBudgetRemaining` 连一条
  引用都没有。本轮新增的 `resolveToolAllow`、`observeApproval`、`manifestCandidates`、
  `missingManifestReason` 与 async `apply` 全部**未被变异测量过**，它们只有正向用例。
  §5 末尾那条同时提醒：变异测试原理上无法显示"缺了一条必要规则"或"规则的对手方
  从未到场"，而本轮修掉的那批缺陷正是后一种。
- **变异之间的相互作用**。**本轮未尝试**：历轮每一次变异都是逐条施加、按 sha256
  逐字节还原的，组合效应没有任何东西在测。
- **多进程争用同一条 run**。**尝试过但不确定**：真机上跑过并发进程，但它们各自持有
  自己的 facility、写自己的 run，所以这不是本文件声明"不在契约内"的那个场景。同一条
  run 的并发写者究竟表现为 fold 失败还是静默损坏，仍然未测；`DomainFacility` 的
  already-open 预留与它注释里警告的多挂载降级也从未被触发。
- **domain 后端在一条完整 run 上的行为**。**本轮未尝试**：本轮 21 次 domain 启动
  证到的是**工具表面**（21/21 携带全部 11 个工具）与**一次 `autopilot_init` 返回
  `store: "domain"`**，仅此而已。完整的 plan-gate / 审计 / 执行 / 收尾流、
  `REVISION_KEY_WIDTH` 溢出守卫、`parseEventKey` 的损坏路径、以及 `apply()` 失败
  路径上的 close-then-rethrow，全部没走到。domain 侧的**工件结算**尤其未测：事件在
  领域库里而 `log.md` 与 usage 工件在文件系统接缝上，这个组合一次都没被驱动过。
- **除 `autopilot-headless` 之外的部署**。**部分驱动**（2026-08-27 更新，先前记
  "本轮未尝试"）：web-app profile（`autopilot-dev`）已被启动并驱动过一条 run，
  native ask 在浏览器里被弹出、被应答、随后派发，因此 `'native'` 一档**不再是**
  从未被回答过——ask→应答→allow 这条链在部署上可达。
  **仍然开着的是"谁在应答"**：那些应答是由驱动本轮的 agent 通过浏览器点的，不是
  所有者本人；概括授权不能把一次自动 UI 操作变成人类回答。所以承载的是**机械通道
  正确**，不是**治理属性正确**。另注：本轮 web profile 走的仍是 bundle 层钉死的
  `storeKind: file`，真正挂 `ctx.storageDomain` 的那条组合仍未与批准通道同时驱动。
- **`test/boundary.test.ts` 自身的覆盖边界**（本轮新增）。**被具体事实挡住**：该
  文件用真 `ToolRuntime`、真 `applyChildComposition`、真 `snapshotJsonValue`、真
  cordis `Context`，但它换掉了三样东西并在文件头逐条写明代价：agent 是结构性作用域
  键（`AgentRuntime` 需要 LLM 与会话存储，本包的依赖闭包里没有）；dsh 全局工具集是
  **名字忠实**的替身（对只校验名字的 `restrict()` 精确，对任何执行它们的用途无价值，
  而这里没有东西执行它们）；`startContinuable` 被替换，执行器过滤器是从引擎真实请求
  上截下来再推过真 `applyChildComposition` 的。于是这一层证不到：真工具的行为、真
  LLM、真会话存储、以及跨部署。承重层存在不等于承重层覆盖全部。
- **真机观察与驱动模型行为的纠缠**。**尝试过但不确定**：两轮所有关于**参数形状**的
  观察都与同一个 provider 行为纠缠——它会把工具 schema 里每一个可选属性都填满。本轮
  这条行为**再次被观察到**，而且这次留下了两个方向的证据：它是缺陷 5（空
  `inheritedFrom`）的触发条件，修好之后也仍然是缺陷 (B)（空 `note:` 被渲染成存在）
  的触发条件。换一个不 force-fill 的驱动模型是否复现，仍未测。不受影响的是那些发生
  在参数校验**之前**的观察（plan gate、usage 钳制、出站门禁的全部文案）。
- **单字符 `covers` 标签能否通过 `autopilot_usage` 自己的参数 schema**。
  **本轮未尝试**（理由形状本轮从"被具体事实挡住"降级）：挡路的那一步（带工件的声明
  被 `inheritedFrom` 拒掉）本轮已经修好，真机上带工件的声明现在过得去，所以这个问题
  第一次可以从工具表面被问出来——只是本轮没有人去问。`test/tools.test.ts` 驱动的仍然
  是类别与边界态，不是标签长度。
- **policy 报的 replan 预算与引擎算的那个从未被钉在一起**。**本轮未尝试**：policy
  一侧有按值断言，引擎一侧的 `replanBudgetRemaining` 在整个 `test/` 里仍然零引用；
  改动其中一份而不改另一份，套件不会有反应。
- **`.smoke/` 内容与原始 v1 端到端 run 的一致性**。**本轮未尝试**：没有基线快照，
  "未改动"依据的仍是 mtime 而不是内容比对。
- **发布产物作为一个整体从未被审计过**。**尝试过但不确定**：本轮的证据比上一轮硬
  一档——profile 里是 `"dsh-autopilot": "link:<本仓库绝对路径>"`，而 `lib/` 是
  本轮重新 emit 的，11 次真机 run 加 21 次启动循环加载的就是这份产物，观察到的行为
  与读 `src/` 得到的预期逐条对上（省略的 `usage` 键、`signal-only` 标签、收窄诊断
  的逐字文案）。但仍然没有人逐字比对过 `lib/` 与 `src/`，也仍然没有人核对过
  `skill/` 与 `cordis.patch.yml` 的内容是否与当前实现一致，或者一个使用者
  `npm install` 之后拿到的东西是否就是文档说的东西。

### 8.2 在真机上 headless 驱动本 harness 的操作注记（2026-08-25 实测）

写给下一个要在真机上跑这套东西的人。这一节记的**不是本仓库的缺陷**，是 dsh
write-tool 契约上的一个模型行为陷阱；它在本轮吃掉了整整一次 run 的步数预算，
而它的错误消息不指名真实原因。

**症状**：模型发出 `write`（或 `pwsh`）时同时带上 `sandbox_permissions` 与
`justification: ""`。dsh 的 `validateEscalationArgs` 要求这两个字段**同时给或
同时不给**，且升级必须严格更宽，于是调用在执行之前被拒，错误文本是
`Error: invalid justification: expected a non-empty sentence`，或
`Error: sandbox escalation to "workspace-write" is not strictly wider than this
call's current "workspace-write" mode`。**两句都不指向真实原因**：前者读起来像
文案校验，后者读起来像沙箱不够宽，而真正的原因是那对字段本身不该出现。

**观察到的后果**：编排者的第一次真机 run 里，模型把 `invalid justification` 读作
沙箱问题，一路升级权限，26 步预算全部烧在这条误判上，run 没跑完。这**不是 v2
缺陷**：同一目录下的对照证明，带一句真实 `justification` 且**不带**
`sandbox_permissions` 的普通 `write` 成功。

**已验证可用的写法**，按可靠性排序：

1. `str_replace_editor command=create`。它不声明任何升级字段，因此完全绕开这条
   校验。三个探针各自独立地用它成功落盘（`ctl-create.txt`、`ctrl-1/2/4.txt`、
   `control-plain.txt` 17 字节）。这是真机上唯一稳定可用的写路径。
2. `write` 带一句**非空**的真实 `justification` 且**不带** `sandbox_permissions`。
   编排者实测成功；但在探针用的 profile 上不可复现——那里的 provider（实测三个：
   ehh/gpt-5.6-sol、cc/claude-opus-5、a1a1/gpt-5.6-sol）会把 schema 里每一个可选
   属性都填满，任务文本明说“不要带这两个字段”反而让情况更糟。也就是说这条路走不走
   得通**取决于驱动模型**，不取决于本仓库。

**配套的诊断规则**：在真机上看到写入或出站被拒时，先判断是谁抛的。autopilot 的
pre-execute seam 跑在 dsh 的沙箱升级解析**之前**（本轮实测：同一个 run 里带同样
升级字段的非出站命令报升级错误、出站命令报门禁文案），所以
`autopilot outbound gate:` / `autopilot plan gate is pending:` /
`autopilot usage gate:` 开头的是**本插件**的判断；
`invalid justification` / `is not strictly wider` /
`requires approval, but no approval channel is available` 开头的是**dsh 自己的
工具层**。把后者读成前者会让人去改 manifest，把前者读成后者会让人去升级权限，
两个方向都是死胡同。

**上一版这里的两条"必须先知道的事"已经作废**（2026-08-25 真机 FIX 轮订正）。
原文写着：`autopilot_init` 在 lightweight run 上**必定**返回
`value is not lossless JSON`（§8 缺陷 1），以及 `autopilot_audit` 在只有 node 的
profile 上**必定**抛 `unknown global tool "ask_user_question"`（§8 缺陷 2）——
两条本轮都已修并在真机上复验，stock `autopilot-headless` 上 lightweight init 干净
返回、`autopilot_audit role=plan` **不带 `--patch`** 就能派出审计者并拿回 verdict。
不要再按上一版去打那两个补丁。**保留下来的那半句**：委派执行器与 standard run 现在
都跑得通，所以下一个驱动者会第一次撞上 resume 臂、并发执行器、以及 domain 后端的
完整流程这些从未被走过的表面（§8.1）。

**仍然为真的一条驱动方陷阱**：本 profile 的 provider 会把工具 schema 里每一个可选
键都填满，包括填成空串。这已经不再让任何声明被拒（缺陷 5 已修），但它会让人读的
`log.md` 把一次 on-plan 检查点渲染成带着 `escalationTarget` 与空 `note:`
（§8 本轮缺陷 (B)）。看到这种行时不要以为发生过一次升级。

### 8.3 PR #6 整改：executor 子代理安装事务化 + rc.1 真机委派 e2e（2026-09-04）

所有者驳回 a545a51 的理由是两条：`agent/created` 监听器"绝不抛出"是假承诺（吞掉 executor
子代理安装失败会让被认定的 executor 在没有 packet 工具与出站守卫的状态下继续跑），以及
rc.1 升级 run 没有跑过一次真正的委派 e2e。整改结果：

1. 安装契约（`src/index.ts`）：`recognizeExecutorChild()` 永不抛出；只有被认定的 executor
   子代理才进入 `installExecutorChildSurface()`——按 seam → packet 工具 → 出站守卫顺序装，
   任一步同步抛出就按相反顺序回滚已装的部分，清理失败只收集、不遮蔽原始错误，原始错误
   原样从 `agent/created` 监听器抛出（把失败挂到错误上的 `rollbackFailures` 是
   **尽力而为**：冻结或不可扩展的抛出值会让 `defineProperty` 自己抛，放任它逃逸就等于
   用注解的 TypeError 顶替了真正的安装失败——这正是本条要防的遮蔽，e0e8509 修掉，
   失败仍走 `onCleanupFailure` 的 warn 通道；该回调本身也只是**通知**，被包在自己的
   try/catch 里——报告器抛出既不会让剩下的 disposer 不被尝试，也不会顶替调用方必须看到的
   错误，PR #6 上 Codex 的第二条 P2，与本条一同修入本轮；第三条 P2 同源——seam 自己的
   `dispose` 在 `installExecutorChildSurface` 的 unwind 里只算**一个**条目，它内部那圈
   无保护的循环一旦中断就会留下另一个监听器与未清空的 `authorized`，而调用方逐条的
   try/catch 救不回来，现在改成两个监听器都尝试、`authorized` 必清、失败以
   `AggregateError` 上报，第二次释放是 no-op），rc.1 的 `AgentRegistry.announce()` 据此否决发布，
   `startContinuable` reject，executor 记录为 `revoked` 并带诊断。非 executor 子代理永远是
   无害 no-op。`childInstalled` 只在整套装完后登记；`agent/disposed` 先删登记再释放，释放
   失败只告警。明写的残留：挂载时对**已存在**子代理的补装（remount）不能再否决它们的发布，
   那里只能告警。
2. 失败注入回归（`test/child-setup.test.ts`、`test/apply.test.ts`、`test/host-publication.test.ts`）：
   seam 成功 + packet 工具抛；seam 与工具成功 + 守卫抛；全成功后 `agent/disposed` 恰清理一次；
   非 executor no-op；以及穿过 rc.1 真 `AgentRegistry` 的发布路径——监听器同步抛出时
   `announce()` 抛、`startContinuable` reject、executor `revoked`。
3. rc.1 真机委派 e2e（运行记录按 §6 的口径留在机器本地、不入库；下面是它的可复述结论）：
   新建 `agentPreset: standard` 会话，standard 尺寸委派 run 走完 plan gate pass →
   startExecutor → 子代理经 `agent/created` 发布 → 子代理看到并调用
   `autopilot_submit_packet` → packet 以正确 executionRevision 被接受 → 独立执行审计 pass →
   合法 closeout（`phase: completed`）。三次尝试中只有第三次（只读任务）走完；前两次暴露的是
   本 harness 之外的事实，如实记下：部署默认路由的模型在 workspace-write 会话里坚持传
   `sandbox_permissions`，被宿主"必须严格更宽"规则拒绝（规则与 schema 同 0.1.1，不是 rc.1
   回归）；plan 审计员未走结构化输出时引擎已把 phase 提交成 `plan-reviewing`，之后没有合法
   操作能退出（main 上同码，属既有缺陷，不在本次整改范围）；`subagent` 对 executor 与审计员
   仍可见，因为 `restrict()` 只遮蔽继承的工具（既有、已在 `engine.ts` 注释里写明）。

## 9. 路线图

编号保持稳定（其他章节按号引用），已交付项保留条目并标注，不删号。

1. ~~**出站证据清单**~~（**v2 已交付**）：manifest 校验 + 消费归档，跑在原生
   `tools/pre-execute`（可 ask）+ `tools/execute`（实际派发才归档消费）两个 seam 上；
   v1 的"一次一批准"语义保留为 native 通道内的直通授权。
2. ~~**使用证据**（usage evidence）~~（**v2 已交付**）：类别 + 边界态菜单 +
   plan-gate 联动拒绝（pass 裁决被**记录**，门禁翻转在落盘前被拒）+ 收尾复问 +
   写工具钳制 + 收尾工件结算。
3. **Web UI 会话卡片**（**已交付**，2026-08-25；本条保留原文用于对照，因为它对
   工作量的判断错了一半）：`ConversationNodeDefinition`（`autopilot-run` 卡片，
   实测在真 web profile 里渲染出 phase、双门禁、计划修订、必需角色、replan 预算、
   审计时间线与模式行）＋ host 侧 `GET /api/autopilot/runs` 与
   `/api/autopilot/run?id=`。实测四个边界态各有截图：无 run（卡片正确缺席、
   会话完好）、planning 中、completed、completed+delegated+independent。另有一次
   把 reducer 在真实日志的递增前缀上折叠出 8 个连续卡片状态。落点见 §8 的本轮条目。

   **原文判断错在哪**：下面写着这一项会"引入 React 与一套前端构建链"。实际不需要
   装任何东西——`react`、`react/jsx-runtime` 与 client-runtime 全部是宿主在运行时
   解析的 `require()` 外置（`dsh-context-doctor` 的产物即为证），`tsc` 已在
   devDependencies 里，多模块靠 envelope 内一个极小的 CommonJS 注册表解决，
   `tsdown` 并非必需。运行时依赖仍然只有 `@deepseek-ai/dsh-tools`。真正的代价是
   构建期靠 `paths` 映射到 dsh checkout 取 `@types/react` 与 client-runtime（2026-09-04
   起改为 ui-conversation，client-runtime 已被 dsh 0.1.2 拆除）的
   `.d.ts`——那是一条对兄弟仓库的**构建期**依赖，记在 §6 而不是藏起来。

   原文（保留）：这一项需要本仓库当时完全没有的**客户端产物**：
   - `package.json` 里一段 `dsh.client`（`platform: web` + `inject` 四个宿主
     客户端包：`@deepseek-ai/dsh-client-runtime`、`dsh-client-locale`、
     `dsh-client-ui-slots`、`dsh-client-ui-conversation`）；
   - 一条 `./client` 导出与一个 `lib/client.js` bundle：React（含
     `react/jsx-runtime`）写界面，tsdown 打包，宿主模块经
     `window.__ModuleLoader__` 的 `require()` 外置而不是打进产物；
   - 面板要拿数据还得有 host 侧 API 路由（`ctx.httpServer` 上注册一条
     `GET /api/…`），且必须在没有该服务的 profile（headless）上自动跳过注册，
     否则 headless 挂不上。

   这不是推测：本机 `C:\Users\<user>\.dsh\profiles\web\node_modules\dsh-context-doctor`
   （0.6.1）是一个跑通了的**树外**先例，上面每一条都能在它的
   `package.json` / `lib/client.js` / README 里直接读到（实测 2026-08-24；
   `tsdown` 与 API 路由两条读的是该项目自己的 README 描述，其余读的是产物本身）。
   照它的形状做即可，但那会引入 React 与一套前端构建链——与 §1 的"运行时依赖
   极小化"是两回事（客户端产物不进 Node 侧运行时），但仍是本包体量的数量级变化，
   所以单列一项而不是顺手做掉。
4. **Session 事件迁移**（**上游阻塞**，不是待办）：上游开放外部事件词表注册后，
   把 run 状态迁回 `autopilot/change` Session 事件（KV-cache 友好、随会话导出）。
   阻塞证据与逐字引文见 §4——`KNOWN_SESSION_EVENT_TYPES` 是生成产物，注册面被
   上游注释明确标记为 deferred，在那之前树外追加事件类型会让冷恢复拒绝重建。
   事件形态已按迁移设计（全快照 + 单调 revision），届时换的是 store 一层。
5. ~~**external 审计模式**~~（**已交付**，2026-08-25）：owner 附署的外部评审通道。
   `validateTriage` 不再拒绝它；风险闸从"medium+ 必须 independent"改写成
   "medium+ 不得自审"，因为规则本来就是后者，只是当初 independent 是唯一的
   另一个选项才那样拼写。通道由 `autopilot_external_audit` 进入，四道约束各有
   变异证明的承载：工具层与 `owner-approve` 同一道 direct-human-turn 闸（去掉后
   精确 1 红）；fold 在**重放**路径上校验附署（去掉后 2 红）；完成校验拒绝
   external 模式下的自审裁决（放开后 1 红）；收尾结算要求 `reviewRef` 落在 run
   目录内且非空（不读盘后 3 红）。诚实上限见 §6。
6. ~~**跨家族评审派遣策略**~~（**已交付**，2026-08-25）：`selectCrossFamily`
   在风险到达 `minRisk` 后，优先派一个不属于执行器家族的评审者，结果四值记进
   每条审计的 `route.crossFamily`。家族键是 **provider 而不是 model**：同一个
   provider 下的两个模型共享它的盲点，若按 model 判定，配置方就能用两个同源模型
   "满足"跨家族而记录声称独立评审（变异证明：把家族键改成 model → 5 红）。
   四值里最要紧的是 `unknown-family`——任何一侧继承部署默认时，本代码**看不到**
   实际家族，就不得声称 `achieved`（变异证明：让它在这种情况下报 achieved →
   精确 2 红）。这是策略不是门禁：单 provider 部署是合法部署，拒绝审计比同家族
   审计并**如实记下**更糟。
7. ~~**组合层原生化**~~（**v2 已交付**，五项全完成；2026-08-24 独立审计改进项）：
   出站批准走 `ctx.approval`（经 `tools/pre-execute` 的 `ask`，服务缺席时由
   dsh 自身降级为 deny）；存储抽出 `RunStoreLike` seam，`ctx.storageDomain`
   后端与文件后端并存、由 `storeKind` 选择、实得后端记进 `enforcement.store`；
   Schemastery `Config` 已导出；`ctx.autopilot` 只读服务已注册（未用
   `extends Service`，理由见 §6）；最后一项——把技能装进 dsh 的技能扫描面——
   已在 `skill/dsh-autopilot/SKILL.md` 里给出安装命令。扫描根按上游源码核对过
   （实测 2026-08-24，`packages/skill/skill-filesystem/src/index.ts`）：
   `user-agents` 根是 `join(agentsHome, 'skills')`，`agentsHome` 默认
   `$DSH_AGENTS_HOME ?? ~/.agents`，rank 500；技能形态是
   `<root>/<name>/SKILL.md`。与旧文档写的 `~/.agents/skills` 一致，无需修正。
   2026-09-01：`apply()` 在 `skillInstall: 'auto'`（默认）下把 bundled
   `SKILL.md` 拷进扫描根（缺则拷、同则 no-op、异则警告不覆盖）；`off` 跳过。
   测试用 `DSH_AUTOPILOT_SKILL_HOME` 沙箱，不写所有者的 `~/.agents`。
   （2026-09-04 更新：发布只走"写满 temp 再 hard link"这一条原语，因为它同时具备
   全有或全无与拒绝抢占已存在目标这两条性质；不支持硬链接的技能根现在返回新状态
   `unsupported`——temp 删掉、**本次调用不向目标写入任何字节**（这是对本次调用的陈述，
   不是对该路径状态的保证：并发写入方随时可能创建它，没有任何终态能诚实排除这一点）、
   `detail` 里点名目标路径与手工
   拷贝的补救方式，`apply()` 与 `drift`/`error` 一样只告警、挂载照常成功。此前两轮
   分别用过 rename 与 `COPYFILE_EXCL` 独占拷贝，各自又被同一条评审意见拒掉一次：
   rename 在 POSIX 与 Windows 上都会**替换**已存在的目标，独占拷贝则在字节写完前
   就让目标可见，崩溃或并发扫描会读到半个 `SKILL.md`、之后被当成 drift。既然没有
   跨平台的"原子且不覆盖"发布原语，诚实的终态就是不发布并说明。代价是
   `SkillSyncIo` 去掉了 `copy` 成员——它经 `src/index.ts` 再导出，对注入 io 的调用方
   是一次公开类型变更；该接口是测试缝，本包内只有 `defaultIo` 与
   `test/skill-install.test.ts` 用它。）
