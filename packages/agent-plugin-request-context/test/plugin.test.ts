import { expect, it } from 'vitest'
import { createAgent, type AgentPlugin, type ModelRequest } from '@quifox/agent-core'
import { ChatModelPlugin } from '@quifox/agent-plugin-model'
import { ChatSessionPlugin, type ChatInput } from '@quifox/agent-plugin-session'
import { chatModelOptions } from '../../../test/support/chat-model.mjs'
import { ContextualChatConversationPlugin, RequestContextPlugin } from '../src/index.js'

it('projects changing beforeModel contributions without recording them in Session snapshots', async () => {
    const requests: ModelRequest[] = []
    const persisted: string[] = []
    const session = new ChatSessionPlugin({ id: 'chat', ownerId: 'owner', store: { save: snapshot => { persisted.push(JSON.stringify(snapshot)) } } })
    const context = new RequestContextPlugin(session)
    const generation = new ChatModelPlugin({ session: context.source, ...chatModelOptions({ provider: 'test', modelId: 'test', async *stream(request) {
        requests.push(structuredClone(request))
        if (requests.length === 1) {
            yield { type: 'tool-call', call: { id: 'step', name: 'step', input: {} } }
            yield { type: 'finish', reason: 'tool-calls' }
        } else { yield { type: 'text-delta', delta: 'done' }; yield { type: 'finish', reason: 'stop' } }
    } }) })
    const conversation = new ContextualChatConversationPlugin({ session, generation, context })
    let step = 0
    const contributions: unknown[] = []
    const contribution: AgentPlugin<ChatInput> = { id: 'contribution', hooks: {
        beforeModel: async () => {
            context.set('test', `TEMPORARY_${++step}`)
            contributions.push(context.snapshot())
            return { action: 'continue' }
        },
        beforeTool: async () => ({ action: 'result', result: { status: 'success', content: 'step finished' } })
    } }
    const outcome = await createAgent<ChatInput>({ plugins: [conversation, contribution] }).run({ prompt: 'user source' })
    expect(outcome.ok).toBe(true)
    expect(JSON.stringify(requests[0])).toContain('TEMPORARY_1')
    expect(JSON.stringify(requests[1])).toContain('TEMPORARY_2')
    expect(JSON.stringify(requests[1])).not.toContain('TEMPORARY_1')
    expect(persisted.length).toBeGreaterThan(1)
    expect(persisted.join('\n')).not.toContain('TEMPORARY_')
    expect(JSON.stringify(session.messages)).not.toContain('TEMPORARY_')
    expect(contributions).toEqual([
        [{ key: 'test', content: 'TEMPORARY_1' }],
        [{ key: 'test', content: 'TEMPORARY_2' }]
    ])
    expect(() => context.set('late', 'invalid')).toThrow('active run')
})

it('retries canonical input with fresh temporary context after a failed model request', async () => {
    const requests: ModelRequest[] = []
    const session = new ChatSessionPlugin({ id: 'retry', ownerId: 'owner' })
    const context = new RequestContextPlugin(session)
    const generation = new ChatModelPlugin({ session: context.source, ...chatModelOptions({ provider: 'test', modelId: 'test', async *stream(request) {
        requests.push(structuredClone(request))
        if (requests.length === 1) { throw new Error('synthetic failure') }
        yield { type: 'text-delta', delta: 'recovered' }; yield { type: 'finish', reason: 'stop' }
    } }) })
    const conversation = new ContextualChatConversationPlugin({ session, generation, context })
    let value = 'OLD_TEMPORARY'
    const contribution: AgentPlugin<ChatInput> = { id: 'contribution', hooks: { beforeModel: async () => {
        context.set('test', value); return { action: 'continue' }
    } } }
    const agent = createAgent<ChatInput>({ plugins: [conversation, contribution] })
    expect((await agent.run({ prompt: 'same user input' })).ok).toBe(false)
    expect(JSON.stringify(session.snapshot())).not.toContain('OLD_TEMPORARY')
    value = 'NEW_TEMPORARY'
    expect((await agent.run({ prompt: 'same user input' })).ok).toBe(true)
    expect(JSON.stringify(requests[1])).toContain('NEW_TEMPORARY')
    expect(JSON.stringify(requests[1])).not.toContain('OLD_TEMPORARY')
    expect(session.messages.filter(message => message.role === 'user')).toHaveLength(1)
})

