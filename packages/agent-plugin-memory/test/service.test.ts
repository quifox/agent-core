import { expect, it } from 'vitest'
import { chatModelOptions } from '../../../test/support/chat-model.mjs'
import { MemoryInputError, MemoryProcessor, MemoryService, MemoryUnavailableError, emptyMemoryState, type ConversationArchive, type MemoryConversation, type MemoryStore } from '../src/index.js'
import { utf8Bytes, memoryToolText } from '../src/index.js'

it('lists unsummarized conversations by title with a stable cursor and filters search scope before ranking', async () => {
    const sources = ['a', 'b', 'c'].map(id => ({ id, ownerId: 'owner', shortId: id, title: `Title ${id}`,
        createdAt: '2026-10-01T00:00:00Z', updatedAt: '2026-10-02T00:00:00Z', sourceRef: `source-${id}`, revision: 1, active: false, generateMemory: true }))
    const state = emptyMemoryState(); state.revoked = ['c']
    const archive: ConversationArchive = { async list() { return sources }, async records() { return [] }, async read() { throw new Error('unused') },
        async send() { throw new Error('unused') }, async search(_owner, _query, limit, allowed) {
            expect(allowed).toEqual(['a', 'b'])
            return sources.filter(source => allowed?.includes(source.id)).slice(0, limit).map(source => ({ ref: source.sourceRef, conversationId: source.id, line: 1, content: 'match', score: 1 }))
        } }
    const service = new MemoryService({ async load() { return state }, async compareAndSet() { return false } }, archive, () => 'unused')
    const first = await service.listConversations('owner', { limit: 1 })
    expect(first.items.map(item => item.id)).toEqual(['c'])
    sources.push({ ...sources[0]!, id: 'd', createdAt: '2026-10-03T00:00:00Z' })
    const next = await service.listConversations('owner', { limit: 1, cursor: first.nextCursor })
    expect(next.items.map(item => item.id)).toEqual(['b'])
    expect(next.items[0]?.description).toBeUndefined()
    expect((await service.listConversations('owner', { query: 'Title a' })).items.map(item => item.id)).toEqual(['d', 'a'])
    sources.pop()
    expect(await service.searchSource('owner', 'match', 1)).toMatchObject([{ conversationId: 'a' }])
})

it('paginates by the tool byte budget without skipping long-description conversations', async () => {
    const state = emptyMemoryState()
    const sources = Array.from({ length: 40 }, (_, index) => {
        const id = `conversation-${index.toString().padStart(3, '0')}`
        const source = { id, ownerId: 'owner', shortId: id, title: 'secret=a '.repeat(22).trim(), createdAt: '2026-10-01T00:00:00Z',
            updatedAt: '2026-10-02T00:00:00Z', sourceRef: `source-${id}`, revision: 1, active: false, generateMemory: true }
        state.summaries[id] = { conversationId: id, path: `conversations/${id}.md`, title: source.title, description: '长'.repeat(340),
            summary: 'Summary', sourceRef: source.sourceRef, sourceUpdatedAt: source.updatedAt, sourceRevision: 1, generatedAt: source.updatedAt, usageCount: 0 }
        return source
    })
    const service = new MemoryService({ async load() { return state }, async compareAndSet() { return false } }, {
        async list() { return sources }, async records() { return [] }, async read() { throw new Error('unused') }, async search() { return [] }, async send() { throw new Error('unused') }
    }, () => 'unused')
    const seen: string[] = []; let cursor: string | undefined
    do {
        const page = await service.listConversations('owner', { limit: 100, cursor })
        expect(utf8Bytes(JSON.stringify(page))).toBeLessThanOrEqual(14_000)
        expect(JSON.parse(memoryToolText(page)).items.map((item: { id: string }) => item.id)).toEqual(page.items.map(item => item.id))
        expect(page.items.length).toBeGreaterThan(0)
        seen.push(...page.items.map(item => item.id)); cursor = page.nextCursor
    } while (cursor)
    expect(seen).toHaveLength(40); expect(new Set(seen).size).toBe(40)
})

