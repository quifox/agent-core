# 事件发布插件

- EventPublisherPlugin 是单个 Agent 即可注册的普通插件。每个实例绑定 sourceId 与 publish 函数；多个 Agent 使用独立实例、独立出口，不强制共享广播通道。
- 同一实例按 Outcome 身份串行观察运行；若被多个 Agent 共享并同时收到不同 Outcome，明确拒绝第二个运行。多 Agent 并发通过每个 Agent 独立实例和出口层聚合实现。
- sourceId 和递增发布序号属于观察插件，不进入 Core Context 或 Agent 输入。传输、持久化与 SSE 属于调用方，通过 publish 出口对接。
- 插件通过 publish 出口发布本次输入、生成开始、完整模型结果、拟调用工具、工具回执、错误类别和收尾事实；通过 Hook 生成器向 stream 贡献 step/model 配对及错误事件。两个通道并非同一事件列表，不自动互相重播。
- 实时文字、推理与工具调用增量通过本插件 model 委托已有生成钩子发布，并原样 yield 给 Core；最终 return 对象不被修改。模型与会话的其他钩子照常执行，业务工具仍由 Core 执行。
- 本插件须是最终插件数组中的最后一个 model 实现；其前面须有真实生成实现。在 beforeModel 核验，允许更早的控制钩子提前停止。
- 同一共享 Context 和可变结果继续按原数组顺序传递。需要观察最终改写结果时，把事件插件放在相应处理器后；不重排其他插件或修改其他对象的方法。
- 消费者提前关闭时，委托生成器也关闭，确保供应商流和资源释放；不得为观察而重新调用模型或丢弃最终结果。
- publish 可同步或异步，发布不等待前端，不改变 ContinueOrStop。同步异常和异步拒绝均接纳为 publishError，不产生未处理拒绝，不把 UI 断开当成 Agent 失败。
- publish 与 stream 中由本插件生成的错误事件都只包含公开错误码与阶段；不得携带原始 `AgentError`、`cause`、`details`、堆栈、认证信息、完整请求、Context 或插件对象。Core 自身的最终 Outcome 仍是宿主内部事实，外部传输必须由 Host 另行投影。
- run-ending 表示本插件已经在 onRunStart 接纳的 Outcome 收尾事实；前置接纳插件合并、拒绝或提前停止的调用既不发布错误，也不发布伪造的 run-ending。Core 不维护 active，Teams 的延后唤醒与客户端实际连接状态由各自 owner 负责。
- interrupt Outcome 的 `reason` 只以是否为 `undefined` 判断；空字符串仍是调用方显式提供的原因，不得在事件投影时丢弃。
- 单 Agent、多个独立 Agent、外部 run/stream 和 Teams 自动唤醒均使用同一事件插件机制；不包装 Agent 入口。

- 各次运行以 Outcome 身份关联；每次 onRunStart 重置本插件计步与阶段状态。工具结果事件在整条 afterTool 链完成后才向消费者输出。onRunEnd 的产出由 Core 缓冲，不在消费者关闭后的 finally yield。

## 观察时机与终态

- publish 在本插件的 Hook 位置调用且不等待异步出口；成功写入数据库或前端已经渲染不是本插件的保证。
- PublishedEvent 的 sequence 按实例累加，step 每轮重置。sourceId 是 Host 选择的观察身份，不是业务运行身份。
- 原结果对象和输入保持引用语义；出口需要不可变历史时，在接收位置编码或自行复制。同步监听不能借修改对象控制业务。
- tool-planned 发生在本插件 beforeTool 位置，不证明工具已经执行；Core tool-start 也位于实际入口之前。判断回执必须观察整理后的 tool-result。
- publish 的 tool-result 在本插件 afterTool 位置观察当时结果；Core stream 的 tool-result 在完整 afterTool 链后交付最终工作对象。需要最终版本时将本插件放在相应改写之后。
- run-ending 是本插件 onRunEnd 位置所见的收尾事实。后面的收尾仍可失败；最终结果由 Core 全链收尾后的 run-end/Outcome 确定，不能把 run-ending 提前当作最终成功。

行为验收见 [发布与委托测试](../../test/plugin.test.ts)，Core 的 [事件缓存测试](../../../agent-core/test/hooks.test.ts) 与 [生命周期测试](../../../agent-core/test/lifecycle.test.ts)。
