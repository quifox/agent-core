# AGENTS.md

Scope: packages/agent-plugin-subagents/。先读根 AGENTS.md 与 docs/specs/architecture.md。

- 子任务由本插件保存和调度；依赖会话组合能力，不读取消息列表，不扩展 Core Hook 或 runId。
- 子任务完成只消费该调用的 Outcome 产物，不把继承历史的末尾回复当作本轮输出。
- 子插件由调用方显式编排；工具仍由 Core 唯一入口执行。ES2022 ESM、四空格、英文 JSDoc，无隐式网络或文件 I/O。
- 验证 `pnpm --filter @quifox/agent-plugin-subagents check`、Session 与 Compaction 相关组合测试。
