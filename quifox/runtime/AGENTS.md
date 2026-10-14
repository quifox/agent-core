# AGENTS.md

Scope: quifox/runtime。继承根规则，读 [Host SPEC](docs/specs/architecture.md) 与相关插件 SPEC。

- TUI/Desktop 共享本 Host 的命令、事件、配置、持久化和插件装配；UI 不自建业务执行者或会话历史。
- Bun Host 可使用 Node 兼容 API；文件、进程、MCP 与平台差异只在 Host。默认应用目录 `.quifox`，测试使用隔离临时目录。
- 原文、临时模型上下文与展示投影分开；敏感配置不进入公开状态、事件或日志。恢复不得推断未知操作未发生。
- 验证 `bun run --filter @quifox/shared-runtime check` 与 TUI/sidecar 组合场景；真实模型和合成 HTTP/MCP 分别报告。
