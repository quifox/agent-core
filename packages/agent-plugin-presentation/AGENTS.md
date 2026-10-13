# AGENTS.md

Scope: 本插件。继承根约束，读 [展示合同](docs/specs/architecture.md)。

- 插件只拥有工具与临时上下文，I/O、展示身份、原生打开与 UI 确认由注入的 Host 适配器拥有。
- 不依赖 React、Bun/Node 或文件系统。Core 不感知 GUI；验证公开工具回执、取消和失败边界。
