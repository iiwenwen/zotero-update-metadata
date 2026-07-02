---
name: zotero-review
description: "为 Zotero 元数据插件和 AI 自主工作流执行多视角对抗评审。用于 PASS、PR handoff、CNB Issue closure 前，或涉及 Zotero 数据写入、元数据字段、附件、笔记、标签、Extra、translator、watchdog/queue/resume、自动化 smoke test、Git scope 的高风险改动。评审必须由独立 reviewer sub-agent 或等价的干净 Codex thread 完成；实现 agent 不允许自评通过。"
---

# Zotero 评审

使用这个 skill 找出单次自查容易漏掉的问题。评审必须由独立 reviewer 执行，并由独立 lead reviewer 汇总发现，不能让任一视角把另一个视角的风险解释掉。

这个 skill 只做评审闸门。它不读取 Issue、不修代码、不建分支、不提交、不推送、不合并、不关闭 CNB Issue，也不运行看门狗。它可以评审 `fix-issues`、`dev-fix-watch`、`dev-changedoc` 和 `changedoc-commit` 产生的产物，但不替代这些 skill。

## 独立性闸门

实现 agent 不能成为最终 reviewer。

在实现 agent 报告任务 `PASS` 前，必须委托一个独立 lead reviewer sub-agent；如果当前平台没有 sub-agent 工具，但允许使用等价干净 Codex thread，也可以使用干净 thread。lead reviewer 必须收到下面的 sealed reviewer packet，并返回 findings 以及唯一的 `REVIEW_ROUND_<n>` 信号。

允许的 reviewer 组织方式：

- 首选：每个必查视角一个独立 reviewer sub-agent，再加一个独立 lead reviewer 汇总发现并输出唯一 `REVIEW_ROUND_<n>` 信号。
- 可接受：一个 reviewer sub-agent 跑完全部必查视角。
- 兜底：一个干净的独立 Codex thread/model 跑完全部必查视角。

不允许：

- 实现 agent 重读自己的 diff 后宣布 `PASS`。
- 实现 agent 把 reviewer 的 `FAIL` 重新解释成非阻塞，而没有修复。
- 没有独立 reviewer，却仍然报告任务 `PASS`。

如果无法启动独立 reviewer，输出：

```text
NEED_HUMAN_DECISION: independent reviewer unavailable
```

这是任务级中止，不是 review-round 信号。没有独立 reviewer 时，不要输出 `REVIEW_ROUND_<n>`。

## 评审材料包

给 reviewer 原始证据，不给预设答案。

packet 必须包含：

- review round 编号、finding ID 前缀，例如 `ZR-<round>-`，以及本轮允许的最终信号。
- 任务来源、目标、验收标准、非目标和用户可见范围。
- 实际 diff、已 staged 文件（如有）、必须保持不动的 out-of-scope 文件。
- verification tier、已运行命令、输出、baseline failure 和残余风险。
- 相关 Issue/PR/CNB 状态，但不要要求 reviewer 管理这些平台状态。
- 判断任务所需的 AGENTS、`.ai`、42COG/spec 或 skill 规则。
- 上轮仍打开的 findings、稳定 finding ID 和关闭证据。

不要包含：

- 实现 agent 偏好的结论。
- 要求 reviewer “确认没问题”的提示。
- 已有原始材料时，不要只给隐藏诊断、预期修复或不可验证摘要。

reviewer 只读。它们不能改文件、stage、commit、push、merge、关闭 CNB Issue、修改 `.ai` 状态，也不能接触真实 Zotero profile 或 library。

## 主评审规则

如果使用多个视角 reviewer，它们只产出 findings。独立 lead reviewer 是唯一允许输出最终 `REVIEW_ROUND_<n>` 信号的 reviewer。实现 agent 不能把 findings 聚合成 pass/fail 决策。

如果任一视角 reviewer 报告 `FAIL`、`NEED_HUMAN_DECISION` 或仍有未关闭的 P0/P1/P2 finding，lead reviewer 必须判定本轮 FAIL。finding 的重新分级或关闭必须有 packet 证据或新 review round 证据。

## 评审契约

评审实际 diff、任务目标、验收标准、验证证据、staged 文件和相关 workflow 状态。只要还有 P0/P1/P2 finding 未关闭，就不能标记完成。

必查视角：

