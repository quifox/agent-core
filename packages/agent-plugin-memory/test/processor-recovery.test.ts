import { expect, it } from 'vitest'
import { chatModelOptions } from '../../../test/support/chat-model.mjs'
import { MemoryProcessor, MemoryService, emptyMemoryState, type ConversationArchive, type MemoryConversation, type MemoryPolicy, type MemoryRecord, type MemoryState, type MemoryStore } from '../src/index.js'

const NOW = Date.parse('2026-10-03T00:00:00Z')
const VALID_GLOBAL = "v1\n\n## User Profile\n\n## User preferences\n\n## General Tips\n\n## What's in Memory\n"
const EMPTY_FINGERPRINT = JSON.stringify({ summaries: [], notes: [], revoked: [] })

interface HarnessOptions {
    initialState?: MemoryState
    conversation?: MemoryConversation
    records?: MemoryRecord[]
    answer: string | Error
    policy?: Partial<MemoryPolicy>
}

function extractionHarness(options: HarnessOptions) {
    let state = structuredClone(options.initialState ?? emptyMemoryState())
    state.global ||= VALID_GLOBAL
    state.consolidatedFingerprint ||= EMPTY_FINGERPRINT
    const conversation = options.conversation ?? {
        id: 'conversation-a', ownerId: 'owner-a', shortId: 'short-a', title: 'A conversation',
        createdAt: '2026-10-01T00:00:00Z', updatedAt: '2026-10-02T00:00:00Z', sourceRef: 'source-a',
        revision: 2, active: false, generateMemory: true
    }
    const store: MemoryStore = {
        async load(ownerId) { expect(ownerId).toBe('owner-a'); return structuredClone(state) },
        async compareAndSet(ownerId, revision, next) {
            expect(ownerId).toBe('owner-a')
            if (revision !== state.revision) { return false }
            state = structuredClone(next)
            return true
        }
    }
    const records = options.records ?? [{ id: 'human-1', line: 1, origin: 'human' as const,
        message: { role: 'user' as const, content: 'A supported source fact.' } }]
    const archive: ConversationArchive = {
        async list(ownerId) { expect(ownerId).toBe('owner-a'); return [conversation] },
        async records(ownerId, ref) { expect(ownerId).toBe('owner-a'); expect(ref).toBe(conversation.sourceRef); return records },
        async read() { throw new Error('not used by extraction tests') },
        async search() { return [] },
        async send() { throw new Error('not used by extraction tests') }
    }
    let sequence = 0
    const processor = new MemoryProcessor({ store, archive, newId: () => `job-${++sequence}`, now: () => NOW,
        policy: { minIdleMs: 0, maxSummaries: 0, ...options.policy },
        model: chatModelOptions({ provider: 'test', modelId: 'test', async *stream() {
            if (options.answer instanceof Error) { throw options.answer }
            yield { type: 'text-delta', delta: options.answer }
            yield { type: 'finish', reason: 'stop' }
        } })
    })
    return { processor, conversation, state: () => state }
}

it('preserves the last published summary and watermark when extraction fails', async () => {
    const previous = {
        conversationId: 'conversation-a', path: 'conversations/2026-10-01T00-00-00Z-short-a.md', title: 'Previous title',
        description: 'Previous description', summary: 'Previous supported summary.', sourceRef: 'source-a',
        sourceUpdatedAt: '2026-10-01T00:00:00Z', sourceRevision: 1, generatedAt: '2026-10-01T01:00:00Z', usageCount: 4
    }
    const initial = emptyMemoryState()
    initial.global = VALID_GLOBAL
    initial.summaries['conversation-a'] = previous
    const harness = extractionHarness({ initialState: initial, answer: new Error('synthetic model failure') })

    await expect(harness.processor.run('owner-a')).resolves.toMatchObject({ extracted: 0, consolidated: false, errors: ['extraction_failed'] })
    expect(harness.state().summaries['conversation-a']).toEqual(previous)
    expect(harness.state().jobs['conversation-a']).toMatchObject({ watermark: 0, retryAt: NOW + 3_600_000, error: 'extraction_failed' })
})

it('reclaims an expired lease with a new token before publishing the revised source', async () => {
    const initial = emptyMemoryState()
    initial.jobs['conversation-a'] = { token: 'expired-token', expiresAt: NOW - 1, retryAt: 0, watermark: 1 }
    const harness = extractionHarness({ initialState: initial, answer: JSON.stringify({ description: 'New description', summary: 'New summary.' }) })

    await expect(harness.processor.run('owner-a')).resolves.toMatchObject({ extracted: 1, consolidated: false, errors: [] })
    expect(harness.state().jobs['conversation-a']).toMatchObject({ token: 'job-1', watermark: 2, expiresAt: 0 })
    expect(harness.state().summaries['conversation-a']).toMatchObject({ sourceRevision: 2, summary: 'New summary.' })
})

it('rejects a schema-breaking model response without advancing its source watermark', async () => {
    const harness = extractionHarness({ answer: JSON.stringify({
        description: 'Candidate', summary: 'Unaccepted candidate.', confidence: 'high'
    }) })

    await expect(harness.processor.run('owner-a')).resolves.toMatchObject({ extracted: 0, errors: ['extraction_failed'] })
    expect(harness.state().summaries['conversation-a']).toBeUndefined()
    expect(harness.state().jobs['conversation-a']).toMatchObject({ watermark: 0, expiresAt: 0,
        retryAt: NOW + 3_600_000, error: 'extraction_failed' })
})

