# QuiFox 应用

[English](README.md) | 简体中文

<img src="desktop/src/assets/fox.svg" alt="QuiFox 狐狸" width="64" height="64">

QuiFox 是本仓库的终端与桌面应用层，将 [Core 与框架插件](../README.zh-CN.md) 组合成可交互的 Agent。两个界面共享会话、模型连接、工具审批、Skills、Memory、子任务与执行轨迹。

> [!NOTE]
> QuiFox 是实验性研究项目，API 与应用行为仍在演进。

## 模块

| 目录 | 职责 | 详细说明 |
| --- | --- | --- |
| `tui/` | React/Ink 终端界面、键盘交互与流式输出 | [TUI README](tui/README.zh-CN.md) |
| `desktop/` | Tauri/React 桌面界面、项目导航与工具展示 | [Desktop README](desktop/README.zh-CN.md) |
| `runtime/` | 共享 Agent 装配、命令、配置、授权、持久化与 Host I/O | [Runtime README](runtime/README.zh-CN.md) |

两个界面向同一个 runtime 提交命令并展示其事件。Desktop 的 Rust 桥负责原生窗口和 sidecar 进程。Core 与通用插件位于 `../packages/`；`../examples/` 保存框架组合示例。

## 工作流工作台

启用工作流插件后，可检查、保存和运行 TypeScript 多 Agent 脚本。Desktop 将方法调用图与多轮对话并排展示，支持实际调用状态、缩放和平移。脚本可追加知识检索等已启用业务插件。编写方式、恢复模板与认证本地 API 部署见[工作流指南](runtime/docs/guides/workflows.zh-CN.md)。

## 安装终端应用

npm 安装包名称为 `quifox`，提供 TUI。需要 Node.js 22.12 或更新版本，安装产物无须 Bun。

> [!NOTE]
> 此包尚未发布到 npm registry。以下命令在发布后可用；目前请使用下方的源码启动方式。

```sh
npm install --global quifox
quifox
```

在项目目录中运行 `quifox`，或用 `quifox --workspace /path/to/project` 选择其他目录。发布后也可以使用 `npx quifox` 启动终端应用。本地安装包构建和快捷键见 [TUI 指南](tui/README.zh-CN.md)。

## 从源码启动

使用根 manifest 固定的 Bun 1.4.0，以及 Node.js 22.12 或更新版本。在**仓库根目录**执行：

```sh
bun install --frozen-lockfile
bun run build
```

启动终端界面：

```sh
bun run quifox/tui/src/cli.tsx --workspace /path/to/project
```

安装 [Tauri 原生开发依赖](https://v2.tauri.app/start/prerequisites/) 后，启动原生桌面界面：

```sh
bun run --filter @quifox/desktop desktop:dev
```

终端安装、快捷键、原生构建和详细配置见对应模块 README。

## 模型与本地数据

在 Desktop 设置或 TUI 的 `/config`、`/model` 面板配置模型连接。两个界面默认共享 `~/.quifox` 数据目录，其中包含 `config.json` 与会话原始记录。每次启动打开新的对话；恢复旧会话时从历史记录中选择。

`MODEL_API_KEY`、`MODEL_BASE_URL` 与 `MODEL_ID` 可覆盖当前进程的默认 Chat 连接，覆盖值不会自动保存。模型配置、隔离数据目录、项目配置与 MCP 连接见 [runtime 配置说明](runtime/README.zh-CN.md#配置与资料)。

## 延伸阅读

- [应用与包边界](../docs/specs/packages.md)。
- [共享 runtime 合同](runtime/docs/specs/architecture.md)。
- [Desktop 合同](desktop/docs/specs/architecture.md)。
- [框架架构指南](../docs/guides/architecture.zh-CN.md)。
