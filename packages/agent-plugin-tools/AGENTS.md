# AGENTS.md

Scope: `packages/agent-plugin-tools/`。先读根 AGENTS.md 和 `docs/specs/architecture.md`。

- 依赖 Core 公开 Tool、Hook、模型类型与 Zod。目录查询、结果补充、模型工具筛选与调用映射属于本包；不得直接执行业务 handler，不把入口名称或分组规则放回 Core。
- ES2022 ESM、strict TypeScript、四空格和英文 JSDoc。公开入口为 src/index.ts，不添加隐式全局 I/O。
- 行为先合同后实现；验证 `bun run --filter @quifox/agent-plugin-tools check`、Core check 和相关 Host tests。
