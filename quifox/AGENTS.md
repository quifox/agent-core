# AGENTS.md

Scope：`quifox/` 应用层。继承仓库根规则；本目录是同一 monorepo 的应用入口，工具链与 workspace 继续由根 manifest 管理。

- 应用定位与启动入口维护在 [README](README.md) 及其中文版本；跨应用职责以 [包与宿主边界](../docs/specs/packages.md) 为准。
- 修改共享命令、插件装配、配置、授权、会话或 I/O 时，读 [runtime 入口](runtime/AGENTS.md) 及其路由的 SPEC。TUI/Desktop 复用共享 runtime 的执行事实，不自建会话或业务状态 owner。
- 修改桌面界面、原生窗口或 sidecar 桥时，读 [Desktop 入口](desktop/AGENTS.md)；修改终端交互时，读 [TUI 入口](tui/AGENTS.md)。仅加载本次涉及的子模块规则。
