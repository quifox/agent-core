import { expect, it } from 'vitest'
import type { CommandEnvelope, EngineFrame, RuntimeEvent } from '@quifox/shared-runtime'
import { DesktopEngine, type EnginePort } from '../src/engine.js'

it('sends a failure receipt to a surviving host when reconnect cancels an unconfirmed presentation', async () => {
    let receive!: (frame: EngineFrame) => void, finish!: () => void
    const envelopes: CommandEnvelope[] = []
    const engine = new DesktopEngine({ start: async callback => { receive = callback; callback({ kind: 'ready', protocol: 1 }) }, write: async envelope => { envelopes.push(envelope) } })
    engine.onPresentation(async request => { await new Promise<void>(resolve => { finish = resolve }); return { destination: 'external', target: request.target } })
    await engine.connect()
    receive({ kind: 'presentation', request: { id: 'pending', sessionId: 'session', operationId: 'operation', workspace: '/synthetic', target: 'https://synthetic.test/' } })
    await engine.reconnect()
    expect(envelopes.map(envelope => envelope.command)).toContainEqual({ type: 'presentation-reply', requestId: 'pending', reply: { ok: false, error: expect.stringContaining('未确认') } })
    finish(); await Promise.resolve(); await Promise.resolve()
    expect(envelopes).toHaveLength(1)
})

it('correlates out-of-order responses while streaming real session events and rejects pending commands on process failure', async () => {
    let receive!: (frame: EngineFrame) => void
    const envelopes: CommandEnvelope[] = []
    const port: EnginePort = { start: async callback => { receive = callback; callback({ kind: 'ready', protocol: 1 }) }, write: async envelope => { envelopes.push(envelope) } }
    const engine = new DesktopEngine(port), events: RuntimeEvent[] = []
    engine.subscribe(event => events.push(event))
    const first = engine.command({ type: 'snapshot' }), second = engine.command({ type: 'snapshot', sessionId: 'session' })
    await expect.poll(() => envelopes.length).toBe(2)
    receive({ kind: 'event', event: { version: 1, sessionId: 'session', sequence: 1, timestamp: '2026-01-01T00:00:00Z', type: 'agent', data: { type: 'text-delta', delta: 'actual' } } })
    receive({ kind: 'response', id: envelopes[1]!.id, ok: true, value: 'second' })
    receive({ kind: 'response', id: envelopes[0]!.id, ok: true, value: 'first' })
    expect(await first).toBe('first'); expect(await second).toBe('second'); expect(events[0]?.data).toEqual({ type: 'text-delta', delta: 'actual' })
    const stopped = engine.command({ type: 'submit', sessionId: 'session', prompt: 'work' })
    await expect.poll(() => envelopes.length).toBe(3)
    receive({ kind: 'fatal', error: 'synthetic process exit' }); await expect(stopped).rejects.toThrow('synthetic process exit')
    await expect(engine.command({ type: 'snapshot' })).rejects.toThrow('synthetic process exit')
    expect(envelopes).toHaveLength(3)
    engine.subscribe(() => { throw new Error('Synthetic observer failure') })
    await engine.reconnect()
    receive({ kind: 'event', event: { version: 1, sessionId: 'session', sequence: 2, timestamp: '2026-01-01T00:00:01Z', type: 'session', data: {} } })
    expect(events).toHaveLength(2)
})

it('acknowledges a presentation only after the view handler confirms it and cancels pending handlers', async () => {
    let receive!: (frame: EngineFrame) => void
    const envelopes: CommandEnvelope[] = []
    const port: EnginePort = { start: async callback => { receive = callback; callback({ kind: 'ready', protocol: 1 }) }, write: async envelope => { envelopes.push(envelope); receive({ kind: 'response', id: envelope.id, ok: true, value: null }) } }
    const engine = new DesktopEngine(port)
    let finish!: () => void
    let signal!: AbortSignal
    engine.onPresentation(async (request, cancellation) => {
        signal = cancellation
        await new Promise<void>(resolve => { finish = resolve })
        return { destination: 'panel', target: request.target, viewId: 'actual-tab', kind: 'image' }
    })
    await engine.connect()
    const request = { id: 'show', sessionId: 'session', operationId: 'operation', workspace: '/synthetic', target: '/synthetic/image.png' }
    receive({ kind: 'presentation', request })
    expect(envelopes).toHaveLength(0)
    finish()
    await expect.poll(() => envelopes.length).toBe(1)
    expect(envelopes[0]?.command).toMatchObject({ type: 'presentation-reply', reply: { ok: true, receipt: { viewId: 'actual-tab' } } })
    receive({ kind: 'presentation', request: { ...request, id: 'cancel' } })
    receive({ kind: 'presentation-cancel', requestId: 'cancel' })
    expect(signal.aborted).toBe(true); finish()
    await Promise.resolve(); expect(envelopes).toHaveLength(1)
})