it('hides generated memory while an unscoped forget is pending without revoking every source', async () => {
    const conversation: MemoryConversation = { id: 'conversation-a', ownerId: 'owner-a', shortId: 'short-a', title: 'A conversation',
        createdAt: '2026-10-01T00:00:00Z', updatedAt: '2026-10-02T00:00:00Z', sourceRef: 'source-a', revision: 1,
        active: false, generateMemory: true }
    let state = emptyMemoryState()
    state.global = 'Old generated preference.'
    state.summaries['conversation-a'] = {
        conversationId: conversation.id, path: 'conversations/2026-10-01T00-00-00Z-short-a.md', title: conversation.title,
        description: 'Old generated preference details.', summary: 'The user prefers the old setting.', sourceRef: conversation.sourceRef,
        sourceUpdatedAt: conversation.updatedAt, sourceRevision: conversation.revision, generatedAt: conversation.updatedAt, usageCount: 0
    }
    state.consolidatedFingerprint = JSON.stringify({ summaries: [], notes: [], revoked: [] })
    const store: MemoryStore = { async load(ownerId) {
        expect(ownerId).toBe('owner-a'); return structuredClone(state)
    }, async compareAndSet(ownerId, revision, next) {
        expect(ownerId).toBe('owner-a')
        if (revision !== state.revision) { return false }
        state = structuredClone(next)
        return true
    } }
    let sourceRead = false
    const archive: ConversationArchive = {
        async list(ownerId) { expect(ownerId).toBe('owner-a'); return [conversation] },
        async records() { return [] },
        async read(ownerId, ref, startLine) {
            expect(ownerId).toBe('owner-a'); expect(ref).toBe('source-a'); sourceRead = true
            return { ref, startLine, lines: ['Original archive remains owner-scoped.'], truncated: false }
        },
        async search() { return [] }, async send() { throw new Error('not needed') }
    }
    const service = new MemoryService(store, archive, () => 'note-1', () => Date.parse('2026-10-03T00:00:00Z'))

    await service.note('owner-a', { kind: 'forget', content: 'Forget the old preference.' })

    expect(state.global).toBe('Old generated preference.')
    const pending = await service.global('owner-a')
    expect(pending.content).toContain('Forget the old preference.')
    expect(pending.content).not.toContain('Old generated preference.')
    expect(await service.list('owner-a')).toEqual([])
    expect(await service.search('owner-a', 'old')).toEqual([])
    await expect(service.read('owner-a', 'conversations/2026-10-01T00-00-00Z-short-a.md')).rejects.toBeInstanceOf(MemoryUnavailableError)
    expect(state.revoked).toEqual([])
    await expect(service.readSource('owner-a', 'source-a')).resolves.toMatchObject({ lines: ['Original archive remains owner-scoped.'] })
    expect(sourceRead).toBe(true)

    const correctedGlobal = 'v1\n\n## User Profile\n\n## User preferences\n\n## General Tips\n\n## What\'s in Memory\n'
    state.global = correctedGlobal
    state.consolidatedFingerprint = JSON.stringify({ summaries: [], notes: state.notes, revoked: state.revoked })
    expect((await service.global('owner-a')).content).toBe(correctedGlobal)
    expect(await service.list('owner-a')).toHaveLength(0)
    await expect(service.read('owner-a', 'conversations/2026-10-01T00-00-00Z-short-a.md')).rejects.toBeInstanceOf(MemoryUnavailableError)
})