it('rebinds fork and empty branches to independent request adapters and compaction factories', async () => {
    const requests: ModelRequest[] = []
    const contexts: RequestContextPlugin[] = []
    const session = new ChatSessionPlugin({ id: 'parent', ownerId: 'owner' })
    const context = new RequestContextPlugin(session)
    const generation = new ChatModelPlugin({ session: context.source, ...chatModelOptions({ provider: 'test', modelId: 'test', async *stream(request) {
        requests.push(structuredClone(request)); yield { type: 'text-delta', delta: 'done' }; yield { type: 'finish', reason: 'stop' }
    } }) })
    const conversation = new ContextualChatConversationPlugin({ session, generation, context, compaction: (source, model, childContext) => {
        expect(childContext.isBoundTo(source)).toBe(true)
        expect(model.isBoundTo(childContext.source)).toBe(true)
        contexts.push(childContext)
        return { async prepare() { return undefined } }
    } })
    const contribution: AgentPlugin<ChatInput> = { id: 'parent-only', hooks: { beforeModel: async () => {
        context.set('test', 'PARENT_TEMPORARY'); return { action: 'continue' }
    } } }
    await createAgent<ChatInput>({ plugins: [conversation, contribution] }).run({ prompt: 'parent history' })
    const child = await conversation.fork({ id: 'child' })
    const empty = await conversation.empty({ id: 'empty' })
    expect(new Set(contexts).size).toBe(3)
    expect((await createAgent<ChatInput>({ plugins: [child] }).run({ prompt: 'child input' })).ok).toBe(true)
    expect((await createAgent<ChatInput>({ plugins: [empty] }).run({ prompt: 'empty input' })).ok).toBe(true)
    expect(JSON.stringify(requests[1])).toContain('parent history')
    expect(JSON.stringify(requests[1])).not.toContain('PARENT_TEMPORARY')
    expect(JSON.stringify(requests[2])).not.toContain('parent history')
})

it('rejects mismatched component identities before an Agent can run', () => {
    const first = new ChatSessionPlugin({ id: 'first', ownerId: 'owner' })
    const second = new ChatSessionPlugin({ id: 'second', ownerId: 'owner' })
    const context = new RequestContextPlugin(first)
    const generation = new ChatModelPlugin({ session: first, ...chatModelOptions({ provider: 'test', modelId: 'test', async *stream() { yield { type: 'finish', reason: 'stop' } } }) })
    expect(() => new ContextualChatConversationPlugin({ session: second, generation, context })).toThrow('Session')
    expect(() => new ContextualChatConversationPlugin({ session: first, generation, context })).toThrow('source')
})

it('a contextual fork binds its own cancellation signal and does not inherit the parent signal', async () => {
    const signals: (AbortSignal | undefined)[] = []
    const parent = new AbortController()
    const child = new AbortController()
    const session = new ChatSessionPlugin({ id: 'parent', ownerId: 'owner' })
    const context = new RequestContextPlugin(session)
    const generation = new ChatModelPlugin({ session: context.source, signal: () => parent.signal,
        ...chatModelOptions({ provider: 'test', modelId: 'test', async *stream(request) {
            signals.push(request.signal)
            yield { type: 'text-delta', delta: 'done' }; yield { type: 'finish', reason: 'stop' }
        } }) })
    const conversation = new ContextualChatConversationPlugin({ session, generation, context })
    const fork = await conversation.fork({ signal: () => child.signal })
    expect((await createAgent<ChatInput>({ plugins: [fork] }).run({ prompt: 'child' })).ok).toBe(true)
    expect(signals).toEqual([child.signal])
    expect(signals[0]).not.toBe(parent.signal)
})
