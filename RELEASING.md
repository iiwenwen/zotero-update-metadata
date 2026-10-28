# 发布流程

日常推送代码和发布安装包是两件事。`main`保存源码，GitHub Release提供可安装的`.xpi`文件；自动更新文件决定已安装的插件何时收到更新。

```mermaid
flowchart LR
  A[源码提交到 main] --> B[检查并固定候选包]
  B --> C[创建版本标签]
  C --> D[上传 Release 草稿]
  D --> E[下载核验与隔离试装]
  E --> F[公开 Release]
  F --> G[更新自动更新文件]
```

## 先看当前状态

- 当前重写版为`0.4.0`，插件ID为`zmta-update-metadata@local`。
- 仓库旧Release最高为`v1.1.3`，旧插件ID为`zotero-update-metadata@iiwenwen`。两个ID不同，不能把重写版当成旧版的直接自动升级。
- 旧版配置的更新入口是仓库`main/update.json`；重写版构建配置使用专门`release`标签下的`update.json`／`update-beta.json`。旧入口没有自动迁移到新入口。
- 本重写版许可暂未确定，正式插件身份与旧版迁移方案也未确定。可以准备本地候选；公开用户版前先明确这些事项，不能从脚手架模板推断授权。
- 当前主线没有发布Actions。推代码或推标签不会自动生成Release，以下步骤由维护者明确执行。

## 1. 日常源码发布

在当前项目修改代码、文档和测试，完成相关检查后提交，只推指定分支。

```bash
npm run test:core
npm run test:ui
python3 -m unittest discover -s test -p '*_test.py'
python3 scripts/check-manifests.py
git diff --check
```

查看diff，只暂存本轮确认可公开的文件，再提交。提交后运行：

```bash
python3 scripts/check-publication.py main
git push origin main
```

普通文档修改只做相关检查，不必每次跑全部产品测试。个人配置、技能、内部状态、测试库、环境实值和构建目录保持忽略。不使用`git push --all`、`--mirror`或批量推送旧本地标签。

## 2. 确定版本与发布渠道

| 渠道 | 用途 | GitHub设置 | 自动更新文件 |
| --- | --- | --- | --- |
| 本地候选 | 开发和隔离验收 | 不创建Release | 不上传 |
| 预发布 | 邀请用户试用 | Pre-release，明确`latest=false` | 只更新`update-beta.json` |
| 正式发布 | 面向普通用户 | 验收后决定是否标Latest | 更新`update.json`及`update-beta.json` |

版本包含`-beta.1`等后缀时，构建走预发布渠道。GitHub的Pre-release标记也要对应设置；只勾选网页Pre-release不会改变XPI内的版本或更新地址。

先同步`package.json`、`package-lock.json`的根版本和`addon/manifest.json`。本机若保留`plugin.json`，同时同步它。本地`npm version <已确认版本> --no-git-tag-version`只处理npm文件，不替你修改插件清单。

把本版本的用户可见变化写入`CHANGELOG.md`的`## 版本号`段，记录兼容范围及已知限制，然后提交。不要提前创建版本标签，也不要沿用指向私有旧历史的`v0.4.0-local`。

## 3. 本地准备安装包

从干净、已提交的源码运行：

```bash
npm run release:prepare
# npm run release 是同一个本地准备入口
```

该命令执行公开内容检查、版本检查、核心／UI／Python回归、生产构建和包检查，再将通过检查的原始字节固定到新的`_build/YYYYMMDD-HHMMSS/`。

| 文件 | 用途 |
| --- | --- |
| `.xpi` | 安装到Zotero的插件 |
| `RELEASE-NOTES.md` | 本次发布说明和源码提交链接 |
| `SHA256SUMS` | 所有候选资产的校验和 |
| `release-manifest.json` | 版本、标签、源码提交及每个文件的摘要，不包含本机路径 |
| `update-beta.json` | 预发布更新文件 |
| `update.json` | 正式版更新文件；预发布候选不携带它 |

`release:prepare`不改版本、不提交、不打标签、不推送，也不创建或公开GitHub Release。准备期间源码变化、检查失败、版本说明缺失或文件摘要不一致都会失败；已有候选目录不覆盖。

正式发布前仍须完成需要的评审和真实隔离宿主验收。本地脚本通过不是这些人工／宿主验收的替代品。

## 4. 创建版本标签与Release草稿

从刚生成的`release-manifest.json`读取候选目录、`tag`和`sourceCommit`。以下变量必须替换成该候选的实际值，不能拿当前HEAD猜测：

```bash
ZMTA_RELEASE_DIR='_build/实际候选目录'
ZMTA_RELEASE_TAG='v实际版本'
ZMTA_RELEASE_COMMIT='候选记录的完整提交SHA'

npm run release:verify -- "$ZMTA_RELEASE_DIR"
git tag -a "$ZMTA_RELEASE_TAG" "$ZMTA_RELEASE_COMMIT" -m "Release $ZMTA_RELEASE_TAG"
git push origin "refs/tags/$ZMTA_RELEASE_TAG"
```

