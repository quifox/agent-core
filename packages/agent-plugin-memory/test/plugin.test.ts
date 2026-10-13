import { expect, it } from 'vitest'
import { createAgent, type AgentPlugin, type ModelRequest } from '@quifox/agent-core'
import { ChatModelPlugin } from '@quifox/agent-plugin-model'
import { ChatSessionPlugin, type ConversationContext } from '@quifox/agent-plugin-session'
import { ContextualChatConversationPlugin as ChatConversationPlugin, RequestContextPlugin } from '@quifox/agent-plugin-request-context'
import { chatModelOptions } from '../../../test/support/chat-model.mjs'
import { MemoryPlugin, MemoryService, emptyMemoryState, type ConversationArchive, type MemoryBinding, type MemoryState, type MemoryStore } from '../src/index.js'

const VALID_GLOBAL = "v1\n\n## User Profile\n\n## User preferences\n\n## General Tips\n\n## What's in Memory\n"

it('continues a large original line through actual conversation_read tool calls with valid bounded JSON receipts', async () => {
    const original = JSON.stringify({ content: '狐狸🦊\0'.repeat(3000) })
    const source = { id: 'prior', ownerId: 'synthetic', shortId: 'prior', title: 'Prior', createdAt: '2026-01-01T00:00:00Z', updatedAt: '2026-01-01T00:00:00Z', sourceRef: 'prior-source', revision: 1, active: false, generateMemory: true }
    const store: MemoryStore = { async load() { return emptyMemoryState() }, async compareAndSet() { return true } }
    const archive: ConversationArchive = { async list() { return [source] }, async records() { return [] }, async search() { return [] }, async send() { throw new Error('unused') },
        async read(_owner, ref, startLine) { return { ref, startLine, lines: startLine === 1 ? [original] : [], truncated: false } } }
    let rebuilt = '', calls = 0
    const session = new ChatSessionPlugin({ id: 'active', ownerId: 'synthetic' }), context = new RequestContextPlugin(session)
    const generation = new ChatModelPlugin({ session: context.source, ...chatModelOptions({ provider: 'test', modelId: 'test', async *stream(request) {
        const last = request.messages.at(-1)
        let nextLine = 1, nextOffset = 0
        if (last?.role === 'tool') {
            expect(new TextEncoder().encode(last.content).length).toBeLessThanOrEqual(12_000)
            const page = JSON.parse(last.content) as { lines: string[]; truncated: boolean; nextLine: number; nextOffset: number }
            rebuilt += page.lines.join('')
            if (!page.truncated) { yield { type: 'text-delta', delta: 'Original verified.' }; yield { type: 'finish', reason: 'stop' }; return }
            nextLine = page.nextLine; nextOffset = page.nextOffset
        }
        calls += 1
        yield { type: 'tool-call', call: { id: `source-page-${calls}`, name: 'conversation_read', input: { ref: source.sourceRef, startLine: nextLine, startOffset: nextOffset, limit: 1 } } }
        yield { type: 'finish', reason: 'tool-calls' }
    } }) })
    const conversation = new ChatConversationPlugin({ session, generation, context })
    const memory = new MemoryPlugin({ service: new MemoryService(store, archive, () => 'unused'), binding: () => ({ ownerId: 'synthetic', conversationId: 'active', context }) })
    expect((await createAgent({ plugins: [conversation, memory] }).run({ prompt: 'Read the complete original source.' })).ok).toBe(true)
    expect(calls).toBeGreaterThan(1); expect(rebuilt).toBe(original); expect(session.pendingToolCalls).toEqual([])
})

