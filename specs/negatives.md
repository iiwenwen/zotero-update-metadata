# 来源与写入安全检查

`scripts`之外的这两份资产随源码公开。`check.sh`读取下列字面模式及人工核对项；字面检查不能替代行为测试和真实隔离宿主验收。

## 字面模式

```PATTERNS
saveAttachments[^,;]*true	translator 必须禁隐式保存附件
libraryID[^,;]*[1-9]	translator 必须禁隐式写入库
allowCrossSourceFallback[^,;]*true	禁止跨源 fallback
setField\([^,]+,[[:space:]]*["']extra["']|field[[:space:]]*:[[:space:]]*["']extra["']	禁止构造或直接执行 extra 字段写入
MCP	产品运行链不引入 MCP 隔离基建
proxy	产品运行链不引入 proxy 热加载旁路
```

## 行为核对

```CHECKLIST
每个冲突字段是否显式标出“本地现值 vs 上游候选值”并可由用户逐项勾选
确认前是否真零写入（候选 → diff → 用户确认 → 才执行），取消是否同样零写入
空值、降精度值和审核后已变化的本地字段是否被拒绝静默覆盖
Provider 是否只产带来源证据的候选，审核界面是否能追溯来源 URL／状态，Translator、UI 与 Provider 是否都不能绕过统一写入层
附件与 Notes 是否分区展示、逐项确认、只增不改且不自动判重
是否只在唯一专用测试库客户端完成宿主实测，并覆盖深浅主题及宽、中、窄、矮窗口
journal 是否完整支持单条失败隔离、只重试失败项、最近批次回退和回退冲突保护
```
