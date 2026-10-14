import { expect, it, vi } from 'vitest'
import { join } from 'node:path'
import { SessionJournal } from '../src/journal.js'
import type { RuntimeSnapshot, SessionView } from '../src/protocol.js'
import { synthetic } from './synthetic.js'

it.each(['empty', 'fork'] as const)('uses %s child history with authoritative request and wait identity', async mode => {
    const originalText = 'Different claimed Agent; original reply remains unchanged.'
    const fixture = await synthetic((input, index) => {
        const last = input.messages.at(-1)
        if (index === 1) return { calls: [{ id: 'child-start', name: 'subagent_start', input: { prompt: 'Assigned child task.', name: 'Connectivity', ...(mode === 'fork' ? { mode } : {}) } }] }
        if (last?.content === 'Assigned child task.') return { text: originalText }
        if (last?.role === 'tool') {
            const creation = JSON.parse(last.content) as { taskId?: string; status?: string }
            if (creation.taskId && creation.status === 'running') return { calls: [{ id: 'child-wait', name: 'subagent_wait', input: { taskId: creation.taskId } }] }
        }
        return { text: 'Parent completed.' }
    }, config => { config.approval = 'allow' })
    try {
        const parent = await fixture.runtime.command({ type: 'create' }) as SessionView
        await fixture.runtime.command({ type: 'submit', sessionId: parent.id, prompt: 'Parent-only goal.' }); await fixture.runtime.waitForIdle(parent.id)
        const child = (await fixture.runtime.command({ type: 'snapshot' }) as RuntimeSnapshot).sessions.find(item => item.parentId === parent.id)!
        const request = fixture.requests.find(input => input.messages.at(-1)?.content === 'Assigned child task.')!
        expect(request.messages.filter(message => message.role === 'user').map(message => message.content)).toEqual(mode === 'fork' ? ['Parent-only goal.', 'Assigned child task.'] : ['Assigned child task.'])
        const role = request.messages.filter(message => message.role === 'system').map(message => message.content).join('\n')
        expect(role).toContain('You are child Agent Connectivity.'); expect(role).toContain(child.taskId!); expect(role).toContain(parent.id)
        expect(request.tools.map(tool => tool.function.name)).not.toContain('subagent_start')
        const result = await fixture.runtime.command({ type: 'snapshot', sessionId: parent.id }) as SessionView
        const waited = result.messages.find(item => item.message.role === 'tool' && item.message.toolName === 'subagent_wait')!
        expect(JSON.parse(waited.message.content)).toEqual({ taskId: child.taskId, name: 'Connectivity', status: 'completed', text: originalText })
    } finally { await fixture.close() }
})

it('cancels an input that was claimed but never entered the Conversation after startup persistence failed', async () => {
    const fixture = await synthetic(() => ({ text: 'fresh reply' }))
    let append: ReturnType<typeof vi.spyOn> | undefined
    try {
        const parent = await fixture.runtime.command({ type: 'create' }) as SessionView
        await fixture.runtime.command({ type: 'submit', sessionId: parent.id, prompt: '/spawn 1 reviewer' })
        const child = (await fixture.runtime.command({ type: 'snapshot' }) as RuntimeSnapshot).sessions.find(item => item.parentId === parent.id)!
        const original = SessionJournal.prototype.append; let fail = true
        append = vi.spyOn(SessionJournal.prototype, 'append').mockImplementation(function (this: SessionJournal, id, record) {
            const state = record.state as { inbox?: { messages: { status: string }[] } } | undefined
            if (fail && id === child.id && state?.inbox?.messages.some(message => message.status === 'staged')) { fail = false; return Promise.reject(new Error('Synthetic startup persistence failure')) }
            return original.call(this, id, record)
        })
        await fixture.runtime.command({ type: 'submit', sessionId: child.id, prompt: 'never started' }); await fixture.runtime.waitForIdle(child.id)
        expect(fixture.requests).toHaveLength(0)
        await fixture.runtime.command({ type: 'stop', sessionId: child.id, waitForExit: true })
        const stopped = await fixture.runtime.command({ type: 'snapshot', sessionId: child.id }) as SessionView
        expect(stopped.pendingMessages).toHaveLength(0); expect(stopped.resumeAvailable).toBe(false)
        await fixture.runtime.command({ type: 'submit', sessionId: child.id, prompt: 'new task' }); await fixture.runtime.waitForIdle(child.id)
        expect(fixture.requests).toHaveLength(1)
        expect(fixture.requests[0]!.messages.some(message => message.content === 'never started')).toBe(false)
    } finally { append?.mockRestore(); await fixture.close() }
})

