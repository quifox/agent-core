# @quifox/agent-plugin-subagents

English | [简体中文](README.zh-CN.md)

Registers subagent_start and subagent_wait. Start supports empty/fork. Child Agents run in the background; waiting collects the final output. The default wait is ten seconds; timeout returns running and can be followed by another wait.

```ts
const subagents = new SubAgentsPlugin({
    plugins: child => [child, new CompactionPlugin()],
    waitTimeoutMs: 10_000,
    maxCompletedTasks: 100
})
const agent = createAgent({ plugins: [conversation, subagents, new CompactionPlugin()] })
```

The example assumes Conversation is configured with ChatCompactionSource. The plugins callback explicitly constructs/selects child Tools, prompts, and permissions; dependencies bind to the child session. Parent plugins are not automatically cloned and recursive child-task capability is not implicitly installed.

taskId belongs to this plugin. Wait timers are released; timeout does not stop the task. Running tasks are retained, while completed results have a bounded completion-order cache.

See the [contract](docs/specs/architecture.md).
