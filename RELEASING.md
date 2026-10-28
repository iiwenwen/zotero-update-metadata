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
- GitHub下载资产必须与候选相同，之后才公开。预发布标记由版本后缀决定，例如`0.4.1-beta.1`。

工作流是`.github/workflows/ci.yml`和`release.yml`；统一发版脚本是`scripts/release.py`，固定包／验包复用`scripts/prepare-release.py`。Actions固定到已核对的完整commit SHA，不需要私人PAT或SSH密钥。

## 当前发布约定

- 当前测试版本为`0.4.1-beta.1`，保留开发ID，公开为Pre-release，不设Latest。
- 脚本不修改固定自动更新文件，也不触碰旧1.x插件的更新入口。
- 旧版ID是`zotero-update-metadata@iiwenwen`，重写版是`zmta-update-metadata@local`，需手动安装，不能当作旧版的直接自动升级。
- 正式公开版须先确定项目许可和正式插件身份；当前预发布仍需在测试库小范围试用，CI不替代真实Zotero界面／数据验收。

本次自动化不把许可暂缓、未完成的实显或第二份评审写成已通过。修改Latest、启用固定自动更新及旧版迁移留待明确决定。

## 只想本地检查或打包

```bash
npm run ci
npm run release:prepare
npm run release:verify -- _build/实际候选目录
```

这三个命令不修改Git或调用GitHub发布API。候选包含XPI、版本说明、摘要与更新JSON；预发布只携带`update-beta.json`，不携带正式更新文件。

旧的`zotero-plugin release`不作为项目入口。
