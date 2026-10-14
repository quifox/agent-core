import { expect, it, vi } from 'vitest'
import { readFile, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import type { SessionView } from '../src/protocol.js'
import { synthetic } from './synthetic.js'
import { SessionJournal } from '../src/journal.js'

it('restores a missing compaction observation from its durable state without another model request', async () => {
    const fixture = await synthetic(input => ({ text: input.messages.at(-1)?.content.includes('当前请求用于生成会话检查点') ? 'Restored checkpoint evidence.' : 'normal' }), config => { config.compaction.compactTokens = 45_000; config.plugins.workflows = false; config.plugins.ragflow = false })
    try {
        const session = await fixture.runtime.command({ type: 'create' }) as SessionView
        for (let index = 0; index < 5; index += 1) { await fixture.runtime.command({ type: 'submit', sessionId: session.id, prompt: `${index} ${'x'.repeat(10_000)}` }); await fixture.runtime.waitForIdle(session.id) }
        await fixture.runtime.close()
        const path = join(fixture.root, 'sessions', `${session.id}.jsonl`)
        const records = (await readFile(path, 'utf8')).trim().split('\n').map(line => JSON.parse(line) as { kind: string; event?: { type: string } })
        await writeFile(path, records.filter(record => record.kind !== 'event' || record.event?.type !== 'compaction').map(record => JSON.stringify(record)).join('\n') + '\n')
        const requests = fixture.requests.length
        await fixture.restart()
        const recovered = await fixture.runtime.command({ type: 'snapshot', sessionId: session.id }) as SessionView
        expect(recovered.events.filter(event => event.type === 'compaction')).toHaveLength(1)
        expect(recovered.events.find(event => event.type === 'compaction')?.data).toMatchObject({ status: 'committed', restored: true, summary: 'Restored checkpoint evidence.' })
        expect(fixture.requests).toHaveLength(requests)
        await fixture.restart()
        expect((await fixture.runtime.command({ type: 'snapshot', sessionId: session.id }) as SessionView).events.filter(event => event.type === 'compaction')).toHaveLength(1)
    } finally { await fixture.close() }
})

it('keeps a durable compaction committed when its subsequent observation event cannot be written', async () => {
    let summaries = 0, fail = true
    const fixture = await synthetic(input => {
        if (input.messages.at(-1)?.content.includes('当前请求用于生成会话检查点')) { summaries += 1; return { text: 'Durable compact checkpoint.' } }
        return { text: 'normal' }
    }, config => { config.compaction.compactTokens = 45_000; config.plugins.workflows = false; config.plugins.ragflow = false })
    const original = SessionJournal.prototype.append
    const spy = vi.spyOn(SessionJournal.prototype, 'append').mockImplementation(function (this: SessionJournal, id, record) {
        if (fail && record.kind === 'event' && (record.event as { type?: string }).type === 'compaction') { fail = false; return Promise.reject(new Error('Synthetic observation failure')) }
        return original.call(this, id, record)
    })
    try {
        const session = await fixture.runtime.command({ type: 'create' }) as SessionView
        const prompts = ['first', 'second', 'third', 'fourth', 'fifth'].map(label => `${label} ${'x'.repeat(10_000)}`)
        for (const prompt of prompts) { await fixture.runtime.command({ type: 'submit', sessionId: session.id, prompt }); await fixture.runtime.waitForIdle(session.id) }
        const view = await fixture.runtime.command({ type: 'snapshot', sessionId: session.id }) as SessionView
        expect(fail).toBe(false); expect(view.status).toBe('idle'); expect(summaries).toBe(1)
        expect(fixture.requests.at(-1)?.messages.some(message => message.content.includes('Durable compact checkpoint.'))).toBe(true)
        expect(view.messages.filter(item => item.message.role === 'user').map(item => item.message.content)).toEqual(prompts)
        expect(view.events.filter(event => event.type === 'compaction')).toHaveLength(1)
        await fixture.restart()
        expect((await fixture.runtime.command({ type: 'snapshot', sessionId: session.id }) as SessionView).messages).toEqual(view.messages)
    } finally { spy.mockRestore(); await fixture.close() }
})

it('keeps the original request recoverable when the first paired compaction write fails', async () => {
    let summaries = 0, fail = true
    const fixture = await synthetic(input => {
        if (input.messages.at(-1)?.content.includes('当前请求用于生成会话检查点')) { summaries += 1; return { text: 'Synthetic compact checkpoint.' } }
        return { text: 'normal' }
    }, config => { config.compaction.compactTokens = 45_000 })
    const original = SessionJournal.prototype.append
    const spy = vi.spyOn(SessionJournal.prototype, 'append').mockImplementation(function (this: SessionJournal, id, record) {
        if (fail && record.kind === 'state' && (record.state as { session: { history: { compaction?: unknown }[] } }).session.history.some(item => item.compaction)) {
            fail = false; return Promise.reject(new Error('Synthetic compaction commit failure'))
        }
        return original.call(this, id, record)
    })
    try {
        const session = await fixture.runtime.command({ type: 'create' }) as SessionView
        const prompts = ['first', 'second', 'third', 'fourth', 'fifth'].map(label => `${label} ${'x'.repeat(10_000)}`)
        let accepted = 0
        for (const prompt of prompts) {
            accepted += 1; await fixture.runtime.command({ type: 'submit', sessionId: session.id, prompt }); await fixture.runtime.waitForIdle(session.id)
            if (!fail) break
        }
        const failed = await fixture.runtime.command({ type: 'snapshot', sessionId: session.id }) as SessionView
        expect(fail).toBe(false); expect(failed.status).toBe('error'); expect(failed.resumeAvailable).toBe(true)
        expect(failed.events.some(event => event.type === 'compaction')).toBe(false)
        await fixture.restart()
        await fixture.runtime.command({ type: 'resume', sessionId: session.id, mode: 'continue' }); await fixture.runtime.waitForIdle(session.id)
        const recovered = await fixture.runtime.command({ type: 'snapshot', sessionId: session.id }) as SessionView
        expect(recovered.status).toBe('idle'); expect(summaries).toBeGreaterThanOrEqual(2)
        expect(recovered.messages.filter(item => item.message.role === 'user').map(item => item.message.content)).toEqual(prompts.slice(0, accepted))
        expect(recovered.events.filter(event => event.type === 'compaction')).toHaveLength(1)
    } finally { spy.mockRestore(); await fixture.close() }
})

it('commits a valid compacted model projection while retaining original messages and their JSONL evidence', async () => {
    let summaries = 0
    const fixture = await synthetic(input => {
        if (input.messages.at(-1)?.content.includes('当前请求用于生成会话检查点')) { summaries += 1; return { text: 'Preserved original human constraints and completed work.' } }
        return { text: 'normal' }
    }, config => { config.compaction.compactTokens = 45_000 })
    try {
        const session = await fixture.runtime.command({ type: 'create' }) as SessionView
        const prompts = ['first', 'second', 'third', 'fourth', 'fifth'].map(label => `${label} ${'x'.repeat(10_000)}`)
        for (const prompt of prompts) { await fixture.runtime.command({ type: 'submit', sessionId: session.id, prompt }); await fixture.runtime.waitForIdle(session.id) }
        const view = await fixture.runtime.command({ type: 'snapshot', sessionId: session.id }) as SessionView
        expect(view.status).toBe('idle'); expect(summaries).toBeGreaterThan(0)
        expect(view.messages.filter(item => item.message.role === 'user').map(item => item.message.content)).toEqual(prompts)
        expect(view.events.some(event => event.type === 'compaction' && (event.data as { status?: string }).status === 'committed')).toBe(true)
        const archive = await readFile(join(fixture.root, 'sessions', `${session.id}.jsonl`), 'utf8')
        expect(archive).toContain(prompts[0]); expect(archive).toContain('Preserved original human constraints')
        expect(fixture.requests.at(-1)?.messages.some(message => message.content.includes('Preserved original human constraints'))).toBe(true)
        await fixture.restart()
        expect((await fixture.runtime.command({ type: 'snapshot', sessionId: session.id }) as SessionView).messages).toEqual(view.messages)
    } finally { await fixture.close() }
})
