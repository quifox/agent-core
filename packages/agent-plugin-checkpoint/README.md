# @quifox/agent-plugin-checkpoint

English | [简体中文](README.zh-CN.md)

Current-model-turn execution records. Complete steps clear the record; interruption preserves the model result, started calls, and actual receipts. Fork does not copy Promises.

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

Completed calls are not repeated. The checkpoint exposes progress and requiresRetry(callId); the chosen recovery plugin interprets the final Tool's optional policy.retrySafe. The default Interrupt combination allows unknown-result retries only when retrySafe is true. False or omission keeps the unknown state stopped.

Alternatively, verify the outcome and provide the same confirmed receipt to conversation.confirmTool and checkpoint.confirm. A missing message is not proof that an operation never ran. For cross-process recovery, the Host saves both Session and execution snapshots.

See the [contract](docs/specs/architecture.md). The example assumes caller-owned conversation, Tools, and compaction setup.
