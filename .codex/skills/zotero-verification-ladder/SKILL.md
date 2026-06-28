---
name: zotero-verification-ladder
description: |
  Chooses the lowest safe verification tier for this Zotero metadata plugin and
  decides when Zotero runtime or UI checks are justified. Use for Zotero code
  changes, UI/runtime checks, data writes, preferences, plugin behavior,
  build/release changes, hooks, or when deciding whether Zotero should be
  started.
argument-hint: "[task or changed files]"
disable-model-invocation: false
user-invocable: true
metadata:
  author: 42ailab
  version: 1.0.0
  title: Zotero 验证阶梯
  description_zh: 为 Zotero 元数据插件选择最低安全验证层级，并判断是否需要启动 Zotero runtime 或 UI 检查。
---

# Zotero Verification Ladder

Use this skill to prove a change at the lowest safe verification tier before escalating to Zotero UI/runtime. The goal is to prevent unnecessary Zotero launches while still proving user-visible and data-writing behavior.

## When to Use

- Zotero plugin code, UI/runtime behavior, preferences, or metadata writes change.
- A task needs a `verification_tier` decision or evidence plan.
- A command could launch, reload, stop, or otherwise control Zotero.
- Agent workflow, hook, or QA changes affect Zotero verification policy.

## When NOT to Use

- The task is unrelated to Zotero plugin behavior or verification.
- The user only asks for general code explanation without repository-state judgment.
- The task already has a narrower project skill that fully owns verification.

## Required Specs

Read only the specs needed by the touched behavior:

- QA tier and test ladder: `.42cog/spec/qa-zotero-verification.md`
- Zotero data writes or preferences: `.42cog/spec/zotero-data-safety.md`
- Zotero runtime or UI commands: `.42cog/spec/runtime-command-policy.md`
- User-visible plugin behavior: `.42cog/spec/plugin-behavior-contracts.md`
- Dependency or release changes: `.42cog/spec/dependency-policy.md`

## Tier Choice

Record `verification_tier` before running checks:

- `docs_or_process`: docs, agent workflow, prompts, hooks, skills, or local runtime state.
- `pure_build_or_types`: build scripts, type declarations, manifest or dependency declarations without behavior changes.
- `pure_logic`: fixture/harness-verifiable logic that does not require Zotero UI.
- `user_visible_plugin_behavior`: menu, ProgressWindow, preferences UI, command entry, or visible feedback.
- `zotero_data_write_or_preferences`: item writes, attachments, notes, tags, Extra, collections, library IDs, or preference persistence.
- `release_or_dependency`: release, update JSON, manifest compatibility, dependency main-version policy.

## Test Ladder

Run the lowest tier that proves the task:

1. Static/unit smoke: TypeScript, build, fixture, harness, or target function check.
2. Functional smoke: automated behavior, data strategy, error feedback, or log marker check.
3. Scaffold-managed Zotero UI/integration: only when the first two layers cannot prove the required runtime or user-visible path.

Do not start Zotero merely to feel safer. If the task is docs/process only, record `E2E: not applicable` and use structured text checks, diff checks, staged scope checks, and review.

## Workflow

1. Classify the touched behavior and read only the matching spec files.
2. Choose `verification_tier` before running checks and record the reason.
3. Run the lowest ladder level that proves the task.
4. Escalate to runtime/UI only when lower levels cannot prove the required behavior.
5. After verification, check that the evidence matches the original goal and touched specs.

Exit criteria: verification evidence is specific, repeatable, and does not rely on a real user Zotero profile.

## Runtime Safety

Before any command that may launch or reload Zotero, record:

- why lower ladder levels are insufficient
- the exact npm script
- isolation evidence for profile/data directory or scaffold runner
- whether `E1 Zotero 条目` or `E3 插件配置` can be written
- recovery or stop condition if isolation cannot be proven

Never use a real user Zotero profile or library. If isolation is unknown, stop with `BLOCKED: isolated test library unavailable` or `NEED_HUMAN_DECISION`.

## Output Evidence

Verification notes must include:

```yaml
verification_tier:
reason:
specs_read: []
commands_run: []
higher_tier_skipped_reason:
real_user_zotero_touched: no
result: pass | fail | blocked
```
