# @quifox/agent-plugin-session

English | [简体中文](README.zh-CN.md)

Chat sessions and Conversation composition with the model plugin. The protocol-neutral Conversation capability has no message-array requirement. Session owns messages, checkpoints, and storage; Core owns the loop.

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
await agent.run({ prompt: 'First turn' })
await agent.run({ prompt: 'Continue' })
const child = await conversation.fork({ id: 'chat-b' })
const childAgent = createAgent({ plugins: [child] })
await childAgent.run({ prompt: 'Independent branch task' })
```

A composed fork returns rebound Session and generation objects. Ordinary fork requires a closed/idle state. boundary: 'before-tools' captures the complete prefix before the current Tool batch; empty() starts with no history. Parent storage and current cancellation callbacks are not inherited by default.

Generation prepares the request in beforeStep; later plugins can modify it in beforeModel. Place result transformations before the composition when Session should record them. onRunStart consumers of the current capability follow the composition. Core does not sort the array.

Supply the protocol adapter through compaction: (session, generation) => new ChatCompactionSource(session, generation), then explicitly register CompactionPlugin. Model configuration supplies contextWindow/maxOutputTokens. The default estimate uses complete JSON UTF-8 bytes conservatively; a vendor tokenizer can replace it.

Recovery needs matching Session and ExecutionCheckpoint snapshots. Once the original stream stops, fork both for resume and create a new Agent. The default combination explicitly registers Interrupt: unknown-result calls retry only with policy.retrySafe: true; otherwise confirm the result through both owners. Completed Tools are not repeated.

Retrying the same original input reuses the final prepared messages. shouldPrepareInput lets coordinating plugins skip frozen input. Snapshots validate id/ownerId; completePendingTools accepts verified receipts without executing operations. Current-request mutation is not unrestricted rewriting of stored history.

See the [contract](docs/specs/architecture.md) and [model plugin](../agent-plugin-model/README.md). Optional storage and additional plugins are caller supplied.
