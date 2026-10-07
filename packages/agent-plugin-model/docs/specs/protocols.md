# 模型插件内部协议与传输规范

本文固定模型插件内部的协议映射与 HTTP 字节流边界。使用者配置并注册插件，不创建协议工厂或底层客户端。Agent 的生命周期与模型执行位置由 [Core 规范](../../../agent-core/docs/specs/architecture.md) 定义；会话历史、Responses 游标和持久化由会话或后端接入插件拥有。

## 职责

Provider 负责把内部 `ModelRequest` 投影为具体供应商协议，并把流式响应解析为 `ModelEvent`。Provider 可以提供创建 `LanguageModel` 的工厂，但不进入 Agent ReAct 循环，不拥有 Hook、Session、Tool 执行或产品提示词。

`HttpTransport` 只处理 URL、Header、状态码和响应字节流。Chat Completions 与 Responses 复用 Transport、SSE、UTF-8 和工具参数解析能力，但保持独立的请求类型、事件扩展和状态模型。

## 运行时与公开入口

- Target 为 ES2022 / ESM；生产源码不依赖 Node 内置模块、文件系统或 `process`。
- 根入口可以提供标准 Fetch Transport，但模块 import 时不得假设全局 `fetch` 已存在。
- 微信 Transport 从 `@quifox/agent-plugin-model/weapp` 导入，通过构造参数接收 `wx.request` 形状函数，不读取隐式全局 `wx`。
- 协议解析不依赖 Node Buffer；字节流、UTF-8 和 SSE 解析在浏览器、Node 宿主与 WeApp adapter 之间复用。
- 不为单一供应商便利引入额外 SDK 或隐式 polyfill。新增依赖须先证明跨运行时价值。

## Chat Completions 协议

- `createOpenAICompatibleProvider` 接收显式 id、baseUrl、认证、Header 与 Transport，返回统一 `LanguageModelProvider`。
- 请求从同一 `ModelRequest` 投影 messages、tools、tool choice、推理配置和输出限制。Provider option 不得覆盖 model、messages、stream、tools 等保留字段。
- OpenAI-compatible chunk 只严格检查实际读取字段，并允许未知供应商扩展字段。
- Tool Call delta 按 index 聚合；参数只在完整后解析。先使用 JSON，失败时只允许项目已有的有限 JSON5 兼容语法，不修补截断、缺失值或非有限数字。
- 原始 `finish_reason` 延迟到流结束统一映射；对外 `finish` 必须精确一次并且是最后一个 `ModelEvent`。usage-only chunk 即使位于原始 finish 后也要先消费。
- Assistant reasoning 回传字段由具体 Provider 配置选择，不进入 Core 或会话通用字段判断。

## Responses 协议

- Responses 使用独立 `ResponsesModelRequest` 和 `ResponsesModelEvent`。`previousResponseId` 只存在于该协议请求，不能进入 Core 通用输入或 Chat 请求。
- Provider 只负责 `previous_response_id` 的 wire projection，并在每个完成事件中以类型和运行时校验保证存在非空服务端 `responseId`。哪个 ID 成为下一次游标、何时提交与如何持久化由 Formal Backend 等会话 owner 决定。
- 有 `previousResponseId` 时只发送服务端游标之后的新输入，不重放完整本地历史；首次请求发送完整有效输入。
- Responses 的 message、function call、function call output、reasoning、usage 与完成状态按独立 wire shape 解析，不借用 Chat chunk 聚合器。
- `function_call.name` 和 `function_call.call_id` 都是必填协议字段；缺失、空白或同一完成响应内 `call_id` 重复时按 Provider 协议错误拒绝。`call_id` 是后续 `function_call_output.call_id` 的唯一关联身份，不能用 output item `id` 或固定占位符代替。
- Chat 与 Responses 不共用会话游标、请求对象、完成事件或调试记录。相同内部 Tool 定义可以分别投影为各自协议形状。

## 错误与数据边界

- 非 2xx、上游 error payload 和网络失败归类为 `MODEL_FAILED/provider`；无效 SSE、JSON、chunk、Tool 参数或缺失完成事实归类为 `PROVIDER_PROTOCOL_ERROR/provider`。
- 错误公开信息保持稳定并限长；不得包含 Authorization、API Key、完整请求体、未脱敏响应或内部堆栈。
- 正常解析不统计字节、字符、行数或解码操作次数。Chat 完成事实缺失时只记录已收到的 SSE 事件数量和完成标记。宿主注入的传输观察器保持可选，不能控制模型执行。
- Provider 不自动重试模型请求，不推进会话游标，不保存消息。是否重试、接受候选或恢复由调用它的插件决定。
- Abort 只取消当前 Transport / Model I/O，不自动表示 Agent 的业务中断、暂停或可恢复检查点。

## 安全与验证边界

- 认证凭证由宿主安全配置提供；不得编译进 H5、小程序或 renderer。
- 客户端生产接入长期凭证时必须经过后端网关或独立短期凭证设计。
- 协议夹具仅验证请求投影与解析，不能替代真实网络、应用会话续接或后端数据库验收。

## Non-goals

- 不拥有 Agent 生命周期、Hook、会话历史或工具执行。
- 不提供统一 Chat/Responses 会话门面或自动协议切换。
- 不保存 `responseId` 作为全局客户端状态，不推断后端权威历史。
- 不内置产品模型目录、密钥管理、预算策略、重试策略或 UI 事件。
