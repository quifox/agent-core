# @quifox/agent-plugin-model

English | [简体中文](README.zh-CN.md)

Model generation through Agent Hooks. Configure the model plugin directly; its protocol client, HTTP/SSE parsing, and vendor field mapping stay inside the package.

The following Chat conversation is one example of plugin composition. You can implement and combine plugins to create richer capabilities and different agent behaviors.

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

The Host supplies the environment. The example sends a real Chat Completions request. Repeated calls on the same Agent retain history through Session.

ChatModelPlugin contributes onInitialize, onRunStart, beforeStep, and model Hooks. It prepares a mutable request for beforeModel collaborators and persists the final input through Session before sending. summarize generates an isolated summary; fork binds a child Session and drops the parent cancellation callback.

Optional configuration includes settings, contextWindow, maxInputTokens, signal, per-request headers, and HttpTransport. FetchHttpTransport uses the Host's Fetch API; WeappHttpTransport from the /weapp entry accepts a Host request adapter. Set assistantReasoningField to reasoning_content or reasoning when the service requires assistant reasoning to be replayed. Omission preserves standard Chat message projection.

Developers can implement their own model Hook directly. Core does not require a protocol factory or a shared model-client interface.

See the [plugin contract](docs/specs/architecture.md) and [internal protocol behavior](docs/specs/protocols.md).
