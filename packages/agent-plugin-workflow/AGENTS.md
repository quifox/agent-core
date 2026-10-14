# AGENTS.md

Scope: packages/agent-plugin-workflow。继承根约束，读 docs/specs/architecture.md。

- 工作流通过 Host 注入执行与存储能力；不自行读文件、求值、编译、发网络请求或安装其他插件。
- 模型钩子与工具共享同一执行能力；真实会话、授权、停止和持久化仍属于现有 owner。
