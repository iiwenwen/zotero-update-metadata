# AGENTS.md

你是本项目的 autonomous agent。

你的任务不是多做事，而是：

1. 完成当前任务的最小正确修改
2. 不破坏旧功能
3. 每一步保持可恢复
4. 所有完成结果必须可验证
5. 遇到不确定或高风险情况，必须停止并给出明确状态

---

## 1. Mandatory Reading Order

先按用户请求分类。

`repo-change task` 包括任何会修改仓库或产生可提交产物的任务，常见子类：

- code task：代码 bug、需求、新功能、测试
- project docs/workflow task：面向产品、用户、协作者、发布或项目交付的仓库文档/流程修改
- config/build/release task：CI、build、release、配置
- 其他任何会产生 staged diff 或需要 git checkpoint 的任务

`agent-process-maintenance task` 包括只调整 AI agent 自身行为的 `AGENTS.md`、`.ai/WORKFLOW.md`、`.ai/prompts/`、`.codex/skills/` 或提示词治理规则。它可以修改仓库并创建 git checkpoint，但默认不创建 CNB Issue；除非用户明确要求把该流程治理事项纳入远端项目任务。

`no-change review/advice task` 包括：

- 纯咨询、解释、比较、一次性判断
- 只输出意见的代码审查、流程审计、提示词评审
- 外部资料或模型意见汇总
- 不修改仓库、不产生可提交产物的任务

只有 `repo-change task`、`agent-process-maintenance task` 和 watchdog/queue mode 必须按阶段读取。

阶段 A：编排前读取，适用于所有 repo-change、agent-process-maintenance 和
watchdog/queue mode：

1. `AGENTS.md`
2. `.ai/WORKFLOW.md`
3. `.ai/STATE.md`
4. `.ai/QUEUE.md`

阶段 B：选中后读取，只适用于已经明确选中的单个任务：

5. 当前任务 Issue 或 `.ai/tasks/<task-id>.md`

如果用户要求“检查待执行任务”、watchdog 心跳、queue mode 或任何未指定单个 Issue
的请求，必须先完成任务编排边界，且只能停留在阶段 A：

1. 只读取远端 Issue 列表摘要、本地队列索引和状态摘要
2. 按 GROUP 规则输出 `current_batch`
3. 按 SELECT 规则输出唯一候选任务，或输出 `HEARTBEAT_OK`
4. 输出该候选任务的 selection reason、certainty、risk、complexity、next gate

在以上 4 项完成前，禁止进入阶段 B，禁止读取候选 Issue 正文，禁止进入 BOOT/ROUTE/META_REFLECT，
禁止打开相关源码，禁止开始实现、测试、stage、commit 或关闭 Issue。`.ai/STATE.md`
里的 `next_action` 只能作为编排输入，不能跳过 GROUP / SELECT。

`no-change review/advice task` 只读取用户提供或明确要求的上下文；除非用户要求基于仓库真实状态判断，否则不读取 `.ai/STATE.md`、`.ai/QUEUE.md`，不进入 BOOT、QUEUE 或 commit gate。

禁止启动时主动遍历整个仓库文档。

禁止启动时读取所有 `.ai/memory/`、`.ai/runs/` 历史文件。

只有在当前任务需要时，才按需读取相关 memory 或 run 归档。

---

## 2. Core Execution Rules

你必须遵守：

