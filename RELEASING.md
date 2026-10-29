# 一键发版

发版只保留一个入口：

```bash
npm run release
```

它会触发GitHub CI，等待检查、打包和发布完成，最后输出Release链接。需要本机已登录GitHub CLI（`gh auth login`），当前源码已提交并普通推送到`main`。

## 日常怎么用

1. 修改代码和`CHANGELOG.md`，同步`package.json`、lock根版本及`addon/manifest.json`；本机有`plugin.json`时也同步。
2. 提交并推送到`main`。每次push和PR都会自动跑CI。
3. 执行`npm run release`。不用手动构建、打标签、上传文件或检查下载摘要。

也可以在GitHub **Actions → Release → Run workflow**执行，选择`main`。取消勾选`publish`则只生成草稿。

```bash
npm run release -- --draft    # 只生成草稿
npm run release -- --no-wait  # 发起后立即返回Actions链接
```

## 脚本自动完成什么

```mermaid
flowchart LR
  A[一条发版命令] --> B[CI安装锁定依赖并检查]
  B --> C[构建和固定候选]
  C --> D[精确版本标签与草稿]
  D --> E[上传后重新下载验包]
  E --> F[公开Release并返回链接]
```

- 构建job只有只读权限，执行核心／UI／Python测试、隐私／版本／生产包检查。
- 发布job不安装npm依赖，只接收该次构建的固定资产，核对源码提交、版本、插件ID和摘要。
- 标签只能指向该次提交；同名已发布版本不覆盖、不移动标签。失败时只保留草稿。
- 已有草稿只补缺失资产，相同摘要可继续；不使用`--clobber`替换其他字节。失败请优先重跑失败job；源码改动则升新版本。
- GitHub下载资产必须与候选相同，之后才公开。预发布标记由版本后缀决定，例如`0.4.1-beta.2`。

工作流是`.github/workflows/ci.yml`和`release.yml`；统一发版脚本是`scripts/release.py`，固定包／验包复用`scripts/prepare-release.py`。Actions固定到已核对的完整commit SHA，不需要私人PAT或SSH密钥。

## 正式版与预发布版

- 无后缀版本（例如 `0.4.1`）公开为正式版，下载验包通过后设为 Latest。带后缀的版本标为 Pre-release，不改变 Latest；草稿也不改变 Latest。
- 当前正式 ID 为 `zmta-update-metadata@iiwenwen`，以 `addon/manifest.json` 为正本。构建、Toolkit、菜单、设置与侧栏共用该身份。
- 正式包的更新地址为 `https://github.com/iiwenwen/zotero-update-metadata/releases/latest/download/update.json`。每次正式发布随 Latest 自动切换，不另行移动标签或覆盖旧版本资产。
- 旧 1.x 的 ID 为 `zotero-update-metadata@iiwenwen`，开发测试版为 `zmta-update-metadata@local`。两者都需手动切换；安装正式版前先禁用或移除测试版。脚本不修改旧版的更新入口。
- 预发布渠道仍使用原有的 beta 地址；本流程不启用开发 ID 的自动迁移。
- 按负责人决定，当前先发正式包，项目许可继续暂缓，npm 元数据为 `UNLICENSED`，不自动创建 `LICENSE` 或替负责人授予许可。候选清单如实记录许可文件是否存在。

CI不替代真实Zotero界面与数据验收；已知验证范围见 `CONTRIBUTING.md`。正式身份禁止使用 `@local`。

## 只想本地检查或打包

```bash
npm run ci
npm run release:prepare
npm run release:verify -- _build/实际候选目录
```

这三个命令不修改Git或调用GitHub发布API。候选包含XPI、版本说明、摘要与更新JSON；预发布只携带`update-beta.json`，不携带正式更新文件。

旧的`zotero-plugin release`不作为项目入口。
