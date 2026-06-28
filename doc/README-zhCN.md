# Zotero Update Metadata

[![zotero target version](https://img.shields.io/badge/Zotero-7--9-green?style=flat-square&logo=zotero&logoColor=CC2936)](https://www.zotero.org)

[English](../README.md) | [Chinese](README-zhCN.md)

这个项目允许你直接从Zotero条目的URL字段更新或保存元数据，无需在对应页面上保存元数据。

## 功能

- 从Zotero条目的URL字段更新或保存元数据。

## 使用

1. 在Zotero中选中条目。
2. 右键点击更新元数据按钮。
3. 等待更新或保存条目。

## 注意

- 目前只适用于使用豆瓣保存的条目。
- 兼容目标：Zotero 7.0 到 Zotero 9.0.*。

## TODO

- [ ] 更新条目时可选择是否保存附件

## 致谢

- 本插件使用 Zotero Plugin Template 脚手架构建。
- 本插件核心代码基于早期 Zotero update-metadata 插件工作修改而来。
- 本插件部分实现模式参考已有 Zotero 元数据与翻译插件。

## Disclaimer 免责声明

在 AGPL 下使用此代码. 不提供任何保证. 遵守你所在地区的法律！

## 开发

复制 `.env.example` 为 `.env`，并确保 `ZOTERO_PLUGIN_PROFILE_PATH` 和
`ZOTERO_PLUGIN_DATA_DIR` 指向隔离的开发 profile 与数据目录。

运行一次 `npm start` 或 `npm run dev` 进入 scaffold 托管的热重载流程。启动脚本会先
检查 Zotero 是否已经运行：如果已经运行，就保持现状并退出；如果尚未运行，才交给
`zotero-plugin serve` 构建插件、启动配置的开发 profile，并监听 `src/` 与 `addon/`
变化。保持 scaffold 进程运行即可热更新，不要每次修改后反复重启 Zotero。

旧的独立 reload 快捷入口已不再暴露，因为裸 `zotero://ztoolkit-debug` URL 可能被错误
的 Zotero profile 接管。

开发脚本按用途分层：

- `npm run format:check`：对插件代码、生成 typings 和根目录项目配置执行
  Prettier 检查。
- `npm run lint:check`：先运行 `format:check`，再只对插件代码执行 ESLint，包括
  `src/`、`test/` 和 `addon/`。生成产物、scaffold profile、日志和 agent 工作流文件
  不进入默认 lint gate。
- `npm run build:xpi`：通过 scaffold 在 `build/` 生成生产 XPI。
- `npm run typecheck`：只执行 TypeScript 检查，不重新打包 XPI。
- `npm run build`：先运行 `build:xpi`，再运行 `typecheck`。
- `npm run test:unit`：执行不会启动 Zotero 的 Node smoke test。
- `npm run test:ui`：使用 scaffold 测试 profile 执行 Zotero runtime smoke test。
  修改 UI、偏好或 Zotero 数据写入行为时使用。
- `npm run check`：快速 PR 前置检查，包含 lint、build 和 unit smoke。
- `npm run verify`：完整本地检查，包含 `check` 和 Zotero UI smoke。
- `npm run release`：版本变更流程。release hook 会在 bump 前运行 `check`，并在
  bump 后重新构建，确保 XPI 元数据使用新版本。本项目发布走 CNB release 流程，不使用
  GitHub 自动发布。
- `npm run release:dry-run`：预览版本变更流程，不写入 release。

## ChangeLog

- 2024-04-09 发布1.0.0 初始版本