it('persists cancellation of a queued child message and does not run it after restart and replan', async () => {
    let finish!: () => void
    const blocked = new Promise<void>(resolve => { finish = resolve })
    const fixture = await synthetic(async input => { if (input.messages.at(-1)?.content === 'first child request') await blocked; return { text: 'done' } })
    try {
        const parent = await fixture.runtime.command({ type: 'create' }) as SessionView
        await fixture.runtime.command({ type: 'submit', sessionId: parent.id, prompt: '/spawn 1 reviewer' })
        const child = (await fixture.runtime.command({ type: 'snapshot' }) as RuntimeSnapshot).sessions.find(item => item.parentId === parent.id)!
        await fixture.runtime.command({ type: 'submit', sessionId: child.id, prompt: 'first child request' })
        await expect.poll(() => fixture.requests.length).toBe(1)
        await fixture.runtime.command({ type: 'submit', sessionId: child.id, prompt: 'cancelled queued request' })
        await fixture.runtime.command({ type: 'stop', sessionId: child.id }); await fixture.runtime.waitForIdle(child.id)
        const stopped = await fixture.runtime.command({ type: 'snapshot', sessionId: child.id }) as SessionView
        expect(stopped.pendingMessages.some(message => message.prompt === 'cancelled queued request')).toBe(false)
        const journal = new SessionJournal(join(fixture.root, 'sessions'))
        const saved = [...(await journal.read(child.id, { latestStateOnly: true })).records].reverse().find(record => record.kind === 'state')!
        expect(JSON.stringify(saved)).toContain('cancelled')
        finish(); await fixture.restart()
        await fixture.runtime.command({ type: 'resume', sessionId: child.id, mode: 'replan' }); await fixture.runtime.waitForIdle(child.id)
        expect(fixture.requests.some(input => input.messages.some(message => message.role === 'user' && message.content === 'cancelled queued request'))).toBe(false)
    } finally { finish(); await fixture.close() }
})

it('accepts a new child turn after stop occurred beyond the completed final reply', async () => {
    let taskId = '', stop = true
    const fixture = await synthetic((input, index) => {
        const last = input.messages.at(-1)
        if (index === 1) return { calls: [{ id: 'fork', name: 'subagent_start', input: {} }] }
        if (last?.content === 'new parent turn') return { calls: [{ id: 'send', name: 'subagent_send', input: { taskId, prompt: 'new child turn' } }, { id: 'wait', name: 'subagent_wait', input: { taskId } }] }
        return { text: last?.content === 'new child turn' ? 'new final reply' : 'done' }
    })
    try {
        const parent = await fixture.runtime.command({ type: 'create' }) as SessionView
        await fixture.runtime.command({ type: 'submit', sessionId: parent.id, prompt: 'original plan' }); await fixture.runtime.waitForIdle(parent.id)
        const child = (await fixture.runtime.command({ type: 'snapshot' }) as RuntimeSnapshot).sessions.find(item => item.parentId === parent.id)!
        taskId = child.taskId!
        fixture.runtime.subscribe(event => {
            if (stop && event.sessionId === child.id && event.type === 'agent' && (event.data as { type?: string }).type === 'run-end') { stop = false; void fixture.runtime.command({ type: 'stop', sessionId: child.id }) }
        })
        await fixture.runtime.command({ type: 'submit', sessionId: child.id, prompt: 'completed first turn' }); await fixture.runtime.waitForIdle(child.id)
        const stopped = await fixture.runtime.command({ type: 'snapshot', sessionId: child.id }) as SessionView
        expect(stopped.status).toBe('stopped'); expect(stopped.resumeAvailable).toBe(false)
        await fixture.runtime.command({ type: 'submit', sessionId: parent.id, prompt: 'new parent turn' }); await fixture.runtime.waitForIdle(parent.id)
        const result = await fixture.runtime.command({ type: 'snapshot', sessionId: child.id }) as SessionView
        expect(result.status).toBe('idle'); expect(result.pendingMessages).toHaveLength(0)
        expect(result.messages.at(-1)?.message.content).toBe('new final reply')
    } finally { await fixture.close() }
})

