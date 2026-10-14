import { expect, it, vi } from 'vitest'
import type { SubAgentsPluginOptions } from '@quifox/agent-plugin-subagents'
import type { RuntimeSnapshot, SessionView } from '../src/protocol.js'
import { synthetic } from './synthetic.js'

// Exercise the public retention option with a small boundary in the Host integration.
vi.mock('@quifox/agent-plugin-subagents', async importOriginal => {
    const original = await importOriginal<typeof import('@quifox/agent-plugin-subagents')>()
    return { ...original, SubAgentsPlugin: class extends original.SubAgentsPlugin {
        constructor(options: SubAgentsPluginOptions) { super({ ...options, maxCompletedTasks: 1 }) }
    } }
})

it('restores evicted durable children through parent tools without granting another parent ownership', async () => {
    let taskId = ''
    const fixture = await synthetic(input => {
        const prompt = input.messages.at(-1)?.content ?? ''
        if (prompt.startsWith('spawn ')) return { calls: [{ id: 'start', name: 'subagent_start', input: { mode: 'empty', prompt: `child ${prompt.slice(6)}` } }] }
        if (prompt === 'recover old') return { calls: [{ id: 'send', name: 'subagent_send', input: { taskId, prompt: 'review again' } }, { id: 'wait', name: 'subagent_wait', input: { taskId, timeoutMs: 3000 } }] }
        if (prompt === 'stop old') return { calls: [{ id: 'stop', name: 'subagent_stop', input: { taskId } }] }
        return { text: prompt === 'review again' ? 'durable child reply' : 'done' }
    })
    try {
        const parent = await fixture.runtime.command({ type: 'create' }) as SessionView
        let first!: SessionView
        for (let index = 0; index < 2; index += 1) {
            await fixture.runtime.command({ type: 'submit', sessionId: parent.id, prompt: `spawn ${index}` }); await fixture.runtime.waitForIdle(parent.id)
            const children = (await fixture.runtime.command({ type: 'snapshot' }) as RuntimeSnapshot).sessions.filter(child => child.parentId === parent.id)
            if (index === 0) { first = await fixture.runtime.command({ type: 'snapshot', sessionId: children[0]!.id }) as SessionView; taskId = first.taskId! }
            await Promise.all(children.map(child => fixture.runtime.waitForIdle(child.id)))
        }
        await fixture.runtime.command({ type: 'submit', sessionId: parent.id, prompt: 'recover old' }); await fixture.runtime.waitForIdle(parent.id)
        const after = await fixture.runtime.command({ type: 'snapshot', sessionId: first.id }) as SessionView
        expect(after.messages.at(-1)?.message.content).toBe('durable child reply')
        const parentView = await fixture.runtime.command({ type: 'snapshot', sessionId: parent.id }) as SessionView
        expect([...parentView.messages].reverse().find(message => message.message.role === 'tool' && message.message.toolName === 'subagent_wait')?.message.content).toBe('durable child reply')
        await fixture.runtime.command({ type: 'submit', sessionId: parent.id, prompt: 'stop old' }); await fixture.runtime.waitForIdle(parent.id)
        expect([...(await fixture.runtime.command({ type: 'snapshot', sessionId: parent.id }) as SessionView).messages].reverse().find(message => message.message.role === 'tool')?.message.content).toContain('请求停止')
        const stranger = await fixture.runtime.command({ type: 'create' }) as SessionView
        await fixture.runtime.command({ type: 'submit', sessionId: stranger.id, prompt: 'recover old' }); await fixture.runtime.waitForIdle(stranger.id)
        expect((await fixture.runtime.command({ type: 'snapshot', sessionId: stranger.id }) as SessionView).messages.filter(message => message.message.role === 'tool').every(message => message.message.content.includes('不存在'))).toBe(true)
    } finally { await fixture.close() }
}, 15_000)