it('permanently suppresses only the conversation explicitly targeted by a forget note', async () => {
    const conversation: MemoryConversation = { id: 'conversation-a', ownerId: 'owner-a', shortId: 'short-a', title: 'A conversation',
        createdAt: '2026-10-01T00:00:00Z', updatedAt: '2026-10-02T00:00:00Z', sourceRef: 'source-a', revision: 1,
        active: false, generateMemory: true }
    let state = emptyMemoryState()
    state.global = 'Generated content.'
    state.summaries['conversation-a'] = {
        conversationId: conversation.id, path: 'conversations/2026-10-01T00-00-00Z-short-a.md', title: conversation.title,
        description: 'Description.', summary: 'Summary.', sourceRef: conversation.sourceRef,
        sourceUpdatedAt: conversation.updatedAt, sourceRevision: conversation.revision, generatedAt: conversation.updatedAt, usageCount: 0
    }
    const store: MemoryStore = { async load() { return structuredClone(state) }, async compareAndSet(_owner, revision, next) {
        if (revision !== state.revision) { return false }
        state = structuredClone(next); return true
    } }
    const archive: ConversationArchive = { async list() { return [conversation] }, async records() { return [] },
        async read() { throw new Error('revoked source must not be read') }, async search() { return [] }, async send() { throw new Error('not needed') } }
    const service = new MemoryService(store, archive, () => 'note-1', () => Date.parse('2026-10-03T00:00:00Z'))

    await service.note('owner-a', { kind: 'forget', content: 'Forget this conversation.', conversationId: conversation.id })

    expect(state.revoked).toEqual([conversation.id])
    expect(state.summaries[conversation.id]).toBeUndefined()
    await expect(service.readSource('owner-a', conversation.sourceRef)).rejects.toBeInstanceOf(MemoryUnavailableError)
})

it('hides stale generated context on a correction and bounds pending-note context by UTF-8 bytes', async () => {
    let state = emptyMemoryState()
    state.global = 'Stale generated memory.'
    const store: MemoryStore = { async load() { return structuredClone(state) }, async compareAndSet(_owner, revision, next) {
        if (revision !== state.revision) { return false }
        state = structuredClone(next); return true
    } }
    const archive: ConversationArchive = { async list() { return [] }, async records() { return [] },
        async read() { throw new Error('not used') }, async search() { return [] }, async send() { throw new Error('not used') } }
    let nextId = 0
    const service = new MemoryService(store, archive, () => `note-${++nextId}`, () => Date.parse('2026-10-03T00:00:00Z'))

    await service.note('owner-a', { kind: 'remember', content: 'r'.repeat(6_000) })
    await service.note('owner-a', { kind: 'remember', content: 's'.repeat(6_000) })
    await service.note('owner-a', { kind: 'correct', content: 'Correct the remembered preference to be concise.' })

    expect(state.global).toBe('Stale generated memory.')
    const pending = await service.global('owner-a')
    expect(pending.content).toContain('Correct the remembered preference to be concise.')
    expect(pending.content).not.toContain('Stale generated memory.')
    expect(pending.content).toContain('omitted')
    expect(utf8Bytes(pending.content)).toBeLessThanOrEqual(8_000)
})

it('keeps the last valid global and summaries readable after remember consolidation fails', async () => {
    const conversation: MemoryConversation = { id: 'conversation-a', ownerId: 'owner-a', shortId: 'short-a', title: 'A conversation',
        createdAt: '2026-10-01T00:00:00Z', updatedAt: '2026-10-02T00:00:00Z', sourceRef: 'source-a', revision: 1,
        active: true, generateMemory: true }
    let state = emptyMemoryState()
    state.global = 'Existing valid global memory.'
    state.summaries[conversation.id] = {
        conversationId: conversation.id, path: 'conversations/2026-10-01T00-00-00Z-short-a.md', title: conversation.title,
        description: 'Existing description.', summary: 'Existing summary remains useful.', sourceRef: conversation.sourceRef,
        sourceUpdatedAt: conversation.updatedAt, sourceRevision: conversation.revision, generatedAt: conversation.updatedAt, usageCount: 0
    }
    state.consolidatedFingerprint = JSON.stringify({ summaries: [], notes: [], revoked: [] })
    const store: MemoryStore = { async load() { return structuredClone(state) }, async compareAndSet(_owner, revision, next) {
        if (revision !== state.revision) { return false }
        state = structuredClone(next); return true
    } }
    const archive: ConversationArchive = { async list() { return [conversation] }, async records() { return [] },
        async read() { throw new Error('not used') }, async search() { return [] }, async send() { throw new Error('not used') } }
    const service = new MemoryService(store, archive, () => 'remember-1')

    await service.note('owner-a', { kind: 'remember', content: 'Also remember this new preference.' })
    const processor = new MemoryProcessor({ store, archive, newId: () => 'failed-consolidation', now: () => Date.parse('2026-10-03T00:00:00Z'),
        model: chatModelOptions({ provider: 'test', modelId: 'test', async *stream() { throw new Error('synthetic consolidation failure') } }) })
    await expect(processor.run('owner-a')).resolves.toMatchObject({ extracted: 0, consolidated: false, errors: ['consolidation_failed'] })

    expect(state.global).toBe('Existing valid global memory.')
    expect((await service.global('owner-a')).content).toContain('Existing valid global memory.')
    expect((await service.global('owner-a')).content).toContain('Also remember this new preference.')
    expect(await service.list('owner-a')).toHaveLength(1)
    await expect(service.read('owner-a', state.summaries[conversation.id]!.path)).resolves.toMatchObject({
        lines: expect.arrayContaining(['Existing summary remains useful.'])
    })
    expect(await service.search('owner-a', 'Existing summary')).not.toEqual([])
})

