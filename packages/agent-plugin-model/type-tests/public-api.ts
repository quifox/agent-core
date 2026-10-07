import { ChatModelPlugin, type ChatSessionSource } from '../src/index.js'

const session: ChatSessionSource = { messages: [], pendingToolCalls: [], async acceptRequest(messages) { return [...messages] } }
const plugin = new ChatModelPlugin({ session, model: 'configured-model', baseUrl: 'https://example.test' })
// @ts-expect-error A model plugin accepts configuration, not a low-level client.
new ChatModelPlugin({ session, model: { stream() {} }, baseUrl: 'https://example.test' })
// @ts-expect-error The protocol client is not a public plugin capability.
plugin.model
void plugin