it('skips automatic Memory storage reads when the trusted binding disables context', async () => {
    let reads = 0
    const store: MemoryStore = { async load() { reads += 1; throw new Error('Disabled Memory must not be read.') }, async compareAndSet() { throw new Error('unused') } }
    const archive: ConversationArchive = { async list() { return [] }, async records() { return [] }, async read() { throw new Error('unused') }, async search() { return [] }, async send() { throw new Error('unused') } }
    const session = new ChatSessionPlugin({ id: 'disabled-memory', ownerId: 'synthetic' }), context = new RequestContextPlugin(session)
    const generation = new ChatModelPlugin({ session: context.source, ...chatModelOptions({ provider: 'test', modelId: 'test', async *stream() {
        yield { type: 'text-delta', delta: 'Ordinary reply.' }; yield { type: 'finish', reason: 'stop' }
    } }) })
    const conversation = new ChatConversationPlugin({ session, generation, context })
    const memory = new MemoryPlugin({ service: new MemoryService(store, archive, () => 'id'), binding: () => ({ ownerId: 'synthetic', conversationId: 'disabled-memory', context, useMemory: false }) })
    const outcome = await createAgent({ plugins: [conversation, memory] }).run({ prompt: 'Reply without Memory.' })
    expect(outcome.ok).toBe(true); expect(reads).toBe(0)
})

it('finishes and closes the session when memory usage storage fails', async () => {
    const state = emptyMemoryState(); let writes = 0; let feedbackFailures = 0
    state.summaries.a = { conversationId: 'a', path: 'conversations/a.md', title: 'A', description: 'A', summary: 'A',
        sourceRef: 'source-a', sourceUpdatedAt: '2026-10-01T00:00:00Z', sourceRevision: 1, generatedAt: '2026-10-01T00:00:00Z', usageCount: 0 }
    const store: MemoryStore = { async load() { return structuredClone(state) }, async compareAndSet() {
        writes += 1; throw new Error('Synthetic usage-store outage')
    } }
    const archive: ConversationArchive = { async list() { return [] }, async records() { return [] },
        async read() { throw new Error('unused') }, async search() { return [] }, async send() { throw new Error('unused') } }
    const session = new ChatSessionPlugin({ id: 'chat', ownerId: 'u' }); const context = new RequestContextPlugin(session)
    const generation = new ChatModelPlugin({ session: context.source, ...chatModelOptions({ provider: 'test', modelId: 'test', async *stream() {
        yield { type: 'text-delta', delta: 'Historical answer. [memory:a]' }; yield { type: 'finish', reason: 'stop' }
    } }) })
    const conversation = new ChatConversationPlugin({ session, generation, context })
    const memory = new MemoryPlugin({ service: new MemoryService(store, archive, () => 'id'),
        binding: () => ({ ownerId: 'u', conversationId: 'chat', context }), onFeedbackError: () => { feedbackFailures += 1 } })

    const outcome = await createAgent({ plugins: [conversation, memory] }).run({ prompt: 'Recall a prior fact.' })
    expect(outcome.ok).toBe(true)
    expect(session.readOutput()).toBe('Historical answer. [memory:a]')
    expect(session.snapshot().pendingInput).toBeUndefined()
    expect(writes).toBe(1)
    expect(feedbackFailures).toBe(1)
})

