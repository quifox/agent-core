import { expect, it } from 'vitest'
import type { SessionView } from '../src/protocol.js'
import { synthetic } from './synthetic.js'
import { readFile } from 'node:fs/promises'

it('completes a session model change after configuration refresh without joining its own command', async () => {
    const fixture = await synthetic(() => ({ text: 'new model selected' }), config => { config.models = [{ ...config.model, id: 'alternate', model: 'alternate-model' }] })
    try {
        const session = await fixture.runtime.command({ type: 'create' }) as SessionView
        const changed = await fixture.runtime.command({ type: 'session-config', sessionId: session.id, modelId: 'alternate' }) as SessionView
        expect(changed.modelId).toBe('alternate')
        await fixture.runtime.command({ type: 'submit', sessionId: session.id, prompt: 'verify selected model' }); await fixture.runtime.waitForIdle(session.id)
        expect(fixture.requests[0]?.model).toBe('alternate-model')
        await fixture.runtime.close()
    } finally { await fixture.close() }
}, 3000)

it('rejects an oversized public configuration before writing or replacing the active composition', async () => {
    const fixture = await synthetic(() => ({ text: 'unchanged' }))
    try {
        const original = await readFile(fixture.runtime.paths.config, 'utf8')
        const models = Array.from({ length: 900 }, (_, index) => ({ id: `model-${index}`, provider: 'p'.repeat(10_000), model: 'm'.repeat(10_000), baseUrl: 'http://127.0.0.1:1', maxOutputTokens: 1000, contextWindow: 100_000 }))
        await expect(fixture.runtime.command({ type: 'config', patch: { models } })).rejects.toThrow('display budget')
        expect(await readFile(fixture.runtime.paths.config, 'utf8')).toBe(original)
        expect(fixture.requests).toHaveLength(0)
        const session = await fixture.runtime.command({ type: 'create' }) as SessionView
        await fixture.runtime.command({ type: 'submit', sessionId: session.id, prompt: 'verify unchanged composition' }); await fixture.runtime.waitForIdle(session.id)
        expect(fixture.requests[0]?.model).toBe('synthetic')
    } finally { await fixture.close() }
})

it('reserves the configuration gate before an asynchronous refresh can admit another switch or input', async () => {
    const fixture = await synthetic(() => ({ text: 'selected exactly once' }), config => { config.models = [{ ...config.model, id: 'alternate', model: 'alternate-model' }] })
    try {
        const session = await fixture.runtime.command({ type: 'create' }) as SessionView
        const outcomes = await Promise.allSettled([
            fixture.runtime.command({ type: 'session-config', sessionId: session.id, modelId: 'alternate' }),
            fixture.runtime.command({ type: 'session-config', sessionId: session.id, modelId: 'default' }),
            fixture.runtime.command({ type: 'submit', sessionId: session.id, prompt: 'must not race the switch' })
        ])
        expect(outcomes.map(result => result.status)).toEqual(['fulfilled', 'rejected', 'rejected'])
        expect(fixture.requests).toHaveLength(0)
        await fixture.runtime.command({ type: 'submit', sessionId: session.id, prompt: 'after the completed switch' })
        await fixture.runtime.waitForIdle(session.id)
        expect(fixture.requests).toHaveLength(1)
        expect(fixture.requests[0]?.model).toBe('alternate-model')
        const view = await fixture.runtime.command({ type: 'snapshot', sessionId: session.id }) as SessionView
        expect(view.messages.filter(message => message.origin === 'human')).toHaveLength(1)
    } finally { await fixture.close() }
})
