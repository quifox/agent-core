import { expect, it } from 'vitest'
import { mkdir, rm } from 'node:fs/promises'
import { join } from 'node:path'
import type { RuntimeSnapshot, SessionView } from '../src/protocol.js'
import { synthetic } from './synthetic.js'

it('keeps a deleted workspace conversation readable while allowing a fresh session in another workspace', async () => {
    const fixture = await synthetic(() => ({ text: 'original reply' }))
    try {
        const workspace = join(fixture.root, 'old-project'); await mkdir(workspace)
        const old = await fixture.runtime.command({ type: 'create', workspace }) as SessionView
        await fixture.runtime.command({ type: 'submit', sessionId: old.id, prompt: 'keep the original history' }); await fixture.runtime.waitForIdle(old.id)
        await fixture.runtime.close(); await rm(workspace, { recursive: true })
        await fixture.restart()
        expect((await fixture.runtime.command({ type: 'snapshot' }) as RuntimeSnapshot).sessions.map(session => session.id)).toContain(old.id)
        const archive = await fixture.runtime.command({ type: 'snapshot', sessionId: old.id }) as SessionView
        expect(archive.messages.map(message => message.message.content)).toEqual(['keep the original history', 'original reply'])
        const observation = await fixture.runtime.command({ type: 'observability', sessionId: old.id, action: 'summary' }) as import('../src/protocol.js').ObservabilityView
        expect(observation.runs).toHaveLength(1)
        expect(observation.runs[0]).toMatchObject({ status: 'success', modelCalls: 1 })
        await expect(fixture.runtime.command({ type: 'submit', sessionId: old.id, prompt: 'must not run' })).rejects.toThrow('不可用')
        const fresh = await fixture.runtime.command({ type: 'create' }) as SessionView
        await fixture.runtime.command({ type: 'submit', sessionId: fresh.id, prompt: 'a new workspace' }); await fixture.runtime.waitForIdle(fresh.id)
        expect(fixture.requests).toHaveLength(2)
        await mkdir(workspace)
        const recovered = await fixture.runtime.command({ type: 'snapshot', sessionId: old.id }) as SessionView
        expect(recovered.unavailable).toBeUndefined()
        expect(recovered.messages).toEqual(archive.messages)
        await fixture.runtime.command({ type: 'submit', sessionId: old.id, prompt: 'continue in the restored project' }); await fixture.runtime.waitForIdle(old.id)
        expect(fixture.requests[2]?.messages.filter(message => message.role === 'user').map(message => message.content)).toEqual(['keep the original history', 'continue in the restored project'])
    } finally { await fixture.close() }
})
