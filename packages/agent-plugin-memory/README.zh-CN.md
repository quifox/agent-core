# @quifox/agent-plugin-memory

[English](README.md) | 简体中文

供 Chat Agent 使用的实验性、按 owner 隔离的记忆插件。它把 OpenAI Codex v2 的两阶段记忆流程适配到服务端 Chat 会话与 Agent Core。

持久记忆投影只有两类文档：

- `memory.md`：可复用的用户上下文，以及指向会话摘要的导航入口。
- `conversations/<创建时间>-<短 ID>.md`：单个会话的 summary、description 和由程序写入的来源元数据。

会话标题由宿主提供。一次提取同时生成 `description` 和 `summary`；代码负责写入标题、来源版本、时间戳和不透明 JSONL `sourceRef`。插件不创建 topic 文件、raw-memory 文件或第二份会话原文存储。

## 宿主接入

宿主负责鉴权、按 owner 隔离的持久化、Chat JSONL 归档和后台调度。`MemoryStore` 必须在单个 owner 内实现原子 compare-and-set。`ConversationArchive` 必须根据传入的 owner 解析不透明来源引用。Agent Core 不负责存储或调度。

通常只创建一个 service 和 processor，并在多个 Agent 之间共享同一个 `MemoryPlugin`。每次运行都从宿主可信的会话绑定解析身份：

```ts
import { createAgent } from '@quifox/agent-core'
import { ChatModelPlugin } from '@quifox/agent-plugin-model'
import { ChatSessionPlugin, type ConversationContext } from '@quifox/agent-plugin-session'
import { ContextualChatConversationPlugin, RequestContextPlugin } from '@quifox/agent-plugin-request-context'
import { MemoryPlugin, MemoryProcessor, MemoryService, type MemoryBinding } from '@quifox/agent-plugin-memory'

const service = new MemoryService(memoryStore, archive, newId)
const processor = new MemoryProcessor({ store: memoryStore, archive, model: modelOptions, newId })
const bindings = new WeakMap<ContextualChatConversationPlugin, MemoryBinding>()
const memory = new MemoryPlugin({
  service,
  binding(ctx) {
    const binding = bindings.get((ctx as ConversationContext).conversation as ContextualChatConversationPlugin)
    if (!binding) throw new Error('当前会话没有可信的记忆身份绑定。')
    return binding
  },
  // 放入持久后台队列；聊天响应不等待记忆整理。
  schedule: binding => enqueueMemoryPass(binding.ownerId, binding.conversationId)
})

const session = new ChatSessionPlugin({ id: conversationId, ownerId })
const context = new RequestContextPlugin(session)
const model = new ChatModelPlugin({ ...modelOptions, session: context.source })
const conversation = new ContextualChatConversationPlugin({ session, generation: model, context })
bindings.set(conversation, { ownerId, conversationId, context })
const agent = createAgent({ plugins: [conversation, memory] })
```

`enqueueMemoryPass` 是宿主实现，随后调用 `processor.run(ownerId, currentConversationId)`。Processor 重新读取符合条件的 Chat 记录、领取 owner 作用域的租约、从来源原文重新提取有变更的会话，再把选中的摘要整理进 `memory.md`。失败会保留已发布文档并安排重试；过期来源快照不能发布。

摘要提取默认通过现有 Model 配置使用 Chat 严格 JSON schema。不支持该能力的路由可由宿主明确将 `MemoryProcessorOptions.extractionFormat` 设为 `'json-object'` 或 `'text'`；所有模式均校验返回结果，失败不自动降级。该约束仅作用于提取请求，跨会话整理继续使用普通工具调用。

## 记忆行为

提取按来源可信度分配优先级：人类输入与结构化的人类答复最高，然后是 assistant、其他 Agent、commentary、context 和 tool 输出。输入有预算，选择后恢复时间顺序，并标记省略或截断内容。系统消息、注入的记忆和生成的推理不会作为人类证据。来源版本变化时，从原始记录重新生成摘要，不把新内容简单追加到旧摘要。

