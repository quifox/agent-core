# @quifox/agent-plugin-subagents

[English](README.md) | 简体中文

注册 `subagent_start` 和 `subagent_wait`。启动支持 `empty` 与 `fork`；后台运行子 Agent，只收取最终输出。等待默认十秒，超时返回 running，可再次等待。

```ts
const subagents = new SubAgentsPlugin({
    plugins: child => [child, new CompactionPlugin()],
    waitTimeoutMs: 10_000,
    maxCompletedTasks: 100
})
const agent = createAgent({ plugins: [conversation, subagents, new CompactionPlugin()] })
```

上述 conversation 已配置 ChatCompactionSource。子工具、提示词和权限插件由 plugins 回调显式创建/选择，内部引用需绑定子会话；不自动复制父插件或隐式安装递归子任务。taskId 属于本插件，Core 没有 runId。等待计时器会释放，超时不会终止子任务；运行中任务不淘汰，完成结果按完成顺序有界保留。