- 面向产品、代码、用户价值、发布、配置或协作者交付的 `repo-change task` 必须先创建或绑定 CNB Issue；没有远端 Issue 编号，不得进入 EXECUTE
- `agent-process-maintenance task` 默认不创建 CNB Issue；如需修改版本化流程文件，使用本地 task/run 记录和受控 git checkpoint
- `no-change review/advice task` 禁止为了形式完整而创建 CNB Issue、更新队列或制造 git commit
- 一次只处理一个任务
- 一次只处理不超过 4 个核心实体
- 同一窗口、同一截图或同一用户反馈中出现多个问题时，先把它视为“问题簇”，不得直接合并成一个执行任务；必须按用户可感知行为契约拆分为独立任务，例如数据写入/确认、文案本地化、布局显示、通知生命周期分别拆分
- 只有当多个症状具备同一根因、同一修改面、同一风险等级、同一自动化验证即可完整覆盖时，才允许合并；否则必须先建立母任务或拆分记录，再选择唯一一个最高优先级子任务执行
- 问题簇中只要包含数据写入、安全、权限、发布或不可逆操作风险，该子问题必须优先独立分流，不得被 UI 文案或布局修复掩盖
- Issue、用户反馈或任务正文包含截图、录屏、附件、日志链接或可视化证据时，必须读取并检查这些证据；不得只根据文字摘要执行
- bug 修复任务必须执行专用闭环：确认证据与复现面、最小修复、旧功能/向后兼容复查、类似模式扫描、补齐或复跑相关测试
- queue/watchdog mode 必须先完成任务编排边界；选定任务前不得读取候选 Issue 正文或开始工作
- 不要顺手修无关问题
- 不要扩大需求边界
- 不要重写用户目标
- 不要在没有验证的情况下宣布完成
- 不要把失败伪装成完成
- 不要因为一个任务卡住而阻塞整个队列
- 如果任务卡住，记录原因，标记 `BLOCKED`，然后进入下一个任务
- watchdog/queue mode 完成一个任务后必须进入 NEXT：在时间预算、失败预算和用户指令允许时，重新回到 ORCHESTRATE，继续选择下一个 ready task；只有没有 ready task、预算耗尽、遇到人类决策点或用户要求停止时才结束
- watchdog/queue mode 恢复中断任务时必须先输出并记录 resume cursor：最后完成步骤、下一步、最后证据、阻塞条件；禁止从头重跑已完成步骤
- queue 选题默认采用“先热身、再攻坚”：P0/P1 仍优先于普通任务；同优先级内先选 SIMPLE、低风险、可验证的小任务，再选 COMPLEX，以便 AI 先沉淀同类问题套路
- 每个被选中任务进入执行前必须记录 `intent_self_check`。这不是否定所有任务；如果目标、上下文和元反思都清楚，且风险允许，就直接干。如果不清楚，才先调研并列出关键决策点等待用户拍板
- SIMPLE 任务和安全原型任务优先使用 `MVP/ALIGN loop`：先做最小可运行产出，再在每个关键小步后回看 Goal、Non-goals 和 Acceptance Criteria，发现偏移就收窄或回到 PLAN
- REVIEW 必须按任务风险选择 focused self-review 或项目级 `zotero-review` 对抗自检；涉及 Zotero 数据、watchdog、队列、Git scope 或复杂流程时，必须多视角检查冗余/重复、并发/边界、Zotero 数据安全、旧功能回归、验证与 Git scope
- FIX 必须分轮收敛。每轮修复后输出 `FIX_ROUND_PASS` 或 `FIX_ROUND_FAIL`，记录本轮修复的 P0/P1/P2、剩余问题、diff/测试证据和沉淀规则；禁止原地重复提交同一无效修复
- 局部失败必须进入 `incident_matrix`：按 if/then 记录、恢复、标记 `BLOCKED` 或 `NEED_HUMAN_DECISION`，然后回到 NEXT。单个任务失败不得阻塞整个队列
- 具有长期交接价值的架构决策、生产/发布操作或故障复盘，应按 `arch` / `ops` / `fix` 分类沉淀变更记录；本机临时状态和可从代码恢复的执行日志不写入长期变更记录

---

## 3. Reality Sync Rule

`repo-change task` 和 `agent-process-maintenance task` 动手前必须确认真实状态。`no-change review/advice task` 可声明 `Repository state not modified; git gates not applicable`，不因 dirty workspace 阻塞。

至少检查：

- 当前分支
- `git status`
- 当前任务是否仍然有效
- 相关文件是否已经有未提交修改
- 上次状态文件是否与真实状态冲突
- 是否已有与当前任务相关的 baseline 测试失败；全量测试成本高时，可只跑最小相关测试并记录未跑全量的原因
- 是否存在未完成的中间改动

如果 `.ai/STATE.md` 与真实世界冲突，以真实世界为准，并更新 `.ai/STATE.md`。

---

## 4. Certainty Routing Rule

每个任务执行前必须判断：

```text
certainty: HIGH / MEDIUM / LOW
risk: LOW / MEDIUM / HIGH
```

同时必须记录动手前自检：

```yaml
intent_self_check:
  has_context: true | false
  goal_clear: true | false
  meta_reflected: true | false
  needs_redefinition: true | false
  decision_points: []
  action: execute | research_then_decide | need_human_decision
```

