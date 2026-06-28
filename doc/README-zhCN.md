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

运行 `npm run start` 会通过 `zotero-plugin-scaffold` 构建插件、用配置的开发
profile 启动 Zotero，并监听 `src/` 与 `addon/` 变化。旧的独立 reload 快捷入口已
不再暴露，因为裸 `zotero://ztoolkit-debug` URL 可能被错误的 Zotero profile 接管。

运行 `npm run build` 可在 `build/` 生成生产 XPI；运行 `npm test` 只执行不会启动
Zotero 的 Node smoke test。

## ChangeLog

- 2024-04-09 发布1.0.0 初始版本
