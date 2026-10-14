import { expect, it } from 'vitest'
import type { SessionView } from '../src/protocol.js'
import { SessionJournal } from '../src/journal.js'
import { synthetic } from './synthetic.js'

it.each(['duplicate-sequence', 'invalid-time', 'wrong-session'] as const)('rejects a closed semantically corrupt event: %s', async corruption => {
    const fixture = await synthetic(() => ({ text: 'unused' }))
    try {
        const session = await fixture.runtime.command({ type: 'create' }) as SessionView
        await fixture.runtime.close()
        await new SessionJournal(fixture.runtime.paths.sessions).append(session.id, { kind: 'event', event: {
            version: 1, sessionId: corruption === 'wrong-session' ? 'different' : session.id, sequence: corruption === 'duplicate-sequence' ? 1 : 2,
            timestamp: corruption === 'invalid-time' ? 'not a timestamp' : '2026-01-01T00:00:00Z', type: 'session', data: {} } })
        await expect(fixture.restart()).rejects.toThrow()
    } finally { await fixture.close() }
})

it.each(['message', 'inbox', 'missing-inbox'] as const)('rejects an invalid historical %s even when the latest state replaces it with a valid value', async corruption => {
    const fixture = await synthetic(() => ({ text: 'valid original' }))
    try {
        const session = await fixture.runtime.command({ type: 'create' }) as SessionView
        await fixture.runtime.command({ type: 'submit', sessionId: session.id, prompt: 'valid input' }); await fixture.runtime.waitForIdle(session.id)
        await fixture.runtime.close()
        const journal = new SessionJournal(fixture.runtime.paths.sessions)
        const state = structuredClone((await journal.read(session.id)).records.filter(record => record.kind === 'state').at(-1)!.state) as { metadata: { revision: number }; session: { history: { message: { content: unknown } }[] }; inbox: unknown }
        const invalid = structuredClone(state); invalid.metadata.revision += 1
        if (corruption === 'message') invalid.session.history[0]!.message.content = 42
        else if (corruption === 'inbox') invalid.inbox = { version: 1, messages: [{ id: 'invalid' }] }
        else invalid.inbox = undefined
        await journal.append(session.id, { kind: 'state', state: invalid })
        state.metadata.revision += 2; await journal.append(session.id, { kind: 'state', state })
        await expect(fixture.restart()).rejects.toThrow('损坏')
    } finally { await fixture.close() }
})
