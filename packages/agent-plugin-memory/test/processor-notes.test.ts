import { expect, it } from 'vitest'
import type { ModelRequest } from '@quifox/agent-core'
import { chatModelOptions } from '../../../test/support/chat-model.mjs'
import { MemoryProcessor, MemoryService, emptyMemoryState, type ConversationArchive, type MemoryNote, type MemoryState, type MemoryStore } from '../src/index.js'
import { utf8Bytes } from '../src/index.js'

const NOW = Date.parse('2026-10-03T00:00:00Z')
const GLOBAL = "v1\n\n## User Profile\n\n## User preferences\n\n## General Tips\n\n## What's in Memory\n"

function makeNote(index: number, kind: MemoryNote['kind'] = 'remember', length = 250): MemoryNote {
    return { id: `note-${index.toString().padStart(3, '0')}`, createdAt: '2026-10-01T00:00:00.000Z', kind,
        content: `note-${index.toString().padStart(3, '0')} ${'x'.repeat(length)}` }
}

function createStore(initial: MemoryState) {
    let state = structuredClone(initial)
    const store: MemoryStore = {
        async load(ownerId) { expect(ownerId).toBe('owner-a'); return structuredClone(state) },
        async compareAndSet(ownerId, revision, next) {
            expect(ownerId).toBe('owner-a')
            if (revision !== state.revision) { return false }
            state = structuredClone(next); return true
        }
    }
    return { store, state: () => state, replace: (next: MemoryState) => { state = structuredClone(next) } }
}

function emptyArchive(): ConversationArchive {
    return { async list() { return [] }, async records() { return [] }, async read() { throw new Error('not used') },
        async search() { return [] }, async send() { throw new Error('not used') } }
}

function inputPayload(request: ModelRequest): Record<string, unknown> {
    const input = [...request.messages].reverse().find(message => message.role === 'user')
    if (!input || input.role !== 'user') { throw new Error('Consolidation input is missing.') }
    return JSON.parse(input.content) as Record<string, unknown>
}

it('supplies maintenance timestamps separately from original conversation dates', async () => {
    const initial = emptyMemoryState()
    const note = { id: 'math-correction', kind: 'correct' as const, content: 'For math, give the conclusion first.', createdAt: new Date(NOW).toISOString() }
    initial.notes = [note]
    const harness = createStore(initial)
    const source = { id: 'math', ownerId: 'owner-a', shortId: 'math', title: 'Math', createdAt: '2026-10-01T00:00:00Z',
        updatedAt: '2026-10-02T00:00:00Z', revision: 1, sourceRef: 'source-math', active: false, generateMemory: true }
    const archive = { ...emptyArchive(), async list() { return [source] }, async records() {
        return [{ id: 'm1', line: 1, origin: 'human' as const, message: { role: 'user' as const, content: 'For math, conditions first.' } }]
    } }
    let metadata: Record<string, unknown> | undefined
    const processor = new MemoryProcessor({ store: harness.store, archive, newId: () => 'job', now: () => NOW,
        model: chatModelOptions({ provider: 'test', modelId: 'test', async *stream(request) {
            if (!request.tools.length) {
                const input = request.messages.find(message => message.role === 'user')!.content
                metadata = JSON.parse(input.split('\n')[0]!.slice('Conversation metadata and maintenance: '.length))
                yield { type: 'text-delta', delta: '{"description":"Math preference","summary":"Conclusion first."}' }
            } else if (!request.messages.some(message => message.role === 'tool')) {
                yield { type: 'tool-call', call: { id: 'publish', name: 'memory_publish', input: { content: GLOBAL } } }
                yield { type: 'finish', reason: 'tool-calls' }; return
            }
            yield { type: 'finish', reason: 'stop' }
        } }) })

    expect(await processor.run('owner-a')).toMatchObject({ extracted: 1, errors: [] })
    expect(metadata).toMatchObject({ updatedAt: source.updatedAt, maintenance: [{ kind: note.kind, content: note.content, createdAt: note.createdAt }] })
})

