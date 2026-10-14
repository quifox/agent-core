# AGENTS.md

Scope: packages/agent-plugin-observability。继承根规则，读 [模块 SPEC](docs/specs/architecture.md)。

- 本包只观察公开 Hook 与 Context 事实，不包装 Agent.run/stream，不成为 Session、模型、工具或持久化 owner。
- 观测失败不能改变 Agent 执行结果；出口、存储与可视化由 Host 组合。
- 默认事件不复制 prompt、tool result 正文、secret 或 provider 私有字段；composition 只在调用方明确提供安全投影时保存。
- Eval 只保存调用方显式提交的 evaluator、score/pass/note；不在插件内部发起模型请求。
- 严格 TS、ES2022 ESM，无 Node、网络或文件系统依赖。验证 `bun run --filter @quifox/agent-plugin-observability check`。