1. 意图与上下文评审：把当前用户请求、任务来源、长期决策和“人类只处理异常”的规则映射成验收标准，先抓意图漂移，再判断实现质量。
2. 冗余评审：查重复规则、重叠流程、死文本、过期状态、重复提示和不必要抽象。
3. 并发与边界评审：查 watchdog lock、NEXT re-entry、queue ordering、retry budget、幂等性、部分写入、超时和实体数量限制。
4. Zotero 数据安全评审：保护真实用户库。检查 item 字段、附件、笔记、标签、Extra、URL/source 更新、translator 行为、备份、隔离 profile、fixture 和回滚路径。
5. 回归评审：检查旧命令、菜单、偏好设置、构建脚本、hot reload、CNB handoff、测试和既有 workflow 保证。
6. 验证与 Git 范围评审：检查 smoke/E2E 证据、实现 fix-round 信号、reviewer `REVIEW_ROUND_<n>` 信号、staged 文件、敏感凭据、cache、本地 `.ai` 状态、`.codex` scope 例外和 commit-message 证据。

## 评审轮协议

review round 是独立 reviewer 周期。fix round 是实现周期，用来响应失败评审或失败验证。不要把两者混在一起。

每个 review round 最后必须输出且只输出一个机器可判定的 reviewer 结果：

```text
REVIEW_ROUND_<n>: PASS
```

或：

```text
REVIEW_ROUND_<n>: FAIL
```

或：

```text
REVIEW_ROUND_<n>: NEED_HUMAN_DECISION: <reason>
```

当一轮失败：

1. 真实修改代码、文档、测试、workflow 或状态，不能做 no-op。
2. 重新运行最小相关验证。
3. 开启新的独立 reviewer round。
4. 用证据重新打开或关闭每个稳定 finding ID，不能悄悄丢弃 finding。
5. 使用 `dev-loop-flywheel` 持久化有价值的 `new_patterns`、`lesson_to_persist` 和 `metric_updates`。
6. 把已持久化的 memory entry ID 记录到当前 task/run notes。

如果同一个 blocking finding 连续两个 fix round 后仍未解决，把任务标记为 `BLOCKED`，保留证据，不要把它重新包装成通过。

## 严重级别

- P0：数据丢失、安全暴露、真实 Zotero library 变更、核心 workflow 断裂、不可逆状态损坏。
- P1：重要用户流程失败、旧行为回归、缺少必要自动化 smoke test、Issue 错误关闭、不安全 queue/watchdog 行为。
- P2：可复现边界风险、验证不完整、fallback 含糊、可能导致未来错误的可维护性风险。
- P3：不阻塞完成的改进项。

只有当存在具体复现路径、违反规则或缺失阻塞性证据时，才列 P0/P1/P2。

## 输出格式

每个 review round 必须包含：

```yaml
findings:
  P0: []
  P1: []
  P2: []
  P3: []
decision: PASS | FAIL | NEED_HUMAN_DECISION
required_fixes: []
new_patterns: []
lesson_to_persist:
  keep: []
  avoid: []
metric_updates: []
```

`decision` 必须和最终 `REVIEW_ROUND_<n>` 信号一致。只要 P0/P1/P2 finding 未在同一轮用证据关闭，`decision` 就必须是 `FAIL`。

每个视角按下面格式输出：

```md
## <Perspective Name>

### P<level> ZR-<round>-<nn>: <title>
文件 / 规则:
<path, method, or workflow rule>

证据:
<diff, command, staged file, log, or missing proof>

为什么重要:
<risk>

最小修复:
<smallest acceptable change>

必要验证:
<command, smoke test, structured check, or review evidence>
```

finding ID 在关闭前必须跨轮保持稳定。

如果某个视角没有阻塞问题，写：

```text
<Perspective Name>: no P0/P1/P2 findings
```

每个 reviewer round 结束时只输出一个 reviewer 信号：

```text
REVIEW_ROUND_<n>: PASS
```

或：

```text
REVIEW_ROUND_<n>: FAIL
```

或：

```text
REVIEW_ROUND_<n>: NEED_HUMAN_DECISION: <reason>
```

实现 agent 只有在所有必查视角都没有 P0/P1/P2、验证/Git scope 证据足够，并且最终信号来自独立 reviewer sub-agent 或等价干净 Codex thread 时，才可以把 `REVIEW_ROUND_<n>: PASS` 翻译成任务 `PASS`。
