# @quifox/agent-plugin-tools

English | [简体中文](README.zh-CN.md)

Tool entry routing and derived plugins. The default entry name is plugin and can be changed. Catalog, detail, and invocation formats belong to this package family.

```ts
const entry = createToolEntryPlugin('plugin')
const todo = deriveToolPlugin(entry, createTodoPlugin())
const agent = createAgent({ plugins: [generation, entry, todo] })
await agent.run({ prompt: 'Create a todo' })
```

Derived plugins filter model definitions in beforeModel, route targets in beforeTool, and enrich query results in afterTool. Mapped entry calls use the default Core Tool entry and the target's own prepare/execute; model history retains the original call identity.

See the [contract](docs/specs/architecture.md). The example assumes a caller-provided Todo plugin and generation implementation.