it('uses a stable operation ID to return the prior note and rejects payload collisions', async () => {
    let state = emptyMemoryState()
    const store: MemoryStore = { async load() { return structuredClone(state) }, async compareAndSet(_owner, revision, next) {
        if (revision !== state.revision) { return false }
        state = structuredClone(next); return true
    } }
    const archive: ConversationArchive = { async list() { return [] }, async records() { return [] },
        async read() { throw new Error('not used') }, async search() { return [] }, async send() { throw new Error('not used') } }
    let nextId = 0
    const service = new MemoryService(store, archive, () => `generated-${++nextId}`)
    const input = { kind: 'correct' as const, content: 'Use concise answers.' }

    const first = await service.note('owner-a', input, 'tool:conversation-a:assistant-entry-1:call-123')
    const retry = await service.note('owner-a', input, 'tool:conversation-a:assistant-entry-1:call-123')

    expect(retry).toEqual(first)
    expect(state.notes).toEqual([first])
    await expect(service.note('owner-a', { ...input, content: 'Different payload.' }, 'tool:conversation-a:assistant-entry-1:call-123'))
        .rejects.toBeInstanceOf(MemoryInputError)
})

it('keeps original reads and search available with paged maintenance history after many corrections', async () => {
    const source: MemoryConversation = { id: 'a', ownerId: 'u', shortId: 'a', title: 'A', createdAt: '2026-10-01T00:00:00Z',
        updatedAt: '2026-10-02T00:00:00Z', sourceRef: 'source-a', revision: 1, active: false, generateMemory: true }
    const state = emptyMemoryState()
    state.notes = Array.from({ length: 30 }, (_, i) => ({ id: `n${i}`, kind: 'correct' as const,
        content: `UNIQUE_${i}_END ` + '条件。'.repeat(100), createdAt: source.updatedAt }))
    state.consolidatedFingerprint = JSON.stringify({ summaries: [], noteWatermark: 30, notesTotal: 30, revoked: [] })
    const archive: ConversationArchive = { async list() { return [source] }, async records() { return [] },
        async read(_owner, ref, startLine) { return { ref, startLine, lines: ['Original exact line.'], truncated: false } },
        async search() { return [{ ref: source.sourceRef, conversationId: source.id, line: 1, content: 'Original exact line.', score: 1 }] },
        async send() { throw new Error('unused') } }
    const service = new MemoryService({ async load() { return state }, async compareAndSet() { return false } }, archive, () => 'id')

    const original = await service.readSource('u', source.sourceRef)
    expect(original.lines).toEqual(['Original exact line.'])
    const pointer = JSON.parse(original.memoryUpdates!) as { ref: string; truncated: boolean }
    expect(pointer).toMatchObject({ ref: 'memory-notes:a', truncated: true })
    expect((await service.searchSource('u', 'exact'))[0]?.content).toContain(pointer.ref)
    let start = 1; let history = ''; let truncated = true
    while (truncated) {
        const page = await service.read('u', pointer.ref, start, 200)
        expect(utf8Bytes(memoryToolText(page))).toBeLessThan(16_000)
        expect(JSON.parse(memoryToolText(page)).lines).toEqual(page.lines)
        history += page.lines.join('\n'); start += page.lines.length; truncated = page.truncated
    }
    for (let i = 0; i < 30; i += 1) { expect(history).toContain(`UNIQUE_${i}_END`) }
    state.notes.push({ id: 'long-forget', kind: 'forget', content: '前'.repeat(3_000) + 'FORGET_TAIL_CONDITION', createdAt: source.updatedAt })
    start = 1; history = ''; truncated = true
    while (truncated) {
        const page = await service.read('u', pointer.ref, start, 200)
        expect(page.lines.length).toBeGreaterThan(0)
        history += page.lines.join(''); start += page.lines.length; truncated = page.truncated
    }
    expect(history).toContain(state.notes.at(-1)!.content)
    state.revoked.push(source.id)
    await expect(service.read('u', pointer.ref)).rejects.toBeInstanceOf(MemoryUnavailableError)
    await expect(service.read('foreign-owner', pointer.ref)).rejects.toBeInstanceOf(MemoryUnavailableError)
})

