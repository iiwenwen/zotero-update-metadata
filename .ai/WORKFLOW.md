# Autonomous Agent Workflow V0

本文件定义 Agent 每轮必须执行的工作流。

边界说明：本文件只负责 AI 自主工作的总体流程、门禁、状态和交接；不承载完整代码实现规则、产品决策、测试矩阵、依赖策略或领域知识。凡是任务涉及产品、设计、架构、编码、QA、依赖、发布或具体 Zotero 业务行为，优先读取并对齐 `.42cog/spec/`、`spec/` 或相关 `.42cog/work/` 文件；流程文件只保留触发条件、检查点和失败处理。

完整流程：

```text
CLASSIFY
-> INTAKE
-> GROUP
-> SELECT
-> BOOT
-> ROUTE
-> META_REFLECT
-> COMPLEXITY
-> CONTEXT
-> PLAN
-> EXECUTE
-> BUG_FIX_LOOP (bug tasks)
-> ALIGN
-> VERIFY
-> SUB_AGENT_REVIEW
-> REVIEW
-> FIX
-> PERSIST
-> NEXT
```

---

## -1. CLASSIFY：请求分类

任何用户输入先分类：

```yaml
request_type: repo-change | agent-process-maintenance | code-review-no-change | advice-consulting | external-summary | ambiguous
```

`repo-change` 包括面向产品、代码、用户价值、发布、配置或协作者交付的仓库修改，例如 code task、project docs/workflow task、config/build/release task，以及其他产品/项目交付类 staged diff。

`agent-process-maintenance` 包括只调整 AI agent 自身行为的 `AGENTS.md`、`.ai/WORKFLOW.md`、`.ai/prompts/`、`.codex/skills/` 或提示词治理规则。它可以修改仓库并创建 git checkpoint，但默认不创建 CNB Issue；除非用户明确要求纳入远端项目任务。

`code-review-no-change`、`advice-consulting`、`external-summary` 不创建 CNB Issue，不进入队列，不写 `.ai/STATE.md`，不做 git checkpoint。

如果请求模糊：

- 用户明确要求修改产品/代码/发布/配置/协作者交付内容：按 `repo-change`
- 用户要求调整 agent 自身流程、提示词或 AGENTS 规则：按 `agent-process-maintenance`
- 用户只要求审核、解释、比较、外部模型意见汇总：按 no-change review/advice

no-change 输出必须说明：

```text
Commit: N/A — no repository changes
```

---

## 0. INTAKE：用户输入转 Issue

只有 `repo-change` 请求必须先确认该事项是否已有 CNB Issue。

`agent-process-maintenance` 默认不创建 CNB Issue；如需修改版本化流程文件，使用本地 task/run 记录和受控 git checkpoint。

no-change review/advice 禁止为了形式完整而创建 CNB Issue、更新队列或制造 commit。

如果没有远端 Issue 编号：

1. 必须使用 `bunx @cnbcool/cnb-cli issues create-issue` 创建 CNB Issue
2. Issue 内容必须记录现象、报错信息、复现入口、预期结果、初步优先级，以及截图、录屏、附件、日志链接等证据
3. Issue 创建成功后，必须拿到 Issue 编号
4. 必须把新 Issue 同步到 `.ai/QUEUE.md` 或 `.ai/STATE.md`
5. 只有完成以上步骤后，repo-change 才能进入 GROUP / SELECT / BOOT

禁止绕过 CNB Issue 直接进入代码修改、验证、提交或发布。

如果 CNB CLI 不可用、登录态缺失或 Issue 创建失败，允许创建本地 provisional task 做诊断、计划、测试准备或 branch prep，但不得 commit、push、创建 CNB pull 或关闭 Issue，直到 CNB 同步成功。必须记录：

```yaml
sync_required: true
sync_blocker: unable to create or bind CNB issue
allowed_actions:
  - diagnosis
  - planning
  - test_preparation
  - branch_prep
forbidden_actions:
  - commit
  - push
  - cnb_pull_create
  - issue_close
```

`.ai/QUEUE.md` 只作为本地任务索引和缓存，不替代 CNB Issues。

输出：

```text
INTAKE_OK: cnb:#<number>
```

## 0.0.1 Evidence Intake Gate

任务正文、Issue、评论或用户反馈包含截图、录屏、附件、日志链接、堆栈、浏览器控制台、测试输出或其他证据时，必须先读取并检查这些证据。

最低要求：

- 视觉证据：下载或打开并实际查看，不得只读 alt text、文件名或文字摘要
- 日志/堆栈：保留关键错误、时间、入口和环境信息
- 远端链接：能访问时读取；不能访问时记录阻塞或缺口
- 与任务不相关或无法访问的证据：记录原因，不得假装已经验证

记录字段：

```yaml
evidence_intake:
  visual_assets_checked: true | false | not_applicable
  logs_checked: true | false | not_applicable
  inaccessible_evidence: []
  impact_on_scope: <none | narrowed | expanded_requires_split | need_human_decision>
```

## 0.1 多问题窗口分诊

当用户在同一窗口、同一截图或同一段反馈中报告多个现象时，先把输入识别为 `problem_cluster`，不要把整段反馈直接包装成一个执行 Issue。

分诊步骤：

1. 逐条列出用户可感知问题，每条必须能写成独立的“现象 -> 预期 -> 验证”。
2. 按行为契约分类：数据写入/确认、错误处理、文案本地化、布局显示、通知生命周期、性能、配置、外部同步。
3. 为每条判断 `risk`、`certainty`、`verification` 和核心实体；涉及写入、安全、权限、发布或不可逆操作的条目必须独立优先。
4. 只有当多条现象同时满足同一根因、同一修改面、同一风险等级、同一自动化验证可以完整覆盖时，才允许合并成一个执行 Issue。
5. 不满足合并条件时，创建母任务或拆分说明，并为每个子问题创建或绑定单独 Issue；本轮只选择唯一一个子任务进入 BOOT。

输出：