it('keeps the published baseline through a local correction and a failed consolidation', async () => {
    const initial = emptyMemoryState()
    initial.global = GLOBAL.replace('## User preferences\n', '## User preferences\nFood: no peanuts. Math: conditions first.\n')
    initial.notes = [{ id: 'old-note', kind: 'remember', content: 'Food: no peanuts. Math: conditions first.', createdAt: '2026-10-01T00:00:00Z' }]
    initial.consolidatedFingerprint = JSON.stringify({ summaries: [], noteWatermark: 1, notesTotal: 1, revoked: [] })
    const harness = createStore(initial); const archive = emptyArchive()
    const service = new MemoryService(harness.store, archive, () => 'correction', () => NOW)
    await service.note('owner-a', { kind: 'correct', content: 'Math: conclusion first.' })
    expect((await service.global('owner-a')).content).not.toContain('Math: conditions first.')
    let input: Record<string, unknown> | undefined
    const processor = new MemoryProcessor({ store: harness.store, archive, newId: () => 'job', now: () => NOW,
        model: chatModelOptions({ provider: 'test', modelId: 'test', async *stream(request) {
            input = inputPayload(request)
            throw new Error('Synthetic consolidation outage')
        } }) })

    expect(await processor.run('owner-a')).toMatchObject({ consolidated: false, errors: ['consolidation_failed'] })
    expect(input?.existingMemory).toBe(initial.global)
    expect(harness.state().global).toBe(initial.global)
    expect((await service.global('owner-a')).content).toContain('Math: conclusion first.')
})

it('processes an append-only history across bounded ordered passes, migrates legacy watermarks, and leaves the tail pending', async () => {
    const initial = emptyMemoryState(); initial.global = GLOBAL
    initial.notes = Array.from({ length: 200 }, (_, index) => makeNote(index + 1))
    initial.consolidatedFingerprint = JSON.stringify({ summaries: [], notes: initial.notes.slice(0, 3), revoked: [] })
    const harness = createStore(initial)
    const archive = emptyArchive()
    const payloads: Record<string, unknown>[] = []
    const processor = new MemoryProcessor({ store: harness.store, archive, newId: (() => { let id = 0; return () => `job-${++id}` })(), now: () => NOW,
        model: chatModelOptions({ provider: 'test', modelId: 'test', async *stream(request) {
            const published = request.messages.some(message => message.role === 'tool' && message.toolName === 'memory_publish')
            if (published) { yield { type: 'finish', reason: 'stop' }; return }
            payloads.push(inputPayload(request))
            yield { type: 'tool-call', call: { id: 'publish', name: 'memory_publish', input: { content: GLOBAL } } }
            yield { type: 'finish', reason: 'tool-calls' }
        } }) })

    let watermark = 3
    let passes = 0
    while (watermark < initial.notes.length && passes < 10) {
        await expect(processor.run('owner-a')).resolves.toMatchObject({ extracted: 0, consolidated: true, errors: [] })
        const input = payloads.at(-1)!
        const batch = input.notes as Array<{ index: number; id: string }>
        const target = input.targetNoteWatermark as number
        expect(input.noteWatermark).toBe(watermark)
        expect(input.notesTotal).toBe(initial.notes.length)
        expect(batch.length).toBeGreaterThan(0)
        expect(batch.length).toBeLessThanOrEqual(32)
        expect(utf8Bytes(JSON.stringify(batch))).toBeLessThanOrEqual(20_000)
        expect(batch[0]!.index).toBe(watermark + 1)
        expect(batch.at(-1)!.index).toBe(target)
        expect(target).toBeGreaterThan(watermark)
        const fingerprint = JSON.parse(harness.state().consolidatedFingerprint) as { noteWatermark: number; notesTotal: number; notes?: unknown }
        expect(fingerprint).toMatchObject({ noteWatermark: target, notesTotal: initial.notes.length })
        expect(fingerprint.notes).toBeUndefined()
        watermark = target; passes += 1

        if (watermark < initial.notes.length) {
            const visible = await new MemoryService(harness.store, archive, () => 'unused').global('owner-a')
            expect(visible.content).toContain(`note-${(watermark + 1).toString().padStart(3, '0')}`)
            expect(visible.content).not.toContain('note-001')
        }
    }

    expect(watermark).toBe(initial.notes.length)
    expect(passes).toBeGreaterThan(1)
    const priorPayloadCount = payloads.length
    await expect(processor.run('owner-a')).resolves.toMatchObject({ extracted: 0, consolidated: false, errors: [] })
    expect(payloads).toHaveLength(priorPayloadCount)
})

it('enforces the 20 KiB note-batch budget before the 32-note limit', async () => {
    const initial = emptyMemoryState(); initial.global = GLOBAL
    initial.notes = Array.from({ length: 40 }, (_, index) => makeNote(index + 1, 'remember', 1_500))
    initial.consolidatedFingerprint = JSON.stringify({ summaries: [], notes: [], revoked: [] })
    const harness = createStore(initial)
    const payloads: Record<string, unknown>[] = []
    const processor = new MemoryProcessor({ store: harness.store, archive: emptyArchive(), newId: () => 'byte-budget-job', now: () => NOW,
        model: chatModelOptions({ provider: 'test', modelId: 'test', async *stream(request) {
            if (request.messages.some(message => message.role === 'tool' && message.toolName === 'memory_publish')) {
                yield { type: 'finish', reason: 'stop' }; return
            }
            payloads.push(inputPayload(request))
            yield { type: 'tool-call', call: { id: 'publish', name: 'memory_publish', input: { content: GLOBAL } } }
            yield { type: 'finish', reason: 'tool-calls' }
        } }) })

    await expect(processor.run('owner-a')).resolves.toMatchObject({ consolidated: true })
    const batch = payloads[0]!.notes as unknown[]
    expect(batch.length).toBeLessThan(32)
    expect(utf8Bytes(JSON.stringify(batch))).toBeLessThanOrEqual(20_000)
    expect(JSON.parse(harness.state().consolidatedFingerprint)).toMatchObject({ noteWatermark: batch.length, notesTotal: 40 })
})