it('consumes both child messages in durable order when a second submit races the first admission event', async () => {
    let taskId = '', concurrent: Promise<unknown> | undefined
    const fixture = await synthetic((input, index) => {
        const last = input.messages.at(-1)
        if (index === 1) return { calls: [{ id: 'fork', name: 'subagent_start', input: {} }] }
        if (last?.content === 'wake child') return { calls: [{ id: 'send', name: 'subagent_send', input: { taskId, prompt: 'first review' } }, { id: 'wait', name: 'subagent_wait', input: { taskId } }] }
        return { text: last?.content === 'first review' ? 'first reply' : last?.content === 'second review' ? 'second reply' : 'parent done' }
    })
    try {
        const parent = await fixture.runtime.command({ type: 'create' }) as SessionView
        await fixture.runtime.command({ type: 'submit', sessionId: parent.id, prompt: 'original plan' }); await fixture.runtime.waitForIdle(parent.id)
        const child = (await fixture.runtime.command({ type: 'snapshot' }) as RuntimeSnapshot).sessions.find(item => item.parentId === parent.id)!
        taskId = child.taskId!
        fixture.runtime.subscribe(event => {
            if (event.sessionId === child.id && event.type === 'inbox' && !concurrent) concurrent = fixture.runtime.command({ type: 'submit', sessionId: child.id, prompt: 'second review' })
        })
        await fixture.runtime.command({ type: 'submit', sessionId: parent.id, prompt: 'wake child' }); await fixture.runtime.waitForIdle(parent.id)
        await concurrent; await fixture.runtime.waitForIdle(child.id)
        const result = await fixture.runtime.command({ type: 'snapshot', sessionId: child.id }) as SessionView
        expect(result.pendingMessages).toHaveLength(0)
        expect(result.messages.map(item => item.message.content)).toEqual(['first review', 'first reply', 'second review', 'second reply'])
        expect(result.status).toBe('idle')
    } finally { await fixture.close() }
})

