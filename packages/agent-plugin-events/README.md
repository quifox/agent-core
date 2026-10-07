# @quifox/agent-plugin-events

English | [简体中文](README.zh-CN.md)

Per-Agent execution observation. An EventPublisherPlugin binds sourceId and publish; the Host may connect the sink to SSE or a local event bus. It does not require Teams or replace Agent.run/stream.

```ts
const events = new EventPublisherPlugin({ sourceId: 'researcher', publish: event => output.publish(event) })
const agent = createAgent({ plugins: [conversation, prompt, events, teams] })
await agent.run({ prompt: 'Start the task' })
```

Place this object as the final model implementation so it delegates to the preceding generator. Other Hooks follow their original order. If Teams is present, its asynchronous-cleanup ordering still applies.

Publishing failure is available through publishError and does not change business decisions. Each Agent normally owns an independent publisher; the current implementation does not support concurrent shared observation across Agents.

A proposed call is not an executed call, and run-ending does not prove every later cleanup finished. Error observations expose public code/phase, not raw causes or internal details. An Outcome not admitted by this publisher does not enter its sourceId.

See the [contract](docs/specs/architecture.md). output and the existing plugins in the example belong to the Host.