判定原则：

- `intent_self_check` 的目的不是让 Agent 否定所有任务，而是防止“没经过编排就开工”
- 如果 `has_context=true`、`goal_clear=true`、`meta_reflected=true`、`needs_redefinition=false`，且 risk 不是 HIGH，可以继续进入 COMPLEXITY / EXECUTE
- 如果上下文不足但可通过本地代码、Issue 摘要或既有文档调研补齐，先调研并列出关键决策点；调研后重新生成 `intent_self_check`
- 如果目标定义、产品取舍、数据风险或高风险操作需要人类判断，输出 `NEED_HUMAN_DECISION`

执行规则：

```text
HIGH certainty + LOW risk      -> 可以自主执行
HIGH certainty + MEDIUM risk   -> 可以自主执行，但必须加强验证
MEDIUM certainty               -> 先调研并重新分流；调研后清楚且风险允许则执行，否则列出关键决策点
LOW certainty                  -> NEED_HUMAN_DECISION
HIGH risk                      -> NEED_HUMAN_DECISION
```

---

## 5. High-Risk Operations

以下操作必须人工确认：

- 删除大量文件
- 删除用户数据
- 修改数据库迁移
- 修改备份/恢复格式
- 修改安全边界
- 修改权限配置
- 发布版本
- 合并到 main/master
- 删除分支
- 重写 Git 历史
- 覆盖已有未提交修改
- 自动执行不可逆操作

遇到以上情况，输出：

```text
NEED_HUMAN_DECISION: <reason>
```

---

## 6. Completion Rule

`repo-change task` 只有同时满足以下条件，才能标记任务完成：

1. 当前任务目标实现
2. Non-goals 没有被破坏
3. Acceptance Criteria 全部满足
4. 必要测试通过；插件功能变更必须包含自动化功能 smoke test，不能只靠人工手动验证
5. Review 没有 P0/P1/P2 必修问题；`SIMPLE` 任务可做 focused self-review，`COMPLEX` 或 `HIGH risk` 任务必须做 structured review
6. `.ai/STATE.md` 已更新
7. `.ai/runs/` 已写入本轮执行记录
8. 必要经验已沉淀到 `.ai/memory/`
9. 本任务范围内的修改已完成一次受控 git commit，并在提交说明中写明任务、具体变更和验证结果
10. CNB Issue 只有在 1-9 全部满足后才能关闭；功能测试不完整时不得关闭任务

`agent-process-maintenance task` 不要求 CNB Issue 或 Issue closure，但如果修改版本化文件，仍必须完成等价验证、受控 git checkpoint，并在本地 `.ai/STATE.md` / `.ai/runs/` 记录。

`no-change review/advice task` 不要求 CNB Issue、`.ai/STATE.md`、`.ai/runs/` 或 git commit。最终回复必须明确未修改仓库：

```text
Commit: N/A — no repository changes
```

完成后最终回复必须以状态信号开头，并附带完成摘要；禁止只输出裸 `PASS`。

`PASS` 最终回复必须包含：

- `Task`：Issue 编号和标题
- `Done`：实际完成的改动
- `Verification`：执行过的验证和结果
- `Commit`：真实 commit hash；如果未提交，说明原因且不得标记 `PASS`
- `Notes`：剩余风险、未做事项或 `none`

格式：

```text
PASS
Task: <source:id> <title>
Done:
- <完成事项 1>
- <完成事项 2>
Verification:
- <命令或检查>: <结果>
Commit: <hash>
Notes: <none 或剩余风险>
```

不能输出：

```text
PASS
基本完成
应该可以
差不多了
大概没问题
```

---

## 7. Allowed Final Signals

每轮结束只能使用以下状态信号之一：

```text
PASS
FAIL
BLOCKED
NEED_HUMAN_DECISION
HEARTBEAT_OK
```

含义：

- `PASS`：当前任务完成且验证通过；必须附带 Task、Done、Verification、Commit、Notes
- `FAIL`：当前任务执行失败，但仍可继续修复
- `BLOCKED`：当前任务卡住，已记录原因，应跳过
- `NEED_HUMAN_DECISION`：需要人类决策
- `HEARTBEAT_OK`：没有待处理任务

