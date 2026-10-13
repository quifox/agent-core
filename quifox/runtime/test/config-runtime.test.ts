import { expect, it, vi } from 'vitest'
import { readFile } from 'node:fs/promises'
import { join } from 'node:path'
import * as projectFiles from '../src/project-files.js'
import type { RuntimeSnapshot, SessionView } from '../src/protocol.js'
import { synthetic } from './synthetic.js'

it('blocks Memory admission throughout a configuration transaction and commits only after candidate composition', async () => {
    const fixture = await synthetic(() => ({ text: 'unused' }), config => { config.memory.generate = true })
    const original = projectFiles.createProjectFiles
    let enter!: () => void, release!: () => void
    const entered = new Promise<void>(resolve => { enter = resolve }), gate = new Promise<void>(resolve => { release = resolve })
    const session = await fixture.runtime.command({ type: 'create' }) as SessionView
    const before = (await fixture.runtime.command({ type: 'snapshot' }) as RuntimeSnapshot).configurationRevision
    const spy = vi.spyOn(projectFiles, 'createProjectFiles').mockImplementation(async (...args) => { enter(); await gate; return original(...args) })
    const updating = fixture.runtime.command({ type: 'config', patch: { memory: { generate: false } } })
    try {
        await entered
        await expect(fixture.runtime.command({ type: 'memory', sessionId: session.id })).rejects.toThrow('配置正在更新')
        const diagnostics = await readFile(join(fixture.root, 'logs', `runtime-${process.pid}.log`), 'utf8')
        expect(diagnostics.split('\n').filter(Boolean).map(line => JSON.parse(line))).toContainEqual(expect.objectContaining({ action: 'memory', error: expect.objectContaining({ message: '配置正在更新，请稍后重试。' }) }))
        expect((await fixture.runtime.command({ type: 'snapshot' }) as RuntimeSnapshot).config.memory.generate).toBe(true)
        release(); await updating
        const snapshot = await fixture.runtime.command({ type: 'snapshot' }) as RuntimeSnapshot
        expect(snapshot.config.memory.generate).toBe(false)
        expect(snapshot.configurationRevision).toMatch(/^[a-f0-9]{64}$/)
        expect(snapshot.configurationRevision).not.toBe(before)
        expect(fixture.requests).toHaveLength(0)
    } finally { release(); await updating.catch(() => {}); spy.mockRestore(); await fixture.close() }
})

it('preserves every old entry and stored config when a later candidate cannot be composed', async () => {
    const fixture = await synthetic(() => ({ text: 'unchanged' }))
    const original = projectFiles.createProjectFiles
    try {
        await fixture.runtime.command({ type: 'create', title: 'First' }); await fixture.runtime.command({ type: 'create', title: 'Second' })
        let compositions = 0
        const spy = vi.spyOn(projectFiles, 'createProjectFiles').mockImplementation(async (...args) => {
            if (++compositions === 2) throw new Error('Synthetic candidate failure')
            return original(...args)
        })
        try { await expect(fixture.runtime.command({ type: 'config', patch: { approval: 'allow' } })).rejects.toThrow('candidate failure') }
        finally { spy.mockRestore() }
        const snapshot = await fixture.runtime.command({ type: 'snapshot' }) as RuntimeSnapshot
        expect(snapshot.config.approval).toBe('ask'); expect(snapshot.sessions.map(session => session.title)).toEqual(['First', 'Second'])
        expect(JSON.parse(await readFile(join(fixture.root, 'config.json'), 'utf8'))).toMatchObject({ approval: 'ask' })
    } finally { await fixture.close() }
})

it('refreshes model capacities on existing sessions and supports clearing optional compaction overrides', async () => {
    const fixture = await synthetic(() => ({ text: 'capacity observed' }), config => { config.compaction.compactTokens = 50_000 })
    const original = globalThis.fetch
    const spy = vi.spyOn(globalThis, 'fetch').mockImplementation((input, init) => String(input) === 'https://models.dev/api.json' ?
        Promise.resolve(new Response(JSON.stringify({ synthetic: { models: { synthetic: { limit: { context: 60_000, input: 40_000, output: 512 } } } } }), { headers: { 'content-type': 'application/json' } })) : original(input, init))
    try {
        const session = await fixture.runtime.command({ type: 'create' }) as SessionView
        await fixture.runtime.command({ type: 'refresh-models' })
        await fixture.runtime.command({ type: 'config', patch: { compaction: { compactTokens: null } } })
        await fixture.runtime.command({ type: 'submit', sessionId: session.id, prompt: 'use refreshed capacities' }); await fixture.runtime.waitForIdle(session.id)
        const view = await fixture.runtime.command({ type: 'snapshot', sessionId: session.id }) as SessionView
        const info = view.events.find(event => event.type === 'agent' && (event.data as { type?: string }).type === 'model-info')?.data
        expect(info).toMatchObject({ model: { contextWindow: 60_000, maxInputTokens: 40_000 } })
        expect((await fixture.runtime.command({ type: 'snapshot' }) as RuntimeSnapshot).config.compaction.compactTokens).toBeUndefined()
    } finally { spy.mockRestore(); await fixture.close() }
})
