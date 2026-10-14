# AGENTS.md

Scope: packages/agent-plugin-tasks。继承根入口；修改行为前读取 docs/specs/architecture.md。

- 后台任务状态与普通查询/等待/取消工具归本插件；实际 I/O 由提交操作的 Host 提供，不修改 Core 循环。
- 所有状态按 Agent Context 的长期身份隔离；不把 Context 当每轮运行身份。取消请求不证明副作用回滚。
- 验证 `bun run --filter @quifox/agent-plugin-tasks check` 与共享 Host 的后台工具组合场景。
