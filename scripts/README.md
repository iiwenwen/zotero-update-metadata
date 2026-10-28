# 检查脚本

- `npm run test:core`：离线核心合同、来源、写入与恢复回归。
- `npm run test:ui`：离线界面／工作流回归及设置资产检查，排除明确的真实宿主用例。
- `python3 scripts/check-manifests.py`：npm、lock与Zotero清单版本一致性；本地可选AI清单存在时一并校验。
- `npm run check`：生产构建及`specs/check.sh`字面安全护栏，不启动Zotero。
- `python3 scripts/check-candidate.py`：离线检查XPI、运行时内容、生产开关、偏好、版本、第三方许可与feed hash；不验证远端URL和宿主行为。
- `python3 scripts/check-publication.py main`：检查指定分支的公开文件与可达历史是否含本地私有目录、个人home路径或常见凭据模式。发现只报文件／行号／类型，不回显匹配内容。

- `npm run release:prepare`（或`npm run release`）：从干净提交检查、构建并固定候选包，不改Git或上传。
- `npm run release:verify -- <目录>`：核对固定候选／下载资产的文件列表、摘要、版本和更新文件。

发布步骤见根目录`RELEASING.md`。输出报告、构建、依赖和测试数据应放忽略目录。检查失败不得算作通过。完整开发及数据保护约定见根目录`CONTRIBUTING.md`。
