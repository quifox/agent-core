import { expect, it, vi } from 'vitest'
import { readFile } from 'node:fs/promises'
import { join } from 'node:path'
import type { SessionView } from '../src/protocol.js'
import { SessionJournal } from '../src/journal.js'
import { synthetic } from './synthetic.js'

it('never retries an unsafe unknown call on continue; replan records the original unknown receipt before the next request', async () => {
    const fixture = await synthetic((_input, index) => index === 1 ? { calls: [{ id: 'unknown-original', name: 'write_file', input: { path: 'never.txt', content: 'unsafe' } }] } : { text: 'replanned' }, config => { config.approval = 'allow' })
    const original = SessionJournal.prototype.append
    let fail = true
    let replanFail = true
    const spy = vi.spyOn(SessionJournal.prototype, 'append').mockImplementation(function (this: SessionJournal, id, record) {
        if (fail && record.kind === 'state' && (record.state as { checkpoint?: { calls: { status: string }[] } }).checkpoint?.calls.some(call => call.status === 'started')) {
            fail = false; return Promise.reject(new Error('Synthetic pre-effect storage failure'))
        }
        if (replanFail && record.kind === 'state' && (record.state as { checkpoint?: { calls: { status: string }[] }; session: { history: { message: { role: string; toolCallId?: string } }[] } }).checkpoint?.calls.every(call => call.status === 'completed') &&
            (record.state as { session: { history: { message: { role: string; toolCallId?: string } }[] } }).session.history.some(item => item.message.role === 'tool' && item.message.toolCallId === 'unknown-original')) {
            replanFail = false; return Promise.reject(new Error('Synthetic replan receipt write failure'))
        }
        return original.call(this, id, record)
    })
    try {
        const session = await fixture.runtime.command({ type: 'create' }) as SessionView
        await fixture.runtime.command({ type: 'submit', sessionId: session.id, prompt: 'unsafe write' }); await fixture.runtime.waitForIdle(session.id)
        await fixture.restart()
        await fixture.runtime.command({ type: 'resume', sessionId: session.id, mode: 'continue' }); await fixture.runtime.waitForIdle(session.id)
        expect(fixture.requests).toHaveLength(1)
        await expect(readFile(join(fixture.root, 'never.txt'))).rejects.toMatchObject({ code: 'ENOENT' })
        await expect(fixture.runtime.command({ type: 'resume', sessionId: session.id, mode: 'replan' })).rejects.toThrow('replan receipt write')
        expect((await fixture.runtime.command({ type: 'snapshot', sessionId: session.id }) as SessionView).toolStates).toEqual([{ id: 'unknown-original', status: 'started' }])
        await fixture.runtime.command({ type: 'resume', sessionId: session.id, mode: 'replan' }); await fixture.runtime.waitForIdle(session.id)
        const view = await fixture.runtime.command({ type: 'snapshot', sessionId: session.id }) as SessionView
        expect(view.status).toBe('idle'); expect(fixture.requests).toHaveLength(2)
        expect(fixture.requests[1]!.messages.find(message => message.role === 'tool')).toMatchObject({ tool_call_id: 'unknown-original' })
        expect(view.messages.find(entry => entry.message.role === 'tool')?.message.content).toContain('unknown')
        expect(view.events.find(event => event.type === 'tool-recovery')?.data).toMatchObject({ call: { id: 'unknown-original' }, previousStatus: 'started', result: { code: 'TOOL_RESULT_UNKNOWN' } })
    } finally { spy.mockRestore(); await fixture.close() }
})
