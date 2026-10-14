# 插件重组合同

暂存完整有序的真实插件数组，在最终收尾中替换 Host 的 Agent 引用；用法见[本包指南](../../README.zh-CN.md)。

## 所有权与 Host

- PluginActivationPlugin 负责候选启停选择，读取调用方给定的 enabled 标记；保留对象引用与相对顺序。Host 可在 createAgent 前调用 select；作为普通插件使用时应置于注册数组首位，在其他对象注册/初始化前移除禁用对象，并移除策略对象自身。它不保存配置、不卸载已运行资源、不成为通用依赖管理器；活动运行的生命周期交接由 Host 与 Composition 既有合同负责。

- 每个进入 onRunStart 的 Outcome 拥有自己的提案；CTX 标识 Agent。setNextPlugins 定位最近一个尚未进入最终收尾的运行；没有这样的运行时抛错，不是空闲配置 setter。
- Host 提供 replaceAgent(nextAgent)，用普通引用容器、闭包或应用类更新当前 Agent。Composition 可独立于 Code Mode 使用，其他 Hook/Host 能力可提交数组。
- 提交完整列表，最后一次为准；允许空数组、自移除、同 ID 和重复位置。复制数组容器，保留对象；只移除本 owner 的私有尾对象，不推断其他依赖或迁移状态。
- 后续调用读取当前引用。可选的 Host run/stream 转发按调用读取；旧 Agent、绑定到旧对象的方法、已启动 run 或已取得 stream 都保留旧接收者。
- 交接只构造新 Agent，首次执行才注册/初始化。首轮失败后引用仍是新 Agent；后续重建归 Host，不自动恢复旧对象或回滚其他 owner。
- 完整提案决定是否保留 Code Mode/管理插件；遗漏的对象不自动重新安装。Teams 成员引用、订阅与资源由各 owner 更新/释放，新 CTX/Registry 不自动迁移。

## 注册与交接

- onRegister 插入一个私有收尾对象，仅将自身放到候选尾部。
- 初始化要求它拥有最后一个 onRunEnd；无收尾的对象可在后面。其他插件可改草稿，但本包不重排它们。
- Hook 对象可变，因此替换前再次核对收尾位置。全部前序收尾完成且 Outcome 成功、有提案时，createAgent 并 await Host 回调，无手动 apply/commit。
- 这是最后业务收尾边界，不表示旧 run Promise 已返回或最终事件已消费。旧执行继续在原 Agent/CTX 完成。
- 执行、初始化、前序收尾失败或业务完成前关闭流时不替换。回调失败形成收尾错误；外部部分效果归 Host。
- 本包不拒绝、排队或串行化 run；仅释放自己的 Outcome。重叠物理调用需要独立接纳或独立管理对象，不提供通用并发重组调度。

## 新 Agent 与对象复用

当前 Hook/Tools 不随提案变动。新 Agent 首次使用时重新装配；复用管理插件重新插入私有尾对象，删除管理插件同时不保留其辅助对象。

其他 owner 的注册辅助对象与复用由其合同处理。兼容对象的私有状态可保留，新 CTX 字段不自动继承。Steering 等要求最终位置的 owner 需要显式兼容组合；缓存的旧引用仍是旧对象。
