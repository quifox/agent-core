import { expect, it } from 'vitest'
import { chatModelOptions } from '../../../test/support/chat-model.mjs'
import { MemoryProcessor, MemoryService, emptyMemoryState, type MemoryStore, type ConversationArchive } from '../src/index.js'

it('keeps recent unselected summaries readable and reselects them without new source messages', async () => {
    let state = emptyMemoryState(); let extractions = 0; let sequence = 0
    const sources = ['a', 'b'].map(id => ({ id, ownerId: 'u', shortId: id, title: id, createdAt: '2026-10-01T00:00:00Z',
        updatedAt: '2026-10-02T00:00:00Z', sourceRef: `source-${id}`, revision: 1, active: false, generateMemory: true }))
    const store: MemoryStore = { async load() { return structuredClone(state) }, async compareAndSet(_owner, revision, next) {
        if (state.revision !== revision) { return false }; state = structuredClone(next); return true
    } }
    const archive: ConversationArchive = { async list() { return sources }, async records(_owner, ref) {
        return [{ id: 'm1', line: 1, origin: 'human', message: { role: 'user', content: `Useful context from ${ref}` } }]
    }, async read() { throw new Error('unused') }, async search() { return [] }, async send() { throw new Error('unused') } }
    const processor = new MemoryProcessor({ store, archive, newId: () => `job-${++sequence}`, now: () => Date.parse('2026-10-03T00:00:00Z'),
        policy: { maxSummaries: 1 }, model: chatModelOptions({ provider: 'test', modelId: 'test', async *stream(request) {
            if (!request.tools.length) {
                extractions += 1
                yield { type: 'text-delta', delta: JSON.stringify({ description: 'Useful context', summary: 'Useful context.' }) }
                yield { type: 'finish', reason: 'stop' }
            } else if (!request.messages.some(message => message.role === 'tool' && message.toolName === 'memory_publish')) {
                yield { type: 'tool-call', call: { id: 'publish', name: 'memory_publish', input: {
                    content: '## User Profile\n\n## User preferences\n\n## General Tips\n'
                } } }
                yield { type: 'finish', reason: 'tool-calls' }
            } else { yield { type: 'finish', reason: 'stop' } }
        } }) })
    const service = new MemoryService(store, archive, () => 'note')

    expect(await processor.run('u')).toMatchObject({ extracted: 2, consolidated: true, errors: [] })
    const path = 'conversations/2026-10-01T00-00-00Z-b.md'
    await expect(service.read('u', path)).resolves.toMatchObject({ ref: path })
    expect(state.global).not.toContain(path)
    sources[0]!.generateMemory = false
    expect(await processor.run('u')).toMatchObject({ extracted: 0, consolidated: true, errors: [] })
    expect(state.global).toContain(path)
    expect(extractions).toBe(2)
})
