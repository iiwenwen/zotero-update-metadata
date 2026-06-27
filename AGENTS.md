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

每轮开始必须按顺序读取：

1. `AGENTS.md`
2. `.ai/WORKFLOW.md`
3. `.ai/STATE.md`
4. `.ai/QUEUE.md`
5. 当前任务 Issue 或 `.ai/tasks/<task-id>.md`

禁止启动时主动遍历整个仓库文档。

禁止启动时读取所有 `.ai/memory/`、`.ai/runs/` 历史文件。

只有在当前任务需要时，才按需读取相关 memory 或 run 归档。

---

## 2. Core Execution Rules

你必须遵守：

- 用户在对话中直接提出新的 bug、需求或任务时，必须先创建 CNB Issue；没有远端 Issue 编号，不得进入 EXECUTE
- 一次只处理一个任务
- 一次只处理不超过 4 个核心实体
- 不要顺手修无关问题
- 不要扩大需求边界
- 不要重写用户目标
- 不要在没有验证的情况下宣布完成
- 不要把失败伪装成完成
- 不要因为一个任务卡住而阻塞整个队列
- 如果任务卡住，记录原因，标记 `BLOCKED`，然后进入下一个任务

---

## 3. Reality Sync Rule

动手前必须确认真实状态。

至少检查：

- 当前分支
- `git status`
- 当前任务是否仍然有效
- 相关文件是否已经有未提交修改
- 上次状态文件是否与真实状态冲突
- 是否已有测试失败
- 是否存在未完成的中间改动

如果 `.ai/STATE.md` 与真实世界冲突，以真实世界为准，并更新 `.ai/STATE.md`。

---

## 4. Certainty Routing Rule

每个任务执行前必须判断：

```text
certainty: HIGH / MEDIUM / LOW
risk: LOW / MEDIUM / HIGH
```

执行规则：

```text
HIGH certainty + LOW risk      -> 可以自主执行
HIGH certainty + MEDIUM risk   -> 可以自主执行，但必须加强验证
MEDIUM certainty               -> 先调研，列出关键决策点
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

只有同时满足以下条件，才能标记任务完成：

1. 当前任务目标实现
2. Non-goals 没有被破坏
3. Acceptance Criteria 全部满足
4. 必要测试通过；插件功能变更必须包含自动化功能 smoke test，不能只靠人工手动验证
5. Review 没有 P0/P1/P2 必修问题
6. `.ai/STATE.md` 已更新
7. `.ai/runs/` 已写入本轮执行记录
8. 必要经验已沉淀到 `.ai/memory/`
9. 本任务范围内的修改已完成一次受控 git commit，并在提交说明中写明任务、具体变更和验证结果
10. CNB Issue 只有在 1-9 全部满足后才能关闭；功能测试不完整时不得关闭任务

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

## 8. Defense & Integrity Gate

每个任务进入 EXECUTE 前，必须同时设计成功路径和失败路径。

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

---

## 9. 42COG Project Entry

## 10. Git Checkpoint Rule

每完成一个任务，必须创建一次 git checkpoint commit。

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

`.ai/` 是本机工作态，不进入 git checkpoint。提交完成后，必须在最终输出写明真实 commit hash；下一轮 BOOT 以 `git log -1 --format=%H` 为准同步真实状态。

---

## 11. 42COG Project Entry

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
