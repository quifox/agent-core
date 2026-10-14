import { expect, it } from 'vitest'
import { QuiFoxRuntime } from '../src/runtime.js'
import type { RuntimeSnapshot, SessionView } from '../src/protocol.js'
import { synthetic } from './synthetic.js'

it('allows two Hosts in one root to run independent sessions while retaining a single writer per session', async () => {
    const fixture = await synthetic(input => ({ text: `reply: ${input.messages.at(-1)?.content}` }))
    let peer: QuiFoxRuntime | undefined
    try {
        const first = await fixture.runtime.command({ type: 'create' }) as SessionView
        peer = await QuiFoxRuntime.open({ root: fixture.root, workspace: fixture.root, environment: {}, globalSkillsRoot: `${fixture.root}/isolated` })
        const second = await peer.command({ type: 'create' }) as SessionView
        await Promise.all([
            fixture.runtime.command({ type: 'submit', sessionId: first.id, prompt: 'first host' }),
            peer.command({ type: 'submit', sessionId: second.id, prompt: 'second host' })
        ])
        await Promise.all([fixture.runtime.waitForIdle(first.id), peer.waitForIdle(second.id)])
        const listing = await fixture.runtime.command({ type: 'snapshot' }) as RuntimeSnapshot
        expect(listing.sessions.map(session => session.id)).toContain(second.id)
        const remote = await fixture.runtime.command({ type: 'snapshot', sessionId: second.id }) as SessionView
        expect(remote.messages.map(item => item.message.content)).toEqual(['second host', 'reply: second host'])
        await expect(peer.command({ type: 'submit', sessionId: first.id, prompt: 'must not mix' })).rejects.toThrow('另一个宿主')
        expect(fixture.requests).toHaveLength(2)
        await fixture.runtime.close()
        await peer.command({ type: 'submit', sessionId: first.id, prompt: 'after handoff' })
        await peer.waitForIdle(first.id)
        expect((await peer.command({ type: 'snapshot', sessionId: first.id }) as SessionView).messages.map(item => item.message.content))
            .toEqual(['first host', 'reply: first host', 'after handoff', 'reply: after handoff'])
    } finally { await peer?.close(); await fixture.close() }
})

it('refreshes shared configuration in an idle peer before showing settings or admitting a new turn', async () => {
    const fixture = await synthetic(() => ({ text: 'current shared model' }))
    const peer = await QuiFoxRuntime.open({ root: fixture.root, workspace: fixture.root, environment: {}, globalSkillsRoot: `${fixture.root}/isolated` })
    try {
        const session = await peer.command({ type: 'create' }) as SessionView
        await fixture.runtime.command({ type: 'config', patch: { approval: 'allow', model: { model: 'synthetic-updated', contextWindow: 100000 }, preferences: { inputMode: 'steer' } } })
        const snapshot = await peer.command({ type: 'snapshot' }) as RuntimeSnapshot
        expect(snapshot.config).toMatchObject({ approval: 'allow', model: { model: 'synthetic-updated' }, preferences: { inputMode: 'steer' } })
        await peer.command({ type: 'submit', sessionId: session.id, prompt: 'use the shared updated model' }); await peer.waitForIdle(session.id)
        expect(fixture.requests[0]?.model).toBe('synthetic-updated')
        await fixture.runtime.command({ type: 'config', patch: { model: { model: 'synthetic-updated-again', contextWindow: 100000 } } })
        await peer.command({ type: 'submit', sessionId: session.id, prompt: 'refresh without an intervening snapshot' }); await peer.waitForIdle(session.id)
        expect(fixture.requests[1]?.model).toBe('synthetic-updated-again')
    } finally { await peer.close(); await fixture.close() }
})