跨会话整理读取现有 `memory.md` 与摘要目录，按精确路径查看相关摘要；遇到冲突时，可读取或搜索选中会话的原始 JSONL 进行核验。只有 Agent 成功完成并通过来源版本、输入指纹和租约检查后才发布。`memory_list`、`memory_read`、`memory_search` 渐进式暴露摘要；`conversation_read`、`conversation_search` 暴露 owner 范围内的原始证据。搜索默认按关键词匹配；宿主可增加排序器，但不能改变来源身份。

`conversation_read` 返回截断页时，将 `nextLine`/`nextOffset` 作为下一次的 `startLine`/`startOffset`。`lineFragment` 表示超大脱敏物理行的片段，偏移按 UTF-16 单元计算且不拆分代理对。JSON 回执在工具预算内保持可解析；过大的列表/搜索结果提供明确的结构预览。

数量上限只限制本轮归纳输入，近期未入选的摘要仍可读取、后续入选。纠正期间向主请求屏蔽旧全局文档，但保留已发布正文供整理器保留无关事实。使用反馈存储失败不会使已完成的回答失败，宿主可通过 `MemoryPluginOptions.onFeedbackError` 观察。

用户明确要求记住、纠正或忘记时，插件追加 note。纠正和未指定会话的忘记会隐藏旧摘要，直到重生成时应用相关维护要求；仅完成全局整理不会让未经纠正的摘要恢复可读。指定会话的忘记会撤销该来源。原始 JSONL 保留历史，工具读取时附带后续维护要求。待处理的 remember 保留已有有效记忆。

维护记录保留程序生成的独立时间；它只修改已有对应事实，不成为原始会话事件，也不把其他主题的事实引入该摘要。摘要和 description 使用该会话用户的语言。

维护记录较多时，原文工具附带程序生成的 `memory-notes:<conversationId>` 引用，通过既有 `memory_read` 按行范围读取。在把历史事实当作当前偏好前，先核对维护条件。该引用是保留笔记的虚拟视图，不增加第三类持久记忆文件。

宿主可实现 `MemoryBinding.operationId(callId)`，从持久化 assistant 批次得到 `tool:<conversation-id>:<batch-entry-id>:<tool-call-id>`。笔记和发信共用这个重试身份。模型只提供发送目标和正文，消息 ID 由后端生成并持久保存；同一调用重放返回原回执，新的调用允许再次发送相同正文。没有持久化操作身份时，工具不声明安全重试。

`conversation_list` 独立列出同用户的全部会话，包括空会话和未摘要会话，支持标题过滤和稳定分页；页面先按字节预算确定实际返回项，再推进游标。原文检索先过滤授权范围再排序，并支持不伪造 JSONL 行号的标题命中。全局整理模型只提供语义 Markdown，程序根据真实摘要元数据添加版本标记和相对路径目录。

记忆插件在 `beforeModel` 向独立的请求上下文插件设置贡献。适配器先让现有 Session 保存纯消息，再把临时投影交给现有 Model；记忆不会写入 Session 原始历史。重试恢复原始输入并重新读取当前记忆，不承诺临时上下文与上次完全相同。Core、Model、Session 的既有实现保持不变。

## 验证范围与限制

插件验证文档结构、准确摘要引用、输入边界、owner 隔离引用、租约、失败退避和已持久化来源版本。已知的缺失/撤销引用和语义输入错误会返回稳定的 `MEMORY_UNAVAILABLE` 或 `MEMORY_INPUT_INVALID` 工具结果，让模型能修正调用并正常闭合工具批次。意外的存储/I/O 异常仍会使工具调用失败，交由宿主恢复。这些检查保证数据血缘与工作流边界，不代表模型摘要在语义上完整，也不代表记忆事实仍然有效。宿主应提供明确的记忆查看/忘记入口，并用代表性对话评估模型行为。

提示词与证据优先级算法派生自 [`openai/codex`](https://github.com/openai/codex/tree/806d9732c974bc8a51b8317c1bd8985544fe627c)，采用 Apache-2.0。来源与改动说明见 [LICENSE](LICENSE) 和 [NOTICE](NOTICE)。
