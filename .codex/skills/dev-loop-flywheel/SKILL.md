---
name: dev-loop-flywheel
description: "读取并沉淀自主开发循环记忆，让 AI 工作流程持续积累。用于 repo-change、governance-change、队列/看门狗恢复、评审或修复规划前读取匹配的模式、教训和指标；也用于 review、fix、verification、PASS、FAIL、BLOCKED 或 handoff 后，当评审输出 new_patterns、lesson_to_persist 或 metric_updates 时写入飞轮记忆。"
---

# 开发循环飞轮

这个 skill 有两种模式：

- 开工前：读取匹配的本地记忆，只带入当前任务真正相关的规则。
- 收工后：沉淀新模式、keep/avoid 教训和循环指标。

目标是让开发循环复利增长，而不是写日记。每条记忆都必须能改变未来行动。

本 skill 只读写 `.ai/memory/**` 下的本地 AI 记忆。它不修改产品代码、spec、评审发现、Issue、PR、提交、`.codex`、CNB 状态或真实 Zotero 数据。

所有 `FLYWHEEL_*` 都只是本地子任务或任务备注信号，绝不能替代仓库最终信号，例如 `PASS`、`FAIL`、`BLOCKED`、`NEED_HUMAN_DECISION` 或 `HEARTBEAT_OK`。

## 记忆文件

使用这三个文件：

- `.ai/memory/dev-loop-patterns.md`：AI 发现的可复用模式。
- `.ai/memory/dev-loop-lessons.md`：评审和修复得到的 keep/avoid 教训。
- `.ai/memory/dev-loop-metrics.md`：判断循环是否变好的指标。

文件不存在时可以创建。除非修正本轮明显笔误，否则保持追加写入。不要保存密钥、令牌、凭据、Cookie、用户隐私数据、完整聊天记录或大段源码。

## 开工前

在规划 repo-change、governance-change、评审轮或自主队列任务之前：

1. 如果三个记忆文件存在，先读取它们。
2. 只选择和当前任务匹配的条目，匹配维度包括 `触发`、`适用范围`、任务类型、验证层级、涉及路径、skill、评审视角、看门狗/队列相关性。
3. 最多应用 5 条，优先使用最具体的 3 条。
4. 有必要时，把选中的条目 ID 记录到任务备注或本地状态。
5. 在写代码、文档、测试、流程或评审输出前应用这些匹配规则。

如果没有匹配项，不要强行制造记忆依赖。空队列的看门狗心跳不能追加记忆。

本模式结束时输出 `FLYWHEEL_CONTEXT_READY` 或 `FLYWHEEL_CONTEXT_EMPTY`。

## 收工后

每个 review/fix/verification round 后，以及最终 `PASS`、`FAIL`、`BLOCKED` 或 handoff 前：

1. 从评审输出、验证证据、失败、用户纠正或实现中的意外发现里提取可复用记忆。
2. 只有在已有验证或评审证据后才写入。
3. 写入前读取 `references/templates.md`，使用其中的精确模板和可行动性测试。
4. 写入指标前读取 `references/metrics.md`，使用指标模板和更新规则。
5. 分别把模式、教训和指标追加到对应记忆文件。
6. 只有当前自主流程正在使用 `.ai/STATE.md` 或 `.ai/tasks/<task-id>.md` 时，才更新这些状态文件。
7. 把创建、更新、跳过或 supersede 的条目 ID 记录到 task/run notes。

不要写空泛表扬、复盘作文或无法改变未来行为的一次性事实。

## 写入规则

写入前先给每个候选项分类：

- `immediate_write`：可复用的成功/失败模式、协议改进、工具行为或可衡量的循环变化。
- `needs_human_review`：敏感的人际/组织判断、含糊政策、尚未明确确认的用户偏好。
- `prohibited`：密钥、凭据、用户隐私数据、完整聊天记录、大段源码、单样本个人评价或空泛建议。

只有 `immediate_write` 可以无人值守写入。`needs_human_review` 只记录到任务备注，并返回 `FLYWHEEL_SKIPPED: needs_human_review`。

追加前，先扫描目标记忆文件里是否已有匹配的 `规则`、`可复用规则` 或 `指标`。如果相同规则已存在且本轮没有新增行为，就跳过。如果相同规则或指标有新证据，尽量更新已有条目。如果规则发生变化，新增条目并写 `Supersedes: <old-id>`。

## 输入契约

当其他 skill 或 reviewer 给出结构化输出时，消费这些字段：

```yaml
new_patterns: []
lesson_to_persist:
  keep: []
  avoid: []
metric_updates: []
```

如果没有这些字段，最多从真实证据中推断 3 条有用记忆。宁可不写，也不要填充废话。

## 输出信号

独立执行“写入模式”时，最后只输出一个本地信号：

```text
FLYWHEEL_PERSISTED
```

或：

```text
FLYWHEEL_SKIPPED: <reason>
```

最终备注必须包含变更过的记忆文件路径和条目 ID。
