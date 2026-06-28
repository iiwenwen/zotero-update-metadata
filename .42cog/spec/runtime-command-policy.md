# Zotero Runtime 命令策略

<meta>
  <document-id>zotero-update-metadata-runtime-command-policy</document-id>
  <version>1.0.1</version>
  <project>zotero-update-metadata</project>
  <type>Runtime Command Policy</type>
  <created>2026-06-28</created>
  <depends>.42cog/cog/cog.md</depends>
  <depends>.42cog/real/real.md</depends>
</meta>

## Cog 对齐

本规约必须参考 `.42cog/cog/cog.md`：

- 主体：`A2 插件维护者`、`A3 Codex 开发智能体`
- 核心实体：`E3 插件配置`、`E4 插件构建产物`
- 信息流：`F3 构建发布`
- 相关权重：插件配置兼容性 4/5、构建发布产物正确性 3/5、Zotero 条目数据安全 5/5

## 允许命令

- 非 UI 检查：`npm run build`、`npm test`、静态 smoke、fixture/harness。
- 受控 UI / runtime：默认只允许经过项目封装且已记录隔离证据的 `npm run start`、`npm run test:ui`、`npm run smoke:ui`。
- `reload` / `stop` 类命令默认不得由 Agent 主动使用；只有用户明确要求，或任务记录证明目标是隔离测试实例且 lower tiers insufficient 时，才能通过专门任务调整 hook/spec 白名单。

## 禁止命令

AI 不得直接执行：

- `/Applications/Zotero.app/Contents/MacOS/zotero`
- `open -a Zotero`
- 裸 `zotero`
- 裸 `zotero://...`
- 绕过项目 npm 脚本直接发送 `zotero://ztoolkit-debug` 或 `-url`
- 未经任务白名单的 `npm run reload`、`npm run reload:print`、`npm run stop`
- `node scripts/reload.mjs`、`node scripts/debug-url.mjs`、`node scripts/stop.mjs`

## Runtime 前置检查

执行任何可能启动或重载 Zotero 的命令前，必须记录：

- 当前 Zotero 进程属于 `isolated test instance` 还是 `real user instance`
- 将使用的 npm 脚本
- profile/data directory 或 scaffold test runner 隔离证据
- 是否写入 `E1 Zotero 条目` 或 `E3 插件配置`
- 失败后的退出、恢复或阻塞方式

无法证明隔离时，只能执行 `docs_or_process`、`pure_build_or_types` 或 `pure_logic` tier，不得声称 runtime 验证完成。
