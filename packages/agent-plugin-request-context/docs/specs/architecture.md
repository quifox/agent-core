# 请求上下文插件架构规范

## 职责与所有权

本包把其他插件提供的短期上下文放入 Chat Model 的请求投影。`ChatSessionPlugin` 仍然唯一拥有 canonical messages、pending input、历史和持久化；Model 插件继续通过原有 `ChatSessionSource.acceptRequest` 获取本轮请求。Core、Model 和 Session 的既有实现不变。

`RequestContextPlugin` 装饰现有 Session 的 `ChatSessionSource`。`source.acceptRequest(messages)` 先等待底层 Session 接纳、校验并持久化原始消息，然后通过 `project` 创建新的模型消息数组。投影只包含副本和临时 system message，不修改传入数组、Session.messages 或 Model.request。

## 本轮生命周期

`RequestContextPlugin` 按 Outcome 跟踪一个活动运行；与其绑定的 Session 仍执行自己的并发接纳。每次 `onRunStart` 清空贡献并记录 Outcome。每次 `beforeModel` 清空上一模型轮次的贡献。按 Agent 插件数组顺序随后执行的 memory 等插件调用 `set(key, content)`，将该轮贡献写入对应的 RequestContextPlugin。

所有 `beforeModel` 完成后，Model 调用 adapter 的 `acceptRequest`：Session 先保存不含插件上下文的 canonical messages；adapter 再把当前贡献投影到返回的 wire messages。多 key 贡献按照首次设置顺序组合，同 key 的后续设置替换前值；空内容删除该 key。`project(messages)` 是纯投影，不修改输入，也不写入 Session。

`snapshot()` 只在活动运行中返回当前轮按顺序排列的 `key/content` 副本，供 Host 的观测插件解释请求组成；它不延长贡献生命周期，也不成为新的持久化入口。

`onRunEnd` 只清理自己当前 Outcome 的贡献。异常、stop 和正常完成都经过 Core 的最终收尾。没有活动运行时调用 `set` 或 `project` 会抛错，避免静默遗漏请求上下文。

请求上下文不持久化，也不进入 Session pending input 的冻结范围。失败后以同一 Chat 输入重试时，贡献插件重新生成当前上下文；本包不保证两次 wire 请求逐字节相同。

## Conversation 组合

`ContextualChatConversationPlugin` 实现现有 `Conversation` 合同并组合三组 hooks：Session、绑定 `context.source` 的 ChatModel、RequestContext。组合会在 initialize 和每轮开始时发布 `ctx.conversation`，其他 Conversation 能力委托给 Session。

构造时验证 RequestContext 绑定的 Session 与生成插件绑定的 source。`fork` 和 `empty` 创建新的 Session、RequestContext source 和绑定子 source 的生成插件；父级临时贡献不会复制。可选 compaction factory 接收 `(session, generation, context)`，子组合会传递子 context。预算估算应调用 `context.project(candidate.messages)` 计入临时上下文；压缩后的 canonical history 不包含临时上下文。

注册组合后再注册贡献插件，例如 `[contextualConversation, memoryPlugin, compactionPlugin]`。RequestContext 的 `beforeModel` 在 memory 插件之前运行，因此贡献插件应在自己的 `beforeModel` 调用 writer；其内容在本轮 `acceptRequest` 时读取。

Fork/empty 可显式绑定子 signal 提供者；父 signal 和临时贡献均不继承，子模型与子工具使用自身停止意图。

## 失败与边界

- Session 接纳或存储失败时，不开始模型请求；投影只在接纳成功后计算。
- 投影是纯内存数据。若贡献插件执行失败，Core 收尾清空贡献；Session 中仍只有 canonical messages。
- 同一 Contextual Conversation 不支持并发复用；Session 和 Outcome 绑定检查会拒绝重叠运行。
- 任何依赖 compaction 投影预算的 Host 都需在 estimator 内显式调用 context.project；默认 compaction adapter 不自动计入本包贡献。