it('lets the consolidation Agent read and search old notes without resending them in the new batch', async () => {
    const initial = emptyMemoryState(); initial.global = GLOBAL
    initial.notes = [makeNote(1, 'correct', 30), makeNote(2, 'forget', 30)]
    initial.notes[0]!.content = 'Old note: user corrected the preferred response style to concise.'
    initial.notes[1]!.content = 'Current note: forget the old temporary detail.'
    initial.consolidatedFingerprint = JSON.stringify({ summaries: [], noteWatermark: 1, notesTotal: 2, revoked: [] })
    const harness = createStore(initial)
    let readResult = ''
    let searchResult = ''
    let batchInput: Record<string, unknown> | undefined
    const processor = new MemoryProcessor({ store: harness.store, archive: emptyArchive(), newId: () => 'history-tools-job', now: () => NOW,
        model: chatModelOptions({ provider: 'test', modelId: 'test', async *stream(request) {
            const toolMessages = request.messages.filter(message => message.role === 'tool')
            if (!toolMessages.length) {
                batchInput = inputPayload(request)
                yield { type: 'tool-call', call: { id: 'read-history', name: 'notes_read', input: { start: 1, limit: 1 } } }
                yield { type: 'finish', reason: 'tool-calls' }
            } else if (toolMessages.at(-1)?.role === 'tool' && toolMessages.at(-1)?.toolName === 'notes_read') {
                readResult = toolMessages.at(-1)!.content
                yield { type: 'tool-call', call: { id: 'search-history', name: 'notes_search', input: { query: 'preferred response style', limit: 1 } } }
                yield { type: 'finish', reason: 'tool-calls' }
            } else if (toolMessages.at(-1)?.role === 'tool' && toolMessages.at(-1)?.toolName === 'notes_search') {
                searchResult = toolMessages.at(-1)!.content
                yield { type: 'tool-call', call: { id: 'publish', name: 'memory_publish', input: { content: GLOBAL } } }
                yield { type: 'finish', reason: 'tool-calls' }
            } else { yield { type: 'finish', reason: 'stop' } }
        } }) })

    await expect(processor.run('owner-a')).resolves.toMatchObject({ consolidated: true })
    expect(batchInput).toMatchObject({ noteWatermark: 1, targetNoteWatermark: 2, notesTotal: 2 })
    expect(batchInput!.notes).toEqual([expect.objectContaining({ index: 2, id: 'note-002' })])
    expect(readResult).toContain('Old note: user corrected the preferred response style to concise.')
    expect(searchResult).toContain('Old note: user corrected the preferred response style to concise.')
})

it('returns invalid history-tool arguments as a repairable Core result', async () => {
    const initial = emptyMemoryState(); initial.global = GLOBAL
    initial.notes = [makeNote(1)]
    initial.consolidatedFingerprint = JSON.stringify({ summaries: [], notes: [], revoked: [] })
    const harness = createStore(initial)
    let invalidResult = ''
    const processor = new MemoryProcessor({ store: harness.store, archive: emptyArchive(), newId: () => 'repair-tool-job', now: () => NOW,
        model: chatModelOptions({ provider: 'test', modelId: 'test', async *stream(request) {
            const toolMessages = request.messages.filter(message => message.role === 'tool')
            const last = toolMessages.at(-1)
            if (!last) {
                yield { type: 'tool-call', call: { id: 'invalid-read', name: 'notes_read', input: { start: 0, limit: 1 } } }
                yield { type: 'finish', reason: 'tool-calls' }
            } else if (last.toolCallId === 'invalid-read') {
                invalidResult = last.content
                yield { type: 'tool-call', call: { id: 'valid-read', name: 'notes_read', input: { start: 1, limit: 1 } } }
                yield { type: 'finish', reason: 'tool-calls' }
            } else if (last.toolName === 'notes_read') {
                yield { type: 'tool-call', call: { id: 'publish', name: 'memory_publish', input: { content: GLOBAL } } }
                yield { type: 'finish', reason: 'tool-calls' }
            } else if (last.toolName === 'memory_publish' && !last.isError) {
                yield { type: 'finish', reason: 'stop' }
            } else { throw new Error('Unexpected consolidation tool result.') }
        } }) })

    await expect(processor.run('owner-a')).resolves.toMatchObject({ extracted: 0, consolidated: true, errors: [] })
    expect(invalidResult).toContain('arguments are invalid')
    expect(harness.state().consolidatedFingerprint).toContain('"noteWatermark":1')
})

