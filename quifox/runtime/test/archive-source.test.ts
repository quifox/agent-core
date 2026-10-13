import { expect, it } from 'vitest'
import { readFile } from 'node:fs/promises'
import type { SessionView } from '../src/protocol.js'
import { HostArchive } from '../src/archive.js'
import { SessionJournal } from '../src/journal.js'
import { synthetic } from './synthetic.js'

it('reads exact physical JSONL lines while replaying message records with their original source line', async () => {
    const fixture = await synthetic(() => ({ text: 'original reply' }))
    try {
        const session = await fixture.runtime.command({ type: 'create' }) as SessionView
        await fixture.runtime.command({ type: 'submit', sessionId: session.id, prompt: 'original é 🦊 input' }); await fixture.runtime.waitForIdle(session.id)
        const journal = new SessionJournal(fixture.runtime.paths.sessions), sourceRef = `conversation:${session.id}`
        const archive = new HostArchive(journal, () => [{ ...session, ownerId: 'local', revision: 1, createdAt: session.updatedAt, shortId: 'synthetic', sourceRef, active: false, generateMemory: true }], async () => { throw new Error('unused') })
        const lines = (await readFile(journal.path(session.id), 'utf8')).trimEnd().split('\n')
        const index = lines.findIndex(line => (JSON.parse(line) as { kind: string }).kind === 'state-delta')
        expect(index).toBeGreaterThan(0)
        expect((await archive.read('local', sourceRef, index + 1, 1)).lines).toEqual([lines[index]])
        const records = await archive.records('local', sourceRef)
        expect(records.map(record => record.message.content)).toEqual(['original é 🦊 input', 'original reply'])
        for (const record of records) expect(lines[record.line! - 1]).toContain(JSON.stringify(record.message))
    } finally { await fixture.close() }
})

it('searches physical source title and tool arguments with bounded excerpts and exact line references', async () => {
    const fixture = await synthetic((_input, index) => index === 1 ? { calls: [{ id: 'list', name: 'list_files', input: { path: 'needle-tool-argument' } }] } : { text: 'done' })
    try {
        const session = await fixture.runtime.command({ type: 'create', title: 'needle-title' }) as SessionView
        await fixture.runtime.command({ type: 'submit', sessionId: session.id, prompt: 'inspect tool paths' }); await fixture.runtime.waitForIdle(session.id)
        const journal = new SessionJournal(fixture.runtime.paths.sessions), sourceRef = `conversation:${session.id}`
        const archive = new HostArchive(journal, () => [{ ...session, ownerId: 'local', revision: 1, createdAt: session.updatedAt, shortId: 'synthetic', sourceRef, active: false, generateMemory: true }], async () => { throw new Error('unused') })
        for (const query of ['needle-title', 'needle-tool-argument']) {
            const matches = await archive.search('local', query, 10)
            const lines = await journal.sourceLines(session.id)
            expect(matches.length).toBeGreaterThan(0)
            for (const match of matches) { expect(lines[match.line! - 1]).toContain(query); expect(match.content.length).toBeLessThanOrEqual(1000) }
        }
        expect(await archive.search('foreign', 'needle-title', 10)).toEqual([])
    } finally { await fixture.close() }
})
