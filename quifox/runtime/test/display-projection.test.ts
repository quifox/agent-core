import { expect, it } from 'vitest'
import type { RuntimeEvent, SessionView } from '../src/protocol.js'
import { displayEvent, displayFrame, displaySession } from '../src/display-projection.js'
import { synthetic } from './synthetic.js'
import { SessionJournal } from '../src/journal.js'

it('keeps long external tool identities distinct and consistently associated in display receipts', () => {
    const first = 'x'.repeat(1024) + 'a', second = 'x'.repeat(1024) + 'b'
    const event = (id: string): RuntimeEvent => ({ version: 1, sessionId: 'session', operationId: id, sequence: 1, timestamp: '2026-01-01T00:00:00Z', type: 'agent', data: { type: 'tool-result', run: { call: { id, name: 'test' }, result: { status: 'success' } } } })
    const one = displayEvent(event(first)).value, two = displayEvent(event(second)).value
    expect(one.operationId).not.toBe(two.operationId)
    expect(one.operationId).toMatch(/^sha256:[a-f0-9]{64}$/)
    expect((one.data as { run: { call: { id: string } } }).run.call.id).toBe(one.operationId)
    expect(displayEvent(event(first)).value.operationId).toBe(one.operationId)
})

it('binds a long call ID to the real composite operation through approval, receipt and repeated projection', async () => {
    const callId = 'shared-prefix'.repeat(100) + 'actual-call'
    const fixture = await synthetic((_input, index) => index === 1 ? { calls: [{ id: callId, name: 'apply_patch', input: { path: 'long-id.txt', oldText: '', newText: 'actual content' } }] } : { text: 'done' })
    try {
        const session = await fixture.runtime.command({ type: 'create' }) as SessionView
        await fixture.runtime.command({ type: 'submit', sessionId: session.id, prompt: 'write with a long external call identity' })
        await expect.poll(async () => (await fixture.runtime.command({ type: 'snapshot', sessionId: session.id }) as SessionView).approvals.length).toBe(1)
        const pending = await fixture.runtime.command({ type: 'snapshot', sessionId: session.id, traceOnly: true }) as SessionView
        const message = pending.messages.find(item => item.message.role === 'assistant' && item.message.toolCalls?.length)!
        expect(message.operations![0]!.operationId).toBe(pending.approvals[0]!.operationId)
        expect(message.operations![0]!.callId).toBe(message.message.role === 'assistant' ? message.message.toolCalls![0]!.id : undefined)
        expect(displaySession(pending).messages.find(item => item.id === message.id)!.operations).toEqual(message.operations)
        await fixture.runtime.command({ type: 'approve', sessionId: session.id, approvalId: pending.approvals[0]!.id, approved: true }); await fixture.runtime.waitForIdle(session.id)
        const done = await fixture.runtime.command({ type: 'snapshot', sessionId: session.id, traceOnly: true }) as SessionView
        expect(done.events.some(event => event.operationId === message.operations![0]!.operationId && (event.data as { type?: string }).type === 'tool-result')).toBe(true)
        const raw = await fixture.runtime.command({ type: 'snapshot', sessionId: session.id }) as SessionView
        expect(raw.messages.find(item => item.id === message.id)!.operations![0]!.callId).toBe(callId)
    } finally { await fixture.close() }
})

it('bounds large event and SessionView frames without changing durable values or operation identities', async () => {
    const fixture = await synthetic(() => ({ text: 'unused' }))
    try {
        const session = await fixture.runtime.command({ type: 'create' }) as SessionView
        const events: RuntimeEvent[] = Array.from({ length: 86 }, (_, index) => ({ version: 1, sessionId: session.id, runId: 'origin-run', operationId: `operation-${index}`, sequence: index + 2,
            timestamp: '2026-01-01T00:00:00Z', type: 'agent', data: { type: 'tool-result', run: { call: { id: `call-${index}`, name: 'apply_patch', input: {} },
                result: { status: 'success', content: 'actual receipt', data: { change: { path: 'large.txt', before: 'a'.repeat(200_000), after: 'b'.repeat(200_000) } } } } } }))
        const entries = (fixture.runtime as unknown as { entries: Map<string, { events: RuntimeEvent[]; observations: RuntimeEvent[] }> }).entries
        entries.get(session.id)!.events.push(...events); entries.get(session.id)!.observations.push(...events)
        const complete = await fixture.runtime.command({ type: 'snapshot', sessionId: session.id }) as SessionView
        expect(Buffer.byteLength(JSON.stringify(complete))).toBeGreaterThan(32 * 1024 * 1024)
        const view = await fixture.runtime.command({ type: 'snapshot', sessionId: session.id, messageLimit: 100, eventLimit: 1000, traceOnly: true }) as SessionView
        expect(Buffer.byteLength(JSON.stringify(view))).toBeLessThan(16 * 1024 * 1024)
        expect(view.displayTruncated).toBe(true)
        expect(view.events.at(-1)).toMatchObject({ operationId: 'operation-85', runId: 'origin-run', data: { run: { result: { status: 'success' } } } })
        expect(view.changes?.[0]?.truncated).toBe(true)
        expect(view.changes?.[0]?.before).not.toContain('预览已截断')
        expect((events[0]!.data as { run: { result: { data: { change: { before: string } } } } }).run.result.data.change.before).toHaveLength(200_000)
        expect(Buffer.byteLength(JSON.stringify(displayFrame({ kind: 'response', id: 'create-response', ok: true, value: complete })))).toBeLessThan(16 * 1024 * 1024)
        const hundredFiles = { ...events[0]!, data: { type: 'tool-result', run: { result: { status: 'error', data: { changes: Array.from({ length: 100 }, () => ({ path: 'large.txt', before: 'a'.repeat(200_000), after: 'b'.repeat(200_000) })) } } } } }
        expect(displayEvent(hundredFiles).bytes).toBeLessThan(1_000_000)
        expect(displayEvent(hundredFiles).value).toMatchObject({ operationId: 'operation-0', data: { run: { result: { status: 'error' } } } })
        const records = (await new SessionJournal(fixture.runtime.paths.sessions).read(session.id)).records
        const unavailable = (fixture.runtime as unknown as { unavailable: Map<string, { state: unknown; events: RuntimeEvent[]; checkedAt: number }> }).unavailable
        unavailable.set(session.id, { state: records.find(record => record.kind === 'state')!.state, events, checkedAt: Date.now() }); entries.delete(session.id)
        const archived = await fixture.runtime.command({ type: 'snapshot', sessionId: session.id, messageLimit: 100, eventLimit: 1000, traceOnly: true }) as SessionView
        expect(archived.unavailable).toBeDefined(); expect(archived.displayTruncated).toBe(true)
        expect(Buffer.byteLength(JSON.stringify(archived))).toBeLessThan(16 * 1024 * 1024)
    } finally { await fixture.close() }
})

