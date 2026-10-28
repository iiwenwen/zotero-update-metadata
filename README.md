<p align="center">
  <img src="addon/content/icons/favicon.png" width="88" alt="Zotero 元数据更新图标">
</p>

<h1 align="center">Zotero 元数据更新</h1>

<p align="center">重新获取条目信息，先看差异，再决定更新什么。</p>

<p align="center">
  <img src="https://img.shields.io/badge/Zotero-10-CC2936?style=flat-square" alt="支持 Zotero 10">
  <img src="https://img.shields.io/badge/TypeScript-3178C6?style=flat-square&logo=typescript&logoColor=white" alt="使用 TypeScript">
  <img src="https://img.shields.io/badge/版本-0.4.0_开发版-orange?style=flat-square" alt="0.4.0 开发版">
</p>

<p align="center">
  <a href="#功能">功能</a> ·
  <a href="#界面预览">界面预览</a> ·
  <a href="#安装">安装</a> ·
  <a href="#使用">使用</a> ·
  <a href="#技术栈">技术栈</a> ·
  <a href="#本地开发">本地开发</a>
</p>

导入 Zotero 的文献信息缺了字段，或想重新核对作者、出版信息？这个插件会根据条目已有的 **URL 或 DOI** 获取信息，把新旧内容放在一起供你比较。你勾选哪些内容，插件就更新哪些内容。

## 功能

- **对照后更新**：查看本地信息与新获取内容的差异，逐项选择，不同意的内容保留原样。
- **单条与批量处理**：从条目侧栏快速操作，也可右键选择最多 50 个条目一起审核。
- **作者名单整组审核**：作者、编辑、译者的名单和顺序一起确认。
- **补充附件与笔记**：按需新增，保留已有内容；默认不勾选，减少意外添加。
- **查看结果与撤销**：查看最近的更新结果，重试失败项，或在符合恢复条件时撤销最近一次更新。

## 界面预览

截图来自 Zotero 10，使用演示条目。点击图片可查看大图。

<table>
  <tr>
    <th>条目侧栏</th>
    <th>插件设置</th>
  </tr>
  <tr>
    <td valign="top"><a href="docs/images/item-pane.jpg"><img src="docs/images/item-pane.jpg" width="420" alt="条目侧栏中的审核更新、查看批次状态和设置按钮"></a></td>
    <td valign="top"><a href="docs/images/preferences.jpg"><img src="docs/images/preferences.jpg" width="420" alt="插件设置：显示侧栏、默认勾选新增附件、默认勾选新增笔记"></a></td>
  </tr>
</table>

## 安装

需要 **Zotero 10 桌面版**。目前主要在 macOS 上测试，Windows 和 Linux 尚未充分验证。