---

## 8. Execution Gates

`repo-change task` 和 `agent-process-maintenance task` 进入 EXECUTE 前，必须先判断任务复杂度：

```text
complexity: SIMPLE / COMPLEX
```

`SIMPLE` 必须同时满足：

- certainty 为 HIGH，risk 为 LOW
- 核心实体不超过 2 个
- 目标和 Acceptance Criteria 明确
- 不涉及用户数据、安全边界、权限、发布、外部同步或真实 Zotero 库写入
- 可以用直接命令、静态检查或等价端到端验证确认完成

`HIGH risk` 必须升级为 `COMPLEX`，不得按 `SIMPLE` 执行。

`SIMPLE` 任务可以在完成 BOOT、ROUTE 和 META_REFLECT 后直接执行，但只需记录：

- Minimal Intent
- Files In Scope
- Verification
- Commit Scope
- Rollback

任何不满足 `SIMPLE` 条件的任务都是 `COMPLEX`。`COMPLEX` 任务必须先写 PLAN，且 PLAN 必须包含元反思结论：

- problem_exists
- narrowed_scope
- redefined_as
- entity_count
- old_behavior_risk
- validation_first

任务完成前必须跑 E2E 或等价端到端验证：

- 插件功能、用户可见行为、外部同步、发布或运行时变更必须执行自动化 E2E / smoke test，不能只靠人工手动验证。
- Zotero 插件 E2E 必须使用隔离 profile、临时测试库、fixture 或等价 harness，不得触碰真实用户资料库。
- 如果任务仅修改文档、流程规则或本机 AI 工作态，且不存在产品功能路径，必须明确记录 `E2E: not applicable` 的原因，并执行等价验证，例如结构化文本检查、规则检索、diff check、staged scope 检查和自审。

### 8.3 Zotero 测试安全边界

Zotero 插件测试分为三档，必须先声明采用哪一档：

1. `static/unit smoke`：只运行 Node、TypeScript、打包或 fixture/harness，不启动 Zotero。默认优先使用这一档。
2. `isolated Zotero integration`：只能在仓库根目录执行精确命令 `npm run start` 启动 Zotero；涉及写入行为的 bug 必须在这一档验证真实写入路径；但写入目标只能是隔离 profile 下的临时测试库/fixture 库，必须同时满足：profile 路径和 dataDir 都位于明确的测试根目录、不会连接真实用户资料库；执行前必须输出并记录精确命令 `npm run start`、profile 路径、测试库数据目录、fixture 条目和预期写入 diff。除 `npm run start` 外，不存在 AI 可执行的 Zotero 启动、重启、热重载或调试 URL 命令。
3. `real Zotero/manual`：任何会启动 `/Applications/Zotero.app`、连接正式 Zotero 用户资料库、复用用户日常 profile、或需要用户手动在正式 Zotero 中验证的操作，默认禁止；除非用户明确要求并确认风险，否则必须停止并输出 `NEED_HUMAN_DECISION`。

执行 Zotero 集成测试前，必须先判定当前 Zotero 进程属于哪一类：

- `isolated test instance`：进程启动参数包含测试 profile，且该 profile 的 `extensions.zotero.dataDir` 指向测试库目录。
- `real user instance`：正式 profile、正式 dataDir，或无法证明隔离。

Zotero 运行时命令白名单：

- 允许 AI 执行的启动命令：`npm run start`
- 允许 AI 执行的非启动命令：`npm run build`、`npm test`
- 禁止 AI 执行：`npm run reload`、`npm run reload:print`、`npm run stop`、`node scripts/reload.mjs`、`node scripts/debug-url.mjs`、`node scripts/stop.mjs`、`/Applications/Zotero.app/Contents/MacOS/zotero`、`open -a Zotero`、`zotero`、`zotero://...`、任何包含 `zotero://ztoolkit-debug` 或 `-url` 的命令

如果已存在 `isolated test instance`，不要执行任何热重载、调试 URL 或 stop 命令；需要重新加载或重启时，只能停止并输出 `NEED_HUMAN_DECISION: Zotero runtime reload/restart requires user action or npm run start from a clean state`。禁止把只带 `-profile` 但 dataDir 未确认隔离的启动命令视为安全测试环境。禁止向 `real user instance` 发送插件测试命令。

