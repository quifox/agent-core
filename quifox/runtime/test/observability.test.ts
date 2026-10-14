import { expect, it, vi } from 'vitest'
import { readFile, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import type { RuntimeEvent, SessionView } from '../src/protocol.js'
import { synthetic } from './synthetic.js'
import { SessionJournal } from '../src/journal.js'
import { createServer } from 'node:http'
import { once } from 'node:events'
import { Server } from '@modelcontextprotocol/sdk/server/index.js'
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js'
import { ListToolsRequestSchema } from '@modelcontextprotocol/sdk/types.js'
import type { Transport } from '@modelcontextprotocol/sdk/shared/transport.js'
import { QuiFoxRuntime } from '../src/runtime.js'

interface ObservabilityView {
    runs: {
        runId: string
        status: string
        modelCalls: number
        toolCalls: number
        usage: { totalTokens?: number }
        composition?: { plugins: { id: string }[]; tools: { name: string }[]; context: { key: string; content: string }[] }
    }[]
    evaluations: { evaluator: string; passed?: boolean; score?: number }[]
    comparison: { variant: string; runs: number; successRate: number }[]
}

it('shows an active writer run in an independent observing Host and refreshes its completed metrics', async () => {
    let enter!: () => void, release!: () => void
    const entered = new Promise<void>(resolve => { enter = resolve }), gate = new Promise<void>(resolve => { release = resolve })
    const fixture = await synthetic(async () => { enter(); await gate; return { text: 'observed by peer' } })
    const session = await fixture.runtime.command({ type: 'create' }) as SessionView
    const peer = await QuiFoxRuntime.open({ root: fixture.root, environment: {}, globalSkillsRoot: join(fixture.root, 'isolated') })
    try {
        await fixture.runtime.command({ type: 'submit', sessionId: session.id, prompt: 'observe externally' }); await entered
        const running = await peer.command({ type: 'observability', sessionId: session.id, action: 'summary' }) as import('../src/protocol.js').ObservabilityView
        expect(running.runs.at(-1)).toMatchObject({ status: 'running', modelCalls: 1, pendingModels: [{ index: 1 }] })
        await expect(peer.command({ type: 'observability', sessionId: session.id, action: 'evaluate', runId: running.runs.at(-1)!.runId, evaluator: 'peer' })).rejects.toThrow('另一个宿主')
        release(); await fixture.runtime.waitForIdle(session.id)
        const finished = await peer.command({ type: 'observability', sessionId: session.id, action: 'summary' }) as import('../src/protocol.js').ObservabilityView
        expect(finished.runs.at(-1)).toMatchObject({ status: 'success', pendingModels: [] })
    } finally { release(); await peer.close(); await fixture.close() }
})

it('persists run metrics and request composition and folds them after a Host restart', async () => {
    const fixture = await synthetic(() => ({ text: 'observed' }))
    try {
        await writeFile(join(fixture.root, 'AGENTS.md'), 'SYNTHETIC_GUIDANCE synthetic-key')
        const session = await fixture.runtime.command({ type: 'create' }) as SessionView
        await fixture.runtime.command({ type: 'submit', sessionId: session.id, prompt: 'observe this run' })
        await fixture.runtime.waitForIdle(session.id)
        const first = await fixture.runtime.command({ type: 'observability', sessionId: session.id, action: 'summary' }) as ObservabilityView
        expect(first.runs).toHaveLength(1)
        expect(first.runs[0]).toMatchObject({ status: 'success', modelCalls: 1, toolCalls: 0 })
        expect(first.runs[0]!.composition?.plugins.map(plugin => plugin.id)).toContain('observability')
        expect(first.runs[0]!.composition?.context.some(item => item.key === 'project-guidance' && item.content.includes('SYNTHETIC_GUIDANCE'))).toBe(true)
        expect(first.runs[0]!.composition?.tools.map(tool => tool.name)).toContain('read_file')
        expect(JSON.stringify(first)).not.toContain('synthetic-key')

        await fixture.restart()
        const restored = await fixture.runtime.command({ type: 'observability', sessionId: session.id, action: 'summary' }) as ObservabilityView
        expect(restored.runs[0]?.runId).toBe(first.runs[0]?.runId)
        expect(restored.runs[0]?.status).toBe('success')
    } finally { await fixture.close() }
})

it('records explicit task evaluation and returns variant comparison without invoking the model', async () => {
    const fixture = await synthetic(() => ({ text: 'observed' }))
    try {
        const session = await fixture.runtime.command({ type: 'create' }) as SessionView
        await fixture.runtime.command({ type: 'submit', sessionId: session.id, prompt: 'evaluate this run' })
        await fixture.runtime.waitForIdle(session.id)
        const summary = await fixture.runtime.command({ type: 'observability', sessionId: session.id, action: 'summary' }) as ObservabilityView
        const runId = summary.runs[0]!.runId
        await fixture.runtime.command({ type: 'observability', sessionId: session.id, action: 'evaluate', runId, evaluator: 'task-pass', score: .9, passed: true, note: 'synthetic' })
        const evaluated = await fixture.runtime.command({ type: 'observability', sessionId: session.id, action: 'summary' }) as ObservabilityView
        expect(evaluated.evaluations).toContainEqual(expect.objectContaining({ evaluator: 'task-pass', score: .9, passed: true }))
        expect(evaluated.comparison[0]).toMatchObject({ runs: 1, successRate: 1 })
        expect(fixture.requests).toHaveLength(1)
    } finally { await fixture.close() }
})

it('keeps a missing observation terminator unknown after restart without changing the successful Agent run', async () => {
    const fixture = await synthetic(() => ({ text: 'completed despite sink failure' }))
    const append = SessionJournal.prototype.append
    const spy = vi.spyOn(SessionJournal.prototype, 'append').mockImplementation(async function (this: SessionJournal, id, record) {
        const event = record.kind === 'event' ? record.event as RuntimeEvent : undefined
        if (event?.type === 'observability' && (event.data as { type: string }).type === 'run-end') throw new Error('Synthetic observation sink failure')
        await append.call(this, id, record)
    })
    try {
        const session = await fixture.runtime.command({ type: 'create' }) as SessionView
        await fixture.runtime.command({ type: 'submit', sessionId: session.id, prompt: 'finish the run' }); await fixture.runtime.waitForIdle(session.id)
        expect((await fixture.runtime.command({ type: 'snapshot', sessionId: session.id }) as SessionView).status).toBe('idle')
        spy.mockRestore(); await fixture.restart()
        const summary = await fixture.runtime.command({ type: 'observability', sessionId: session.id, action: 'summary' }) as ObservabilityView
        expect(summary.runs[0]?.status).toBe('unknown')
        expect(summary.comparison).toEqual([])
    } finally { spy.mockRestore(); await fixture.close() }
})

it('bounds persisted composition for a large real MCP tool catalog before the observation reaches the journal', async () => {
    const server = new Server({ name: 'synthetic-observation', version: '1.0.0' }, { capabilities: { tools: {} } })
    server.setRequestHandler(ListToolsRequestSchema, async () => ({ tools: Array.from({ length: 130 }, (_, index) => ({
        name: `verbose-${index}`, description: index === 0 ? '界'.repeat(150000) + 'synthetic-key' : 'description'.repeat(200), inputSchema: { type: 'object', properties: {} }
    })) }))
    const transport = new StreamableHTTPServerTransport({ sessionIdGenerator: () => 'synthetic-observation' })
    await server.connect(transport as Transport)
    const http = createServer((request, response) => { void transport.handleRequest(request, response).catch(() => response.end()) })
    http.listen(0, '127.0.0.1'); await once(http, 'listening')
    const fixture = await synthetic(() => ({ text: 'observed' }), config => {
        config.model.contextWindow = 1000000
        config.mcp = [{ id: 'verbose', enabled: true, transport: 'http', url: `http://127.0.0.1:${(http.address() as { port: number }).port}`, args: [] }]
    })
    try {
        const session = await fixture.runtime.command({ type: 'create' }) as SessionView
        await fixture.runtime.command({ type: 'submit', sessionId: session.id, prompt: 'observe the catalog' }); await fixture.runtime.waitForIdle(session.id)
        const journal = (await readFile(join(fixture.root, 'sessions', `${session.id}.jsonl`), 'utf8')).trim().split('\n').map(line => JSON.parse(line) as { kind: string; event?: RuntimeEvent })
        const composition = journal.find(item => item.event?.type === 'observability' && (item.event.data as { type: string }).type === 'composition')?.event?.data as { composition: { tools: unknown[]; totalTools: number; truncated: boolean } }
        expect(composition.composition.truncated).toBe(true)
        expect(composition.composition.totalTools).toBeGreaterThan(130)
        expect(composition.composition.tools.length).toBeLessThanOrEqual(100)
        expect(Buffer.byteLength(JSON.stringify(composition))).toBeLessThan(300000)
        expect(JSON.stringify(composition)).not.toContain('synthetic-key')
        expect(fixture.requests).toHaveLength(1)
    } finally { await fixture.close(); await server.close(); http.closeAllConnections(); http.close() }
})

it('limits historical run details while comparing all completed runs', async () => {
    const fixture = await synthetic(() => ({ text: 'observed' }))
    try {
        const session = await fixture.runtime.command({ type: 'create' }) as SessionView
        let oldestRun: string | undefined
        for (let index = 0; index < 55; index++) {
            await fixture.runtime.command({ type: 'submit', sessionId: session.id, prompt: `observe ${index}` }); await fixture.runtime.waitForIdle(session.id)
            if (index === 0) oldestRun = (await fixture.runtime.command({ type: 'observability', sessionId: session.id, action: 'summary' }) as import('../src/protocol.js').ObservabilityView).runs[0]!.runId
        }
        const summary = await fixture.runtime.command({ type: 'observability', sessionId: session.id, action: 'summary' }) as import('../src/protocol.js').ObservabilityView
        expect(summary.totalRuns).toBe(55)
        expect(summary.runs.length).toBeLessThanOrEqual(50)
        expect(summary.displayTruncated).toBe(true)
        expect(summary.comparison[0]).toMatchObject({ runs: 55, successRate: 1 })
        expect(summary.runs.every(run => Array.isArray(run.models) && Array.isArray(run.pendingTools))).toBe(true)
        expect(Buffer.byteLength(JSON.stringify(summary))).toBeLessThan(3000000)
        expect(summary.runs.some(run => run.runId === oldestRun)).toBe(false)
        const evaluated = await fixture.runtime.command({ type: 'observability', sessionId: session.id, action: 'evaluate', runId: oldestRun!, evaluator: 'historical', passed: true }) as import('../src/protocol.js').ObservabilityView
        expect(evaluated.evaluations).toContainEqual(expect.objectContaining({ runId: oldestRun, evaluator: 'historical', passed: true }))
    } finally { await fixture.close() }
}, 20000)