> 当前主线是 **0.4.0 开发版**，尚未发布对应的 XPI 安装包。[Releases](https://github.com/iiwenwen/zotero-update-metadata/releases) 中现有安装包属于旧版。想试用当前版本，可先按[本地开发](#本地开发)中的步骤构建。

拿到 `.xpi` 文件后：

1. 打开 Zotero，进入 **工具 → 插件**。
2. 点击齿轮菜单，选择 **从文件安装插件**。
3. 选中 `.xpi` 文件，按提示完成安装。

首次使用前请备份文库，先用少量测试条目试用。

## 使用

1. 选中需要更新的书目条目。
2. 右键选择 **元数据更新 → 审核并更新所选条目**；单条也可以点击侧栏里的 **审核此条目的更新**。
3. 等待获取完成，对照新旧信息，勾选想采用的内容。
4. 点击 **更新所选内容**，查看处理结果。取消审核不会修改条目。

条目需要有可用的 URL 或 DOI。插件使用 Zotero 的网页抓取和标识符查询能力，能获取哪些信息取决于对应网站及 Zotero 的支持情况。豆瓣等网站可能限制访问，遇到拒绝访问时请勿连续重试。

### 默认设置

在 Zotero 设置中打开 **Zotero 元数据更新**：

| 设置 | 默认 | 作用 |
| --- | --- | --- |
| 在条目侧栏显示元数据更新 | 开启 | 显示单条更新入口；关闭后仍可使用右键菜单 |
| 默认勾选新增附件 | 关闭 | 下次审核时是否预选附件 |
| 默认勾选新增笔记 | 关闭 | 下次审核时是否预选笔记 |

### 更新与撤销要注意什么？

- 已有字段出现不同值时，默认不替换，需要你主动勾选。
- 作者名单按整组替换，确认前请检查成员和顺序。
- 已有附件和笔记不会被修改或删除；新增内容不自动去重，请留意重复。
- 撤销针对最近一次更新。后来手工改过的内容会保留并提示冲突，无法确认归属的新增内容也会保留。撤销不能代替备份。

## 技术栈

插件使用 **TypeScript + Zotero 原生扩展 API** 开发，界面直接使用 Zotero 的控件。

| 部分 | 使用的框架或工具 | 用途 |
| --- | --- | --- |
| 开发语言 | TypeScript | 插件逻辑与宿主接口调用 |
| 界面 | XHTML / XUL、DOM API | 侧栏、设置页和审核窗口 |
| 多语言 | Fluent（`.ftl`） | 中文与英文界面文案 |
| 开发与构建 | [Zotero Plugin Scaffold](https://github.com/northword/zotero-plugin-scaffold) 0.8.8 | 开发服务、热重载、构建与 XPI 打包 |
| 插件工具库 | [Zotero Plugin Toolkit](https://github.com/windingwind/zotero-plugin-toolkit) 5.2.0 | 对话框等插件开发辅助功能 |
| JavaScript 打包 | [esbuild](https://github.com/evanw/esbuild) 0.28.2 | 编译并打包 TypeScript 源码 |
| 类型定义 | [zotero-types](https://github.com/windingwind/zotero-types) 4.1.3 | Zotero API 类型支持 |
| 自动测试 | [Mocha](https://github.com/mochajs/mocha) 11.8 / [Chai](https://github.com/chaijs/chai) 6.2 | 核心逻辑、界面与工作流回归 |
| 开发环境 | Node.js 24、npm、Python 3.9+ | 依赖管理、构建与检查脚本 |

表中依赖版本对应当前锁文件，后续以 `package-lock.json` 为准。

## 本地开发

先安装 Node.js 24、Git；运行检查脚本还需要 Python 3.9+。

```bash
git clone https://github.com/iiwenwen/zotero-update-metadata.git
cd zotero-update-metadata
npm ci
npm run build
```

构建完成后，在 `.scaffold/build/` 中找到 `.xpi` 文件，即可安装到 Zotero。

常用命令：

| 命令 | 说明 |
| --- | --- |
| `npm start` | 启动开发服务，默认模拟获取结果，需要本地 Zotero 环境配置 |
| `npm run start:live` | 使用真实来源获取信息 |
| `npm run test:core` | 运行离线核心测试 |
| `npm run test:ui` | 运行离线界面与工作流测试 |
| `npm run check` | 构建并检查基本安全规则 |

开发配置、完整测试命令与数据保护要求见 [CONTRIBUTING.md](CONTRIBUTING.md)。

## 反馈与贡献

欢迎通过 [Issues](https://github.com/iiwenwen/zotero-update-metadata/issues) 报告问题或提出建议。请附上 Zotero 版本、插件版本、操作步骤和报错截图，并遮盖私人信息；不要上传整库或完整更新日志。

版本变化见 [CHANGELOG.md](CHANGELOG.md)。

## 隐私与许可

插件不提供遥测或自动上传文库的服务。查询时会向对应网站发送 URL、DOI 等必要信息；更新日志保存在本地，可能含文献信息，请妥善保管。

本重写版的项目许可证尚未确定。第三方依赖的许可见[第三方说明](addon/content/third-party-notices.txt)。
