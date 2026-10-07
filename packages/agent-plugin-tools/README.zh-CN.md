# @quifox/agent-plugin-tools

[English](README.md) | 简体中文

普通工具入口及配套衍生插件。入口名称默认 `plugin`，可改名；目录、详情和调用格式只属于这个插件族。

```ts
const entry = createToolEntryPlugin('plugin')
const todo = deriveToolPlugin(entry, createTodoPlugin())
const agent = createAgent({ plugins: [generation, entry, todo] })
await agent.run({ prompt: '创建待办' })
```

衍生插件在 beforeModel 筛选模型工具定义，在 beforeTool 映射目标，在 afterTool 按原调用参数补充查询结果。实际执行始终经过 Core 唯一 Executor 和目标工具自己的 prepare / execute，模型历史保留原始调用身份。

[规范](docs/specs/architecture.md)。