在执行任何可能启动 Zotero 的命令前，必须先检查并记录：

- 当前是否已有 Zotero 进程
- 将使用的 Zotero 可执行路径
- profile / data directory 是否隔离
- 测试是否会写入条目、附件、笔记、标签、Extra 或偏好；如果会写入，必须说明写入到哪个测试库、写入前后如何检查 diff、如何证明主库未连接且未变更
- 退出/清理和失败恢复方式

如果无法证明以上隔离条件，允许继续做 `static/unit smoke`，但不得声明插件运行时验证已完成，不得关闭涉及运行时行为的 Issue。涉及写入确认、附件、笔记、标签、Extra 或偏好持久化的 Issue，不能因为“避免写入”而跳过运行时验证；必须写入隔离测试库，或标记 `BLOCKED: isolated test library unavailable`。

创建 PR 或准备 PR handoff 前，必须先自审。自审至少覆盖：

- Goal / Acceptance Criteria 是否全部满足
- 是否破坏旧功能、旧流程或旧数据
- 边界、失败路径和兜底是否清楚
- E2E 或等价验证证据是否充分
- staged files 是否只包含 Commit Scope
- 是否包含密钥、隐私数据、cache、日志或本机绝对路径

如果自审存在 P0/P1/P2 必修问题，不得创建 PR，不得输出 `PASS`。

### 8.1 Run-First Alignment Rule

计划只是脚手架，不是唯一真相。对 SIMPLE 任务、低风险文档/流程变更和安全原型任务，默认采用 `MVP/ALIGN loop`：

1. 先产生最小可运行、可检查或可 diff 的版本
2. 每完成一个关键小步，记录一次 `ALIGN_CHECK`
3. `ALIGN_CHECK` 必须对照 Goal、Non-goals、Acceptance Criteria、旧功能风险和 Git scope
4. 对齐通过就继续；发现偏移就缩小范围、回到 PLAN 或输出 `NEED_HUMAN_DECISION`

复杂任务仍需 PLAN，但 PLAN 最多 7 步，并且只作为可调整脚手架；实际产出和验证证据优先。

### 8.2 Adversarial Review And Fix Rounds

项目级对抗自检 Skill 为：

```text
.codex/skills/zotero-review/SKILL.md
```

触发条件：

- Zotero 插件行为、元数据写入、附件/笔记/标签/Extra 字段、安全边界或真实资料库风险
- watchdog、队列、锁、NEXT、状态持久化或自动化 smoke test
- COMPLEX 任务、HIGH risk 任务、PR handoff 前或自审发现 P0/P1/P2
- 用户明确要求“对抗性自检”“多视角评审”或 `zotero-review`

`zotero-review` 至少覆盖：

- 重复和冗余
- 并发和边界
- Zotero 数据安全
- 是否破坏旧功能
- 验证与 Git scope

分级修复必须按 P0 -> P1 -> P2 收敛。每一轮必须输出：

```yaml
fix_round_signal: FIX_ROUND_PASS | FIX_ROUND_FAIL
fixed:
  - <P0/P1/P2 id>
remaining:
  - <P0/P1/P2 id>
evidence:
  diff: <files or none>
  verification: <commands/results>
lesson: <可沉淀规则或 none>
```

`FIX_ROUND_FAIL` 不等于停止；如果仍在预算内且不是同一问题连续两轮失败，必须继续真修。若同一问题连续两轮没有真实 diff、验证证据或可解释的非代码修复，标记 `BLOCKED`，记录原因，然后进入 NEXT。

---

## 9. Defense & Integrity Gate

Defense & Integrity 按风险分级启用。

`SIMPLE` 任务只需轻量 guard：

- intent：本轮要做的最小改动
- files：允许修改和提交的文件
- verification：如何证明完成
- rollback：失败时如何撤回本轮改动

`COMPLEX` 或 `HIGH risk` 任务进入 EXECUTE 前，必须同时设计成功路径和失败路径。

PLAN 必须记录：

- fallback：主路径失败时的兜底策略
- three_layers：三重防护，至少包含 prevention、detection、recovery
- atomicity：如何避免半完成状态
- consistency：如何从合法状态进入另一个合法状态
- idempotency：重复执行、Watchdog 重入或重试是否安全
- recovery：如何恢复、回滚、跳过或标记 BLOCKED
- auditability：如何记录命令、证据、staged 文件、commit 和剩余风险

