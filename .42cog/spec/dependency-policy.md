# 依赖支持策略

<meta>
  <document-id>zotero-update-metadata-dependency-policy</document-id>
  <version>1.0.0</version>
  <project>zotero-update-metadata</project>
  <type>Dependency Support Policy</type>
  <created>2026-06-26</created>
  <source>CNB Issue #3</source>
  <depends>.42cog/cog/cog.md</depends>
</meta>

## Cog 对齐

本规约必须参考 `.42cog/cog/cog.md`：

- 主体：`A2 插件维护者`、`A3 Codex 开发智能体`
- 核心实体：`E4 插件构建产物`、`E5 依赖主版本线`
- 信息流：`F3 构建发布`、`F4 依赖升级决策`
- 相关权重：依赖主版本线稳定性 4/5、构建发布产物正确性 3/5

## 决策

本项目采用“当前主版本线”依赖支持策略。

<decision id="D1">
<title>依赖支持当前主版本线</title>
<description>项目支持当前已采用的依赖主版本线：`zotero-plugin-toolkit` v5 和 `zotero-types` v4。允许在同一主版本内跟随兼容的 minor/patch 更新，但不承诺兼容旧主版本线，例如 toolkit v2 或 types v1。</description>
<rationale>toolkit v2 到 v5 已发生导出结构变化，旧主版本双线兼容会引入额外适配层和长期维护负担。项目规模较小，应优先保持当前主线清晰、可构建、可验证。</rationale>
<status>accepted</status>
</decision>

## 当前基线

<dependency-baseline>
- `zotero-plugin-toolkit`: `^5.1.4`
- `zotero-types`: `^4.1.2`
- Zotero manifest range: `7.0` 到 `9.0.*`
</dependency-baseline>

## 支持范围

<support-scope>
- 支持：当前依赖主版本线内的兼容更新。
- 支持：Zotero `7.0` 到 `9.0.*` 的 manifest 安装范围。
- 不承诺：toolkit v2/v3/v4 与 v5 的双线代码兼容。
- 不承诺：types v1/v2/v3 与 v4 的双线类型兼容。
- 必须说明：运行兼容需要以实际 Zotero 版本验证为准；若无法双环境验证，文档应区分“声明兼容范围”和“已验证版本”。
</support-scope>

## 对后续任务的影响

<impacts>
- CNB Issue #2 的 Zotero 9 运行环境优化应以 toolkit v5 / types v4 为前提。
- 若用户要求支持旧依赖主版本，必须新建独立 Issue，并明确测试矩阵和维护成本。
- 依赖升级不应静默改变元数据写入逻辑、偏好语义或外部站点支持范围。
</impacts>

## 验证检查清单

- [ ] `package.json` 依赖主版本符合当前基线。
- [ ] `npm run build` 通过。
- [ ] README 或交付说明区分安装兼容范围与实际验证版本。
- [ ] 后续兼容性修复不引入旧主版本适配层，除非有新的明确 Issue。
