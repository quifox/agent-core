import { expect, it, vi } from 'vitest'
import { chatModelOptions } from '../../../test/support/chat-model.mjs'
import { MemoryProcessor, emptyMemoryState, type MemoryStore, type ConversationArchive } from '../src/index.js'

it('waits for an already started lease renewal before returning its completed Memory pass', async () => {
    vi.useFakeTimers()
    let state = emptyMemoryState(), modelEntered!: () => void, releaseModel!: () => void, renewalEntered!: () => void, releaseRenewal!: () => void
    state.global = "v1\n\n## User Profile\n\n## User preferences\n\n## General Tips\n\n## What's in Memory\n"
    state.consolidatedFingerprint = JSON.stringify({ summaries: [], notes: [], revoked: [] })
    const enteredModel = new Promise<void>(resolve => { modelEntered = resolve }), modelGate = new Promise<void>(resolve => { releaseModel = resolve })
    const enteredRenewal = new Promise<void>(resolve => { renewalEntered = resolve }), renewalGate = new Promise<void>(resolve => { releaseRenewal = resolve })
    const store: MemoryStore = { async load() { return structuredClone(state) }, async compareAndSet(_owner, revision, next) {
        if (revision === 1 && next.jobs.a?.watermark === 0) { renewalEntered(); await renewalGate }
        if (revision !== state.revision) return false
        state = structuredClone(next); return true
    } }
    const archive: ConversationArchive = { async list() { return [{ id: 'a', ownerId: 'u', shortId: 'a', title: 'Source', createdAt: '2026-10-01T00:00:00Z', updatedAt: '2026-10-02T00:00:00Z', sourceRef: 'source', revision: 1, active: false, generateMemory: true }] },
        async records() { return [{ id: 'm1', line: 1, origin: 'human', message: { role: 'user', content: 'A supported preference.' } }] },
        async read() { throw new Error('unused') }, async search() { return [] }, async send() { throw new Error('unused') } }
    const processor = new MemoryProcessor({ store, archive, newId: () => 'job', now: () => Date.parse('2026-10-03T00:00:00Z'), policy: { leaseMs: 30, maxSummaries: 0 },
        model: chatModelOptions({ provider: 'test', modelId: 'test', async *stream() {
            modelEntered(); await modelGate
            yield { type: 'text-delta', delta: JSON.stringify({ description: 'Preference', summary: 'A supported preference.' }) }
            yield { type: 'finish', reason: 'stop' }
        } }) })
    let completed = false
    const work = processor.run('u').then(result => { completed = true; return result })
    try {
        await enteredModel; await vi.advanceTimersByTimeAsync(10); await enteredRenewal
        releaseModel(); await vi.advanceTimersByTimeAsync(0)
        expect(completed).toBe(false)
        releaseRenewal(); await expect(work).resolves.toMatchObject({ extracted: 1, errors: [] })
        expect(state.jobs.a?.watermark).toBe(1)
    } finally { releaseModel(); releaseRenewal(); await work; vi.useRealTimers() }
})
