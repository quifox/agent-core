# 后台任务插件

[English](README.md) | 简体中文

BackgroundTasksPlugin 保存后台操作状态，Core 继续普通串行工具循环。与 Conversation 和 Host 工具一起注册；提交工具调用 `tasks.submit(ctx, signal => operation(signal))` 并立即返回身份，operation 返回真实 ToolResult。

插件注册 `task_wait` 和 `task_cancel`。设置 `task_wait.timeoutMs: 0` 可立即查询状态；省略时最多等待十秒，正数可设为最长五分钟。超时只返回当前事实，不取消或重复执行。任务按提交者 Agent Context 隔离。

取消是请求，不表示业务回滚；确认结束前保持 running，取消后到达的真实结果仍保留。观察回执不能反写内部状态；不可序列化的可选 data 省略并标记 resultDataUnavailable，操作真实状态和文本继续可读。

Host 退出时调用 `await tasks.close(ctx)` 请求取消并有界等待确认。忽略取消的操作可能仍返回 running，实际资源需由 Host 收口。详见 [合同](docs/specs/architecture.md)。
