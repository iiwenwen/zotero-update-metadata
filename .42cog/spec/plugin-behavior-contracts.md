# 插件行为契约规约

<meta>
  <document-id>zotero-update-metadata-plugin-behavior-contracts</document-id>
  <version>1.0.0</version>
  <project>zotero-update-metadata</project>
  <type>Plugin Behavior Contracts</type>
  <created>2026-06-28</created>
  <depends>.42cog/cog/cog.md</depends>
  <depends>.42cog/real/real.md</depends>
</meta>

## Cog 对齐

本规约必须参考 `.42cog/cog/cog.md`：

- 主体：`A1 Zotero 用户`、`A2 插件维护者`
- 核心实体：`E1 Zotero 条目`、`E2 外部网页元数据`、`E3 插件配置`
- 信息流：`F1 更新已有条目`、`F2 保存新条目`
- 相关权重：Zotero 条目数据安全 5/5、外部网页元数据准确性 4/5、插件配置兼容性 4/5、用户可见反馈 3/5
- 用户体验上下文：低打扰、可恢复、结果明确

## 行为契约

- 更新已有条目和保存新条目是不同契约，必须分别验证和反馈。
- 外部网页元数据来自 `E2`，当前核心场景以 Douban 为主；新增来源前必须确认 translator 行为和失败路径。
- 用户可见反馈必须区分成功、部分成功、失败和跳过，不能把异常路径包装成成功。
- 偏好项属于 `E3 插件配置`，改变默认值或持久化语义时必须说明向后兼容影响。

## 任务触发

任务触及以下内容时必须读取本规约：

- 右键菜单、命令入口、ProgressWindow、偏好窗口
- metadata provider / translator / URL fallback
- 错误反馈、批量结果汇总、保存策略
- 用户可见文案或行为默认值

## 验证要求

- 明确本轮触及的是 `F1`、`F2` 或两者。
- 至少验证一个成功路径和一个失败/不可用反馈路径；若本轮不适用，记录原因。
- 不扩大对外部站点或条目类型的支持范围，除非有独立任务和验收标准。