it('requires an exact history read before consuming an oversized note', async () => {
    const initial = emptyMemoryState(); initial.global = GLOBAL
    initial.notes = [{ ...makeNote(1, 'correct', 0), content: '\u0000'.repeat(6_000) }]
    initial.consolidatedFingerprint = JSON.stringify({ summaries: [], notes: [], revoked: [] })
    const harness = createStore(initial)
    let batch: Record<string, unknown> | undefined
    let fullNote: MemoryNote | undefined
    const processor = new MemoryProcessor({ store: harness.store, archive: emptyArchive(), newId: () => 'oversized-note-job', now: () => NOW,
        model: chatModelOptions({ provider: 'test', modelId: 'test', async *stream(request) {
            const toolMessages = request.messages.filter(message => message.role === 'tool')
            const last = toolMessages.at(-1)
            if (!last) {
                batch = inputPayload(request)
                yield { type: 'tool-call', call: { id: 'early-publish', name: 'memory_publish', input: { content: GLOBAL } } }
                yield { type: 'finish', reason: 'tool-calls' }
            } else if (last.toolCallId === 'early-publish') {
                expect(last.content).toContain('Read every truncated note')
                yield { type: 'tool-call', call: { id: 'read-full', name: 'notes_read', input: { start: 1, limit: 1 } } }
                yield { type: 'finish', reason: 'tool-calls' }
            } else if (last.toolName === 'notes_read') {
                const result = JSON.parse(last.content) as { notes: MemoryNote[] }
                fullNote = result.notes[0]
                yield { type: 'tool-call', call: { id: 'publish', name: 'memory_publish', input: { content: GLOBAL } } }
                yield { type: 'finish', reason: 'tool-calls' }
            } else if (last.toolName === 'memory_publish' && !last.isError) {
                yield { type: 'finish', reason: 'stop' }
            } else { throw new Error('Unexpected consolidation tool result.') }
        } }) })

    await expect(processor.run('owner-a')).resolves.toMatchObject({ extracted: 0, consolidated: true, errors: [] })
    const entries = batch!.notes as Array<{ index: number; content: string; contentTruncated?: boolean }>
    expect(utf8Bytes(JSON.stringify(entries))).toBeLessThanOrEqual(20_000)
    expect(entries).toHaveLength(1)
    expect(entries[0]).toMatchObject({ index: 1, contentTruncated: true })
    expect(fullNote?.content).toBe('\u0000'.repeat(6_000))
    expect(JSON.parse(harness.state().consolidatedFingerprint)).toMatchObject({ noteWatermark: 1, notesTotal: 1 })
})

it('does not advance noteWatermark when the lease is replaced after a valid candidate', async () => {
    const initial = emptyMemoryState(); initial.global = 'Previously published memory.'
    initial.notes = [makeNote(1), makeNote(2)]
    initial.consolidatedFingerprint = JSON.stringify({ summaries: [], notes: initial.notes.slice(0, 1), revoked: [] })
    const harness = createStore(initial)
    let replaced = false
    const processor = new MemoryProcessor({ store: harness.store, archive: emptyArchive(), newId: () => 'lease-job', now: () => NOW,
        model: chatModelOptions({ provider: 'test', modelId: 'test', async *stream(request) {
            if (request.messages.some(message => message.role === 'tool' && message.toolName === 'memory_publish')) {
                if (!replaced) {
                    replaced = true
                    harness.replace({ ...harness.state(), consolidation: { token: 'new-owner-token', expiresAt: NOW + 60_000, retryAt: 0, watermark: 0 } })
                }
                yield { type: 'finish', reason: 'stop' }; return
            }
            yield { type: 'tool-call', call: { id: 'publish', name: 'memory_publish', input: { content: GLOBAL } } }
            yield { type: 'finish', reason: 'tool-calls' }
        } }) })

    await expect(processor.run('owner-a')).resolves.toMatchObject({ extracted: 0, consolidated: false, errors: [] })

    expect(harness.state().global).toBe('Previously published memory.')
    expect(JSON.parse(harness.state().consolidatedFingerprint)).not.toHaveProperty('noteWatermark')
    expect(harness.state().consolidation).toMatchObject({ token: 'new-owner-token', watermark: 0 })
})