如果同名标签已存在，先核对它指向的提交；不能强行移动已发布标签。

使用GitHub CLI创建草稿，或在GitHub网页的Releases页面选择该标签并保存草稿：

```bash
gh release create "$ZMTA_RELEASE_TAG" "$ZMTA_RELEASE_DIR/"* \
  --repo iiwenwen/zotero-update-metadata \
  --verify-tag --draft --latest=false \
  --title "Zotero 元数据更新 $ZMTA_RELEASE_TAG" \
  --notes-file "$ZMTA_RELEASE_DIR/RELEASE-NOTES.md"
```

只上传刚校验的候选目录中的文件，不上传整个`_build`、源码工作目录或测试数据。此目录已由校验器限制为交付资产；预发布时其中没有`update.json`，因此不能误覆盖正式更新文件。

`--verify-tag`用于防止CLI从其他提交自动生成标签，`--draft`让Release保留为草稿。上传完成不等于已经公开。

## 5. 下载验包，再公开Release

1. 核对GitHub草稿选用的标签、源码提交、版本号、发布说明和资产列表。
2. 从GitHub下载刚上传的全部资产到一个新的忽略目录，校验下载内容：

   ```bash
   ZMTA_VERIFY_DIR='_tmp/本次发版下载验包'
   gh release download "$ZMTA_RELEASE_TAG" \
     --repo iiwenwen/zotero-update-metadata \
     --dir "$ZMTA_VERIFY_DIR" --pattern '*'
   npm run release:verify -- "$ZMTA_VERIFY_DIR"
   ```

3. 在专用测试库试装下载的这个XPI，验证本次受影响的显示、审核、写入／回退和升级行为；真实写入仍需要明确授权。不能拿另一个构建包的结果代替。
4. 确认项目许可、插件ID、旧版迁移和本次验收边界。预发布勾选 **This is a pre-release**；正式版才决定是否标为Latest。
5. 在GitHub草稿页点击 **Publish release**。首次重写版发布不要直接替代旧版Latest，除非迁移方案已确认。
6. 更新README安装段，提供本版本的直接下载入口；新旧发布线并存时，不能把`releases/latest`默认当作新版本下载链接。

失败时保留草稿，修正源码或配置后准备新的候选。已经正式公开的版本不替换同名XPI，不移动其标签；修复用新版本发布。

## 6. 最后更新自动更新文件

先确认版本Release已经公开，XPI下载地址、版本、插件ID、Zotero兼容范围与`update_hash`全部对应。然后才允许更新已安装插件使用的入口。

重写版配置的固定入口为：

```text
https://github.com/iiwenwen/zotero-update-metadata/releases/download/release/update.json
https://github.com/iiwenwen/zotero-update-metadata/releases/download/release/update-beta.json
```

固定入口用一个专门的`release`标签／Release承载，不能标Latest。首次启用前需明确授权创建该入口并确认资产可修改；当前流程不自动创建它。若仓库要求不可变Release资产，应先改用可维护的静态更新地址并重新验证，不能覆盖不可变版本资产。

更新时的规则：

- 预发布：只替换固定入口的`update-beta.json`，不触碰`update.json`。
- 正式发布：使用同一固定候选中的两个更新文件。
- 更新失败：停止后续操作，保留已公开的版本包；修复或恢复上一份已发布版本所附的更新文件，不重新构建一个包来凑摘要。
- 文件上传后重新请求固定URL，确认返回内容和XPI摘要；随后用隔离客户端检查更新发现和安装，不以“上传成功”代替验证。

旧版`zotero-update-metadata@iiwenwen`的更新入口与重写版不同。只有明确决定旧用户如何迁移、同ID时新版本如何高于旧版，以及旧Zotero兼容性后，才处理旧入口；不能把重写版JSON直接写到旧入口。

## 常见问题

**代码已经在GitHub，为什么没有新安装包？**

源码推送不会自动创建Release。必须完成候选准备、版本标签、上传和正式公开。

**还可以运行脚手架的release命令吗？**

项目统一入口现在是本地`npm run release:prepare`。不要直接使用`zotero-plugin release`代替本流程：当前锁定的脚手架会在本地改版本／提交／打tag／推送，在CI中直接创建公开Release并刷新更新文件，缺少这里的草稿验包阶段。

**每次都需要强推吗？**

不需要。第一次替换旧main已经完成，后续源码和新标签均普通推送。

## 参考

- [GitHub CLI：创建Release](https://cli.github.com/manual/gh_release_create)
- [GitHub：管理Release](https://docs.github.com/en/repositories/releasing-projects-on-github/managing-releases-in-a-repository)
- [Zotero：manifest及updates.json格式](https://www.zotero.org/support/dev/zotero_7_for_developers#updaterdf_updatesjson)
