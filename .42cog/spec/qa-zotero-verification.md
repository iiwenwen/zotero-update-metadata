# Zotero QA 与验证分层规约

<meta>
  <document-id>zotero-update-metadata-qa-zotero-verification</document-id>
  <version>1.0.0</version>
  <project>zotero-update-metadata</project>
  <type>QA Verification Specification</type>
  <created>2026-06-28</created>
  <depends>.42cog/cog/cog.md</depends>
  <depends>.42cog/spec/zotero-data-safety.md</depends>
  <depends>.42cog/spec/runtime-command-policy.md</depends>
</meta>

## Cog 对齐

本规约必须参考 `.42cog/cog/cog.md`：

- 主体：`A1 Zotero 用户`、`A2 插件维护者`、`A3 Codex 开发智能体`
- 核心实体：`E1 Zotero 条目`、`E2 外部网页元数据`、`E3 插件配置`、`E4 插件构建产物`、`E5 依赖主版本线`
- 信息流：`F1 更新已有条目`、`F2 保存新条目`、`F3 构建发布`、`F4 依赖升级决策`
- 相关权重：Zotero 条目数据安全 5/5、外部网页元数据准确性 4/5、插件配置兼容性 4/5、依赖主版本线稳定性 4/5、构建发布产物正确性 3/5、用户可见反馈 3/5

## Verification Tier

AI workflow 只选择并记录 `verification_tier` 与理由；具体验证矩阵以本规约为准。

| tier | 适用变更面 | 最低验证 |
| --- | --- | --- |
| `docs_or_process` | 文档、流程规则、本机 AI 工作态 | 文本结构检查、规则检索、diff check、staged scope、自审 |
| `pure_build_or_types` | 构建脚本、类型、依赖声明但不改变运行行为 | typecheck/build 或等价静态检查；若涉及 `E5/F4`，同时读取依赖策略 |
| `pure_logic` | 可用 fixture/harness 验证的纯逻辑 | unit/fixture/functional smoke，不启动 Zotero UI |
| `user_visible_plugin_behavior` | 菜单、ProgressWindow、偏好窗口、用户可见反馈 | build + functional smoke；当前两层不能证明时再执行 runtime/UI |
| `zotero_data_write_or_preferences` | 写入条目、附件、笔记、标签、Extra、偏好持久化 | 隔离 profile/library + runtime/integration smoke，并证明真实用户库未连接 |
| `release_or_dependency` | release、manifest、update.json、依赖主版本线 | build + 兼容声明检查 + 对应 spec 的版本/发布矩阵 |

## Test Ladder

1. `static/unit smoke`：纯 Node、TypeScript、fixture、harness、构建或目标函数检查。
2. `functional smoke`：最小自动化路径验证目标用户行为、数据策略、错误反馈或日志 marker。
3. `scaffold-managed Zotero UI/integration`：仅当前两层无法证明用户可见或运行时路径时执行。

## 验证记录

每次 VERIFY 必须记录：

- `verification_tier`
- 选择该 tier 的理由
- 读取的相关 Cog/spec 文件
- 执行过的命令或结构化检查
- 未执行更高 tier 的理由
- 是否涉及真实 Zotero 用户库；若涉及则必须停止并请求确认