```yaml
problem_cluster:
  parent: <source:id 或 none>
  split_required: true | false
  items:
    - title: <single behavior problem>
      category: <data-write | localization | layout | notification-lifecycle | other>
      risk: LOW | MEDIUM | HIGH
      verification: <specific automated or structured check>
  selected_first: <source:id/title>
  reason: <why this one is first>
```

---

## 0.5 WATCHDOG：定时唤醒入口

Codex Watchdog 是本项目的本机心跳循环。它由 Codex Desktop automation、`codex exec`、`launchd` 或其他外部 scheduler 唤醒；本仓库流程不自动安装系统级定时任务。

固定提示词：

```text
.ai/prompts/watchdog.md
```

每次唤醒必须：

1. 按阶段 A 读取 `AGENTS.md`、`.ai/WORKFLOW.md`、`.ai/STATE.md`、`.ai/QUEUE.md`
2. 在未选中单个任务前，只读取远端 Issue 列表摘要；不得读取候选 Issue 正文或进入阶段 B
3. 使用 `.ai/watchdog.lock` 防止同一仓库并发跑两个 watchdog
4. 最多推进一个任务或一个可恢复步骤
5. 单轮默认 time budget 为 60 分钟
6. 同一任务连续失败两次后标记 `BLOCKED` 并跳过
7. 每个选中任务执行前生成 `intent_self_check`
8. 执行中按 `MVP/ALIGN loop` 小步推进，并在异常时读取 `incident_matrix`
9. 完成、阻塞或跳过后进入 NEXT；没有 ready task 时输出 `HEARTBEAT_OK`
10. 低确定性或高风险任务输出 `NEED_HUMAN_DECISION`
11. 退出前更新 `.ai/STATE.md`、`.ai/QUEUE.md`、`.ai/runs/`，并释放本轮创建的 lock
12. 如果发现上一轮中断或 `.ai/STATE.md` 有进行中任务，先输出并记录 `resume_cursor`，再决定继续、跳过或阻塞

Watchdog 禁止：

- 安装或修改系统级 scheduler
- 覆盖已有未提交修改
- stage `.ai/`、`.42cog/`、`.codex/`、缓存、日志、会话、环境文件或密钥，除非当前任务明确要求版本化
- 触碰真实 Zotero 用户数据

输出：

```text
HEARTBEAT_OK
```

或继续进入 GROUP / SELECT。

### 0.5.1 Watchdog State Machine

watchdog/queue mode 必须使用最小状态机：

```text
READY -> CLAIMED -> IN_PROGRESS -> VERIFYING -> REVIEWING -> CNB_REVIEW_OPEN -> MERGED -> DONE
```

异常状态：

```text
BLOCKED
NEED_HUMAN_DECISION
SKIPPED
```

`CNB_REVIEW_OPEN` 表示 Agent 工作已完成并等待 CNB review/merge。watchdog 不得把 `CNB_REVIEW_OPEN` 任务重新选为可执行任务，除非 CNB pull 更新、冲突、CI 失败、review comment 或用户明确要求继续处理。

`.ai/watchdog.lock` 必须至少包含：

```yaml
task_id:
branch:
pid:
host:
started_at:
heartbeat_at:
ttl_minutes:
resume_cursor:
```

`.ai/QUEUE.md` 每个任务项至少保留：

```yaml
source:
title:
status:
priority:
risk:
certainty:
branch:
pr:
last_attempt_at:
failure_count:
blocker:
next_action:
```

### 0.5.2 Watchdog Automation Suggestion

本仓库默认不主动启用后台定时任务。允许准备可审阅的 PAUSED/suggested cron automation 配置，用于 Codex Desktop 或外部 scheduler 后续人工启用。

建议配置必须满足：

- status: `PAUSED` 或 suggested，不得直接 ACTIVE
- prompt 固定读取 `.ai/prompts/watchdog.md`
- 每次 wakeup 只执行一个 heartbeat，不触碰真实 Zotero 用户数据
- heartbeat 必须读取 `incident_matrix`，遇到局部失败后记录、跳过并回到 NEXT
- 无 ready task 时返回 `HEARTBEAT_OK`

---

## 0.6 ORCHESTRATE：任务编排边界

当用户要求“检查待执行任务”、watchdog/queue mode 被唤醒，或请求没有指定单个 Issue 时，
必须先完成 ORCHESTRATE，禁止直接读取候选 Issue 正文或进入执行。

ORCHESTRATE 只允许读取：

- `AGENTS.md`
- `.ai/WORKFLOW.md`
- `.ai/STATE.md`
- `.ai/QUEUE.md`
- 远端 Issue 列表摘要，例如编号、标题、优先级、状态、更新时间

ORCHESTRATE 必须输出：

```yaml
current_batch: <batch-name>
selected_candidate: <source:id 或 none>
selection_reason: <按 SELECT 规则说明>
certainty: HIGH | MEDIUM | LOW
risk: LOW | MEDIUM | HIGH
complexity: SIMPLE | COMPLEX | unknown
next_gate: BOOT | NEED_HUMAN_DECISION | HEARTBEAT_OK
```

只有 `next_gate: BOOT` 且 `selected_candidate` 唯一时，才允许进入阶段 B：读取该任务
Issue 正文或 `.ai/tasks/<task-id>.md`。`.ai/STATE.md` 中的 `next_action` 只能作为候选输入，
不能跳过 GROUP / SELECT。若编排信息不足，输出 `NEED_HUMAN_DECISION` 或 `HEARTBEAT_OK`，
不得“先打开看看”候选任务详情。

---

## 1. GROUP：合并同类项

GROUP 只适用于 watchdog/queue mode。用户已明确指定当前 repo-change 任务时，可以直接进入 BOOT / ROUTE，不必重新分组选题。

读取 `.ai/QUEUE.md` 或任务系统中的 open issues。

本项目的远端 Issue 真源是 CNB：

```yaml
cnb_repo: iisyaoran/zotero-update-metadata
cnb_url: https://cnb.cool/iisyaoran/zotero-update-metadata
cnb_cli: bunx @cnbcool/cnb-cli
```

