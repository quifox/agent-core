# @quifox/agent-plugin-session

[English](README.md) | 简体中文

会话/模型组合插件。协议无关的 Conversation 能力没有消息列表；具体 Chat 组件保留消息、检查点和存储，Core 仍只负责循环。

```ts
import { createAgent } from '@quifox/agent-core'
import { ChatModelPlugin } from '@quifox/agent-plugin-model'
import { ChatSessionPlugin, ChatConversationPlugin } from '@quifox/agent-plugin-session'

const apiKey = process.env.DEEPSEEK_API_KEY
if (!apiKey) { throw new Error('Missing DEEPSEEK_API_KEY') }
const memory = new ChatSessionPlugin({ id: 'chat-a', ownerId: 'user-a' })
const generation = new ChatModelPlugin({ session: memory,
    model: 'deepseek-flash', baseUrl: 'https://api.deepseek.com', apiKey, assistantReasoningField: 'reasoning_content' })
const conversation = new ChatConversationPlugin({ session: memory, generation })
const agent = createAgent({ plugins: [conversation] })
await agent.run({ prompt: '第一轮' })
await agent.run({ prompt: '继续' })
const child = await conversation.fork({ id: 'chat-b' })
const childAgent = createAgent({ plugins: [child] })
await childAgent.run({ prompt: '独立分支任务' })
```

组合 Fork 返回重绑后的新会话与生成组件。普通 Fork 要求闭合/空闲；工具中使用 `boundary: 'before-tools'` 取得本批次之前的完整前缀。`empty()` 创建空历史。父存储及当前取消回调不默认继承。

生成组件在 `beforeStep` 准备请求，其他插件在 `beforeModel` 改写。示例把结果改写插件放在组合前，使 Session 保存改写后的 assistant / tool 结果；需要读取本轮 Context 能力的 `onRunStart` 则应放在组合之后。数组顺序由调用方决定，Core 不自动排序。

压缩由 `compaction: (session, generation) => new ChatCompactionSource(session, generation)` 注入协议适配器，外部再注册 `new CompactionPlugin()`。生成配置需提供 contextWindow 和 maxOutputTokens；估算器默认按完整 JSON 的 UTF-8 字节保守估算，可替换为供应商 tokenizer。

本轮恢复需同时保存对应 Session 与 ExecutionCheckpointPlugin 快照。父流停止后，`conversation.fork({boundary:'resume'})` 与 `checkpoint.fork()` 装配新 Agent，调用 `run({resume:true})`。默认组合显式注册 InterruptPlugin：结果未知的调用仅在工具声明 `policy.retrySafe: true` 时重试，否则先用 `conversation.confirmTool` 和 `checkpoint.confirm` 接纳核实结果。不会重复已完成工具；恢复策略不进入 Core。

失败后使用相同原始输入重试时复用最终准备消息。`shouldPrepareInput()` 可让 环境准备等协调插件跳过已冻结输入；Core 和本插件不要求消息 ID 或输入来源枚举。

快照按 id/ownerId 验证；completePendingTools 只接纳已经核实的回执，不执行业务操作。ChatSessionHistory 保留追加记录与压缩检查点，不能把当前请求改写当成随意覆盖已有权威历史。

规范：[架构](docs/specs/architecture.md)。
