---
name: zotero-verification-ladder
description: "为这个 Zotero 元数据插件选择最低安全验证层级，并判断是否有必要启动 Zotero runtime 或 UI 检查。用于 Zotero 代码改动、UI/runtime 检查、数据写入、偏好设置、插件行为、构建/发布变更、hook，或判断是否应该启动 Zotero。"
argument-hint: "[任务或变更文件]"
disable-model-invocation: false
user-invocable: true
metadata:
  author: 42ailab
  version: 1.0.0
  title: Zotero 验证阶梯
  description_zh: 为 Zotero 元数据插件选择最低安全验证层级，并判断是否需要启动 Zotero runtime 或 UI 检查。
---

# Zotero 验证阶梯

使用这个 skill 在升级到 Zotero UI/runtime 前，用最低安全层级证明改动。目标是避免不必要地启动 Zotero，同时仍能证明用户可见行为和数据写入行为。

## 什么时候使用

- Zotero 插件代码、UI/runtime 行为、偏好设置或元数据写入发生变化。
- 任务需要决定 `verification_tier` 或制定验证证据计划。
- 某个命令可能启动、reload、停止或控制 Zotero。
- 开发任务询问是否应该启动或重启 Zotero。
- agent workflow、hook 或 QA 改动影响 Zotero 验证策略。

## 什么时候不要使用

- 任务和 Zotero 插件行为或验证无关。
- 用户只要求一般代码解释，且不需要判断仓库状态。
- 已经有更窄的项目 skill 完全负责验证。

## 必读 Spec

只读取和被触碰行为相关的 spec：

- QA 层级和测试阶梯：`.42cog/spec/qa-zotero-verification.md`
- Zotero 数据写入或偏好设置：`.42cog/spec/zotero-data-safety.md`
- Zotero runtime 或 UI 命令：`.42cog/spec/runtime-command-policy.md`
- 用户可见插件行为：`.42cog/spec/plugin-behavior-contracts.md`
- 依赖或发布变更：`.42cog/spec/dependency-policy.md`

## 层级选择

运行检查前，先记录 `verification_tier`：

- `docs_or_process`：文档、agent workflow、prompt、hook、skill 或本地 runtime 状态。
- `pure_build_or_types`：构建脚本、类型声明、manifest 或依赖声明，且没有行为变化。
- `pure_logic`：可用 fixture/harness 验证、且不需要 Zotero UI 的逻辑。
- `user_visible_plugin_behavior`：菜单、ProgressWindow、偏好 UI、命令入口或可见反馈。
- `zotero_data_write_or_preferences`：item 写入、附件、笔记、标签、Extra、collection、library ID 或偏好持久化。
- `release_or_dependency`：发布、update JSON、manifest 兼容性、依赖主版本策略。

## 测试阶梯

运行能证明任务的最低层级：

1. 静态/unit smoke：TypeScript、build、fixture、harness 或目标函数检查。
2. 功能 smoke：自动化行为、数据策略、错误反馈或日志标记检查。
3. scaffold 管理的 Zotero UI/integration：只有当前两层无法证明所需 runtime 或用户可见路径时才使用。

不要为了“更安心”而启动 Zotero。如果任务只是 docs/process，记录 `E2E: not applicable`，并使用结构化文本检查、diff 检查、staged scope 检查和 review。

对 scaffold 管理的开发，把 `npm run start` / `npm run dev` 当成一次性守卫：先检查 Zotero 是否已经运行；如果已经运行，保持不动，依赖 scaffold hot reload。只有 Zotero 未运行时，才启动 scaffold serve。

## 工作流

1. 分类被触碰的行为，并只读取匹配的 spec 文件。
2. 运行检查前选择 `verification_tier`，并记录原因。
3. 运行能证明任务的最低阶梯。
4. 只有低层级无法证明所需行为时，才升级到 runtime/UI。
5. 验证后，检查证据是否匹配原始目标和被触碰的 spec。

退出标准：验证证据具体、可重复，且不依赖真实用户 Zotero profile。

## Runtime 安全

在任何可能启动或 reload Zotero 的命令前，记录：

- 为什么较低验证层级不足。
- 精确的 npm script。
- profile/data directory 或 scaffold runner 的隔离证据。
- 是否可能写入 `E1 Zotero 条目` 或 `E3 插件配置`。
- 如果无法证明隔离，恢复方式或停止条件是什么。
- 这是否是一次性 scaffold start guard；如果 Zotero 已经运行，不要 restart、reload 或 stop。

绝不使用真实用户 Zotero profile 或 library。如果隔离状态未知，返回 `BLOCKED: isolated test library unavailable` 或 `NEED_HUMAN_DECISION`。

## 输出证据

验证备注必须包含：

```yaml
verification_tier:
reason:
specs_read: []
commands_run: []
higher_tier_skipped_reason:
real_user_zotero_touched: no
result: pass | fail | blocked
```
