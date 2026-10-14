# AGENTS.md

Scope: `packages/agent-plugin-request-context/`。先读仓库根 `AGENTS.md` 与 [模块 SPEC](docs/specs/architecture.md)。

- 本包只为 Chat Model 请求提供短期上下文投影；ChatSessionPlugin 仍是 canonical messages、历史和持久化的唯一 owner。
- 通过 ChatSessionSource adapter 在 Session 接纳并持久化 canonical messages 后生成 wire projection。不得修改 Model.request、Session.messages、快照、历史或 Core。
- `RequestContextPlugin` 每个 Session/Agent 独立实例；Outcome 标识活动运行。共享业务插件只能通过本轮对应的 `set(key, content)` writer 贡献内容。
- `set` 只允许在活动 Outcome 中调用。每次 beforeModel 清空上一轮贡献；之后的插件可以设置本轮内容。RequestContext hooks 必须在贡献插件之前执行。
- `ContextualChatConversationPlugin` 配对同一 Session、其 RequestContext source 和绑定该 source 的 ChatModel；其 fork/empty 重新建立三者绑定，不继承父贡献。
- request context 不持久化，也不与 Session pending input 一起冻结；恢复或重试时由贡献插件重新计算。不要承诺 wire 请求字节级重放。
- 压缩估算器应对候选 `messages` 调用 `context.project(messages)`；compaction factory 接收分支对应的新 context，不能捕获父 context。
- 源码保持 ES2022 ESM、strict TypeScript、四空格、英文 JSDoc；Node I/O 不属于本包。

验证：`bun run --filter @quifox/agent-plugin-request-context check`，以及 Memory/Session 组合测试。
