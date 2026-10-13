import { expect, it } from 'vitest'
import { chatModelOptions } from '../../../test/support/chat-model.mjs'
import { MemoryProcessor, emptyMemoryState, type ConversationArchive, type MemoryConversation, type MemoryStore } from '../src/index.js'

it('consolidates a stable older summary while its source awaits the next idle extraction', async () => {
    let state = emptyMemoryState()
    const syntheticCredential = 'sk-' + 'synthetic_credential_for_test'.repeat(2)
    const conversation: MemoryConversation = { id: 'a', ownerId: 'u', shortId: 'a', title: 'A', createdAt: '2026-10-01T00:00:00Z',
        updatedAt: '2026-10-03T00:00:00Z', sourceRef: 'source-a', revision: 2, active: true, generateMemory: true }
    state.summaries.a = { conversationId: 'a', path: 'conversations/a.md', title: syntheticCredential, description: 'Earlier useful context', summary: 'Earlier context.',
        sourceRef: 'source-a', sourceUpdatedAt: '2026-10-02T00:00:00Z', sourceRevision: 1, generatedAt: '2026-10-02T00:00:00Z', usageCount: 0 }
    state.notes.push({ id: 'note', kind: 'remember', content: 'Also remember a new preference.', createdAt: conversation.updatedAt })
    const store: MemoryStore = { async load() { return structuredClone(state) }, async compareAndSet(_owner, revision, next) {
        if (revision !== state.revision) { return false }; state = structuredClone(next); return true
    } }
    const archive: ConversationArchive = { async list() { return [conversation] }, async records() { throw new Error('Active source must not be extracted') },
        async read() { throw new Error('unused') }, async search() { return [] }, async send() { throw new Error('unused') } }
    const processor = new MemoryProcessor({ store, archive, newId: () => 'job', now: () => Date.parse(conversation.updatedAt),
        model: chatModelOptions({ provider: 'test', modelId: 'test', async *stream(request) {
            expect(JSON.stringify(request.messages)).not.toContain(syntheticCredential)
            const last = request.messages.at(-1)
            if (last?.role !== 'tool') {
                yield { type: 'tool-call', call: { id: 'read', name: 'memory_read', input: { path: 'conversations/a.md' } } }
                yield { type: 'finish', reason: 'tool-calls' }
            } else if (last.toolName === 'memory_read') {
                yield { type: 'tool-call', call: { id: 'publish', name: 'memory_publish', input: { content: "v1\n\n## User Profile\n\n## User preferences\nNew preference.\n\n## General Tips\n\n## What's in Memory\n" } } }
                yield { type: 'finish', reason: 'tool-calls' }
            } else { yield { type: 'finish', reason: 'stop' } }
        } }) })
    expect(await processor.run('u')).toMatchObject({ extracted: 0, consolidated: true, errors: [] })
    expect(state.global).toContain('New preference.')
})

it('does not publish a cross-conversation result after one of its source conversations changes', async () => {
    let state = emptyMemoryState()
    const originalGlobal = "v1\n\n## User Profile\n\n## User preferences\n\n## General Tips\n\n## What's in Memory\n"
    state.global = originalGlobal
    const conversation: MemoryConversation = { id: 'conversation-a', ownerId: 'owner-a', shortId: 'short-a', title: 'A conversation',
        createdAt: '2026-10-01T00:00:00Z', updatedAt: '2026-10-02T00:00:00Z', sourceRef: 'source-a', revision: 2,
        active: false, generateMemory: true }
    const store: MemoryStore = { async load(ownerId) {
        expect(ownerId).toBe('owner-a'); return structuredClone(state)
    }, async compareAndSet(ownerId, revision, next) {
        expect(ownerId).toBe('owner-a')
        if (revision !== state.revision) { return false }
        state = structuredClone(next)
        return true
    } }
    const archive: ConversationArchive = {
        async list(ownerId) { expect(ownerId).toBe('owner-a'); return [conversation] },
        async records(ownerId, ref) {
            expect(ownerId).toBe('owner-a'); expect(ref).toBe('source-a')
            return [{ id: 'human-1', line: 1, origin: 'human', message: { role: 'user', content: 'One supported fact.' } }]
        },
        async read() { throw new Error('not needed') }, async search() { return [] }, async send() { throw new Error('not needed') }
    }
    let sequence = 0
    let publishRequested = false
    const candidate = "v1\n\n## User Profile\n\n## User preferences\n\n## General Tips\n\n## What's in Memory\n"
    const processor = new MemoryProcessor({ store, archive, newId: () => `job-${++sequence}`, now: () => Date.parse('2026-10-03T00:00:00Z'),
        model: chatModelOptions({ provider: 'test', modelId: 'test', async *stream(request) {
            if (request.tools.length === 0) {
                yield { type: 'text-delta', delta: JSON.stringify({ description: 'One conversation', summary: 'One supported fact.' }) }
                yield { type: 'finish', reason: 'stop' }
            } else if (!publishRequested) {
                publishRequested = true
                yield { type: 'tool-call', call: { id: 'publish', name: 'memory_publish', input: { content: candidate } } }
                yield { type: 'finish', reason: 'tool-calls' }
            } else {
                conversation.revision = 3
                conversation.updatedAt = '2026-10-03T00:00:00Z'
                yield { type: 'text-delta', delta: 'Candidate prepared.' }
                yield { type: 'finish', reason: 'stop' }
            }
        } })
    })

    await expect(processor.run('owner-a')).resolves.toMatchObject({ extracted: 1, consolidated: false, errors: [] })
    expect(state.global).toBe(originalGlobal)
    expect(state.summaries['conversation-a']).toMatchObject({ sourceRevision: 2 })
    expect(state.consolidation).toMatchObject({ watermark: 0, error: 'stale_consolidation' })
})
