import { afterEach, expect, it, vi } from 'vitest'
import { appendFile, mkdtemp, readFile, rm } from 'node:fs/promises'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { workflowJournal } from '../src/workflow-journal.js'
import { runWorkflow } from '../src/workflow.js'
import { synthetic } from './synthetic.js'
import type { SessionView } from '../src/protocol.js'

const fault = vi.hoisted(() => ({ sync: false, close: false, point: undefined as 'completed-node' | 'completed-run' | undefined, failures: 0 }))
vi.mock('node:fs', async importOriginal => {
    const fs = await importOriginal<typeof import('node:fs')>()
    return { ...fs, writeFileSync: (...args: Parameters<typeof fs.writeFileSync>) => {
        if (fault.point && typeof args[1] === 'string' && args[1].startsWith('{"version":1,"identity":')) {
            const record = JSON.parse(args[1]) as { operation: string; args: Record<string, unknown>[] }
            if (fault.point === 'completed-node' && record.operation === 'putNode' && record.args[0]?.status === 'completed'
                || fault.point === 'completed-run' && record.operation === 'appendEvent' && record.args[1]?.type === 'run-settled' && record.args[1]?.status === 'completed') {
                fault.point = undefined; fault.failures++; throw new Error('Synthetic settlement write failure')
            }
        }
        return fs.writeFileSync(...args)
    }, fsyncSync: (...args: Parameters<typeof fs.fsyncSync>) => {
        if (fault.sync) { fault.failures++; throw Object.assign(new Error('Synthetic disk failure'), { code: 'ENOSPC' }) }
        return fs.fsyncSync(...args)
    }, closeSync: (...args: Parameters<typeof fs.closeSync>) => {
        fs.closeSync(...args)
        if (fault.close) { fault.close = false; fault.failures++; throw new Error('Synthetic close failure') }
    } }
})
afterEach(() => { fault.sync = false; fault.close = false; fault.point = undefined; fault.failures = 0 })

it('repairs only an incomplete WAL tail and replays a completed ask once', async () => {
    const root = await mkdtemp(join(tmpdir(), 'workflow-tail-')), path = join(root, 'checkpoint.jsonl'), identity = 'a'.repeat(64)
    const options = { script: 'return await agent("Answer").ask("question");', args: {}, runId: identity }
    let calls = 0
    try {
        await runWorkflow({ ...options, journal: workflowJournal(path, identity, value => value), ask: async () => { calls++; return 'answer' } })
        const committed = await readFile(path, 'utf8')
        await appendFile(path, '{"version":1,"identity":')
        expect(await runWorkflow({ ...options, journal: workflowJournal(path, identity, value => value), ask: async () => { calls++; return 'duplicate' } })).toBe('answer')
        expect(calls).toBe(1)
        expect((await readFile(path, 'utf8')).startsWith(committed)).toBe(true)
        await appendFile(path, '{bad record}\n')
        expect(() => workflowJournal(path, identity, value => value)).toThrow()
    } finally { await rm(root, { recursive: true, force: true }) }
}, 15000)

it.each(['completed-node', 'completed-run'] as const)('withholds successful graph settlement on %s WAL failure and recovers the committed actor', async point => {
    const fixture = await synthetic(() => ({ text: 'committed actor output' }))
    try {
        const view = await fixture.runtime.command({ type: 'create', workflow: { name: 'settlement', script: 'return await agent("Answer").ask("question");' } }) as SessionView
        fault.point = point
        await fixture.runtime.command({ type: 'submit', sessionId: view.id, prompt: 'question' }); await fixture.runtime.waitForIdle(view.id)
        const stopped = await fixture.runtime.command({ type: 'snapshot', sessionId: view.id }) as SessionView
        expect(fault.failures).toBe(1)
        expect(stopped.status).toBe('error')
        const events = stopped.events.filter(event => event.type === 'workflow').map(event => event.data as { type: string; status?: string; outcome?: string })
        expect(events.some(event => event.type === 'checkpoint-failed')).toBe(true)
        expect(events.some(event => event.type === 'run-settled' && event.status === 'completed')).toBe(false)
        if (point === 'completed-node') expect(events.some(event => event.type === 'node-settled' && event.outcome === 'ok')).toBe(false)
        expect(stopped.messages.filter(message => message.message.role === 'assistant')).toEqual([])
        await fixture.restart()
        await fixture.runtime.command({ type: 'resume', sessionId: view.id, mode: 'replan' }); await fixture.runtime.waitForIdle(view.id)
        expect(fixture.requests).toHaveLength(1)
        expect((await fixture.runtime.command({ type: 'snapshot', sessionId: view.id }) as SessionView).messages.at(-1)?.message.content).toBe('committed actor output')
    } finally { fault.point = undefined; await fixture.close() }
}, 15000)

it.each(['sync', 'close'] as const)('stops the Host on checkpoint %s failure without publishing success or repeating failed writes', async kind => {
    const fixture = await synthetic(() => ({ text: 'must not be requested' }))
    try {
        const view = await fixture.runtime.command({ type: 'create', workflow: { name: 'storage', script: 'return await agent("Answer").ask("question");' } }) as SessionView
        fault[kind] = true
        await fixture.runtime.command({ type: 'submit', sessionId: view.id, prompt: 'question' }); await fixture.runtime.waitForIdle(view.id)
        expect(fault.failures).toBe(1)
        expect(fixture.requests).toHaveLength(0)
        const stopped = await fixture.runtime.command({ type: 'snapshot', sessionId: view.id }) as SessionView
        expect(stopped.status).toBe('error')
        expect(stopped.messages.filter(message => message.message.role === 'assistant')).toEqual([])
        fault.sync = false; fault.close = false
        await fixture.restart()
        await fixture.runtime.command({ type: 'resume', sessionId: view.id, mode: 'replan' }); await fixture.runtime.waitForIdle(view.id)
        expect(fixture.requests).toHaveLength(1)
        expect((await fixture.runtime.command({ type: 'snapshot', sessionId: view.id }) as SessionView).status).toBe('idle')
    } finally { fault.sync = false; fault.close = false; await fixture.close() }
}, 15000)
