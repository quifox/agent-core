import { expect, it, vi } from 'vitest'
import { readFile } from 'node:fs/promises'
import { join } from 'node:path'
import type { SessionView } from '../src/protocol.js'
import { SessionJournal } from '../src/journal.js'
import { synthetic } from './synthetic.js'

it('identifies recovery by its durable tool batch when a model reuses a call ID', async () => {
    let starts = 0
    const fixture = await synthetic((_input, index) => index <= 2 ? { calls: [{ id: 'reused', name: 'list_files', input: {} }] } : { text: 'recovered' })
    try {
        const session = await fixture.runtime.command({ type: 'create' }) as SessionView
        fixture.runtime.subscribe(event => {
            if (event.sessionId === session.id && event.type === 'agent' && (event.data as { type?: string }).type === 'tool-start' && ++starts === 2) void fixture.runtime.command({ type: 'stop', sessionId: session.id })
        })
        await fixture.runtime.command({ type: 'submit', sessionId: session.id, prompt: 'two batches' }); await fixture.runtime.waitForIdle(session.id)
        await fixture.runtime.command({ type: 'resume', sessionId: session.id, mode: 'replan' }); await fixture.runtime.waitForIdle(session.id)
        const view = await fixture.runtime.command({ type: 'snapshot', sessionId: session.id }) as SessionView
        const observed = view.events.filter(event => event.type === 'agent' && (event.data as { type?: string }).type === 'tool-start')
        const receipt = view.events.filter(event => event.type === 'agent' && (event.data as { type?: string }).type === 'tool-result').at(-1)
        expect(observed).toHaveLength(2)
        expect(observed[0]?.operationId).toBeDefined(); expect(observed[1]?.operationId).toBeDefined()
        expect(observed[0]?.operationId).not.toBe(observed[1]?.operationId)
        expect(receipt?.operationId).toBe(observed[1]?.operationId)
    } finally { await fixture.close() }
})

it.each(['continue', 'replan'] as const)('resumes sealed interrupted tool batches with %s and rejects concurrent resume', async mode => {
    const fixture = await synthetic((_input, index) => index === 1 ? { calls: [
        { id: 'write-once', name: 'write_file', input: { path: 'receipt.txt', content: 'original effect' } },
        { id: 'read-original', name: 'read_file', input: { path: 'receipt.txt' } }
    ] } : { text: 'restored' }, config => { config.approval = 'allow' })
    try {
        const session = await fixture.runtime.command({ type: 'create' }) as SessionView
        fixture.runtime.subscribe(event => {
            if (event.type === 'agent' && (event.data as { type?: string }).type === 'tool-result') void fixture.runtime.command({ type: 'stop', sessionId: session.id })
        })
        await fixture.runtime.command({ type: 'submit', sessionId: session.id, prompt: 'write then read' }); await fixture.runtime.waitForIdle(session.id)
        const paused = await fixture.runtime.command({ type: 'snapshot', sessionId: session.id }) as SessionView
        expect(paused.status).toBe('stopped'); expect(paused.resumeAvailable).toBe(true)
        expect(paused.messages.filter(item => item.message.role === 'tool')).toHaveLength(2)
        await fixture.runtime.command({ type: 'submit', sessionId: session.id, prompt: 'queued follow-up', mode: 'queue' })
        await fixture.restart()
        const resumes = await Promise.allSettled([fixture.runtime.command({ type: 'resume', sessionId: session.id, mode }), fixture.runtime.command({ type: 'resume', sessionId: session.id, mode })])
        expect(resumes.filter(item => item.status === 'fulfilled')).toHaveLength(1)
        await fixture.runtime.waitForIdle(session.id)
        expect(await readFile(join(fixture.root, 'receipt.txt'), 'utf8')).toBe('original effect')
        const restored = await fixture.runtime.command({ type: 'snapshot', sessionId: session.id }) as SessionView
        expect(restored.status).toBe('idle'); expect(fixture.requests).toHaveLength(3)
        const queued = restored.messages.findIndex(item => item.message.content === 'queued follow-up')
        const receipt = restored.messages.findIndex(item => item.message.role === 'tool' && item.message.toolCallId === 'read-original')
        expect(queued).toBeGreaterThan(receipt)
        expect(restored.messages.filter(item => item.message.role === 'assistant' && item.message.toolCalls?.length)).toHaveLength(1)
        const tool = restored.messages.find(item => item.message.role === 'tool' && item.message.toolCallId === 'read-original')?.message
        expect(tool?.content).toMatch(/not executed|未执行|未启动/)
    } finally { await fixture.close() }
})

