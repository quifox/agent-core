# AGENTS.md

Scope: packages/agent-plugin-teams/。先读根 AGENTS.md 与 docs/specs/architecture.md；实现时同时读 docs/specs/design.md。

- Teams 共享成员引用、信箱与唤醒调度；成员仍是普通 Agent，任意成员均可直接 run/stream。
- 多个成员共享同一个 TeamsPlugin 是本插件的核心组合方式；每个成员仍有独立 Agent、Conversation、模型、提示词与普通插件。成员地位平等，Teams 不绑定 Leader、Top、撰稿人或全局完成条件，调用哪个 Agent 就取得哪个 Agent 本轮 Outcome。
- 仅使用 Core 公开钩子与 Conversation 能力；不修改 Core，不包装 Agent 方法，不补模型工具调用。
- Teams 必须是最后一个拥有异步收尾状态的插件；只允许显式 `after: 'teams'` 且不等待外部 I/O 的协调尾对象位于其后。收尾检查延后至下一事件回合。
- ES2022 ESM、strict TypeScript、四空格、英文 JSDoc，无隐式网络或 Node 内置依赖。
- 验证 `pnpm --filter @quifox/agent-plugin-teams check`、架构边界、文档链接；相关时序测试必须使用真实 Core。