it('advances the source watermark and removes an obsolete summary when extraction has no useful output', async () => {
    const initial = emptyMemoryState()
    initial.summaries['conversation-a'] = {
        conversationId: 'conversation-a', path: 'conversations/2026-10-01T00-00-00Z-short-a.md', title: 'Old title',
        description: 'Old description', summary: 'Old summary.', sourceRef: 'source-a', sourceUpdatedAt: '2026-10-01T00:00:00Z',
        sourceRevision: 1, generatedAt: '2026-10-01T01:00:00Z', usageCount: 0
    }
    initial.jobs['conversation-a'] = { token: 'old-job', expiresAt: NOW - 1, retryAt: 0, watermark: 1 }
    const harness = extractionHarness({ initialState: initial, answer: JSON.stringify({ description: '', summary: '' }) })

    await expect(harness.processor.run('owner-a')).resolves.toMatchObject({ extracted: 1, consolidated: false, errors: [] })
    expect(harness.state().summaries['conversation-a']).toBeUndefined()
    expect(harness.state().jobs['conversation-a']).toMatchObject({ watermark: 2, expiresAt: 0, retryAt: 0 })
})

it('regenerates an unchanged source after a forget and applies maintenance notes before making its summary visible', async () => {
    const initial = emptyMemoryState()
    initial.notes.push({ id: 'forget', kind: 'forget', content: 'Forget OLD_SETTING. Retain the deadline.', createdAt: '2026-10-02T12:00:00Z' })
    initial.jobs['conversation-a'] = { token: 'previous', watermark: 2, expiresAt: 0, retryAt: 0 }
    let state = initial; let input = ''
    const conversation: MemoryConversation = { id: 'conversation-a', ownerId: 'owner-a', shortId: 'a', title: 'Source', createdAt: '2026-10-01T00:00:00Z',
        updatedAt: '2026-10-02T00:00:00Z', sourceRef: 'source-a', revision: 2, active: false, generateMemory: true }
    const store: MemoryStore = { async load() { return structuredClone(state) }, async compareAndSet(_owner, revision, next) {
        if (revision !== state.revision) { return false }; state = structuredClone(next); return true
    } }
    const archive: ConversationArchive = { async list() { return [conversation] }, async records() {
        return [{ id: 'm1', line: 1, origin: 'human', message: { role: 'user', content: 'OLD_SETTING. The deadline is Friday.' } }]
    }, async read() { throw new Error('unused') }, async search() { return [] }, async send() { throw new Error('unused') } }
    const processor = new MemoryProcessor({ store, archive, newId: () => 'job', now: () => NOW,
        model: chatModelOptions({ provider: 'test', modelId: 'test', async *stream(request) {
            if (!request.tools.length) {
                input = JSON.stringify(request.messages)
                yield { type: 'text-delta', delta: JSON.stringify({ description: 'Deadline', summary: 'The deadline is Friday.' }) }
                yield { type: 'finish', reason: 'stop' }
            } else if (request.messages.at(-1)?.role !== 'tool') {
                yield { type: 'tool-call', call: { id: 'publish', name: 'memory_publish', input: { content: VALID_GLOBAL } } }
                yield { type: 'finish', reason: 'tool-calls' }
            } else { yield { type: 'finish', reason: 'stop' } }
        } }) })
    expect(await processor.run('owner-a')).toMatchObject({ extracted: 1, consolidated: true })
    expect(input).toContain('Forget OLD_SETTING. Retain the deadline.')
    expect(state.summaries['conversation-a']).toMatchObject({ noteWatermark: 1, summary: 'The deadline is Friday.' })
    expect(await new MemoryService(store, archive, () => 'unused').list('owner-a')).toHaveLength(1)
})

it('releases its stale extraction lease when a correction arrives during generation', async () => {
    let state = emptyMemoryState(); let correctDuringExtraction = true
    const conversation: MemoryConversation = { id: 'a', ownerId: 'u', shortId: 'a', title: 'Source', createdAt: '2026-10-01T00:00:00Z',
        updatedAt: '2026-10-02T00:00:00Z', sourceRef: 'source-a', revision: 1, active: false, generateMemory: true }
    const store: MemoryStore = { async load() { return structuredClone(state) }, async compareAndSet(_owner, revision, next) {
        if (revision !== state.revision) { return false }; state = structuredClone(next); return true
    } }
    const archive: ConversationArchive = { async list() { return [conversation] }, async records() {
        return [{ id: 'm1', line: 1, origin: 'human', message: { role: 'user', content: 'Original source.' } }]
    }, async read() { throw new Error('unused') }, async search() { return [] }, async send() { throw new Error('unused') } }
    const service = new MemoryService(store, archive, () => 'correction')
    const processor = new MemoryProcessor({ store, archive, newId: () => 'job', now: () => NOW,
        model: chatModelOptions({ provider: 'test', modelId: 'test', async *stream(request) {
            if (!request.tools.length) {
                if (correctDuringExtraction) { correctDuringExtraction = false; await service.note('u', { kind: 'correct', content: 'Use the corrected setting.' }) }
                yield { type: 'text-delta', delta: JSON.stringify({ description: 'Current setting', summary: 'Corrected setting.' }) }
                yield { type: 'finish', reason: 'stop' }
            } else if (request.messages.at(-1)?.role !== 'tool') {
                yield { type: 'tool-call', call: { id: 'publish', name: 'memory_publish', input: { content: VALID_GLOBAL } } }
                yield { type: 'finish', reason: 'tool-calls' }
            } else { yield { type: 'finish', reason: 'stop' } }
        } }) })
    expect((await processor.run('u')).extracted).toBe(0)
    expect(state.jobs.a).toMatchObject({ expiresAt: 0, retryAt: 0 })
    expect((await processor.run('u')).extracted).toBe(1)
})