需要读取、创建、更新或关闭远端 Issue 时，优先使用：

```bash
bunx @cnbcool/cnb-cli
```

不要改用 `npx`。`.ai/QUEUE.md` 只作为本地任务索引和缓存，不替代 CNB Issues。

先按任务类型分组：

- bug
- test
- data-safety
- backup
- migration
- UI
- docs
- refactor
- release

优先选择同类任务批次。

不要在同一轮里混合处理不同类型任务。

输出：

```text
current_batch: <batch-name>
```

---

## 2. SELECT：选择一个任务

选择规则：

1. P0/P1 安全或紧急任务优先；不要为了热身跳过真正紧急任务
2. 未阻塞优先
3. 同类任务优先，延续当前 batch 的上下文
4. 同优先级、同 batch 内采用热身优先：SIMPLE 优先于 COMPLEX，低风险优先于中风险，小任务优先于大任务
5. 可验证任务优先，能自动 smoke/unit 验证的任务优先
6. 上下文明确任务优先
7. 如果一个 COMPLEX 任务是后续 SIMPLE 任务的必要前置依赖，可以先执行该 COMPLEX，但必须在 selection_reason 中说明依赖关系

不要选择：

- 目标模糊的任务
- 缺少验收标准的任务
- 状态为 `CNB_REVIEW_OPEN` 且没有 CNB pull 更新、冲突、CI 失败、review comment 或用户继续处理要求的任务
- 涉及超过 4 个核心实体的任务
- 需要高风险操作的任务
- 需要人类产品决策的任务

如果没有任务，输出：

```text
HEARTBEAT_OK
```

---

## 2.5 NEXT：连续执行边界

watchdog/queue mode 完成一个任务后，不得默认停止。完成 PERSIST、checkpoint、push、Issue
closure 和 lock 释放前的本轮记录后，必须进入 NEXT：

```yaml
next_decision:
  continue_queue: true | false
  reason: <why>
  remaining_budget: <time/retry/entity summary>
```

`continue_queue: true` 时，必须回到 ORCHESTRATE，重新读取远端 Issue 列表摘要和本地队列索引，
再按 GROUP / SELECT 选择下一项。不要复用刚完成任务的 Issue 正文或上下文直接开工。

只有以下情况可以 `continue_queue: false` 并结束：

- 没有 ready task
- 本轮时间预算不足以完成下一个可恢复步骤
- 连续失败预算触发
- 下一个候选为 LOW certainty、HIGH risk 或需要人类产品决策
- 工作区出现会影响下一任务的 in-scope 未提交冲突
- 用户明确要求只做一个任务或停止

NEXT 不是跳过验证或提交的理由；每个 repo-change 任务仍必须独立满足 Completion Rule。

## 2.6 RESUME_CURSOR：断点恢复游标

当 `.ai/STATE.md`、`.ai/runs/`、watchdog lock、未完成计划或 git diff 显示上一轮未完整结束时，必须先建立恢复游标，而不是从头重跑。

记录：

```yaml
resume_cursor:
  task: <source:id/title>
  last_completed_step: <step or none>
  next_step: <single next recoverable action>
  last_evidence: <command/diff/review/log or none>
  blockers: []
  safe_to_resume: true | false
  decision: continue | mark_blocked | need_human_decision | start_new_task
```

规则：

- `safe_to_resume=true` 时，从 `next_step` 继续，不重复已完成且已有证据的步骤
- `safe_to_resume=false` 时，按 `incident_matrix` 标记 `BLOCKED` 或 `NEED_HUMAN_DECISION`
- 恢复过程中不得覆盖用户已有未提交修改，不得扩大 Commit Scope
- 如果恢复目标已经过期或远端 Issue 已关闭，必须重新 ROUTE / META_REFLECT

---

## 3. BOOT：启动与真实状态同步

BOOT 只适用于 repo-change/watchdog mode。no-change review/advice 可以声明仓库未修改，跳过 dirty workspace、测试和 commit gate。

必须执行：

1. 读取 `AGENTS.md`
2. 读取 `.ai/WORKFLOW.md`
3. 读取 `.ai/STATE.md`
4. 读取 `.ai/QUEUE.md`
5. 读取当前任务
6. 检查当前分支
7. 检查 `git status`
8. 检查任务相关文件是否有未提交修改
9. 检查上一轮是否中断
10. 检查当前任务是否仍然有效
11. 检查与当前任务相关的 baseline 测试失败；全量测试成本高时，可只跑最小相关测试并记录原因
12. 检查 `.gitignore` 是否只忽略缓存、本机态、密钥和构建产物
13. 如果任务包含截图、录屏、附件、日志链接或其他证据，完成 `Evidence Intake Gate`
14. 记录本轮允许修改的 Files In Scope 和允许提交的 Commit Scope

输出：

```text
BOOT_OK
```

如果发现 `.ai/STATE.md` 过期，必须先更新。

---

## 4. ROUTE：确定性分流

判断当前任务：

```yaml
certainty: HIGH | MEDIUM | LOW
risk: LOW | MEDIUM | HIGH
intent_self_check:
  has_context: true | false
  goal_clear: true | false
  meta_reflected: true | false
  needs_redefinition: true | false
  decision_points: []
  action: execute | research_then_decide | need_human_decision
```

判断问题：

- 目标是否清楚？
- 上下文是否足够？
- 涉及实体是否不超过 4 个？
- 是否其实是同一窗口/截图里的多个独立行为问题？如果是，是否已完成 `problem_cluster` 分诊并只选择一个子任务？
- 是否需要人工决策？
- 是否涉及高风险操作？
- 是否可以由 Agent 自动验证？
- 如果缺少自动化验证能力，是否可以在本轮先补最小测试脚本、fixture 或 harness？
- 是否可在当前 loop 内完成？

分流规则：

```text
目标、上下文、元反思都清楚且风险允许 -> 进入 CONTEXT 或 EXECUTE
上下文不足但可调研 -> 先调研并列出决策点，调研后重跑 intent_self_check
缺少自动化验证但可补齐 -> 把最小自动化测试能力纳入本轮 PLAN
需要人类判断 -> NEED_HUMAN_DECISION
高风险操作 -> NEED_HUMAN_DECISION
```

