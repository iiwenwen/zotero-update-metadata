# 测试

`npm run test:core`检查候选、Planner、Executor／MutationPort、journal、重试与回退的生产函数，使用假宿主及内存端口。`npm run test:ui`检查审核布局、选择收集、设置、侧栏生命周期与公共占用；明确排除真实宿主用例。两者均不能替代Zotero显示或实际API验收。

`hostProfile.cjs`用于真实宿主测试，在交互前核测试运行器提供的项目根及当前profile／dataDir，不包含维护者机器路径。路径保护自身的回归包含缺值、相对根及任意一项不匹配的拒绝行为。

`npm test`会启动隔离Zotero，不要与现有测试客户端并开；真实书目写入需要另行明确授权。日常用例不得写正式库。已有附件、笔记和人工修改均须保留；合成数据按精确归属清理。

`npm start`默认离线Mock，不访问上游。可在测试条目Extra写`ZMTA-MOCK: success`、`rich-success`、`no-result`、`http-403`、`identifier-conflict`、`item-type-conflict`、`version-ambiguous`或`identity-review`选择场景。`rich-success`提供合成附件与笔记候选；确认后仍可能产生真实测试子项。只有`npm run start:live`显式启用真实上游。

完整验证入口和固定安全规则见`CONTRIBUTING.md`；不同版本／不同层次的结果不相加冒充同一轮宿主测试。
