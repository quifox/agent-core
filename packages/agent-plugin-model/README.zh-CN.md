# @quifox/agent-plugin-model

[English](README.md) | 简体中文

通过 Agent 钩子提供模型生成。调用方直接配置模型插件；协议客户端、HTTP/SSE 解析与供应商字段映射留在包内部。

下面的 Chat 对话只是插件组合的一种实现示例。开发者可以自行实现和组合插件，构建更丰富的能力与不同的 Agent 行为。

```js
import { createAgent } from '@quifox/agent-core'
import { ChatModelPlugin } from '@quifox/agent-plugin-model'
import { ChatSessionPlugin, ChatConversationPlugin } from '@quifox/agent-plugin-session'

const session = new ChatSessionPlugin({ id: 'example', ownerId: 'example' })
const generation = new ChatModelPlugin({
    session,
    model: 'deepseek-flash',
    baseUrl: 'https://api.deepseek.com',
    apiKey: process.env.DEEPSEEK_API_KEY,
    assistantReasoningField: 'reasoning_content'
})
const conversation = new ChatConversationPlugin({ session, generation })
const agent = createAgent({ plugins: [conversation] })
const outcome = await agent.run({ prompt: 'Reply with exactly "Hello World".' })
if (!outcome.ok) { throw outcome.error }
console.log(conversation.readOutput())
```

环境由宿主提供。示例发送真实的 Chat Completions 请求；重复调用同一个 Agent 时，Session 保留历史。

ChatModelPlugin 提供 onInitialize、onRunStart、beforeStep、model 钩子。它准备可供 beforeModel 协作插件修改的请求，并在发送前通过 Session 保存最终输入。summarize 生成隔离摘要；fork 绑定子 Session，并去除父运行的取消回调。

可选配置包括 settings、contextWindow、maxInputTokens、signal、逐次计算的请求头与 HttpTransport。FetchHttpTransport 使用宿主 Fetch；/weapp 入口的 WeappHttpTransport 接收宿主请求适配器。服务要求回传 assistant 推理内容时，通过 assistantReasoningField 选择 reasoning_content 或 reasoning；省略时保留标准 Chat 消息投影。

开发者可以直接实现自己的 model Hook。Core 不要求协议工厂或统一的底层模型客户端接口。

参见[插件合同](docs/specs/architecture.md)与[内部协议行为](docs/specs/protocols.md)。