it('isolates a shared plugin across concurrent owner contexts and binds note IDs to each tool call', async () => {
    const states = new Map<string, MemoryState>()
    for (const ownerId of ['owner-a', 'owner-b']) {
        const state = emptyMemoryState(); state.global = `${VALID_GLOBAL}\n${ownerId} private context.`; states.set(ownerId, state)
    }
    const store: MemoryStore = {
        async load(ownerId) { return structuredClone(states.get(ownerId) ?? emptyMemoryState()) },
        async compareAndSet(ownerId, revision, next) {
            const current = states.get(ownerId) ?? emptyMemoryState()
            if (revision !== current.revision) { return false }
            states.set(ownerId, structuredClone(next)); return true
        }
    }
    const conversations = new Map([
        ['owner-a', { id: 'conversation-a', ownerId: 'owner-a', shortId: 'short-a', title: 'A', createdAt: '2026-10-01T00:00:00Z',
            updatedAt: '2026-10-02T00:00:00Z', sourceRef: 'source-a', revision: 1, active: false, generateMemory: true }],
        ['owner-b', { id: 'conversation-b', ownerId: 'owner-b', shortId: 'short-b', title: 'B', createdAt: '2026-10-01T00:00:00Z',
            updatedAt: '2026-10-02T00:00:00Z', sourceRef: 'source-b', revision: 1, active: false, generateMemory: true }]
    ])
    const archive: ConversationArchive = { async list(ownerId) { return [conversations.get(ownerId)!] }, async records() { return [] },
        async read() { throw new Error('not used') }, async search() { return [] }, async send() { throw new Error('not used') } }
    const service = new MemoryService(store, archive, () => 'unused-note-id')
    const bindings = new WeakMap<ChatConversationPlugin, MemoryBinding>()
    const shared = new MemoryPlugin({ service, binding: ctx => {
        const conversation = (ctx as ConversationContext).conversation as ChatConversationPlugin
        const binding = bindings.get(conversation)
        if (!binding) { throw new Error('Missing test memory binding.') }
        return binding
    } })
    const requests = new Map<string, ModelRequest[]>()
    let arrivals = 0
    let releaseBoth!: () => void
    const bothRequests = new Promise<void>(resolve => { releaseBoth = resolve })
    const policies = new Map<string, boolean | undefined>()
    const outcomes: Array<{ ownerId: string; agent: ReturnType<typeof createAgent> }> = []

    for (const [ownerId, conversationId, callId] of [
        ['owner-a', 'conversation-a', 'call-a'], ['owner-b', 'conversation-b', 'call-b']
    ]) {
        const session = new ChatSessionPlugin({ id: conversationId!, ownerId: ownerId! })
        const context = new RequestContextPlugin(session)
        const generation = new ChatModelPlugin({ session: context.source, ...chatModelOptions({ provider: 'test', modelId: `${ownerId}-model`, async *stream(request) {
            if (!(requests.get(ownerId!)?.length)) {
                const ownerRequests = requests.get(ownerId!) ?? []
                ownerRequests.push(structuredClone(request)); requests.set(ownerId!, ownerRequests)
                arrivals += 1
                if (arrivals === 2) { releaseBoth() }
                await bothRequests
                yield { type: 'tool-call', call: { id: callId!, name: 'memory_note', input: { kind: 'correct', content: `Correction from ${ownerId}.` } } }
                yield { type: 'finish', reason: 'tool-calls' }
            } else {
                const ownerRequests = requests.get(ownerId!) ?? []
                ownerRequests.push(structuredClone(request)); requests.set(ownerId!, ownerRequests)
                yield { type: 'text-delta', delta: `reply from ${ownerId}` }
                yield { type: 'finish', reason: 'stop' }
            }
        } }) })
        const conversation = new ChatConversationPlugin({ session, generation, context })
        bindings.set(conversation, { ownerId: ownerId!, conversationId: conversationId!, context,
            operationId: callIdValue => `tool:${conversationId}:batch-${ownerId}:${callIdValue}` })
        const inspectPolicy: AgentPlugin = { id: `policy-${ownerId}`, hooks: { onInitialize: async ctx => {
            policies.set(ownerId!, ctx.tools.policy('memory_note')?.retrySafe)
        } } }
        outcomes.push({ ownerId: ownerId!, agent: createAgent({ plugins: [conversation, shared, inspectPolicy] }) })
    }

    const results = await Promise.all(outcomes.map(({ agent, ownerId }) => agent.run({ prompt: `request for ${ownerId}` })))

    expect(results.every(result => result.ok)).toBe(true)
    expect(JSON.stringify(requests.get('owner-a')![0]!.messages)).toContain('owner-a private context.')
    expect(JSON.stringify(requests.get('owner-a')![0]!.messages)).not.toContain('owner-b private context.')
    expect(JSON.stringify(requests.get('owner-b')![0]!.messages)).toContain('owner-b private context.')
    expect(JSON.stringify(requests.get('owner-b')![0]!.messages)).not.toContain('owner-a private context.')
    expect(JSON.stringify(requests.get('owner-a')![1]!.messages)).toContain('Correction from owner-a.')
    expect(JSON.stringify(requests.get('owner-a')![1]!.messages)).not.toContain('owner-a private context.')
    expect(JSON.stringify(requests.get('owner-b')![1]!.messages)).toContain('Correction from owner-b.')
    expect(JSON.stringify(requests.get('owner-b')![1]!.messages)).not.toContain('owner-b private context.')
    expect(states.get('owner-a')!.notes.map(note => note.id)).toEqual(['tool:conversation-a:batch-owner-a:call-a'])
    expect(states.get('owner-b')!.notes.map(note => note.id)).toEqual(['tool:conversation-b:batch-owner-b:call-b'])
    expect(policies).toEqual(new Map([['owner-a', true], ['owner-b', true]]))
})

