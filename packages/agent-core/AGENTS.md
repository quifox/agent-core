# AGENTS.md

Scope: packages/agent-core/。先读根 AGENTS.md。

## 路由与边界

- 本包是跨运行时、协议无关的 Hook-driven ReAct 内核；Core 保留插件对象、调度钩子与默认工具执行链。Registry 同时公开原 Tool 读取能力，直接调用的边界以 tool-runtime SPEC 为准。消息、模型请求与 I/O、系统提示词、会话、Fork、恢复和持久化属于插件。
- 模型客户端、协议工厂与专用错误码由模型插件包内部拥有；Core 不导出 LanguageModel，也不声明 Provider 阶段。插件可使用自己的错误码与阶段字符串，Core 保留其原始 AgentError 与统一收尾语义。
- 改生命周期、Context、模型执行或跨包职责前，读 docs/specs/architecture.md；注册、初始化与对象复用同时读 docs/specs/sessions.md；Tool、Registry、Executor、参数准备、policy 或结果处理同时读 docs/specs/tool-runtime.md。
- SPEC 是长期合同的唯一正文；源码、测试和运行结果证明实现状态。不同版本的研究图或旧实现不能覆盖用户最新要求。
- 行为或边界变更先更新对应 SPEC；删除、移动或重命名 TypeScript export 时核对当前源码与消费方引用。
- Source target 为 ES2022 / ESM；禁止 Node 内置模块、文件系统、进程和隐式全局网络依赖。输入校验复用 Zod。
- 主循环保持可直接阅读：一个 ReAct while 与一个串行工具 for；产品策略通过插件进入。
- 一个 Agent 在生命周期内复用同一 CTX；CTX 只承载长期协作能力，不得用对象身份充当每轮运行令牌。插件的每轮状态使用 Outcome 身份，或在 `onRunStart` 明确重置自身字段；不要用 `WeakMap<AgentContext, ...>` 隐式区分 Run。
- `run()` 与 `stream()` 共用 `AgentRunOutcome`；结果、调用身份与错误边界以 docs/specs/architecture.md 为准。旧结果类型和替代方案的原因按根 AGENTS 路由读取决策 Note。
- `prepare` 与 `execute` 是工具自己的方法。工具自行决定捕获并返回正常结果，还是抛出异常终止本次运行；Core 只把已经抛出的异常纳入统一 `onError` / `onRunEnd` 流程，不猜测工具内部失败，也不擅自转换为 `ToolResult`。
- 业务中断、暂停与恢复由显式插件通过既有钩子协作实现；消费者直接关闭事件流只表示传输停止和必要收尾，不得充当 Core 内置的业务中断状态或替代优雅停止插件。
- 公共接口、可变工作数据、钩子返回和执行事实边界统一遵守上述 SPEC，不另在 AGENTS.md 维护第二份生命周期合同。

## 代码风格

- TypeScript 使用四空格；类、具名函数、构造器、方法与可调用公共类型使用英文 JSDoc，具名参数用 @param。
- 字段仅在职责或约束不直观时注释；方法体注释说明非显然原因，不复述逐行操作。

## 验证

- Typecheck: bun run --filter @quifox/agent-core typecheck
- Tests: bun run --filter @quifox/agent-core test
- Build: bun run --filter @quifox/agent-core build
- Package gate: bun run --filter @quifox/agent-core check

Package gate 包含类型检查、单元测试与构建。