最低要求：

- 涉及用户数据、外部同步、发布、权限或状态队列时，三重防护不得为空。
- 如果无法保证原子性或幂等性，必须给出明确手动恢复路径。
- 如果恢复路径依赖人类判断，必须输出 `NEED_HUMAN_DECISION`，不得进入 EXECUTE。
- VERIFY 必须复核上述完整性项是否仍然成立。

### 9.1 incident_matrix

遇到异常时必须执行 `incident_matrix`，不要停在原地等用户：

| if | then |
| --- | --- |
| 测试失败 | 记录命令和摘要，最小修复后复跑；同一任务连续 2 轮仍失败则标记 `BLOCKED`，保留分支/现场，进入 NEXT |
| Review 连续返回 P0/P1/P2 | 按分级真修并复跑 VERIFY/REVIEW；同一问题连续 2 轮无法清零则标记 `BLOCKED`，记录 review 输出，进入 NEXT |
| 插件自动化 smoke test 缺失且本轮无法补齐 | 输出 `BLOCKED: plugin automation smoke test unavailable`，记录缺口、已尝试动作和所需脚本/环境，进入 NEXT |
| `.ai/watchdog.lock` 冲突 | fresh lock 输出 `HEARTBEAT_OK`；stale lock 记录后替换并继续；无法判断则 `NEED_HUMAN_DECISION` |
| 命令、review 或外部工具超时 | kill 或停止当前子进程，记录超时点和已完成证据；可恢复则重试一次，不可恢复则 `BLOCKED` 并进入 NEXT |
| Git scope 越界 | 立即取消越界 stage，记录文件列表，回到 VERIFY；无法隔离 in-scope 与用户改动时输出 `NEED_HUMAN_DECISION` |
| 不可恢复错误 | 保留现场，更新 `.ai/STATE.md` 和 `.ai/runs/`，当前任务标记 `BLOCKED`，进入 NEXT |

矩阵原则：局部失败可阻塞单条任务，但不能阻塞队列；每个绕行动作都必须可审计、可恢复。

---

## 10. 42COG Project Entry

## 11. Sub-Agent Review Separation

Sub-agent review 主要用于代码审查、运行时行为审查和高风险变更审查。AI 自主流程、提示词或本机工作态维护默认不强制使用 sub-agent；除非用户明确要求，或该流程修改会直接影响代码执行安全、发布、权限、真实数据或不可逆操作。

适用范围：

- 所有 `COMPLEX` 或 `HIGH risk` 的 code task
- 插件功能、用户可见行为、数据安全、备份/恢复、发布、权限、外部同步、真实 Zotero 数据边界相关任务
- watchdog、queue、lock、NEXT、PERSIST、Git checkpoint、Issue closure 等会影响代码执行、任务状态或远端任务状态的 repo-change 自动化任务
- 创建 PR、准备 handoff 或关闭远端 Issue 前仍有行为风险的任务
- code task 的 focused self-review 发现 P0/P1/P2 后，修复完成必须再交给 reviewer 复审

执行规则：

- executor agent 负责实现或修复；reviewer sub-agent 负责找问题，不直接修改同一批文件
- reviewer 必须使用不同指令，以 P0/P1/P2/P3 findings 为主，优先找回归、数据风险、验证缺口、git scope 问题
- reviewer 可以使用更强模型或更高 reasoning；不可用时记录原因和 fallback
- reviewer 的任务必须是只读审查，除非主 agent 明确把一个独立修复子任务交给另一个 worker
- executor 不得把自己的自评替代 reviewer 结论
- reviewer 必须读取任务目标、diff、验证证据和 scope 说明，但不继承 executor 的“已经完成”假设

分级要求：

- `SIMPLE` 且低风险的非代码或文档任务：允许 focused self-review
- `SIMPLE` 代码任务：至少做 focused self-review；如果涉及用户可见行为、插件运行路径或回归风险，必须请求 reviewer sub-agent
- `agent-process-maintenance task`：默认 focused self-review；如果用户明确要求使用 sub-agent，或该变更直接改变代码执行安全、发布、权限、真实数据或不可逆操作边界，才请求 reviewer sub-agent
- 纯格式、拼写、注释、低风险说明文案：允许 focused self-review，但必须记录 review 类型
- `COMPLEX` 或 `HIGH risk` 的 code / runtime / data-safety 任务：必须请求 reviewer sub-agent；如果 sub-agent 不可用，记录 `reviewer_unavailable`，并按风险输出 `NEED_HUMAN_DECISION` 或 `BLOCKED`

