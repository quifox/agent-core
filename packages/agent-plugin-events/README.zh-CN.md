# @quifox/agent-plugin-events

[English](README.md) | 简体中文

单 Agent 的独立事件发布能力。每个实例绑定 sourceId 与 publish，服务端可将出口接到 SSE，客户端也可接到本地事件总线。它不要求 Teams，也不包装 Agent 的 run/stream。

```ts
const events = new EventPublisherPlugin({ sourceId: 'researcher', publish: event => output.publish(event) })
const agent = createAgent({ plugins: [conversation, prompt, events, teams] })
await agent.run({ prompt: '开始任务' })
```

events 位于最后一个 model 实现的位置，委托前面的生成器；其他钩子仍按原顺序执行。Teams 如有使用，仍放在最后一个拥有异步收尾状态的位置。发布失败可读取 publishError，不影响原执行。

事件是已有钩子的可见事实；拟调用不代表已执行，run-ending 也不表示所有后续收尾已完成。本插件产生的错误事件只包含公开 code/phase，不携带原始错误、cause 或 details；未被本插件接纳的 Outcome 不进入该 sourceId。长期约束见 [SPEC](docs/specs/architecture.md)。