`intent_self_check` 不是否定所有任务。它只回答三件事：是否已有足够上下文、是否明白目标、是否做过元反思。三者清楚时直接干；不清楚时才调研、重定义或请求用户拍板。

禁止把“请用户手动测试”作为默认验证路径。手动验证只允许作为补充证据，不能替代 Agent 自动验证。

---

## 4.5 META_REFLECT：元反思分流

每个任务进入 CONTEXT / PLAN 前，必须先做一轮元反思。目标不是写长篇推理，而是确认问题定义是否值得执行。

必须回答：

- 该问题是否真实存在，还是由过期状态、误读日志或旧 Issue 编号造成？
- 是否可以缩小边界，避免把多个目标合并为一个任务？
- 是否可以重新定义为已有成熟解法的问题，例如测试缺口、状态同步、数据一致性、权限边界或文档治理？
- 本轮核心实体是否不超过 4 个？如果超过，必须拆分任务或只选择一个子任务。
- 是否存在为了实现新目标而破坏旧功能、旧数据、旧流程或旧验证链路的风险？
- 当前任务是否需要先补校验标准或最小验证脚本，再进入 EXECUTE？

输出必须记录到 `.ai/CONTEXT.md` 或 `.ai/STATE.md`：

```yaml
meta_reflection:
  problem_exists: true | false
  narrowed_scope: <本轮缩小后的边界>
  redefined_as: <成熟问题类型或 none>
  entity_count: <number>
  old_behavior_risk: LOW | MEDIUM | HIGH
  validation_first: true | false
```

分流规则：

```text
problem_exists: false      -> NEED_HUMAN_DECISION 或关闭/跳过错误任务
entity_count > 4           -> 拆分任务；无法拆分则 NEED_HUMAN_DECISION
old_behavior_risk: HIGH    -> NEED_HUMAN_DECISION
validation_first: true     -> 把最小校验能力纳入 PLAN
其他情况                  -> 进入 CONTEXT
```

禁止把元反思变成无边界调研；只允许读取当前任务必要的 Issue、状态、Real/Cog/Spec 和直接相关文件。

---

## 4.6 COMPLEXITY：复杂度门禁

在 META_REFLECT 之后，必须判断：

```yaml
complexity: SIMPLE | COMPLEX
```

`SIMPLE` 必须同时满足：

- certainty 为 HIGH，risk 为 LOW
- 核心实体不超过 2 个
- 目标和 Acceptance Criteria 明确
- 不涉及用户数据、安全边界、权限、发布、外部同步或真实 Zotero 库写入
- 可以用直接命令、静态检查或等价端到端验证确认完成

`SIMPLE` 可以在 CONTEXT 中记录最小意图后直接进入 EXECUTE，但仍必须保留 Files In Scope、Commit Scope、验证命令和回滚方式。

任何不满足 `SIMPLE` 的任务都是 `COMPLEX`。`COMPLEX` 必须进入 PLAN，且 PLAN 必须包含 META_REFLECT 结论：

```yaml
plan_meta_reflection:
  problem_exists: true | false
  narrowed_scope: <本轮缩小后的边界>
  redefined_as: <成熟问题类型或 none>
  entity_count: <number>
  old_behavior_risk: LOW | MEDIUM | HIGH
  validation_first: true | false
```

如果复杂任务没有 plan 或 plan 没有元反思结论，禁止进入 EXECUTE。

---

## 5. CONTEXT：生成本轮上下文包

生成或更新：

```text
.ai/CONTEXT.md
```

内容必须包括：

- 当前任务
- 目标
- 非目标
- 涉及文件
- 涉及实体
- 验收标准
- 风险点
- 验证命令
- 当前真实状态
- 下一步动作

要求：

```text
本轮任务最多 4 个核心实体。
```

如果超过，必须拆分任务。

### 5.1 42COG / RCSW Cognitive Alignment

每个任务进入 PLAN 前，必须把 42COG/RCSW 作为本轮上下文的一部分，而不是只作为项目背景。

AI 自主流程只判断“需要读哪些规约、如何对齐、如何验证是否偏离”；具体的产品规则、架构约束、编码约定、测试矩阵、依赖策略和发布要求必须优先来自 `.42cog/spec/`、`spec/` 或相关 `.42cog/work/` 文档。不要把这些领域细节长期复制到 `.ai/WORKFLOW.md`。

新增或更新 `.42cog/spec/**` 时，必须显式参考 `.42cog/cog/cog.md`，并写明关联主体、核心实体、信息流和相关权重。

必须按最小必要原则读取：

- `.42cog/meta/meta.md`
- `.42cog/real/real.md`
- `.42cog/cog/cog.md`
- 当前任务直接相关的 `spec/pm/`、`spec/design/`、`spec/dev/`、`.42cog/work/` 或 `.42cog/spec/` 文件

禁止为了“使用 42COG”而主动遍历全部 `.42cog/`、`.ai/runs/`、`.ai/memory/` 或 `.codex/` 历史文件。

`.ai/CONTEXT.md` 必须增加或保留以下内容：

- 42COG stage：本轮任务落在哪个阶段，例如 Real、Cog、Coding、QA、Work / Iteration
- affected_cog_entities：受影响的 Cog 核心实体，最多 4 个
- real_constraints：相关 Real 约束编号或说明
- rcsw_inputs：读取过的相关 RCSW/42COG 文件
- rcsw_non_goals：本轮不处理的阶段、实体或文档
- rcsw_verification：如何验证没有违背 Real/Cog/Spec 边界

如果缺少必要 42COG 文档：

- 任务本身是补齐 42COG 文档或流程：可把缺口纳入本轮 PLAN
- 任务需要依赖缺失文档作产品或架构决策：输出 `NEED_HUMAN_DECISION`
- 任务可由现有 Real/Cog 和代码事实安全判断：记录缺口并继续最小执行

---

## 6. PLAN：最小计划