完成门禁：

- reviewer 的 P0/P1/P2 必修问题未清零，不得输出 `PASS`、不得关闭 Issue、不得创建 PR
- 如果 reviewer 只提出 P3，可记录为剩余建议，不阻塞完成
- sub-agent 不可用时必须记录 `reviewer_unavailable` 的原因、尝试方式、影响范围和替代 review 类型
- final / run 记录必须说明 review 是 `sub-agent review`、`focused self-review`，或 `reviewer_unavailable fallback`

---

## 12. Git Checkpoint Rule

每完成一个 `repo-change task`，必须创建一次 git checkpoint commit。每完成一个修改版本化文件的 `agent-process-maintenance task`，也必须创建一次受控 git checkpoint commit，但不得为了该类本机流程治理自动创建 CNB Issue。

`no-change review/advice task` 禁止 fake commit；最终输出使用：

```text
Commit: N/A — no repository changes
```

允许自动提交的前提：

- 任务已经满足 Completion Rule 的 1-8 项
- 已确认 `git status` 中哪些是本轮任务文件，哪些是既有无关改动
- 只 stage 当前任务 Commit Scope 中的文件
- 提交前已检查 `git diff --cached --name-only`
- staged 文件列表没有超出当前任务范围
- `git diff --cached --check` 通过

禁止：

- 使用 `git add .`
- 使用 `git add -A`
- 把既有无关修改带入本任务 commit
- 提交本机 cache、日志、临时会话、绝对路径 symlink、密钥或环境文件
- 提交 `.ai/`、`.42cog/`、`.codex/` 本机 AI 工作态，除非用户明确要求这些目录进入版本控制
- 为了完成 commit 而覆盖用户已有未提交修改

如果当前任务范围文件与用户已有未提交修改冲突，必须停止并输出：

```text
NEED_HUMAN_DECISION: in-scope files already contain unrelated uncommitted changes
```

提交信息必须使用 Conventional Commits：

```text
<type>(<scope>): <summary>

Task: <source:id> <title>
Changes:
- <具体变更 1>
- <具体变更 2>
Verification:
- <命令或检查>: <结果>
```

常用 type：

```text
feat / fix / docs / chore / refactor / test / build / ci
```

提交前，必须在本机 `.ai/STATE.md` 和 `.ai/runs/<date>-<task-id>.md` 记录 staged 文件列表、验证结果和 `commit_hash: pending`。

`.ai/` 是本机工作态，不进入 git checkpoint。`.ai` runtime records 默认不属于 Commit Scope；checkpoint commit 只要求仓库应版本化产物受控提交，不要求清理、提交或回滚本机 AI runtime dirty files。提交完成后，必须在最终输出写明真实 commit hash；下一轮 BOOT 以 `git log -1 --format=%H` 为准同步真实状态。

---

## 13. 42COG Project Entry

本项目已接入 42COG / RCSW 工作流：

```text
Init -> Real -> Cog -> Product Requirements -> User Story -> UX/UI Design -> System Architecture -> Data / Domain -> Coding -> QA -> Work / Iteration
```

Codex 应优先读取项目内技能目录 `.codex/skills/`。如果技能缺失，使用 `smart-init` 从项目内 `.42plugin/42edu` 补齐相对软链接，不创建指向本机 cache 或绝对路径的 symlink。

关键目录：

- `.42cog/meta/meta.md`：项目身份、当前状态和技术背景
- `.42cog/real/real.md`：现实约束
- `.42cog/cog/cog.md`：认知模型
- `spec/pm/`：产品需求和用户故事
- `spec/design/`：UX/UI 规约
- `spec/dev/`：架构、数据、编码和 QA 规约
- `.codex/skills/`：项目级 Codex 技能入口

协作约束：

- 完成任务后按 Git Checkpoint Rule 自动创建一次受控 commit。
- 不删除用户已有文件。
- 不覆盖已有未提交修改。
- 不提交本机 cache 型绝对路径 symlink。
