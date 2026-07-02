# 开发循环指标

指标用来判断自主开发循环有没有变好。优先维护稳定指标卡，并追加带日期的观察记录，不要每轮创建重复指标卡。

## 初始指标

- `fix_rounds_to_pass`
- `review_blocking_findings_by_severity`
- `repeated_finding_count`
- `verification_failures_before_pass`
- `watchdog_resume_success_rate`
- `startup_state_mismatch_count`
- `memory_entries_applied_count`
- `dedupe_skipped_count`

## 指标模板

```md
## M-YYYYMMDD-001: <指标名称>

指标:
- <测量什么>

基线:
- <旧值、unknown 或 not yet measured>

目标:
- <期望方向或阈值>

当前:
- <本轮观察值>

行动:
- <已经做的改变或下一步改进>

适用范围:
- <workflow、评审类型、skill 或任务类型>

观察记录:
- YYYY-MM-DD: <数值和简短上下文>
```

## 更新规则

- 如果同一指标已经存在，只更新 `观察记录`，不要创建重复指标卡。
- 如果指标定义发生变化，创建新指标卡，并写 `Supersedes: <old-id>`。
- 观察记录要简短，不要粘贴日志或长评审输出。
