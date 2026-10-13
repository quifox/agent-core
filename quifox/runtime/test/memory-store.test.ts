import { expect, it } from 'vitest'
import { mkdtemp, readFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { emptyMemoryState } from '@quifox/agent-plugin-memory'
import { FileMemoryStore } from '../src/memory-store.js'

it('atomically isolates owners and rejects a stale memory writer', async () => {
    const root = await mkdtemp(join(tmpdir(), 'quifox-memory-'))
    try {
        const store = new FileMemoryStore(root)
        const one = { ...emptyMemoryState(), revision: 1, global: 'Owned fact' }
        expect(await store.compareAndSet('owner-one', 0, one)).toBe(true)
        expect(await store.compareAndSet('owner-one', 0, { ...one, global: 'Stale fact' })).toBe(false)
        expect((await store.load('owner-one')).global).toBe('Owned fact')
        expect((await store.load('owner-two')).global).toBe('')
        expect(await readFile(join(store.directory('owner-one'), 'memory.md'), 'utf8')).toBe('Owned fact')
    } finally { await rm(root, { recursive: true, force: true }) }
})
