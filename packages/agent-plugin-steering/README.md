# @quifox/agent-plugin-steering

English | [简体中文](README.zh-CN.md)

Concurrent user-input admission without replacing Agent.run/stream. Inputs arriving before the first model request merge into the current batch. Later inputs use the internal terminate policy to close the Tool batch and enter the next physical execution in order.

```ts
const steering = new RunSteeringPlugin()
const agent = createAgent({ plugins: [steering, conversation, ...plugins] })

await Promise.all([
    agent.run({ prompt: 'Original task' }),
    agent.run({ prompt: 'Additional constraints' })
])
```

Steering is the first candidate and appears once. It appends a private cleanup coordinator during registration so the next batch starts only after asynchronous onRunEnd handlers finish.

Waiting calls have independent Outcomes but do not replay the executing call's model events. Observe through that executor's stream or an Events publisher.

See the [contract](docs/specs/architecture.md). The example assumes an existing Conversation and supporting plugins.