计划最多 7 步。

必须包含：

- 要改什么
- 不改什么
- 如何验证
- 如何回滚
- 失败时怎么办
- 是否需要补测试
- 是否可能破坏旧功能
- 本轮允许 stage 和 commit 哪些文件
- `.ai/`、`.42cog/`、`.codex/` 是否属于本机工作态
- 对 `COMPLEX` 任务，必须包含 `plan_meta_reflection`

禁止写长篇泛泛计划。

输出：

```text
PLAN_OK
```

### 6.1 DEFENSE_INTEGRITY：防护与完整性设计

Defense & Integrity 按风险分级启用。`HIGH risk` 必须升级为 `COMPLEX`，不得按 `SIMPLE` 执行。`SIMPLE` 任务只需记录 intent、files、verification、rollback。`COMPLEX` 或 `HIGH risk` 任务进入 EXECUTE 前，PLAN 必须记录完整防护与完整性设计。

目标是同时设计成功路径和失败路径，避免半成品、脏状态和重复执行副作用。

必须写入 `.ai/CONTEXT.md` 或 `.ai/STATE.md`：

```yaml
defense_integrity:
  fallback: <主路径失败时的兜底策略>
  three_layers:
    prevention: <执行前如何预防事故>
    detection: <执行中/验证时如何发现事故>
    recovery: <失败后如何恢复、跳过或阻塞>
  atomicity: <如何避免半完成状态>
  consistency: <如何保证合法状态到合法状态>
  idempotency: <重复执行或 watchdog 重入是否安全>
  auditability: <如何记录命令、证据、staged 文件、commit 和风险>
```

最低要求：

- 涉及用户数据、外部同步、发布、权限或状态队列时，`three_layers` 不得为空。
- 如果无法保证原子性或幂等性，必须在 PLAN 中给出明确的手动恢复路径。
- 如果恢复路径依赖人类判断，输出 `NEED_HUMAN_DECISION`，不要进入 EXECUTE。
- 如果只是低风险文档任务，可使用 SIMPLE 轻量 guard；复杂流程文档或状态队列变更才需要完整矩阵。

---

## 7. EXECUTE：小步执行

执行要求：

- 一次只做一个小步
- 不改无关文件
- 不顺手重构
- 不扩大范围
- 每完成一个关键步骤，更新 `.ai/STATE.md`
- 保留可回滚点
- 遇到异常立即记录
- SIMPLE 任务和安全原型任务默认使用 `MVP/ALIGN loop`：先让最小可运行产出出现，再用验证和 ALIGN 校准它
- 复杂任务按 PLAN 执行，但 PLAN 是脚手架；实际产出、测试证据和 ALIGN 检查优先

如果执行中发现任务定义错误，停止并输出：

```text
NEED_HUMAN_DECISION
```

## 7.5 BUG_FIX_LOOP：Bug 修复专用闭环

当任务类型为 `bug`、Issue/标题/用户请求包含“修复/报错/异常/不生效/回归”等 bug 信号，或任务目标是恢复既有行为时，必须执行本闭环。本闭环补充 EXECUTE / ALIGN / VERIFY，不替代它们。

步骤：

1. Evidence：完成 `Evidence Intake Gate`，并把现象写成“输入/操作 -> 实际结果 -> 预期结果”
2. Reproduce：优先用自动化、fixture、日志或最小命令复现；无法复现时记录原因和替代证据
3. Minimal Fix：只改最小根因面，不做顺手重构
4. Regression Check：复查旧功能、默认值、向后兼容、失败反馈和数据安全边界
5. Similar Pattern Scan：用 `rg` 搜索相同调用、相同状态流、相同 mock/API 字段、相同错误处理模式
6. Test Lock：新增或复跑最小相关测试；插件行为仍受 Zotero 隔离和 smoke test 门禁约束

记录：

```yaml
bug_fix_loop:
  evidence_checked: true | false
  reproduced_by: <command/fixture/log/static-reasoning>
  minimal_fix_scope: []
  regression_checks: []
  similar_pattern_scan:
    command: <rg or other>
    result: <none | synced_changes | followup_needed>
  tests: []
```

如果 similar pattern scan 发现同类问题但不属于同一根因、同一修改面、同一风险等级和同一验证方式，必须拆出后续任务，不得扩大本轮范围。

---

## 8. ALIGN：对齐检查

在执行中和执行后，必须对齐原始任务。

`MVP/ALIGN loop` 必须在每个关键小步后记录：

```yaml
align_check:
  goal: pass | fail
  non_goals: pass | fail
  acceptance_criteria: pass | fail
  old_behavior_risk: LOW | MEDIUM | HIGH
  git_scope: pass | fail
  drift: none | <what drifted>
  decision: continue | narrow_scope | return_to_plan | need_human_decision
```

检查：

- 当前实现是否仍然满足 Goal？
- 是否偏离 Non-goals？
- 是否漏掉 Acceptance Criteria？
- 是否为了新目标破坏旧功能？
- 是否引入无关改动？
- 是否需要缩小任务边界？

如果不对齐，回到 PLAN。

如果目标本身冲突，输出：

```text
NEED_HUMAN_DECISION
```

如果 `align_check.decision` 为 `narrow_scope` 或 `return_to_plan`，必须先记录原因，再回到 PLAN；禁止为了贴合旧计划而忽略实际产出暴露的问题。

---

## 9. VERIFY：测试验证

按需读取：

```text
.ai/skills/verify.md
```

必须记录：

- `verification_tier` 和选择理由
- 读取的相关 `.42cog/spec/` / `spec/` 文件
- 执行了哪些命令
- E2E 或等价端到端验证是否完成
- 插件自动化功能 smoke test 覆盖了哪些用户路径；具体矩阵以 `.42cog/spec/qa-zotero-verification.md` 为准
- 哪些通过
- 哪些失败
- 失败如何修复
- 是否复跑通过
- 是否存在 P0/P1/P2 修复轮次，以及每轮 `FIX_ROUND_PASS/FAIL` 的证据
- `git diff --cached --name-only` 是否只包含当前任务 Commit Scope
- `git diff --cached --check` 是否通过
- `defense_integrity` 中的 fallback、三重防护、原子性、一致性、幂等性、恢复和可审计性是否仍然成立