it('keeps reused provider call IDs distinct across assistant batches and disables safe-retry without host identity', async () => {
    let state = emptyMemoryState()
    state.global = VALID_GLOBAL
    const store: MemoryStore = { async load() { return structuredClone(state) }, async compareAndSet(_owner, revision, next) {
        if (revision !== state.revision) { return false }
        state = structuredClone(next); return true
    } }
    const conversationSource = { id: 'conversation-a', ownerId: 'owner-a', shortId: 'short-a', title: 'A', createdAt: '2026-10-01T00:00:00Z',
        updatedAt: '2026-10-02T00:00:00Z', sourceRef: 'source-a', revision: 1, active: false, generateMemory: true }
    const archive: ConversationArchive = { async list() { return [conversationSource] }, async records() { return [] }, async read() { throw new Error('not used') },
        async search() { return [] }, async send() { throw new Error('not used') } }
    const service = new MemoryService(store, archive, () => 'unused-id')
    const bindings = new WeakMap<ChatConversationPlugin, MemoryBinding>()
    const memory = new MemoryPlugin({ service, binding: ctx => bindings.get((ctx as ConversationContext).conversation as ChatConversationPlugin)! })
    let batch = 0
    let modelTurn = 0
    const session = new ChatSessionPlugin({ id: 'conversation-a', ownerId: 'owner-a' })
    const context = new RequestContextPlugin(session)
    const generation = new ChatModelPlugin({ session: context.source, ...chatModelOptions({ provider: 'test', modelId: 'test', async *stream() {
        const turn = modelTurn++
        if (turn === 0 || turn === 2) {
            yield { type: 'tool-call', call: { id: 'reused-call-id', name: 'memory_note', input: { kind: 'correct', content: `Correction for batch ${batch + 1}.` } } }
            yield { type: 'finish', reason: 'tool-calls' }
        } else {
            yield { type: 'text-delta', delta: 'done' }
            yield { type: 'finish', reason: 'stop' }
        }
    } }) })
    const conversation = new ChatConversationPlugin({ session, generation, context })
    bindings.set(conversation, { ownerId: 'owner-a', conversationId: 'conversation-a', context,
        operationId: callId => `tool:conversation-a:assistant-entry-${++batch}:${callId}` })
    let retrySafe: boolean | undefined
    const inspect: AgentPlugin = { id: 'policy-inspect', hooks: { onInitialize: async ctx => { retrySafe = ctx.tools.policy('memory_note')?.retrySafe } } }
    const agent = createAgent({ plugins: [conversation, memory, inspect] })

    expect((await agent.run({ prompt: 'First correction.' })).ok).toBe(true)
    expect((await agent.run({ prompt: 'Second correction.' })).ok).toBe(true)
    expect(state.notes.map(note => note.id)).toEqual([
        'tool:conversation-a:assistant-entry-1:reused-call-id', 'tool:conversation-a:assistant-entry-2:reused-call-id'
    ])
    expect(retrySafe).toBe(true)

    const noIdentitySession = new ChatSessionPlugin({ id: 'conversation-no-identity', ownerId: 'owner-a' })
    const noIdentityContext = new RequestContextPlugin(noIdentitySession)
    const noIdentityModel = new ChatModelPlugin({ session: noIdentityContext.source, ...chatModelOptions({ provider: 'test', modelId: 'test', async *stream() {
        yield { type: 'text-delta', delta: 'done' }; yield { type: 'finish', reason: 'stop' }
    } }) })
    const noIdentityConversation = new ChatConversationPlugin({ session: noIdentitySession, generation: noIdentityModel, context: noIdentityContext })
    bindings.set(noIdentityConversation, { ownerId: 'owner-a', conversationId: 'conversation-no-identity', context: noIdentityContext })
    const noIdentityMemory = new MemoryPlugin({ service, binding: ctx => bindings.get((ctx as ConversationContext).conversation as ChatConversationPlugin)! })
    let retrySafeWithoutIdentity: boolean | undefined
    const inspectNoIdentity: AgentPlugin = { id: 'policy-inspect-no-identity', hooks: { onInitialize: async ctx => { retrySafeWithoutIdentity = ctx.tools.policy('memory_note')?.retrySafe } } }
    const noIdentityAgent = createAgent({ plugins: [noIdentityConversation, noIdentityMemory, inspectNoIdentity] })

    expect((await noIdentityAgent.run({ prompt: 'No tool operation identity.' })).ok).toBe(true)
    expect(retrySafeWithoutIdentity).toBe(false)
})

