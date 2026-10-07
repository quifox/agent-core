# @quifox/agent-plugin-steering

[English](README.md) | 简体中文

在不包装 `Agent.run/stream` 的前提下接纳同一 Agent 的并发用户输入。首次模型请求前到达的输入合入当前批次；之后到达的输入使用内部 terminate 中断闭合当前工具批次，并按顺序进入下一次物理运行。

```ts
const steering = new RunSteeringPlugin()
const agent = createAgent({ plugins: [steering, conversation, ...plugins] })

await Promise.all([
    agent.run({ prompt: '原任务' }),
    agent.run({ prompt: '补充条件' })
])
```

Steering 必须是调用方数组首项，同一实例只能出现一次。插件会在注册阶段追加私有收尾对象，确保下一批只在全部异步 `onRunEnd` 完成后启动。等待调用拥有独立 Outcome，但不会重放执行者的模型事件；过程观察使用执行者 stream 或 Events 插件。

[规范](docs/specs/architecture.md)。