it('classifies invalid memory ranges, searches, and notes as correctable input failures', async () => {
    const store: MemoryStore = { async load() { return emptyMemoryState() }, async compareAndSet() { return false } }
    const archive: ConversationArchive = { async list() { return [] }, async records() { return [] },
        async read() { throw new Error('not used') }, async search() { return [] }, async send() { throw new Error('not used') } }
    const service = new MemoryService(store, archive, () => 'note-id')

    await expect(service.read('owner-a', 'memory.md', 0)).rejects.toBeInstanceOf(MemoryInputError)
    await expect(service.searchSource('owner-a', ' ')).rejects.toBeInstanceOf(MemoryInputError)
    await expect(service.note('owner-a', { kind: 'remember', content: ' ' })).rejects.toBeInstanceOf(MemoryInputError)
})

it('filters cross-owner archive results and rejects cross-owner reads and sends', async () => {
    const owned: MemoryConversation = { id: 'conversation-a', ownerId: 'owner-a', shortId: 'short-a', title: 'Owned',
        createdAt: '2026-10-01T00:00:00Z', updatedAt: '2026-10-02T00:00:00Z', sourceRef: 'source-a', revision: 1,
        active: false, generateMemory: true }
    const foreign: MemoryConversation = { ...owned, id: 'conversation-b', ownerId: 'owner-b', shortId: 'short-b', title: 'Foreign', sourceRef: 'source-b' }
    const store: MemoryStore = { async load(ownerId) { expect(ownerId).toBe('owner-a'); return emptyMemoryState() },
        async compareAndSet() { return false } }
    const archive: ConversationArchive = {
        async list(ownerId) { expect(ownerId).toBe('owner-a'); return [owned, foreign] }, async records() { return [] },
        async read(_owner, ref, startLine) { return { ref, startLine, lines: ['source'], truncated: false } },
        async search() { return [
            { ref: 'source-a', conversationId: owned.id, line: 1, content: 'owned match', score: 1 },
            { ref: 'source-b', conversationId: foreign.id, line: 1, content: 'foreign match', score: 1 }
        ] }, async send() { throw new Error('foreign target must be rejected before send') }
    }
    const service = new MemoryService(store, archive, () => 'note-id')

    await expect(service.readSource('owner-a', 'source-b')).rejects.toBeInstanceOf(MemoryUnavailableError)
    expect(await service.searchSource('owner-a', 'match')).toEqual([
        { ref: 'source-a', conversationId: owned.id, line: 1, content: 'owned match', score: 1 }
    ])
    await expect(service.send('owner-a', owned.id, foreign.id, 'hello', 'delivery-1')).rejects.toBeInstanceOf(MemoryUnavailableError)
    await expect(service.note('owner-a', { kind: 'forget', content: 'Forget it.', conversationId: foreign.id }))
        .rejects.toBeInstanceOf(MemoryUnavailableError)
})
