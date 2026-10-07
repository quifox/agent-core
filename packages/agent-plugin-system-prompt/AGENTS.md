# AGENTS.md

Scope: `packages/agent-plugin-system-prompt/`。先读根 AGENTS.md 和 `docs/specs/architecture.md`。

- 依赖 Core 公开 Hook 与消息类型。可信提示词通过 beforeModel 向具体消息 owner 贡献，不增加 Core 提示词模式字段；本插件保持已有消息顺序并按当前内容去重，不覆盖远端祖先历史。内容必须由调用方显式提供；具体应用身份和诊断提示词不得放入本通用包。
- ES2022 ESM、strict TypeScript、四空格和英文 JSDoc。公开入口为 src/index.ts，不添加隐式全局 I/O。
- 行为先合同后实现；验证 `pnpm --filter @quifox/agent-plugin-system-prompt check`、Core check 和相关 Host tests。
