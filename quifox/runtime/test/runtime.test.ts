import { expect, it, vi } from 'vitest'
import { createServer } from 'node:http'
import { once } from 'node:events'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { defaultConfig, saveConfig } from '../src/config.js'
import { QuiFoxRuntime } from '../src/runtime.js'
import type { RuntimeEvent, SessionView } from '../src/protocol.js'
import { SessionJournal } from '../src/journal.js'
import { synthetic } from './synthetic.js'
import { randomUUID } from 'node:crypto'
import { runtimeCommandSchema } from '../src/protocol.js'

it('uses real Chat HTTP, streams output, keeps secrets out of events and restores the same archive', async () => {
    let requests = 0
    const server = createServer(async (request, response) => {
        let body = ''; for await (const chunk of request) body += chunk
        expect(JSON.parse(body).model).toBe('synthetic')
        expect(request.headers.authorization).toBe('Bearer synthetic-secret')
        requests += 1
        response.writeHead(200, { 'Content-Type': 'text/event-stream' })
        response.end('data: {"choices":[{"delta":{"content":"Hello from the model"}}]}\n\ndata: {"choices":[{"delta":{},"finish_reason":"stop"}]}\n\ndata: [DONE]\n\n')
    })
    server.listen(0, '127.0.0.1'); await once(server, 'listening')
    const address = server.address() as { port: number }
    const root = await mkdtemp(join(tmpdir(), 'quifox-runtime-'))
    let runtime: QuiFoxRuntime | undefined
    try {
        const config = defaultConfig(root)
        config.model = { provider: 'synthetic', model: 'synthetic', baseUrl: `http://127.0.0.1:${address.port}`, apiKey: 'synthetic-secret', contextWindow: 100000, maxOutputTokens: 1024 }
        config.memory.generate = false
        await saveConfig(root, config)
        runtime = await QuiFoxRuntime.open({ root, workspace: root, environment: {}, globalSkillsRoot: join(root, 'isolated-skills') })
        const events: RuntimeEvent[] = []
        runtime.subscribe(event => events.push(event))
        const created = await runtime.command({ type: 'create', title: 'Synthetic session' }) as SessionView
        await runtime.command({ type: 'submit', sessionId: created.id, prompt: 'Hello' })
        await runtime.waitForIdle(created.id)
        const view = await runtime.command({ type: 'snapshot', sessionId: created.id }) as SessionView
        expect(view.messages.map(entry => entry.message.content)).toEqual(['Hello', 'Hello from the model'])
        expect(events.some(event => event.type === 'agent' && (event.data as { type?: string }).type === 'text-delta')).toBe(true)
        expect(JSON.stringify(events)).not.toContain('synthetic-secret')
        expect(requests).toBe(1)
        await runtime.close()
        runtime = await QuiFoxRuntime.open({ root, workspace: root, environment: {}, globalSkillsRoot: join(root, 'isolated-skills') })
        const restored = await runtime.command({ type: 'snapshot', sessionId: created.id }) as SessionView
        expect(restored.messages).toEqual(view.messages)
        expect(restored.status).toBe('idle')
    } finally { await runtime?.close(); server.close(); await rm(root, { recursive: true, force: true }) }
})

it('acknowledges a durable new session when only its observation append fails', async () => {
    const fixture = await synthetic(() => ({ text: 'created once' }))
    const original = SessionJournal.prototype.append
    let fail = true
    const spy = vi.spyOn(SessionJournal.prototype, 'append').mockImplementation(function (this: SessionJournal, id, record) {
        if (fail && record.kind === 'event') { fail = false; return Promise.reject(new Error('Synthetic observation failure')) }
        return original.call(this, id, record)
    })
    try {
        const session = await fixture.runtime.command({ type: 'create' }) as SessionView
        expect((await fixture.runtime.command({ type: 'snapshot' }) as { sessions: SessionView[] }).sessions.map(item => item.id)).toEqual([session.id])
        await fixture.runtime.command({ type: 'submit', sessionId: session.id, prompt: 'use the committed session' }); await fixture.runtime.waitForIdle(session.id)
        await fixture.restart()
        expect((await fixture.runtime.command({ type: 'snapshot' }) as { sessions: SessionView[] }).sessions.map(item => item.id)).toEqual([session.id])
        expect(fixture.requests).toHaveLength(1)
    } finally { spy.mockRestore(); await fixture.close() }
})

it('replays lost create and submit acknowledgements with stable identities across concurrent calls and restart', async () => {
    const fixture = await synthetic(() => ({ text: 'one accepted turn' }))
    try {
        const sessionId = randomUUID(), command = { type: 'create' as const, sessionId, title: 'Replayable creation' }
        const created = await Promise.all([fixture.runtime.command(command), fixture.runtime.command(command)]) as SessionView[]
        expect(created.map(session => session.id)).toEqual([sessionId, sessionId])
        await expect(fixture.runtime.command({ ...command, title: 'Conflicting creation' })).rejects.toThrow('身份')
        const prompt = '  Unicode é 🦊\t\noriginal spacing  '
        const input = { type: 'submit' as const, sessionId, prompt, messageId: 'stable-original-input' }
        expect(runtimeCommandSchema.parse(input)).toHaveProperty('prompt', prompt)
        await fixture.runtime.command(input); await fixture.runtime.waitForIdle(sessionId)
        await fixture.restart()
        expect((await fixture.runtime.command(command) as SessionView).id).toBe(sessionId)
        await fixture.runtime.command(input); await fixture.runtime.waitForIdle(sessionId)
        const snapshot = await fixture.runtime.command({ type: 'snapshot' }) as { sessions: SessionView[] }
        expect(snapshot.sessions).toHaveLength(1); expect(fixture.requests).toHaveLength(1)
        expect(fixture.requests[0]?.messages.at(-1)?.content).toBe(prompt)
    } finally { await fixture.close() }
})
