# @quifox/agent-plugin-formal-backend

[English](README.md) | 简体中文

正式后端的会话插件：内部组合 ResponsesModelPlugin、后端预算预检、摘要检查点和跨轮游标。

```ts
const backend = createFormalBackendPlugin({
    id: 'conversation', ownerId: 'user',
    model: modelId, baseUrl, headers, transport, api, store
})
const agent = createAgent({ plugins: [backend, ...plugins] })
await agent.run({ prompt: '第一轮' })
for await (const event of agent.stream({ prompt: '继续' })) render(event)
```

公开输入只接受 `{prompt:string}`；本地 `{resume:true}` 不属于本插件。ResponsesModelPlugin 与每轮上下文由插件内部创建；提供 api 时启用后端预算预检、摘要和检查点路由，省略时只使用 Responses 游标与本地快照。首次真实请求创建远端链，不预建空 Response；最终请求在全部 beforeModel 完成后进行预算准备和发送。

`backend.snapshot()` 只保存当前 cursor、未完成输入和工具增量。`backend.fork(id, childStore?)` 返回新后端插件，复用不可变父引用，下一请求生成新的 Response；默认不复用父存储回调。未知工具结果须核实，不能自动重跑写操作。

规范：[架构](docs/specs/architecture.md)。
