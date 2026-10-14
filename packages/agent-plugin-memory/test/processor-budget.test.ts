import { expect, it } from 'vitest'
import { chatModelOptions } from '../../../test/support/chat-model.mjs'
import { MemoryProcessor, emptyMemoryState, utf8Bytes, type ConversationArchive, type MemoryStore } from '../src/index.js'

it('does not send a consolidation request that exceeds the configured model input capacity', async () => {
    let state = emptyMemoryState(); state.global = 'Previously published memory.'
    const store: MemoryStore = { async load() { return structuredClone(state) }, async compareAndSet(_owner, revision, next) {
        if (revision !== state.revision) { return false }; state = structuredClone(next); return true
    } }
    const archive: ConversationArchive = { async list() { return [] }, async records() { return [] },
        async read() { throw new Error('unused') }, async search() { return [] }, async send() { throw new Error('unused') } }
    let calls = 0
    const processor = new MemoryProcessor({ store, archive, newId: () => 'budget-job',
        model: { ...chatModelOptions({ provider: 'test', modelId: 'small-model', async *stream() {
            calls += 1; yield { type: 'finish', reason: 'stop' }
        } }), maxInputTokens: 1_024, contextWindow: 2_048, settings: { maxOutputTokens: 256 } } })
    expect(await processor.run('owner')).toMatchObject({ consolidated: false, errors: ['consolidation_input_budget_exceeded'] })
    expect(calls).toBe(0)
    expect(state.global).toBe('Previously published memory.')
})

it('checks accumulated tool results against the model limit before every worker request', async () => {
    const now = Date.parse('2026-10-03T00:00:00Z')
    const conversation = { id: 'source', ownerId: 'owner', shortId: 'short', title: 'Source', createdAt: '2026-10-01T00:00:00Z',
        updatedAt: '2026-10-02T00:00:00Z', sourceRef: 'source-ref', revision: 1, active: false, generateMemory: true }
    let state = emptyMemoryState(); state.global = 'Previously published memory.'
    state.jobs.source = { token: 'old', expiresAt: 0, retryAt: 0, watermark: 1 }
    state.summaries.source = { conversationId: 'source', path: 'conversations/source.md', title: 'Source', description: 'Source description',
        summary: 'x'.repeat(9_000), sourceRef: 'source-ref', sourceUpdatedAt: conversation.updatedAt, sourceRevision: 1,
        generatedAt: conversation.updatedAt, usageCount: 0 }
    const store: MemoryStore = { async load() { return structuredClone(state) }, async compareAndSet(_owner, revision, next) {
        if (revision !== state.revision) { return false }; state = structuredClone(next); return true
    } }
    const archive: ConversationArchive = { async list() { return [conversation] }, async records() { return [] },
        async read() { throw new Error('unused') }, async search() { return [] }, async send() { throw new Error('unused') } }
    let calls = 0
    const processor = new MemoryProcessor({ store, archive, newId: () => 'budget-job', now: () => now,
        model: { ...chatModelOptions({ provider: 'test', modelId: 'bounded-model', async *stream() {
            calls += 1
            if (calls === 1) {
                yield { type: 'tool-call', call: { id: 'read', name: 'memory_read', input: { path: 'conversations/source.md' } } }
                yield { type: 'finish', reason: 'tool-calls' }
            } else { yield { type: 'finish', reason: 'stop' } }
        } }), maxInputTokens: 12_000, contextWindow: 13_000, settings: { maxOutputTokens: 256 } } })
    expect(await processor.run('owner')).toMatchObject({ consolidated: false, errors: ['consolidation_input_budget_exceeded'] })
    expect(calls).toBe(1)
    expect(state.global).toBe('Previously published memory.')
})

it('shrinks extraction evidence while reserving output space and retaining the latest human input', async () => {
    const now = Date.parse('2026-10-03T00:00:00Z')
    const source = { id: 'source', ownerId: 'owner', shortId: 'short', title: 'Source', createdAt: '2026-10-01T00:00:00Z',
        updatedAt: '2026-10-02T00:00:00Z', sourceRef: 'source-ref', revision: 1, active: false, generateMemory: true }
    let state = emptyMemoryState()
    const store: MemoryStore = { async load() { return structuredClone(state) }, async compareAndSet(_owner, revision, next) {
        if (revision !== state.revision) { return false }; state = structuredClone(next); return true
    } }
    const archive: ConversationArchive = { async list() { return [source] }, async records() { return [
        { id: 'old', line: 1, origin: 'human', message: { role: 'user', content: 'old '.repeat(20_000) } },
        { id: 'new', line: 2, origin: 'human', message: { role: 'user', content: 'LATEST_HUMAN_PREFERENCE' } }
    ] }, async read() { throw new Error('unused') }, async search() { return [] }, async send() { throw new Error('unused') } }
    let observed = ''
    const model = chatModelOptions({ provider: 'test', modelId: 'bounded-model', async *stream(request) {
        if (!observed) { observed = JSON.stringify(request.messages) }
        yield { type: 'text-delta', delta: JSON.stringify({ description: 'Latest preference', summary: 'Latest preference retained.' }) }
        yield { type: 'finish', reason: 'stop' }
    } })
    const transport = model.transport!
    const processor = new MemoryProcessor({ store, archive, newId: () => 'budget-job', now: () => now,
        model: { ...model, contextWindow: 8_000, settings: { maxOutputTokens: 2_000 }, transport: {
            async stream(request) { expect(utf8Bytes(request.body!)).toBeLessThan(6_000); return transport.stream(request) }
        } } })
    const result = await processor.run('owner')
    expect(result.extracted).toBe(1)
    expect(observed).toContain('LATEST_HUMAN_PREFERENCE')
    expect(state.jobs.source?.watermark).toBe(1)
})