it('turns unavailable memory references into model-visible tool errors and closes the pending batch', async () => {
    let state = emptyMemoryState(); state.global = VALID_GLOBAL
    const ownerConversation = { id: 'conversation-a', ownerId: 'owner-a', shortId: 'short-a', title: 'Owned', createdAt: '2026-10-01T00:00:00Z',
        updatedAt: '2026-10-02T00:00:00Z', sourceRef: 'source-a', revision: 1, active: false, generateMemory: true }
    const foreignConversation = { ...ownerConversation, id: 'conversation-b', ownerId: 'owner-b', shortId: 'short-b', title: 'Foreign', sourceRef: 'source-b' }
    const store: MemoryStore = { async load(ownerId) { expect(ownerId).toBe('owner-a'); return structuredClone(state) }, async compareAndSet(_owner, revision, next) {
        if (revision !== state.revision) { return false }; state = structuredClone(next); return true
    } }
    let archiveReads = 0
    const archive: ConversationArchive = { async list(ownerId) { expect(ownerId).toBe('owner-a'); return [ownerConversation, foreignConversation] },
        async records() { return [] }, async read() { archiveReads += 1; throw new Error('foreign source must never be opened') },
        async search() { return [] }, async send() { throw new Error('not used') } }
    const service = new MemoryService(store, archive, () => 'unused-id')
    const session = new ChatSessionPlugin({ id: ownerConversation.id, ownerId: ownerConversation.ownerId })
    const context = new RequestContextPlugin(session)
    const generation = new ChatModelPlugin({ session: context.source, ...chatModelOptions({ provider: 'test', modelId: 'test', async *stream(request) {
        if (request.messages.some(message => message.role === 'tool')) {
            yield { type: 'text-delta', delta: 'No matching memory source is available.' }
            yield { type: 'finish', reason: 'stop' }
        } else {
            yield { type: 'tool-call', call: { id: 'bad-summary-ref', name: 'memory_read', input: { ref: 'conversations/foreign-summary.md' } } }
            yield { type: 'tool-call', call: { id: 'foreign-source-ref', name: 'conversation_read', input: { ref: 'source-b' } } }
            yield { type: 'finish', reason: 'tool-calls' }
        }
    } }) })
    const conversation = new ChatConversationPlugin({ session, generation, context })
    const bindings = new WeakMap<ChatConversationPlugin, MemoryBinding>([[conversation, { ownerId: ownerConversation.ownerId, conversationId: ownerConversation.id, context }]])
    const memory = new MemoryPlugin({ service, binding: ctx => bindings.get((ctx as ConversationContext).conversation as ChatConversationPlugin)! })
    const observed: Array<{ status: string; content: string; code?: string }> = []
    const observeTools: AgentPlugin = { id: 'observe-memory-errors', hooks: { afterTool: async (_ctx, run) => {
        observed.push(run.result); return { action: 'continue' }
    } } }
    const agent = createAgent({ plugins: [conversation, memory, observeTools] })

    const outcome = await agent.run({ prompt: 'Look up this prior discussion.' })

    expect(outcome.ok).toBe(true)
    expect(session.pendingToolCalls).toEqual([])
    const results = session.messages.filter((message): message is Extract<typeof message, { role: 'tool' }> => message.role === 'tool')
    expect(results).toHaveLength(2)
    expect(results.map(result => result.content)).toEqual(['Memory is unavailable.', 'Memory is unavailable.'])
    expect(results.every(result => result.isError)).toBe(true)
    expect(observed.map(result => result.code)).toEqual(['MEMORY_UNAVAILABLE', 'MEMORY_UNAVAILABLE'])
    expect(JSON.stringify(results)).not.toContain('source-b')
    expect(JSON.stringify(results)).not.toContain('foreign-summary.md')
    expect(archiveReads).toBe(0)
})

