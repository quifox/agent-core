# 用户主动中断插件

- InterruptPlugin 是普通对象，按钮或组合插件通过闭包调用 requestStop()；默认停止原因是通用 `stop`，调用方需要观察来源时可传入其他字符串，空字符串也表示一次有效停止请求。不要求运行 ID、会话 ID、Core AbortSignal 或新的终止钩子。
- onRunStart 首次绑定本次 Outcome 并重置标记；同一对象重复插入时，同一 Outcome 的再次绑定保持幂等且不重置已收到的停止请求。不同活动 Outcome 并发共享仍失败。空闲 requestStop 不污染下一轮。onRunEnd 仅释放属于自己的活动执行，不清理另一个 Agent 误共享产生的运行。
- `pause` 是默认模式：beforeStep / beforeModel / beforeTool 检测停止请求并返回 stop；afterTool 等当前调用的真实结果经过完整结果链后停止。未开始的后续调用不执行、不补 USER_INTERRUPTED 回执，留给执行记录插件续跑。
- `terminate` 模式在工具批次中保留当前已执行调用的真实结果；后续 beforeTool 返回 `USER_INTERRUPTED` 错误结果，跳过真实 prepare/execute 但仍完整经过 afterTool。全部调用闭合后由 afterStep 返回 stop，使下一轮由模型重新生成工具调用。没有工具批次时仍在普通安全边界停止。
- 真实结果优先于用户停止；已开始的业务等待实际回执，不伪装成撤销。用户停止不改变工具本身的取消与副作用语义。
- beforeTool 可读取协作插件发布的 execution.requiresRetry(callId)。结果未知的恢复调用仅在最终目标工具 policy.retrySafe=true 时继续，否则返回 stop（reason=tool-result-unknown），保留调用且不伪造结果。false 或未声明不自动重试；完成回执由记录插件排除，不重新执行。本插件没有该协作能力时只执行普通停止策略，不隐式依赖或安装 Checkpoint。
- 改写工具目标的插件放在本插件之前，使恢复判断读取改写后的工具元数据；调用方保持明确的钩子顺序。不同恢复策略可用其他普通插件实现，Core 不解释 retrySafe，也不增加重试循环。
- 本插件只负责协作停止。网络或业务 I/O 的取消信号与执行机制由实际 I/O 插件提供。
- 不维护消息、执行进度、Queue、Steer 或后台调度；只解释停止请求和已有恢复记录，不复制执行记录或自行调用工具。

## 模式、返回与边界

| 情况 | pause | terminate |
|---|---|---|
| 尚未开始模型或工具批次 | 下一个停止检查返回 stop | 同样停止；不补造工具批次 |
| 工具正在 prepare/execute | 等真实结果，不取消当前 I/O | 等真实结果，不取消当前 I/O |
| 当前结果已经返回 | 完整 afterTool 后停止 | 完整 afterTool 后继续闭合批次 |
| 后续尚未开始的工具 | 不执行，不补回执 | beforeTool.result 提供 USER_INTERRUPTED，仍进入 afterTool |
| 本批工具全部闭合 | 尚未执行的调用由 Checkpoint 保存 | afterStep.stop；后续新运行由模型重新规划 |

onRunStart/reset 和 requestStop 的标记属于该插件实例。需要多 Agent 同时运行时使用独立 Interrupt 实例；共享同一个实例不等价于独立停止每个成员。

本插件的 stop.value 是 InterruptRunValue：kind=interrupt、reason 及可选 previous。previous 保存本插件在 afterModel 所见的模型结果引用，不是 Core 自动回滚点，也不代表副作用撤销。正常停止形成成功 Outcome；缺少结果的业务异常仍形成失败 Outcome，不被停止标记覆盖。

只有 Checkpoint 声明需要核实的未知恢复调用才检查 retrySafe；not-started 调用可以第一次进入原工具入口，completed 调用由执行记录排除。本插件只做准入判断，不执行自动重试。

行为验收见 [中断模式测试](../../test/plugin.test.ts) 与 [Checkpoint 恢复测试](../../../agent-plugin-checkpoint/test/plugin.test.ts)。
