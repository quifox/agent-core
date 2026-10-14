# AGENTS.md

Scope: `packages/agent-plugin-session/`。先读根 AGENTS.md 与 docs/specs/architecture.md。

- 本包拥有 Chat 会话与 Conversation 组合；生成能力由 agent-plugin-model 的 ChatModelPlugin 提供。协议连接由模型插件内部创建，调用方只配置插件。跨轮记忆、存储、恢复与 Fork 不进入 Core。
- 会话与生成是独立插件对象；会话不包装 model，不重建其他插件，不提供另一个 Agent 运行入口。
- Conversation 可在本轮首次模型请求前接纳运行转向插件贡献的额外 user 消息；Session 仍是消息历史的唯一 owner，转向插件不得直接持有或改写 Message[]。
- ES2022 ESM、strict TypeScript、四空格、英文 JSDoc；无隐式全局网络或 Node 依赖。
- 验证 `bun run --filter @quifox/agent-plugin-session check`、Core check、压缩包与 Host 相关测试。