it('leaves a pending tool batch when a source backend raises an unexpected I/O error', async () => {
    let state = emptyMemoryState(); state.global = VALID_GLOBAL
    const source = { id: 'conversation-a', ownerId: 'owner-a', shortId: 'short-a', title: 'Owned', createdAt: '2026-10-01T00:00:00Z',
        updatedAt: '2026-10-02T00:00:00Z', sourceRef: 'source-a', revision: 1, active: false, generateMemory: true }
    const store: MemoryStore = { async load() { return structuredClone(state) }, async compareAndSet(_owner, revision, next) {
        if (revision !== state.revision) { return false }; state = structuredClone(next); return true
    } }
    const archive: ConversationArchive = { async list() { return [source] }, async records() { return [] },
        async read() { throw new Error('synthetic archive I/O failure') }, async search() { return [] }, async send() { throw new Error('not used') } }
    const service = new MemoryService(store, archive, () => 'unused-id')
    const session = new ChatSessionPlugin({ id: source.id, ownerId: source.ownerId })
    const context = new RequestContextPlugin(session)
    const generation = new ChatModelPlugin({ session: context.source, ...chatModelOptions({ provider: 'test', modelId: 'test', async *stream() {
        yield { type: 'tool-call', call: { id: 'source-read', name: 'conversation_read', input: { ref: source.sourceRef } } }
        yield { type: 'finish', reason: 'tool-calls' }
    } }) })
    const conversation = new ChatConversationPlugin({ session, generation, context })
    const bindings = new WeakMap<ChatConversationPlugin, MemoryBinding>([[conversation, { ownerId: source.ownerId, conversationId: source.id, context }]])
    const memory = new MemoryPlugin({ service, binding: ctx => bindings.get((ctx as ConversationContext).conversation as ChatConversationPlugin)! })
    const agent = createAgent({ plugins: [conversation, memory] })

    const outcome = await agent.run({ prompt: 'Read original evidence.' })

    expect(outcome.ok).toBe(false)
    expect(session.pendingToolCalls).toMatchObject([{ id: 'source-read', name: 'conversation_read' }])
    expect(session.messages.filter(message => message.role === 'tool')).toEqual([])
})
