import assert from 'node:assert/strict'
import { RequestContextPlugin, ContextualChatConversationPlugin } from '@quifox/agent-plugin-request-context'

assert.equal(typeof RequestContextPlugin, 'function')
assert.equal(typeof ContextualChatConversationPlugin, 'function')
await assert.rejects(import('@quifox/agent-plugin-request-context/internal'), error =>
    ['ERR_PACKAGE_PATH_NOT_EXPORTED', 'ERR_MODULE_NOT_FOUND'].includes(error.code))
