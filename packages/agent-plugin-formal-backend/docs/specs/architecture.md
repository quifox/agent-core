# 正式后端接入插件

内部组合 ResponsesModelPlugin、Session 包的消息与校验能力、每轮上下文及既有压缩 Hooks，作为 Context/检查点后端协议的参考接入实现。跨轮续接与恢复状态属于接入插件；Core 的插件对象和生命周期边界遵循 [Core 规范](../../../agent-core/docs/specs/sessions.md)，消息合同遵循 [Session 规范](../../../agent-plugin-session/docs/specs/architecture.md)。

- Host 配置模型名称、地址、传输、认证和可选后端 API；模型插件由本包内部创建，不导入应用、微信、隐式网络或存储实现。
- 公开运行输入只接受 `{ prompt: string }`。本地 `{ resume: true }` 属于 Chat Session/Checkpoint 组合，不进入 Formal Backend 类型；运行时也明确拒绝携带 `resume` 的输入，避免未类型化调用被误当成新用户消息。后端未完成工具通过 `completePendingTools` 核实，失败输入使用原 prompt 重试。
- 插件内部组合模型插件和每轮上下文。提供 api 时启用后端预算预检、摘要和检查点路由；省略时只使用 Responses 游标、消息投影与本地快照。底层客户端和 Context 工厂不属于公开构造参数。
- 每个 Run 创建独立 Responses 门面，仅保存引用与下一次请求目标；后端保留权威历史。私有上下文路由绑定、预算预检和 checkpoint 语义属于本包。
- 复用 agent-plugin-compaction 的准备、摘要分支与提交流程；不在 Core 或 Host 再实现一条压缩链路。
- 取消和 isCurrent 在异步边界前后检查；冻结请求的 identity 必须与最终流式请求匹配。拒绝、陈旧或失败候选不推进主请求引用，不自动重放业务操作。
- 连接构造验证接入配置，不创建空 Response。后端链由首次真实请求创建；注入面以公开 FormalBackendApi 为准，消费方的网络路由、认证和数据库合同由其宿主维护。
- 接入其他后端时另写 adapter/插件组合，不按协议名推断历史能力，不宣称本参考实现自动兼容任意后端。
- 验证请求冻结、引用绑定、摘要接受/拒绝、检查点失败、取消/过期和首次请求；网络和数据库验收与本地 mock 验证分别报告。

- 客户端游标位于本插件快照，ResponsesModelPlugin 的请求与事件保留协议字段，交给 Core 的 ModelTurnResult 不带 responseId。
- 最终模型包装在全部 beforeModel 后投影增量并执行预算预检；不能依赖“压缩 Hook 排最后”来保证请求冻结。
- 同一插件串行使用自己的可变状态。相同未完成输入重试时复用已冻结请求，已被后端接纳的 user 不重复发送；未知工具写入不自动重跑。
- 工具意图和已提交回执在后续副作用前保存；completePendingTools 先保存候选再改变内存状态，并保留原输入接纳身份。
- fork(id, childStore?) 只派生本插件，父引用不可变，新请求取得新游标。默认不复用父 store；仅从已知、工具批次闭合的状态派生，不复制未完成 I/O。
