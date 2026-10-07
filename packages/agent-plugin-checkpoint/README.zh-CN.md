# @quifox/agent-plugin-checkpoint

[English](README.md) | 简体中文

独立的本轮执行记录。完整步骤后清空；中断后保存模型产物、已开始调用和真实回执，Fork 不复制 Promise。

```ts
const checkpoint = new ExecutionCheckpointPlugin()
const interrupt = new InterruptPlugin()
const agent = createAgent({ plugins: [conversation, interrupt, checkpoint, tools, compression] })
// 原流已经关闭或失败，Fork 同一位置的会话及本轮记录。
const child = await conversation.fork({ boundary: 'resume' })
const childCheckpoint = checkpoint.fork()
await createAgent({ plugins: [child, new InterruptPlugin(), childCheckpoint, tools, new CompactionPlugin()] })
    .run({ resume: true })
```

已完成调用不重复。Checkpoint 只提供进度与 `requiresRetry(callId)` 查询，不在启动恢复时拦截未知调用；默认组合显式使用 InterruptPlugin 解释工具的可选 `policy.retrySafe`。true 允许重新进入 Core 原工具入口，false 或省略则停止并保留未知状态。也可先核实，再同时交给 `conversation.confirmTool` / `checkpoint.confirm`；不能把缺少消息等同于没有执行。自定义恢复策略由调用方自行组合。需要跨进程恢复时宿主同时保存 Session 和执行记录快照。