E2E 门禁：

- 需要 E2E / smoke 的任务必须按所选 `verification_tier` 完成自动化或等价端到端验证。
- Zotero 插件 E2E 必须遵守 `.42cog/spec/zotero-data-safety.md`、`.42cog/spec/runtime-command-policy.md` 和 `.42cog/spec/qa-zotero-verification.md`。
- 文档、流程规则或本机 AI 工作态任务如果没有产品功能路径，必须记录 `E2E: not applicable` 的原因，并执行等价验证，例如结构化文本检查、规则检索、diff check、staged scope 检查和自审。
- 未完成 E2E 或等价验证时，禁止 `VERIFY_PASS`。

Verification tier：

```yaml
verification_tier:
  one_of:
    - docs_or_process
    - pure_build_or_types
    - pure_logic
    - user_visible_plugin_behavior
    - zotero_data_write_or_preferences
    - release_or_dependency
  reason: <why this tier proves the task>
  specs_read: []
```

Spec 路由：

- Zotero 数据写入或偏好持久化：读取 `.42cog/spec/zotero-data-safety.md`
- Zotero runtime / UI / 命令启动：读取 `.42cog/spec/runtime-command-policy.md`
- 用户可见插件行为：读取 `.42cog/spec/plugin-behavior-contracts.md`
- QA 验证矩阵和 Test Ladder：读取 `.42cog/spec/qa-zotero-verification.md`
- 依赖主版本线：读取 `.42cog/spec/dependency-policy.md`

输出：

```text
VERIFY_PASS
```

或：

```text
VERIFY_FAIL: <reason>
```

所选 `verification_tier` 的必要验证缺失时：

- 禁止输出 `VERIFY_PASS`
- 禁止进入 `PASS`
- 禁止关闭 CNB Issue 或把本地队列标记为 Done
- 必须把任务保持为 `BLOCKED` 或 `FAIL`
- 必须在 Issue、本地 `.ai/STATE.md` 和 `.ai/runs/` 记录缺少的验证、已完成的证据和下一步

---

## 10. REVIEW：对抗评审

### 10.0 SUB_AGENT_REVIEW：执行者与检查者分离

Sub-agent review 主要用于代码审查、运行时行为审查和高风险变更审查。AI 自主流程、提示词或本机工作态维护默认不强制使用 sub-agent；除非用户明确要求，或该流程修改会直接影响代码执行安全、发布、权限、真实数据或不可逆操作。

必须请求 reviewer sub-agent 的情况：

- `COMPLEX` 或 `HIGH risk` code task
- 插件功能、用户可见行为、数据安全、备份/恢复、发布、权限、外部同步或真实 Zotero 数据边界相关任务
- watchdog、queue、lock、NEXT、PERSIST、Git checkpoint、Issue closure 等会影响代码执行、任务状态或远端任务状态的 repo-change 自动化任务
- 创建 CNB pull、准备 handoff 或关闭远端 Issue 前仍有行为风险的任务
- code task 的 focused self-review 发现 P0/P1/P2 后，修复完成必须再交给 reviewer 复审

规则：

- executor agent 负责实现；reviewer sub-agent 负责只读审查，不直接修改 executor 的文件
- reviewer 使用不同指令，按 P0/P1/P2/P3 输出 findings，重点检查回归、数据风险、验证缺口、git scope
- reviewer 可使用更强模型或更高 reasoning；不可用时记录 `reviewer_unavailable`
- reviewer 必须读取任务目标、diff、验证证据和 scope 说明，但不继承 executor 的“已经完成”假设
- `SIMPLE` 低风险非代码任务允许 focused self-review
- `SIMPLE` 代码任务至少 focused self-review；涉及用户可见行为、插件运行路径或回归风险时，必须请求 reviewer sub-agent
- `agent-process-maintenance` 默认 focused self-review；如果用户明确要求使用 sub-agent，或该变更直接改变代码执行安全、发布、权限、真实数据或不可逆操作边界，才请求 reviewer sub-agent
- 纯格式、拼写、注释、低风险说明文案允许 focused self-review，但必须记录 review 类型

门禁：

- P0/P1 总是阻塞 `PASS`、Issue closure 和 CNB pull 创建
- P2 仅在涉及 correctness、data safety、regression、verification、git scope、release 或 security 时阻塞；其他 P2 可降为记录性 follow-up
- P3 可记录为剩余建议，不阻塞
- sub-agent 不可用时：`COMPLEX` / `HIGH risk` code task 必须 `BLOCKED`；SIMPLE 或 process-only 任务允许 focused self-review fallback，并记录 `reviewer_unavailable` 的原因、尝试方式、影响范围和替代 review 类型
- `.ai/runs/` 必须记录 review 类型：`sub-agent review`、`focused self-review` 或 `reviewer_unavailable fallback`

按需读取：

```text
.ai/skills/review.md
.codex/skills/zotero-review/SKILL.md
```

`SIMPLE` 任务可做 focused self-review；涉及 Zotero 数据、安全、watchdog/queue、NEXT、Git scope、COMPLEX 或 HIGH risk 时，必须使用项目级 `zotero-review` 多视角评审。

至少执行以下视角：

1. 重复和冗余
2. 并发和边界
3. Zotero 数据安全
4. 旧功能回归
5. 验证与 Git scope

问题分级：

```text
P0
P1
P2
P3
```

最终只能输出：

```text
PASS
```

或：

```text
FAIL
```

### 10.1 HANDOFF_SELF_REVIEW：CNB handoff 前自审

创建 CNB pull 或准备 CNB handoff 前，必须完成自审。

自审至少覆盖：

- Goal / Acceptance Criteria 是否全部满足
- 是否破坏旧功能、旧流程或旧数据
- 边界、失败路径和兜底是否清楚
- E2E 或等价验证证据是否充分
- staged files 是否只包含 Commit Scope
- 是否包含密钥、隐私数据、cache、日志或本机绝对路径

