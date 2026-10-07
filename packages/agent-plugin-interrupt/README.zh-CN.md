# @quifox/agent-plugin-interrupt

[English](README.md) | 简体中文

通过已有 Run/Tool Hooks 处理用户停止，无需 Session 工厂或额外 Core Hook。

```ts
const interrupt = createInterruptPlugin()
const agent = createAgent({ plugins: [...plugins, interrupt, generation] })
for await (const event of agent.stream(input)) render(event)

stopButton.onclick = () => interrupt.requestStop()
```

插件只在活动 Run 内记录停止请求。默认 `pause` 等当前工具真实回执并完成全部 afterTool 后停止，剩余调用不补中断结果，可由执行记录插件续跑。`terminate` 保留当前真实回执，为后续未开始调用写入 `USER_INTERRUPTED` 结果并完整经过 afterTool，再结束本轮。及时取消模型或业务 I/O 由对应 owner 处理。

显式配合执行记录插件时，beforeTool 查询其 execution.requiresRetry(callId)。只有工具声明 `policy.retrySafe: true` 才允许结果未知的调用重新执行，false 或省略均停止并保留记录（reason 为 tool-result-unknown）。不声明不会影响首次执行，也不会阻止确认未开始的调用续跑。改写工具目标的钩子应放在 InterruptPlugin 之前；Core 不自动重试。

[规范](docs/specs/architecture.md)。
