# @quifox/agent-plugin-subagents

English | [简体中文](README.zh-CN.md)

Start defaults to empty history. Pass `mode: "fork"` explicitly to copy the safe parent prefix. Wait and graceful-stop payloads expose authoritative `taskId`, `name`, and `status`; completed text remains in `text`, without deriving identity from that text. The public `fork()` composition primitive keeps its explicit fork semantics.

Registers `subagent_start`, `subagent_send`, `subagent_wait`, and `subagent_stop`. Start supports empty/fork; omitting `prompt` creates an idle child without a model request. Optional `agent`, `model`, and `reasoningEffort` selections are resolved by the Host. Set `name` for a readable identity, or omit it for automatic naming; duplicate names are rejected. Creation and send receipts expose the actual name and task ID. Send wakes the same child. Further messages run in admission order. Wait accepts `timeoutMs` (0–300000), defaults to ten seconds, and never cancels the child on timeout.

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

Set `subagent_stop.waitForExit: true` with an optional `timeoutMs` to request graceful termination and wait for actual cleanup. A timeout returns `stopping`, not completion. `stopAndWait` exposes the same boundary to Hosts. Hosts use `onStop(taskId, settled)` to cancel their execution immediately and commit queue/resource cleanup after `settled`; `onResult` can publish a parent notification without starting another model turn. `observeExecution` binds an explicitly resumed child to the same wait/stop lifecycle.

Tools only access children owned by the calling parent Context. Stop aborts the child's own signal, preserves a running tool's real receipt, and marks unstarted calls as interrupted. It does not promise rollback. New messages can restart a stopped child. The Host may supply `createConversation` to bind child persistence and `onEvent` to observe real streaming events; observer failures do not change outcomes. Fork preserves the current effective prefix, including existing compaction, and cannot reconstruct earlier discarded context.

See the [contract](docs/specs/architecture.md).