it.each(['model', 'tools'] as const)('rejects a parent send while the child needs %s recovery', async boundary => {
    let taskId = '', interrupt = true
    const fixture = await synthetic((input, index) => {
        const last = input.messages.at(-1)
        if (index === 1) return { calls: [{ id: 'fork', name: 'subagent_start', input: {} }] }
        if (last?.content === 'new parent message') return { calls: [{ id: 'send', name: 'subagent_send', input: { taskId, prompt: 'new child message' } }] }
        if (boundary === 'tools' && last?.content === 'original child task') return { calls: [{ id: 'read', name: 'list_files', input: {} }] }
        return { text: last?.content === 'original child task' ? 'recovered original reply' : 'done' }
    })
    try {
        const parent = await fixture.runtime.command({ type: 'create' }) as SessionView
        await fixture.runtime.command({ type: 'submit', sessionId: parent.id, prompt: 'original plan' }); await fixture.runtime.waitForIdle(parent.id)
        const child = (await fixture.runtime.command({ type: 'snapshot' }) as RuntimeSnapshot).sessions.find(item => item.parentId === parent.id)!
        taskId = child.taskId!
        fixture.runtime.subscribe(event => {
            if (interrupt && event.sessionId === child.id && event.type === 'agent' && (event.data as { type?: string }).type === (boundary === 'model' ? 'text-delta' : 'tool-start')) {
                interrupt = false; void fixture.runtime.command({ type: 'stop', sessionId: child.id })
            }
        })
        await fixture.runtime.command({ type: 'submit', sessionId: child.id, prompt: 'original child task' }); await fixture.runtime.waitForIdle(child.id)
        const before = await fixture.runtime.command({ type: 'snapshot', sessionId: child.id }) as SessionView
        expect(before.status).toBe('stopped'); expect(before.resumeAvailable).toBe(true)
        await fixture.runtime.command({ type: 'submit', sessionId: parent.id, prompt: 'new parent message' }); await fixture.runtime.waitForIdle(parent.id)
        const after = await fixture.runtime.command({ type: 'snapshot', sessionId: child.id }) as SessionView
        expect(after.messages).toEqual(before.messages); expect(after.pendingMessages).toEqual(before.pendingMessages)
        expect(fixture.requests.some(input => input.messages.at(-1)?.content === 'new child message')).toBe(false)
        const receipt = (await fixture.runtime.command({ type: 'snapshot', sessionId: parent.id }) as SessionView).messages.find(item => item.message.role === 'tool' && item.message.toolCallId === 'send')
        expect(receipt?.message.content).toContain('恢复')
        await fixture.runtime.command({ type: 'resume', sessionId: child.id, mode: 'replan' }); await fixture.runtime.waitForIdle(child.id)
        expect((await fixture.runtime.command({ type: 'snapshot', sessionId: child.id }) as SessionView).status).toBe('idle')
    } finally { await fixture.close() }
})

it('forks a persisted idle child, wakes it through the same Host and keeps child replies out of the parent archive', async () => {
    const fixture = await synthetic((input, index) => index === 1 ? { calls: [{ id: 'fork-id', name: 'subagent_start', input: { mode: 'fork' } }] } :
        { text: input.messages.at(-1)?.content === 'review this' ? 'child review' : 'parent done' })
    try {
        const parent = await fixture.runtime.command({ type: 'create', title: 'Parent' }) as SessionView
        await fixture.runtime.command({ type: 'submit', sessionId: parent.id, prompt: 'preserve this plan' }); await fixture.runtime.waitForIdle(parent.id)
        const snapshot = await fixture.runtime.command({ type: 'snapshot' }) as RuntimeSnapshot
        const child = snapshot.sessions.find(item => item.parentId === parent.id)
        expect(child).toBeDefined(); expect(child?.status).toBe('idle'); expect(fixture.requests).toHaveLength(2)
        const childBefore = await fixture.runtime.command({ type: 'snapshot', sessionId: child!.id }) as SessionView
        expect(childBefore.messages.map(item => item.message.content)).toEqual(['preserve this plan'])
        await fixture.runtime.command({ type: 'submit', sessionId: child!.id, prompt: 'review this', messageId: 'stable-child-message' }); await fixture.runtime.waitForIdle(child!.id)
        const childAfter = await fixture.runtime.command({ type: 'snapshot', sessionId: child!.id }) as SessionView
        expect(childAfter.messages.map(item => item.message.content)).toEqual(['preserve this plan', 'review this', 'child review'])
        expect(childAfter.messages.map(item => item.origin)).toEqual(['human', 'human', 'assistant'])
        const requestCount = fixture.requests.length
        await fixture.runtime.command({ type: 'submit', sessionId: child!.id, prompt: 'review this', messageId: 'stable-child-message' }); await fixture.runtime.waitForIdle(child!.id)
        expect(fixture.requests).toHaveLength(requestCount)
        const parentAfter = await fixture.runtime.command({ type: 'snapshot', sessionId: parent.id }) as SessionView
        expect(parentAfter.messages.some(item => item.message.content === 'child review')).toBe(false)
        await fixture.restart()
        expect((await fixture.runtime.command({ type: 'snapshot', sessionId: child!.id }) as SessionView).messages).toEqual(childAfter.messages)
    } finally { await fixture.close() }
})

