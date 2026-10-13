import assert from 'node:assert/strict'
import * as memory from '@quifox/agent-plugin-memory'

assert.equal(typeof memory.MemoryPlugin, 'function')
assert.equal(typeof memory.MemoryProcessor, 'function')
assert.equal(typeof memory.MemoryService, 'function')
assert.equal(typeof memory.MemoryInputError, 'function')
assert.equal(typeof memory.MemoryUnavailableError, 'function')
assert.equal(typeof memory.selectMemoryEvidence, 'function')
assert.equal(memory.emptyMemoryState().notes.length, 0)
assert.equal(memory.conversationMemoryPath({
    id: 'conversation', ownerId: 'owner', shortId: 'short-id', title: 'Existing title', createdAt: '2026-10-01T00:00:00.000Z',
    updatedAt: '2026-10-02T00:00:00.000Z', sourceRef: 'source', revision: 1, active: false, generateMemory: true
}), 'conversations/2026-10-01T00-00-00Z-short-id.md')
await assert.rejects(import('@quifox/agent-plugin-memory/internal'), error =>
    ['ERR_PACKAGE_PATH_NOT_EXPORTED', 'ERR_MODULE_NOT_FOUND'].includes(error.code))