it.each([false, true])('does not execute rejected nondurable admission, including concurrent retry=%s', async concurrent => {
    const fixture = await synthetic(() => ({ text: 'accepted once' }))
    const original = SessionJournal.prototype.append
    let fail = true
    const spy = vi.spyOn(SessionJournal.prototype, 'append').mockImplementation(function (this: SessionJournal, id, record) {
        if (fail && record.kind === 'state' && (record.state as { inbox: { messages: { id: string }[] } }).inbox.messages.some(item => item.id === 'failed')) {
            fail = false; return Promise.reject(new Error('Synthetic admission write failure'))
        }
        return original.call(this, id, record)
    })
    try {
        const session = await fixture.runtime.command({ type: 'create' }) as SessionView
        const first = fixture.runtime.command({ type: 'submit', sessionId: session.id, prompt: 'original draft', messageId: 'failed' }).catch(error => error as Error)
        if (concurrent) await fixture.runtime.command({ type: 'submit', sessionId: session.id, prompt: 'original draft', messageId: 'retry' })
        expect(await first).toMatchObject({ message: 'Synthetic admission write failure' })
        if (!concurrent) {
            const unchanged = await fixture.runtime.command({ type: 'snapshot', sessionId: session.id }) as SessionView
            expect(unchanged.pendingMessages).toHaveLength(0); expect(unchanged.title).toBe('New session'); expect(unchanged.resumeAvailable).toBe(false)
            await fixture.runtime.command({ type: 'submit', sessionId: session.id, prompt: 'original draft', messageId: 'retry' })
        }
        await fixture.runtime.waitForIdle(session.id)
        const completed = await fixture.runtime.command({ type: 'snapshot', sessionId: session.id }) as SessionView
        expect(completed.messages.map(item => item.message.content)).toEqual(['original draft', 'accepted once'])
        expect(fixture.requests).toHaveLength(1)
        await fixture.restart()
        expect((await fixture.runtime.command({ type: 'snapshot', sessionId: session.id }) as SessionView).messages).toEqual(completed.messages)
    } finally { spy.mockRestore(); await fixture.close() }
})

it('closes the actual Core stream after observer persistence failure and resumes accepted model input once', async () => {
    const fixture = await synthetic(() => ({ text: 'answer' }))
    const original = SessionJournal.prototype.append
    let fail = true
    const spy = vi.spyOn(SessionJournal.prototype, 'append').mockImplementation(function (this: SessionJournal, id, record) {
        if (fail && record.kind === 'event' && (record.event as { data?: { type?: string } }).data?.type === 'text-delta') {
            fail = false; return Promise.reject(new Error('Synthetic journal failure'))
        }
        return original.call(this, id, record)
    })
    try {
        const session = await fixture.runtime.command({ type: 'create' }) as SessionView
        await fixture.runtime.command({ type: 'submit', sessionId: session.id, prompt: 'original input' }); await fixture.runtime.waitForIdle(session.id)
        const failed = await fixture.runtime.command({ type: 'snapshot', sessionId: session.id }) as SessionView
        expect(failed.status).toBe('error'); expect(failed.resumeAvailable).toBe(true)
        await fixture.runtime.command({ type: 'resume', sessionId: session.id, mode: 'continue' }); await fixture.runtime.waitForIdle(session.id)
        const completed = await fixture.runtime.command({ type: 'snapshot', sessionId: session.id }) as SessionView
        expect(completed.status).toBe('idle')
        expect(completed.messages.map(item => item.message.content)).toEqual(['original input', 'answer'])
        expect(fixture.requests).toHaveLength(2)
    } finally { spy.mockRestore(); await fixture.close() }
})

it('keeps an acknowledged but unstarted inbox message available for explicit recovery', async () => {
    const fixture = await synthetic(() => ({ text: 'retried' }))
    const original = SessionJournal.prototype.append
    let fail = true
    const spy = vi.spyOn(SessionJournal.prototype, 'append').mockImplementation(function (this: SessionJournal, id, record) {
        if (fail && record.kind === 'state' && (record.state as { status?: string }).status === 'running') { fail = false; return Promise.reject(new Error('Synthetic pre-start failure')) }
        return original.call(this, id, record)
    })
    try {
        const session = await fixture.runtime.command({ type: 'create' }) as SessionView
        await fixture.runtime.command({ type: 'submit', sessionId: session.id, prompt: 'retained input' }); await fixture.runtime.waitForIdle(session.id)
        expect(fixture.requests).toHaveLength(0)
        await fixture.restart()
        const restored = await fixture.runtime.command({ type: 'snapshot', sessionId: session.id }) as SessionView
        expect(restored.resumeAvailable).toBe(true); expect(restored.pendingMessages).toHaveLength(1)
        await fixture.runtime.command({ type: 'resume', sessionId: session.id, mode: 'continue' }); await fixture.runtime.waitForIdle(session.id)
        const completed = await fixture.runtime.command({ type: 'snapshot', sessionId: session.id }) as SessionView
        expect(completed.messages.map(item => item.message.content)).toEqual(['retained input', 'retried'])
    } finally { spy.mockRestore(); await fixture.close() }
})