it('keeps a failed child tool-send admission out of the executable child Inbox', async () => {
    let taskId = ''
    const fixture = await synthetic((input, index) => index === 1 ? { calls: [{ id: 'fork', name: 'subagent_start', input: {} }] } : input.messages.at(-1)?.content === 'send rejected child message' ?
        { calls: [{ id: 'send', name: 'subagent_send', input: { taskId, prompt: 'must not execute' } }] } : { text: 'parent done' })
    const original = SessionJournal.prototype.append
    let fail = true
    const spy = vi.spyOn(SessionJournal.prototype, 'append').mockImplementation(function (this: SessionJournal, id, record) {
        if (fail && record.kind === 'state' && (record.state as { metadata: { parentId?: string }; inbox: { messages: unknown[] } }).metadata.parentId && (record.state as { inbox: { messages: unknown[] } }).inbox.messages.length) {
            fail = false; return Promise.reject(new Error('Synthetic child admission failure'))
        }
        return original.call(this, id, record)
    })
    try {
        const parent = await fixture.runtime.command({ type: 'create' }) as SessionView
        await fixture.runtime.command({ type: 'submit', sessionId: parent.id, prompt: 'original plan' }); await fixture.runtime.waitForIdle(parent.id)
        const child = (await fixture.runtime.command({ type: 'snapshot' }) as RuntimeSnapshot).sessions.find(item => item.parentId === parent.id)!
        taskId = child.taskId!
        await fixture.runtime.command({ type: 'submit', sessionId: parent.id, prompt: 'send rejected child message' }); await fixture.runtime.waitForIdle(parent.id)
        const childAfter = await fixture.runtime.command({ type: 'snapshot', sessionId: child.id }) as SessionView
        expect(childAfter.pendingMessages).toHaveLength(0); expect(childAfter.messages).toHaveLength(0)
        expect(fixture.requests.some(input => input.messages.at(-1)?.content === 'must not execute')).toBe(false)
    } finally { spy.mockRestore(); await fixture.close() }
})

it('does not let an old child result conceal a cancelled admission after interrupted startup and graceful shutdown', async () => {
    let taskId = ''
    const fixture = await synthetic((input, index) => index === 1 ? { calls: [{ id: 'fork', name: 'subagent_start', input: {} }] } : input.messages.at(-1)?.content === 'wait for preserved child' ?
        { calls: [{ id: `wait-${index}`, name: 'subagent_wait', input: { taskId } }] } : { text: input.messages.at(-1)?.content === 'old child task' ? 'old child answer' : input.messages.at(-1)?.content === 'new admitted child task' ? 'new child answer' : 'parent done' })
    try {
        const parent = await fixture.runtime.command({ type: 'create' }) as SessionView
        await fixture.runtime.command({ type: 'submit', sessionId: parent.id, prompt: 'original plan' }); await fixture.runtime.waitForIdle(parent.id)
        const child = (await fixture.runtime.command({ type: 'snapshot' }) as RuntimeSnapshot).sessions.find(item => item.parentId === parent.id)!
        taskId = child.taskId!
        await fixture.runtime.command({ type: 'submit', sessionId: child.id, prompt: 'old child task' }); await fixture.runtime.waitForIdle(child.id)
        const original = SessionJournal.prototype.append
        let fail = true
        const spy = vi.spyOn(SessionJournal.prototype, 'append').mockImplementation(function (this: SessionJournal, id, record) {
            if (fail && id === child.id && record.kind === 'state' && (record.state as { status: string }).status === 'running') { fail = false; return Promise.reject(new Error('Synthetic child startup failure')) }
            return original.call(this, id, record)
        })
        try {
            await fixture.runtime.command({ type: 'submit', sessionId: child.id, prompt: 'new admitted child task' })
            await expect.poll(async () => (await fixture.runtime.command({ type: 'snapshot', sessionId: child.id }) as SessionView).status).toBe('error')
        } finally { spy.mockRestore() }
        await fixture.restart()
        await fixture.runtime.command({ type: 'submit', sessionId: parent.id, prompt: 'wait for preserved child' }); await fixture.runtime.waitForIdle(parent.id)
        const after = await fixture.runtime.command({ type: 'snapshot', sessionId: parent.id }) as SessionView
        const waiting = [...after.messages].reverse().find(item => item.message.role === 'tool' && item.message.toolName === 'subagent_wait')!
        expect(JSON.parse(waiting.message.content)).toMatchObject({ status: 'cancelled', taskId, name: child.name }); expect(waiting.message.content).not.toContain('old child answer')
        const pending = await fixture.runtime.command({ type: 'snapshot', sessionId: child.id }) as SessionView
        expect(pending.resumeAvailable).toBe(false); expect(pending.pendingMessages).toHaveLength(0)
        await fixture.runtime.command({ type: 'submit', sessionId: child.id, prompt: 'new admitted child task' }); await fixture.runtime.waitForIdle(child.id)
        expect((await fixture.runtime.command({ type: 'snapshot', sessionId: child.id }) as SessionView).messages.at(-1)?.message.content).toBe('new child answer')
    } finally { await fixture.close() }
})

