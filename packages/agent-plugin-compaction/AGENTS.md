# AGENTS.md

Scope: packages/agent-plugin-compaction。先读根 AGENTS.md 和 docs/specs/architecture.md。

- 具体 Chat 压缩范围/预算/两次候选加一次兜底和摘要提示词由本包提供。依赖 Core 运行合同和 agent-plugin-session 消息记录；Responses 适配器属于 agent-plugin-formal-backend，复用本包摘要策略。
- strict TypeScript ESM，生产源码不依赖 Node/fs/process/隐式网络。四空格、英文 JSDoc。
- 行为先合同后实现，验证 `pnpm --filter @quifox/agent-plugin-compaction check`、Core check 和相关 Host tests。
