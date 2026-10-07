# @quifox/agent-plugin-formal-backend

English | [简体中文](README.zh-CN.md)

Reference backend composition for Responses generation, budget preparation, summary checkpoints, and cross-turn cursors. The Host injects the API and transport; this package does not define a universal backend protocol.

```ts
const backend = createFormalBackendPlugin({
    id: 'conversation', ownerId: 'user',
    model: modelId, baseUrl, headers, transport, api, store
})
const agent = createAgent({ plugins: [backend, ...plugins] })
await agent.run({ prompt: 'First turn' })
for await (const event of agent.stream({ prompt: 'Continue' })) render(event)
```

The public input is { prompt: string }; the local { resume: true } contract is not used here. The plugin creates its ResponsesModelPlugin and per-run context internally. Supplying api enables backend budget/checkpoint routing; without api, it uses the Responses cursor and local snapshots.

The first actual request creates the remote chain. Requests are prepared and sent after the full beforeModel chain.

snapshot preserves the current cursor, pending input, and Tool increments. fork(id, childStore?) returns a new backend plugin sharing immutable parent references; the next request creates a new Response. The parent's store callback is not reused by default. Unknown Tool effects require verification.

See the [contract](docs/specs/architecture.md). Connection parameters, api, store, and render are Host dependencies.