it.each(['config', 'restart'] as const)('keeps the parent task capability after %s and streams real child events to its parent', async transition => {
    let taskId = ''
    const fixture = await synthetic((input, index) => {
        const last = input.messages.at(-1)
        if (index === 1) return { calls: [{ id: 'passive-fork', name: 'subagent_start', input: { mode: 'fork' } }] }
        if (last?.content === 'wake preserved reviewer') return { calls: [{ id: 'send-review', name: 'subagent_send', input: { taskId, prompt: 'review preserved plan' } }, { id: 'wait-review', name: 'subagent_wait', input: { taskId } }] }
        return { text: last?.content === 'review preserved plan' ? 'verified child review' : 'parent complete' }
    })
    try {
        const parent = await fixture.runtime.command({ type: 'create' }) as SessionView
        await fixture.runtime.command({ type: 'submit', sessionId: parent.id, prompt: 'original plan' }); await fixture.runtime.waitForIdle(parent.id)
        const child = (await fixture.runtime.command({ type: 'snapshot' }) as RuntimeSnapshot).sessions.find(item => item.parentId === parent.id)!
        taskId = child.taskId!
        if (transition === 'restart') await fixture.restart()
        else await fixture.runtime.command({ type: 'config', patch: { approval: 'allow' } })
        await fixture.runtime.command({ type: 'submit', sessionId: parent.id, prompt: 'wake preserved reviewer' }); await fixture.runtime.waitForIdle(parent.id)
        const after = await fixture.runtime.command({ type: 'snapshot', sessionId: parent.id }) as SessionView
        const receipts = after.messages.filter(item => item.message.role === 'tool' && item.message.toolCallId === 'wait-review')
        expect(receipts).toHaveLength(1); expect(receipts[0]?.message.content).toContain('verified child review')
        expect(after.messages.some(item => item.message.role === 'assistant' && item.message.content === 'verified child review')).toBe(false)
        const actual = after.events.filter(event => event.type === 'subagent-event')
        expect(actual.some(event => (event.data as { event: { data: { type?: string } } }).event.data.type === 'text-delta')).toBe(true)
        const result = await fixture.runtime.command({ type: 'snapshot', sessionId: child.id }) as SessionView
        expect(result.messages.map(item => item.message.content)).toEqual(['original plan', 'review preserved plan', 'verified child review'])
    } finally { await fixture.close() }
})
