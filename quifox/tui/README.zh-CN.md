# QuiFox TUI

[English](README.md) | [简体中文](README.zh-CN.md)

React/Ink 终端宿主，展示蓝身体、黄耳朵狐狸与 **QUIFOX**。所有 Agent 能力使用 [共享运行时](../runtime/README.zh-CN.md)。

完成 workspace 构建后，在仓库根目录启动：

```sh
bun run quifox/tui/src/cli.tsx --workspace /path/to/project
```

用 `MODEL_API_KEY`、`MODEL_BASE_URL`、`MODEL_ID` 或共享 JSON 配置连接 Chat 模型。`--root /path/to/isolated-root` 使用独立资料目录；`--prompt "解释这个项目"` 执行单轮批处理，批处理会拒绝需要人工审批的工具。

正常启动打开新主会话；`--resume` 打开历史选择器，`--resume 会话ID` 选择指定会话。多个终端/原生宿主可以共享资料目录，运行不同会话。

| 操作 | 行为 |
| --- | --- |
| Enter / Shift+Enter | 发送 / 换行 |
| Tab | 补全斜杠命令、Skill 或 @ 接收者 |
| Up / Down | 筛选/选择命令或滚动输出 |
| Escape | 关闭面板或请求停止 |
| Ctrl+C | 收尾 Host 并退出 |
| `/approve`、`/deny` | 回复当前显示的审批 |
| `/new [目录]`、`/resume`、`/open 会话ID` | 创建或显式选择会话 |
| `/tasks` | 进入子任务或返回父会话 |
| `/spawn [--fork] [数量] [说明]` | 创建待机子 Agent，只有 `--fork` 复制父前缀 |
| `/continue`、`/stop` | 重新规划后恢复或停止实际运行 |
| `/config [JSON]`、`/model`、`/effort`、`/models` | 可视设置、模型/思考选择或资料刷新 |
| `/mcp`、`/agents` | MCP 连接与 Markdown Agent 定义 |
| `/skills`、`/memory`、`/trace`、`/help` | 查看共享资源与真实事件 |

技能名与内建命令冲突时用 `$skill-name` 选择；`$catalog-identity` 指定准确来源，普通 `/skill-name` 补全使用最近作用域。

`/spawn 3 审查这些需求` 返回三个名称与 ID，默认空历史，不请求模型；`/spawn --fork 3 审查既有计划` 才复制父安全前缀。QuiFox 首期只允许一层子 Agent。`@Turing @Curie 审查代码 @Newton 搜索相关问题` 向 Turing/Curie 广播第一段，向 Newton 发送第二段。使用返回的名称或 ID；补全也包含模型创建的子 Agent。部分派发失败时保留草稿，重试沿用原输入身份。

Queue/Steer 在 `/config` 配置：Queue 等待完整执行与收尾，Steer 在下一完整请求边界加入。未知工具副作用保持未知；普通 `y`/`n` 文本不触发授权。终端视口保留品牌与输入区，长草稿显示光标附近内容；审批卡展示操作摘要，`/trace` 查看实际参数、回执与文件差异。

命令行添加标准 stdio server 后，可在 `/mcp` 连接：

```sh
bun run quifox/tui/src/cli.tsx mcp add local -- npx -y server-package
```

命令只保存配置；连接或执行已授权 Agent 时才由 MCP SDK 启动。HTTP 使用 `mcp add local --url https://server.example.test/mcp`。项目 MCP 配置需要显式目录授权。
