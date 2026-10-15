# Background Tasks Plugin

English | [简体中文](README.zh-CN.md)

`BackgroundTasksPlugin` owns background operations while Core keeps its ordinary serial Tool loop. Register it with the Conversation and Host tools. A Host submit tool calls `tasks.submit(ctx, signal => operation(signal))` and returns the task identity immediately; the operation returns a real `ToolResult`.

The plugin registers `task_wait` and `task_cancel`. `task_wait({taskId, timeoutMs: 0})` checks immediately; wait otherwise defaults to ten seconds and accepts `timeoutMs` up to five minutes. Timeout returns current facts without cancelling or repeating the operation. All tools isolate tasks by their submitting Agent Context. An optional `context(ctx)` writer contributes short instructions for the tools that remain registered.

Cancellation is a request, not rollback. The task remains running until acknowledgement; a real result arriving after cancellation is preserved. Observation receipts cannot rewrite task facts. Nonserializable optional result data is omitted with `resultDataUnavailable`; the operation's actual status and text remain available.

The Host calls `await tasks.close(ctx)` during shutdown to request cancellation and observe acknowledgement with a bounded wait. Operations that ignore cancellation may still be running in the returned facts and require Host resource cleanup.

See the [contract](docs/specs/architecture.md).
