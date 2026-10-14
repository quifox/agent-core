# QuiFox 共享运行时

[English](README.md) | [简体中文](README.zh-CN.md)

[TUI](../tui/README.zh-CN.md) 与 [Desktop](../desktop/README.zh-CN.md) 使用同一仓库内部 Bun Host，组合 Chat、Session、恢复、压缩、Memory、Skills、项目指引、权限、MCP、后台任务与子 Agent；Core 不因宿主变化而修改。

`model-catalog` 读取缓存的 Models.dev Chat 目录，`refresh: true` 更新目录且不携带模型密钥。接口的思考布尔值不代表支持哪些档位；`model.reasoningEfforts` 可显式配置，`null` 清除覆盖。全局 `preferences.reasoningEffort` 缺省 `high`，仅在已知支持时应用。切换 URL origin 会清除未重填的连接密钥。`resources` 无需会话即可读取目录资源，`plugins` 枚举实际装配。

```ts
import { QuiFoxRuntime, type SessionView } from '@quifox/shared-runtime'

const runtime = await QuiFoxRuntime.open({ workspace: process.cwd() })
try {
    const session = await runtime.command({ type: 'create' }) as SessionView
    runtime.subscribe(event => console.log(event.type, event.sequence))
    await runtime.command({ type: 'submit', sessionId: session.id, prompt: '解释这个项目。' })
    await runtime.waitForIdle(session.id)
} finally {
    await runtime.close()
}
```

Host 拥有文件、进程与传输。`RuntimeCommand` 提供会话创建/快照/提交/停止/续跑、审批、配置、模型资料与 Memory 命令。事件携带会话、运行和序列身份；接纳消息或任务不代表执行完成。sidecar 通过标准输入/输出上的 JSONL 使用相同命令。

## 配置与资料

默认根目录为 `~/.quifox`，可用 `root` 指定独立目录；保存 `config.json`、模型资料、原始会话 JSONL 与 owner 隔离的 Memory。同一根目录可运行多个 Host，各自运行不同会话；每棵会话树同时只有一个执行宿主。UI 默认打开新主会话，历史显式选择。闲置宿主在下一条命令前刷新共享配置。

`MODEL_API_KEY`、`MODEL_BASE_URL`、`MODEL_ID` 在内存中覆盖 Chat 连接，不自动保存。默认使用 DeepSeek `deepseek-flash`；其他模型需要对应 models.dev 资料或明确的 `model.contextWindow`。空闲时通过 `refresh-models` 刷新资料。

配置包含默认 `model`、带稳定 ID 的额外 `models`、思考默认值/支持列表、压缩预算、Memory 与 `approval: "ask" | "allow"`。预算不能抬高已知模型容量；活动操作结束后才能切换配置。配置 patch 用 `null` 清除可选容量/压缩参数。公开快照省略凭据与 URL 查询参数。

项目 `.quifox/config.json` 从全局经所有祖先目录逐字段继承，最近值覆盖；项目不能自行授予 MCP 信任、提高逐次审批权限或重新开启全局关闭的 Memory。模型目标需先在用户模型列表中声明，切换 URL origin 不继承凭据和 Provider 参数。独立 `root` 不会将默认用户配置当成项目层读入。

Agent 定义使用 `<root>/agents/*.md`、祖先 `.claude/agents/*.md` 或 `.quifox/agents/*.md` 的 YAML frontmatter，支持 name/description/model/tools/disallowedTools/permissionMode/effort，最近同名定义优先。权限模式只支持 default/plan/dontAsk，其他模式明确列入问题。子 Agent 可继承或指定模型，工具权限不超过父 Agent 的实际范围。

MCP 接受标准 stdio 或 HTTP server，例如：

```json
{
    "mcp": [
        { "id": "local", "transport": "stdio", "command": "your-mcp-server", "args": [] }
    ]
}
```

Skills 使用标准 `.agents/skills/<name>/SKILL.md` 与 quifox 技能目录，先发现元数据，再按需加载正文和资源。项目指引按祖先 scope 加载，同级 `AGENTS.override.md` 优先。文件修改、进程与 MCP 工具使用相同的 policy/审批入口。

项目 MCP 需要在设置中授权；未授权或发现失败的 server 不阻断普通工具，并显示实际状态。闲置时连接/重试会重新装配工具目录；退出等待连接与尚未完成的握手清理。

Memory 复用已有两阶段插件，原文、摘要与临时请求上下文分开。后台命令返回供 `task_get/wait/cancel` 使用的任务 ID。`subagent_start` 无 prompt 创建待机 Fork，有 prompt 则异步启动；send、可指定超时的 wait 与 stop 使用同一身份。恢复后的未知工作需要检查子会话。原生取消不能证明副作用已回滚。

创建命令可带 UUID `sessionId`，提交可带稳定 `messageId`，用于回执丢失后的同身份重试；参数冲突明确拒绝，避免重复会话或输入。

参见 [Host 合同](docs/specs/architecture.md) 与 [包归属](../../docs/specs/packages.md)。