it('bounds pending messages, Memory and catalogs while retaining the current approval identity', async () => {
    const fixture = await synthetic(() => ({ text: 'unused' }))
    try {
        const view = await fixture.runtime.command({ type: 'create' }) as SessionView
        view.memory.content = '狐狸'.repeat(1_000_000)
        view.title = '\0'.repeat(3_000_000)
        view.untrustedMcp = Array.from({ length: 1000 }, () => 'server'.repeat(100_000))
        view.pendingMessages = Array.from({ length: 300 }, (_, index) => ({ id: `input-${index}`, prompt: 'x'.repeat(100_000), mode: 'queue' }))
        view.agents = { agents: Array.from({ length: 300 }, (_, index) => ({ name: `agent-${index}`, description: 'x'.repeat(100_000), source: 'synthetic.md' })), issues: [] }
        view.approvals = [{ id: 'actual-approval', sessionId: view.id, operationId: 'actual-operation', call: { id: 'actual-call', name: 'write_file', input: { content: 'x'.repeat(1_000_000) } } }]
        const projected = displaySession(view)
        expect(Buffer.byteLength(JSON.stringify(projected))).toBeLessThan(16 * 1024 * 1024)
        expect(projected.approvals[0]).toMatchObject({ id: 'actual-approval', operationId: 'actual-operation', call: { id: 'actual-call', name: 'write_file' } })
        expect(projected.displayTruncated).toBe(true)
        expect(projected.memory.content).toContain('预览已截断')
        expect(projected.title).toContain('预览已截断'); expect(projected.untrustedMcp!.length).toBeLessThanOrEqual(100)
        expect(Buffer.byteLength(JSON.stringify(displayFrame({ kind: 'response', id: 'archive', ok: true, value: view })))).toBeLessThan(16 * 1024 * 1024)
    } finally { await fixture.close() }
})

it('publishes a bounded native receipt while retaining its full file difference in the journal', async () => {
    const content = 'x'.repeat(200_000)
    const fixture = await synthetic((_input, index) => index === 1 ? { calls: [{ id: 'write', name: 'apply_patch', input: { path: 'large.txt', oldText: '', newText: content } }] } : { text: 'done' }, config => { config.approval = 'allow' })
    const events: RuntimeEvent[] = []; fixture.runtime.subscribe(event => events.push(event))
    try {
        const session = await fixture.runtime.command({ type: 'create' }) as SessionView
        await fixture.runtime.command({ type: 'submit', sessionId: session.id, prompt: 'write a large file' }); await fixture.runtime.waitForIdle(session.id)
        const receipt = events.find(event => event.type === 'agent' && (event.data as { type?: string }).type === 'tool-result')!
        expect(Buffer.byteLength(JSON.stringify(receipt))).toBeLessThan(1_000_000)
        expect(receipt.operationId).toBeDefined()
        const records = (await new SessionJournal(fixture.runtime.paths.sessions).read(session.id)).records
        const actual = records.find(record => record.kind === 'event' && (record.event as RuntimeEvent).operationId === receipt.operationId && ((record.event as RuntimeEvent).data as { type?: string }).type === 'tool-result')!.event as RuntimeEvent
        expect((actual.data as { run: { result: { data: { change: { after: string } } } } }).run.result.data.change.after).toBe(content)
    } finally { await fixture.close() }
})