如果自审存在 P0/P1/P2 必修问题，不得创建 CNB pull，不得输出 `PASS`。

---

## 11. FIX：分级修复

修复顺序：

```text
P0 -> P1 -> P2
```

规则：

- P0 未清零，不能完成
- P1 未清零，不能完成
- P2 涉及 correctness、data safety、regression、verification、git scope、release 或 security 时必须修；其他 P2 可记录为 follow-up
- P3 不阻塞完成

每修一轮，必须输出本轮信号：

```yaml
fix_round_signal: FIX_ROUND_PASS | FIX_ROUND_FAIL
fixed:
  - <P0/P1/P2 id>
remaining:
  - <P0/P1/P2 id>
evidence:
  diff: <files or none>
  verification: <commands/results>
lesson: <写入 .ai/memory/patterns.md 的复用规则或 none>
```

然后必须重新：

```text
VERIFY -> REVIEW
```

如果同一问题连续两轮修不掉：

```text
BLOCKED
```

并写入 `.ai/runs/`。

禁止原地打转：如果一轮没有真实 diff、没有新的验证证据，也没有明确说明“无需代码变更”的可审计理由，则该轮视为无效修复，计入连续失败预算。

---

## 11.5 incident_matrix：意外处理矩阵

任何卡死、修不动、不可恢复或局部失败，都必须按 `incident_matrix` 处理。原则是：单条任务可以 `BLOCKED`，队列必须回到 NEXT。

| if | then |
| --- | --- |
| 测试失败 | 记录失败命令和摘要；最小修复后复跑；连续 2 轮仍失败则 `BLOCKED`，保留现场并进入 NEXT |
| Review 连续返回 P0/P1/P2 | 按 P0 -> P1 -> P2 真修；连续 2 轮同一问题不清零则 `BLOCKED`，记录 review 输出并进入 NEXT |
| 自动化 smoke test 缺失且本轮无法安全补齐 | 输出 `BLOCKED: plugin automation smoke test unavailable`，记录缺失脚本/fixture/harness 和已尝试动作，进入 NEXT |
| `.ai/watchdog.lock` 冲突 | fresh lock 输出 `HEARTBEAT_OK`；stale lock 记录后替换；无法判断活跃性则 `NEED_HUMAN_DECISION` |
| 命令、review 或外部工具超时 | 停止或 kill 当前子进程，记录超时点；可恢复则重试一次，不可恢复则 `BLOCKED` 并进入 NEXT |
| Git scope 越界 | 取消越界 stage，记录文件列表，回到 VERIFY；无法隔离本轮改动与用户改动则 `NEED_HUMAN_DECISION` |
| 不可恢复错误 | 保留现场，更新 `.ai/STATE.md` / `.ai/runs/`，当前任务标 `BLOCKED`，进入 NEXT |

矩阵执行后必须记录：

```yaml
incident_matrix:
  trigger: <if>
  action: <then>
  task_status: blocked | need_human_decision | retried | skipped
  next: NEXT
```

---

## 12. PERSIST：状态持久化

完成或阻塞后，必须更新：

```text
.ai/STATE.md
.ai/QUEUE.md
.ai/runs/<date>-<task-id>.md
.ai/memory/patterns.md 或 .ai/memory/decisions.md（仅当有可复用经验或稳定决策）
```

职责区分：

```text
STATE = 当前真相
RUNS = 历史过程
MEMORY = 可复用经验
QUEUE = 任务索引
ISSUE = 任务本体
```

`.ai/STATE.md`、`.ai/QUEUE.md`、`.ai/runs/`、`.ai/memory/` 是 `.ai local runtime state`，默认不进 CNB pull。允许这些文件在本机保持 dirty；CNB handoff 前必须确认它们没有 staged，并在最终输出说明它们是 local runtime state。

可版本化的 AI 流程资产仅包括明确任务范围内的 `AGENTS.md`、`.ai/WORKFLOW.md`、`.ai/prompts/**`、`.codex/skills/**` 和 `.42cog/spec/**`。

不要把完整历史塞进 `STATE.md`。只有产生复用经验、重复失败模式、稳定决策或安全规则时，才更新 `.ai/memory/`；否则记录 `memory_update: not_applicable`。

### 12.0.1 ChangeDoc Gate

完成任务后判断是否需要长期变更记录。它不同于 `.ai/runs/`：runs 保存执行过程，ChangeDoc 保存未来协作者需要知道的稳定事实。

需要写入长期变更记录的情况：

- `arch`：重要架构、技术选型、数据模型、兼容策略或安全边界决策
- `ops`：发布、部署、迁移、仓库/CI 配置、生产或远端仓库重要操作
- `fix`：值得复盘的故障、回归、数据安全事故、验证链路缺口或重复发生的问题

不写入长期变更记录的情况：

- 仅本轮临时状态、普通命令输出、可从 commit diff 直接恢复的细节
- 低风险拼写、格式、局部注释或不影响协作者决策的小改动
- `.ai/STATE.md`、`.ai/runs/` 已足够承载的本机 runtime 信息

如果仓库已有 `docs/changes/` 体系，必须按现有编号和索引规则追加，并同步更新相关 README / index。若仓库尚无该体系，只在 `.ai/runs/` 记录 `changedoc: not_applicable | recommended`，不得为小任务临时制造文档架构。

### 12.0 Issue Closure Gate

关闭 CNB Issue 或把本地队列标记为 Done 前，必须确认：

1. `VERIFY_PASS` 已覆盖当前任务的必要功能测试
2. 插件功能变更已完成自动化 smoke test
3. E2E 或等价端到端验证已完成；不适用时已记录原因和替代验证
4. Review 没有 P0/P1/P2 必修问题；`SIMPLE` 可做 focused self-review，`COMPLEX` 或 `HIGH risk` 必须做 structured review
5. 如需 CNB handoff，`HANDOFF_SELF_REVIEW` 已通过
6. 受控 git checkpoint commit 已完成

