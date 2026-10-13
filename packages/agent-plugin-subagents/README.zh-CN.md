# @quifox/agent-plugin-subagents

[English](README.md) | 简体中文

注册 `subagent_start`、`subagent_send`、`subagent_wait` 与 `subagent_stop`。start 支持 `empty` 与 `fork`；省略 `prompt` 创建待机子会话，不请求模型。可选 `agent`、`model`、`reasoningEffort` 由 Host 解析。`name` 可指定名称，省略时自动命名；重复名称会报错。创建和发送回执返回实际名称与任务 ID。send 唤醒同一子 Agent，后续消息按接纳顺序运行。wait 支持 `timeoutMs`（0–300000），默认十秒；超时返回 running，不取消子任务。

`subagent_stop` 可传 `waitForExit: true` 与可选 `timeoutMs`，请求优雅终止并等待真实收尾；超时返回 `stopping`。Host 方法 `stopAndWait` 使用同一边界，`onStop(taskId, settled)` 先请求停止执行者、在 settled 后提交队列取消和资源收尾。`onResult` 可向父会话发布结果通知，不自动启动新模型轮；手动恢复的子执行通过 `observeExecution` 接入同一 wait/stop 生命周期。

```ts
const subagents = new SubAgentsPlugin({
    plugins: child => [child, new CompactionPlugin()],
    waitTimeoutMs: 10_000,
    maxCompletedTasks: 100
})
const agent = createAgent({ plugins: [conversation, subagents, new CompactionPlugin()] })
```

上述 conversation 已配置 ChatCompactionSource。子工具、提示词和权限插件由 plugins 回调显式创建/选择，内部引用需绑定子会话；不自动复制父插件或隐式安装递归子任务。taskId 属于本插件，Core 没有 runId。等待计时器会释放，超时不会终止子任务；运行中任务不淘汰，完成结果按完成顺序有界保留。

工具只访问当前父 Context 创建的子任务。stop 使用子信号，保留已执行工具的真实回执，对未启动调用标记中断，不保证业务回滚；新消息可重新启动子 Agent。Host 可通过 createConversation 绑定子持久化，通过 onEvent 观察真实流事件，观察失败不改变执行。fork 保存当前有效前缀及既有压缩点，不能复原此前已压缩的上下文。
