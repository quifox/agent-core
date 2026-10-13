import { expect, it } from 'vitest'
import type { SessionView } from '../src/protocol.js'
import { synthetic } from './synthetic.js'

it('delivers one message to another owned conversation and preserves its origin across source recovery', async () => {
    let targetId = '', stop = true
    const fixture = await synthetic(input => {
        const last = input.messages.at(-1)
        if (last?.content === 'send independent note') return { calls: [{ id: 'dispatch', name: 'conversation_send', input: { conversationId: targetId, content: 'independent follow-up' } }] }
        return { text: last?.content === 'independent follow-up' ? 'target reply' : 'source complete' }
    })
    try {
        const target = await fixture.runtime.command({ type: 'create', title: 'Target' }) as SessionView
        targetId = target.id
        const source = await fixture.runtime.command({ type: 'create', title: 'Source' }) as SessionView
        fixture.runtime.subscribe(event => {
            if (stop && event.sessionId === source.id && event.type === 'agent' && (event.data as { type?: string }).type === 'tool-result') {
                stop = false; void fixture.runtime.command({ type: 'stop', sessionId: source.id })
            }
        })
        await fixture.runtime.command({ type: 'submit', sessionId: source.id, prompt: 'send independent note' }); await fixture.runtime.waitForIdle(source.id)
        await fixture.runtime.waitForIdle(target.id)
        await fixture.restart()
        await fixture.runtime.command({ type: 'resume', sessionId: source.id, mode: 'continue' }); await fixture.runtime.waitForIdle(source.id)
        const targetAfter = await fixture.runtime.command({ type: 'snapshot', sessionId: target.id }) as SessionView
        expect(targetAfter.messages.map(item => item.message.content)).toEqual(['independent follow-up', 'target reply'])
        expect(targetAfter.messages.map(item => item.origin)).toEqual(['other-agent', 'assistant'])
        expect(fixture.requests.filter(input => input.messages.at(-1)?.content === 'independent follow-up')).toHaveLength(1)
        const sourceAfter = await fixture.runtime.command({ type: 'snapshot', sessionId: source.id }) as SessionView
        expect(sourceAfter.messages.some(item => item.message.content === 'target reply')).toBe(false)
        expect(sourceAfter.messages.find(item => item.message.role === 'tool')?.message.content).toContain('queued')
    } finally { await fixture.close() }
})