默认分支工作流下，Agent 完成验证、自审、commit、push 并创建 CNB pull 后，任务状态为 `CNB_REVIEW_OPEN`。`CNB_REVIEW_OPEN` 是合法交付终态，表示 Agent work complete, awaiting CNB review/merge。此时：

- 可以输出 `PASS`
- 本地队列状态保持 `CNB_REVIEW_OPEN`
- CNB Issue 保持 open，直到 CNB pull merged 或用户明确要求关闭
- watchdog 不得重复执行该任务，除非 CNB pull 更新、冲突、CI 失败、review comment 或用户明确要求继续处理

如果功能测试不完整，即使代码已经修改、构建已经通过，也不得关闭 Issue，不得把任务标记为 Done，不得输出 `PASS`。

此时必须输出：

```text
BLOCKED: functional verification incomplete
Task: <source:id> <title>
State: code changed but task remains open
Missing verification:
- <缺失的功能测试>
Next: <补齐自动化测试或环境所需动作>
```

### 12.1 Git Checkpoint

每个 repo-change 任务完成后，必须创建一次受控 git commit。

no-change review/advice 禁止 fake commit，最终记录：

```text
Commit: N/A — no repository changes
```

### 12.1.1 Branch And CNB Handoff Gate

后续任务默认不得直接在 `main` 分支上工作。

适用范围：

- `repo-change`
- 修改版本化文件的 `agent-process-maintenance`

执行规则：

1. 启动任务时先确认当前分支和 `git status --short`。
2. 从最新可用的 `main` 创建任务分支，默认命名为 `codex/<task-slug>`；用户指定分支名时按用户要求。
3. 所有实现、验证、commit、push 都在任务分支完成。
4. VERIFY、REVIEW、HANDOFF_SELF_REVIEW 全部通过后，创建 CNB pull。
5. 除非用户明确要求并确认，不得由 Agent 自行合并 CNB pull。
6. CNB pull 创建后将本地队列状态设为 `CNB_REVIEW_OPEN`；只有 CNB pull 合并后，才关闭对应 CNB Issue；如果用户明确要求先关闭，必须在 run 记录原因。

允许例外：

- 用户明确要求直接在 `main` 修复。
- 紧急恢复或仓库维护要求直接动 `main`，且用户确认。
- no-change review/advice 不创建分支、不创建 CNB pull。

如果进入 EXECUTE 前发现仍在 `main` 且当前任务需要版本化提交，必须先创建任务分支；如果已有 in-scope 修改无法安全带到分支，输出：

```text
NEED_HUMAN_DECISION: task changes started on main and cannot be safely moved to a branch
```

提交前必须执行：

```bash
git status --short
git diff --cached --name-only
git diff --cached --check
```

stage 规则：

- 只允许使用 `git add -- <file...>` 添加当前任务 Commit Scope
- 禁止使用 `git add .`
- 禁止使用 `git add -A`
- 禁止把启动前已经存在的无关修改带入 commit
- 禁止提交本机 cache、日志、临时会话、密钥、环境文件和绝对路径 symlink
- 禁止提交 `.ai` runtime state、`.42cog` 非 spec 本机模型、`.codex` 非 skills 本机文件，除非当前任务明确版本化这些资产

如果 `git diff --cached --name-only` 出现当前任务范围外文件，必须：

```bash
git restore --staged -- <out-of-scope-file>
```

然后回到 VERIFY。

如果当前任务范围文件混有用户已有无关修改，必须停止并输出：

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

本机 AI 工作态处理规则：

- `.ai/STATE.md`、`.ai/QUEUE.md`、`.ai/runs/`、`.ai/memory/` 仍然必须按 PERSIST 更新，但属于 `.ai local runtime state`
- `.ai/WORKFLOW.md`、`.ai/prompts/**`、`.codex/skills/**` 和 `.42cog/spec/**` 可以在明确任务范围内版本化
- `.ai` runtime records 不属于 Commit Scope；checkpoint commit 不要求清理、提交或回滚本机 AI runtime dirty files
- Git checkpoint 只提交代码仓库应版本化的任务产物

提交完成后，必须记录：

- 最终输出中的真实 commit hash
- 本机 `.ai/STATE.md` 和 `.ai/runs/<date>-<task-id>.md` 中的 `commit_hash: pending`
- staged 文件列表
- 验证命令和结果
- 未提交但保留的无关修改摘要

---

## 13. NEXT：进入下一轮

如果当前任务完成：

```text
PASS
Task: <source:id> <title>
State: <DONE | CNB_REVIEW_OPEN>
Done:
- <完成事项 1>
- <完成事项 2>
Verification:
- <命令或检查>: <结果>
Commit: <hash>
CNB Pull: <url or N/A>
Issue: <closed | open until CNB pull merge | N/A>
Notes: <none 或剩余风险>
```

禁止只输出裸 `PASS`。`PASS` 后必须说明当前任务完成程度、验证结果、真实 commit hash、CNB handoff / Issue 状态和遗留风险。默认分支工作流下，`State: CNB_REVIEW_OPEN` 表示 Agent work complete, awaiting CNB review/merge。

然后必须执行 NEXT 决策，而不是默认结束：

```yaml
next_decision:
  continue_queue: true | false
  reason: <why>
  remaining_budget: <time/retry/entity summary>
```

如果 `continue_queue: true`，回到 ORCHESTRATE，重新读取远端 Issue 列表摘要和本地队列索引，
继续 GROUP / SELECT。不得复用刚完成任务的上下文直接开始下一个任务。

只有在无 ready task、预算不足、连续失败预算触发、下一个候选需要人类决策、工作区出现
in-scope 冲突，或用户明确要求停止时，才可以 `continue_queue: false`。

如果当前任务阻塞：

```text
BLOCKED: <reason>
Task: <source:id> <title>
State: <已完成到哪一步>
Evidence:
- <已确认事实或失败输出>
Next: <解除阻塞需要什么>
```

记录后跳过当前任务。

如果没有任务：

```text
HEARTBEAT_OK
Queue: no ready tasks
```
