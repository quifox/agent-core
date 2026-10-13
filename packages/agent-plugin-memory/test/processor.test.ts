import { expect, it } from 'vitest'
import { chatModelOptions } from '../../../test/support/chat-model.mjs'
import { MemoryProcessor, emptyMemoryState, type MemoryState, type MemoryStore, type ConversationArchive, type MemoryConversation } from '../src/index.js'

it('extracts summary and description once, consolidates through real Core tools, then skips unchanged sources', async () => {
    let state = emptyMemoryState(); let calls = 0; let published = false; let sequence = 0
    const store: MemoryStore = { async load() { return structuredClone(state) }, async compareAndSet(_owner, revision, next) {
        if (revision !== state.revision) { return false }; state = structuredClone(next); return true
    } }
    const conversation: MemoryConversation = { id: 'a', ownerId: 'u', shortId: 'abc', title: 'Existing title', createdAt: '2026-10-01T00:00:00Z',
        updatedAt: '2026-10-02T00:00:00Z', sourceRef: 'source-a', revision: 1, active: false, generateMemory: true }
    const archive: ConversationArchive = { async list() { return [conversation] }, async records() {
        return [{ id: 'm1', line: 1, origin: 'human', message: { role: 'user', content: 'Always make daily study plans concise.' } }]
    }, async read() { throw new Error('not needed') }, async search() { return [] }, async send() { throw new Error('worker cannot send') } }
    const global = "v1\n\n## User Profile\n\n## User preferences\nDaily study plans: concise.\n\n## General Tips\n\n## What's in Memory\n"
    const processor = new MemoryProcessor({ store, archive, newId: () => `job-${++sequence}`, now: () => Date.parse('2026-10-03T00:00:00Z'),
        model: chatModelOptions({ provider: 'test', modelId: 'test', async *stream(request) {
            calls += 1
            if (request.tools.length === 0) {
                yield { type: 'text-delta', delta: JSON.stringify({ description: 'Daily study plan preference', summary: 'The user explicitly prefers concise daily study plans. Source: m1.' }) }
                yield { type: 'finish', reason: 'stop' }
            } else if (!published) {
                published = true; yield { type: 'tool-call', call: { id: 'publish', name: 'memory_publish', input: { content: global } } }
                yield { type: 'finish', reason: 'tool-calls' }
            } else { yield { type: 'finish', reason: 'stop' } }
        } }) })
    expect(await processor.run('u')).toMatchObject({ extracted: 1, consolidated: true, errors: [] })
    expect(state.summaries.a).toMatchObject({ title: 'Existing title', sourceRef: 'source-a', sourceRevision: 1 })
    expect(state.global).toContain('Daily study plans: concise.')
    expect(state.global).toContain('conversations/2026-10-01T00-00-00Z-abc.md — Existing title: Daily study plan preference')
    const previousCalls = calls
    expect(await processor.run('u')).toMatchObject({ extracted: 0, consolidated: false, errors: [] })
    expect(calls).toBe(previousCalls)
    expect((state as MemoryState).jobs.a?.watermark).toBe(1)
})

it('regenerates a revised conversation from its original records and only then advances the source watermark', async () => {
    let state = emptyMemoryState()
    const now = Date.parse('2026-10-03T00:00:00Z')
    const global = "v1\n\n## User Profile\n\n## User preferences\n\n## General Tips\n\n## What's in Memory\n"
    state.global = global
    state.consolidatedFingerprint = JSON.stringify({ summaries: [], notes: [], revoked: [] })
    state.jobs.a = { token: 'previous-job', expiresAt: now - 1, retryAt: 0, watermark: 1 }
    state.summaries.a = {
        conversationId: 'a', path: 'conversations/2026-10-01T00-00-00Z-abc.md', title: 'Old title',
        description: 'Old description', summary: 'Old summary', sourceRef: 'source-a', sourceUpdatedAt: '2026-10-01T00:00:00Z',
        sourceRevision: 1, generatedAt: '2026-10-01T01:00:00Z', usageCount: 3, lastUsedAt: '2026-10-02T00:00:00Z'
    }
    const conversation: MemoryConversation = { id: 'a', ownerId: 'u', shortId: 'abc', title: 'Updated title',
        createdAt: '2026-10-01T00:00:00Z', updatedAt: '2026-10-02T00:00:00Z', sourceRef: 'source-a', revision: 2,
        active: false, generateMemory: true }
    const originalRecords = [
        { id: 'm1', line: 1, origin: 'human' as const, message: { role: 'user' as const, content: 'original task condition' } },
        { id: 'm2', line: 2, origin: 'human' as const, message: { role: 'user' as const, content: 'later correction in the same source' } }
    ]
    const archive: ConversationArchive = {
        async list(ownerId) { expect(ownerId).toBe('u'); return [conversation] },
        async records(ownerId, ref) { expect(ownerId).toBe('u'); expect(ref).toBe('source-a'); return originalRecords },
        async read() { throw new Error('not needed') }, async search() { return [] }, async send() { throw new Error('not needed') }
    }
    const store: MemoryStore = { async load() { return structuredClone(state) }, async compareAndSet(_owner, revision, next) {
        if (revision !== state.revision) { return false }; state = structuredClone(next); return true
    } }
    let extractionInput = ''
    const processor = new MemoryProcessor({ store, archive, newId: () => 'replacement-job', now: () => now,
        policy: { minIdleMs: 0, maxSummaries: 0 },
        model: chatModelOptions({ provider: 'test', modelId: 'test', async *stream(request) {
            extractionInput = JSON.stringify(request.messages)
            yield { type: 'text-delta', delta: JSON.stringify({ description: 'Revised conversation description', summary: 'Revised full-source summary.' }) }
            yield { type: 'finish', reason: 'stop' }
        } })
    })

    await expect(processor.run('u')).resolves.toMatchObject({ extracted: 1, consolidated: false, errors: [] })
    expect(extractionInput).toContain('original task condition')
    expect(extractionInput).toContain('later correction in the same source')
    expect(state.summaries.a).toMatchObject({ title: 'Updated title', description: 'Revised conversation description',
        summary: 'Revised full-source summary.', sourceRevision: 2, usageCount: 3 })
    expect(state.jobs.a).toMatchObject({ watermark: 2, expiresAt: 0, retryAt: 0 })
})
