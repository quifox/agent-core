import { expect, it } from 'vitest'
import { mkdtemp, readFile, rm, writeFile, stat } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { SessionJournal } from '../src/journal.js'

it('recovers only an incomplete final line and appends complete records in arrival order', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'quifox-journal-'))
    try {
        await writeFile(join(directory, 'session.jsonl'), '{"type":"first"}\n{"type":')
        const journal = new SessionJournal(directory)
        expect(await journal.read('session')).toMatchObject({ records: [{ type: 'first' }], ignoredTail: true })
        await Promise.all([journal.append('session', { type: 'second' }), journal.append('session', { type: 'third' })])
        expect((await journal.read('session')).records).toEqual([{ type: 'first' }, { type: 'second' }, { type: 'third' }])
        expect(await readFile(join(directory, 'session.jsonl'), 'utf8')).toBe('{"type":"first"}\n{"type":"second"}\n{"type":"third"}\n')
    } finally { await rm(directory, { recursive: true, force: true }) }
})

it('rejects a closed corrupt line and prevents session path traversal', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'quifox-journal-'))
    try {
        await writeFile(join(directory, 'bad.jsonl'), '{"type":"first"}\ninvalid\n')
        const journal = new SessionJournal(directory)
        await expect(journal.read('bad')).rejects.toThrow('第 2 行损坏')
        expect(() => journal.path('../escape')).toThrow('identity')
        await writeFile(join(directory, 'complete.jsonl'), '{"type":"first"}')
        await journal.append('complete', { type: 'next' })
        expect((await journal.read('complete')).records).toEqual([{ type: 'first' }, { type: 'next' }])
    } finally { await rm(directory, { recursive: true, force: true }) }
})

it('stores growing state incrementally while replaying exact historical states and recovering a partial delta tail', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'quifox-journal-growth-'))
    try {
        const journal = new SessionJournal(directory), history: { id: string; content: string }[] = []
        for (let revision = 1; revision <= 60; revision += 1) {
            history.push({ id: String(revision), content: `original ${revision}: ${'x'.repeat(2000)}` })
            await journal.append('session', { kind: 'state', state: { metadata: { revision }, history: [...history], flags: { current: revision, keep: 'unchanged' } } })
        }
        const before = await journal.read('session')
        let validated = 0
        const latest = await journal.read('session', { latestStateOnly: true, onState: (_state, line) => { validated += 1; expect(line).toBe(validated) } })
        expect(validated).toBe(60); expect(latest.records).toHaveLength(1); expect(latest.records[0]?.state).toEqual(before.records.at(-1)?.state)
        expect((before.records[0]?.state as { history: unknown[] }).history).toHaveLength(1)
        expect((before.records.at(-1)?.state as { history: unknown[] }).history).toEqual(history)
        expect((await stat(journal.path('session'))).size).toBeLessThan(500_000)
        const raw = await readFile(journal.path('session'), 'utf8')
        expect(raw).toContain('state-delta')
        await writeFile(journal.path('session'), raw + '{"kind":"state-delta"')
        const restarted = new SessionJournal(directory)
        await restarted.append('session', { kind: 'state', state: { metadata: { revision: 61 }, history: [...history], flags: { current: 61 } } })
        expect((await restarted.read('session')).records.at(-1)?.state).toEqual({ metadata: { revision: 61 }, history, flags: { current: 61 } })
    } finally { await rm(directory, { recursive: true, force: true }) }
})

it('rejects a corrupt delta base and safely handles dictionary keys matching object prototype names', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'quifox-journal-delta-'))
    try {
        const journal = new SessionJournal(directory)
        await journal.append('session', { kind: 'state', state: { metadata: { revision: 1 }, values: {} } })
        const values = Object.fromEntries([['__proto__', { synthetic: true }]])
        await journal.append('session', { kind: 'state', state: { metadata: { revision: 2 }, values } })
        expect((await journal.read('session')).records.at(-1)?.state).toEqual({ metadata: { revision: 2 }, values })
        expect(({} as Record<string, unknown>).synthetic).toBeUndefined()
        const raw = await readFile(journal.path('session'), 'utf8')
        await writeFile(journal.path('session'), raw + JSON.stringify({ kind: 'state-delta', version: 1, baseRevision: 1, changes: [] }) + '\n')
        await expect(journal.read('session')).rejects.toThrow('第 3 行损坏')
    } finally { await rm(directory, { recursive: true, force: true }) }
})
