# @quifox/agent-plugin-interrupt

English | [简体中文](README.zh-CN.md)

Cooperative stopping through the existing Run/Tool Hooks.

```ts
const interrupt = createInterruptPlugin()
const agent = createAgent({ plugins: [...plugins, interrupt, generation] })
for await (const event of agent.stream(input)) render(event)

stopButton.onclick = () => interrupt.requestStop()
```

Requests are recorded only during an active admitted call. Default pause waits for a running Tool's real receipt and the complete afterTool chain, then stops without filling the remaining calls. Execution records can support a later explicit recovery.

terminate keeps the real receipt and gives each not-yet-started call a USER_INTERRUPTED result through the complete afterTool chain, then stops at afterStep. Model or business I/O cancellation belongs to its owner.

When paired with execution records, beforeTool uses execution.requiresRetry(callId). An unknown result re-enters the Tool only when policy.retrySafe is true; false or omission stops with tool-result-unknown. This does not block first execution or a confirmed not-started call. Routing Hooks precede Interrupt.

See the [contract](docs/specs/architecture.md). The example assumes existing model/input/render and a Host stop button.
