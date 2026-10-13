# AGENTS.md

Scope: packages/agent-plugin-mcp。继承根规则，读 [模块 SPEC](docs/specs/architecture.md)。

- MCP 客户端连接/传输由 Host 注入；本包只将标准 tools/list/call 映射到普通 Core 工具。
- 保留原始工具身份、JSON Schema 和参数，不依据服务端 annotations 放宽授权或未知结果重试。
- 验证 `bun run --filter @quifox/agent-plugin-mcp check`，以及 shared-runtime 的本地标准 MCP 服务组合。
