# AGENTS.md

Scope: `packages/agent-plugin-formal-backend/`。先读根 AGENTS.md 和 `docs/specs/architecture.md`。

- 依赖 Core、Model 插件、Session 与压缩包合同。内部组合 ResponsesModelPlugin，不导出底层连接或 Context 工厂。后端特有的引用绑定与检查点属于本包；宿主注入连接参数、认证、传输与后端 API。
- ES2022 ESM、strict TypeScript、四空格和英文 JSDoc。公开入口为 src/index.ts，不添加隐式全局 I/O。
- 行为先合同后实现；验证 `bun run --filter @quifox/agent-plugin-formal-backend check`、Core check 和相关 Host tests。
