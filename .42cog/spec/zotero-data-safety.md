# Zotero 数据安全规约

<meta>
  <document-id>zotero-update-metadata-zotero-data-safety</document-id>
  <version>1.0.0</version>
  <project>zotero-update-metadata</project>
  <type>Data Safety Specification</type>
  <created>2026-06-28</created>
  <depends>.42cog/cog/cog.md</depends>
  <depends>.42cog/real/real.md</depends>
</meta>

## Cog 对齐

本规约必须参考 `.42cog/cog/cog.md`：

- 主体：`A1 Zotero 用户`、`A2 插件维护者`、`A3 Codex 开发智能体`
- 核心实体：`E1 Zotero 条目`、`E2 外部网页元数据`、`E3 插件配置`
- 信息流：`F1 更新已有条目`、`F2 保存新条目`
- 权重：`Zotero 条目数据安全 5/5`

## 安全边界

- 任何更新必须以当前目标 `E1 Zotero 条目` 为边界，不得误改笔记、附件、非目标条目或用户手工维护字段。
- 保存新条目必须明确目标 library / collection，不能把 `F2` 的新建行为混入 `F1` 的更新行为。
- 批量行为必须保留逐项失败可见性，不能用整体成功掩盖部分失败。
- 日志、运行记录和测试 fixture 不得保存用户真实文献库内容、账号信息、私密题名清单、Cookie、令牌或本机敏感路径。

## 任务触发

任务触及以下内容时必须读取本规约：

- 元数据写入、保存新条目、附件、笔记、标签、Extra、collection、libraryID
- 偏好项改变写入策略或保存位置
- 运行时测试会创建、修改或删除 Zotero 数据

## 验证要求

- 记录受影响 Cog 实体和信息流，例如 `E1/F1` 或 `E1/E3/F2`。
- 写入类任务必须使用隔离 profile、临时测试库、fixture 或等价 harness。
- 验证应覆盖目标条目被修改、非目标条目未修改、失败反馈可见。
- 无法证明隔离数据边界时，不得执行真实写入验证，应标记 `BLOCKED: isolated test library unavailable`。
