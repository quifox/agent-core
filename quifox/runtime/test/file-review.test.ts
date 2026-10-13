import { expect, it } from 'vitest'
import { readFile, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import type { SessionView } from '../src/protocol.js'
import { synthetic } from './synthetic.js'

it('shows the real file diff for approval and rejects a source changed while approval was pending', async () => {
    const fixture = await synthetic((_input, index) => index === 1 ? { calls: [{ id: 'edit', name: 'write_file', input: { path: 'review.txt', content: 'requested\n' } }] } : { text: 'done' })
    try {
        await writeFile(join(fixture.root, 'review.txt'), 'original\n')
        const session = await fixture.runtime.command({ type: 'create' }) as SessionView
        await fixture.runtime.command({ type: 'submit', sessionId: session.id, prompt: 'edit file' })
        await expect.poll(async () => (await fixture.runtime.command({ type: 'snapshot', sessionId: session.id }) as SessionView).approvals.length).toBe(1)
        const approval = (await fixture.runtime.command({ type: 'snapshot', sessionId: session.id }) as SessionView).approvals[0]!
        expect(approval.inspection?.change).toMatchObject({ before: 'original\n', after: 'requested\n' })
        await writeFile(join(fixture.root, 'review.txt'), 'external edit\n')
        await fixture.runtime.command({ type: 'approve', sessionId: session.id, approvalId: approval.id, approved: true })
        await fixture.runtime.waitForIdle(session.id)
        expect(await readFile(join(fixture.root, 'review.txt'), 'utf8')).toBe('external edit\n')
        const view = await fixture.runtime.command({ type: 'snapshot', sessionId: session.id }) as SessionView
        expect(view.messages.find(item => item.message.role === 'tool')?.message.content).toContain('已变化')
    } finally { await fixture.close() }
})

it('returns ordinary business errors for missing files and invalid file/directory targets without breaking the tool batch', async () => {
    const fixture = await synthetic((_input, index) => index === 1 ? { calls: [
        { id: 'directory', name: 'write_file', input: { path: '.', content: 'cannot write a directory' } },
        { id: 'missing', name: 'read_file', input: { path: 'missing.txt' } },
        { id: 'not-directory', name: 'list_files', input: { path: 'file.txt' } }
    ] } : { text: 'errors observed; choose a valid path next' }, config => { config.approval = 'allow' })
    try {
        await writeFile(join(fixture.root, 'file.txt'), 'file content')
        const session = await fixture.runtime.command({ type: 'create' }) as SessionView
        await fixture.runtime.command({ type: 'submit', sessionId: session.id, prompt: 'exercise invalid paths' }); await fixture.runtime.waitForIdle(session.id)
        const view = await fixture.runtime.command({ type: 'snapshot', sessionId: session.id }) as SessionView
        expect(view.status).toBe('idle'); expect(fixture.requests).toHaveLength(2)
        const receipts = view.messages.filter(item => item.message.role === 'tool')
        expect(receipts).toHaveLength(3)
        expect(receipts.every(item => item.message.role === 'tool' && item.message.isError)).toBe(true)
        expect(await readFile(join(fixture.root, 'file.txt'), 'utf8')).toBe('file content')
    } finally { await fixture.close() }
})
