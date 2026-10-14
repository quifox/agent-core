import { expect, it } from 'vitest'
import { createAgent, defineTool, toolSuccess, type ModelRequest } from '@quifox/agent-core'
import { ChatModelPlugin } from '@quifox/agent-plugin-model'
import { ChatConversationPlugin, ChatSessionPlugin, copySessionValue } from '@quifox/agent-plugin-session'
import { z } from 'zod'
import { chatModelOptions } from '../../../test/support/chat-model.mjs'
import { MessageInboxPlugin } from '../src/inbox.js'

it('persists cancellation of pending identities without cancelling staged work or reviving duplicate delivery', () => {
    const inbox = new MessageInboxPlugin()
    inbox.post({ id: 'active', prompt: 'active request', mode: 'queue' }); inbox.claim('active')
    inbox.post({ id: 'queued', prompt: 'cancel this request', mode: 'queue' })
    expect(inbox.cancelPending(['active', 'queued'])).toEqual(['queued'])
    expect(inbox.cancelPending(['queued'])).toEqual([])
    expect(inbox.post({ id: 'queued', prompt: 'cancel this request', mode: 'queue' }).status).toBe('cancelled')
    const restored = new MessageInboxPlugin(inbox.snapshot()); restored.restoreStaged()
    expect(restored.next()?.id).toBe('active'); expect(restored.next()).toBeUndefined()
    expect(restored.snapshot().messages.find(item => item.id === 'queued')).toMatchObject({ status: 'cancelled', prompt: 'cancel this request' })
})

it('injects steer after a real tool result while queue waits for the next complete run', async () => {
    const requests: ModelRequest[] = []
    const inbox = new MessageInboxPlugin()
    const session = new ChatSessionPlugin({ id: 's', ownerId: 'o' })
    const generation = new ChatModelPlugin({ session, ...chatModelOptions({ provider: 'test', modelId: 'test', async *stream(request) {
        requests.push(copySessionValue(request))
        if (requests.length === 1) { yield { type: 'tool-call', call: { id: 'work', name: 'work', input: {} } }; yield { type: 'finish', reason: 'tool-calls' } }
        else { yield { type: 'text-delta', delta: 'done' }; yield { type: 'finish', reason: 'stop' } }
    } }) })
    const conversation = new ChatConversationPlugin({ session, generation })
    const agent = createAgent({ plugins: [conversation, inbox, { id: 'host-tools', hooks: { onInitialize: async ctx => {
        ctx.tools.register(defineTool({ name: 'work', description: 'A synthetic operation.', inputSchema: z.object({}).strict(), policy: { sideEffect: 'none', approval: 'none' },
            execute: async () => {
                inbox.post({ id: 'steer', prompt: 'change direction', mode: 'steer' })
                inbox.post({ id: 'queue', prompt: 'next task', mode: 'queue' })
                return toolSuccess('actual work result')
            } }))
    } } }] })
    expect((await agent.run({ prompt: 'initial' })).ok).toBe(true)
    expect(requests[1]!.messages.at(-1)?.content).toBe('change direction')
    expect(JSON.stringify(requests[1])).not.toContain('next task')
    expect(requests[0]!.messages.map(message => message.content)).toEqual(['initial'])
    const next = inbox.next()!
    expect(next).toMatchObject({ id: 'queue', prompt: 'next task', status: 'staged' })
    expect((await agent.run({ prompt: next.prompt })).ok).toBe(true)
    expect(requests[2]!.messages.at(-1)?.content).toBe('next task')
})

it('keeps steer pending during frozen input retry and applies it after the first complete exchange', async () => {
    const requests: ModelRequest[] = []
    const inbox = new MessageInboxPlugin()
    const session = new ChatSessionPlugin({ id: 's', ownerId: 'o' })
    const generation = new ChatModelPlugin({ session, ...chatModelOptions({ provider: 'test', modelId: 'test', async *stream(request) {
        requests.push(copySessionValue(request))
        if (requests.length === 1) throw new Error('Synthetic network failure')
        if (requests.length === 2) { yield { type: 'tool-call', call: { id: 'read', name: 'read', input: {} } }; yield { type: 'finish', reason: 'tool-calls' } }
        else { yield { type: 'text-delta', delta: 'done' }; yield { type: 'finish', reason: 'stop' } }
    } }) })
    const conversation = new ChatConversationPlugin({ session, generation })
    const agent = createAgent({ plugins: [conversation, inbox, { id: 'tools', hooks: { onInitialize: async ctx => {
        ctx.tools.register(defineTool({ name: 'read', description: 'Read a value.', inputSchema: z.object({}).strict(), policy: { sideEffect: 'none', approval: 'none' },
            execute: async () => toolSuccess('value') }))
    } } }] })
    expect((await agent.run({ prompt: 'original' })).ok).toBe(false)
    inbox.post({ id: 'steer', prompt: 'new direction', mode: 'steer' })
    expect((await agent.run({ prompt: 'original' })).ok).toBe(true)
    expect(requests[1]!.messages).toEqual(requests[0]!.messages)
    expect(requests[2]!.messages.at(-1)?.content).toBe('new direction')
})

it('stable delivery identities do not duplicate input and conflicting payloads fail', () => {
    const inbox = new MessageInboxPlugin()
    const input = { id: 'message', prompt: 'original', mode: 'queue' as const }
    inbox.post(input); inbox.post(input)
    expect(inbox.snapshot().messages).toHaveLength(1)
    expect(() => inbox.post({ ...input, prompt: 'changed' })).toThrow('conflict')
    expect(inbox.next()?.status).toBe('staged')
    const candidate = inbox.committedSnapshot()
    expect(candidate.messages[0]?.status).toBe('applied')
    expect(inbox.snapshot().messages[0]?.status).toBe('staged')
    inbox.restoreStaged()
    expect(inbox.next()?.id).toBe('message')
    inbox.commitStaged()
    expect(inbox.next()).toBeUndefined()
})
