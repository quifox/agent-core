import { expect, it, vi } from 'vitest'
import { readdir } from 'node:fs/promises'
import { SessionJournal } from '../src/journal.js'
import { FileMemoryStore } from '../src/memory-store.js'
import { synthetic } from './synthetic.js'

it('releases a new session lease when critical creation persistence fails', async () => {
    const fixture = await synthetic(() => ({ text: 'must not run' }))
    const original = SessionJournal.prototype.append
    let fail = true
    const spy = vi.spyOn(SessionJournal.prototype, 'append').mockImplementation(function (this: SessionJournal, id, record) {
        if (fail && record.kind === 'state') { fail = false; return Promise.reject(new Error('Synthetic creation failure')) }
        return original.call(this, id, record)
    })
    try {
        await expect(fixture.runtime.command({ type: 'create' })).rejects.toThrow('Synthetic creation failure')
        expect((await readdir(fixture.runtime.paths.sessions)).filter(path => path.endsWith('.lock'))).toHaveLength(0)
        await fixture.runtime.command({ type: 'create' })
        expect(fixture.requests).toHaveLength(0)
    } finally { spy.mockRestore(); await fixture.close() }
})

it('serializes independent Memory store instances so exactly one CAS wins the same owner revision', async () => {
    const fixture = await synthetic(() => ({ text: 'unused' }))
    try {
        const stores = [new FileMemoryStore(fixture.runtime.paths.memory), new FileMemoryStore(fixture.runtime.paths.memory)]
        const original = await stores[0]!.load('same-owner')
        const result = await Promise.all(stores.map((store, index) => store.compareAndSet('same-owner', 0, { ...original, revision: 1, global: `winner-${index}` })))
        expect(result.filter(Boolean)).toHaveLength(1)
        expect(await stores[0]!.load('same-owner')).toMatchObject({ revision: 1, global: `winner-${result.indexOf(true)}` })
    } finally { await fixture.close() }
})
