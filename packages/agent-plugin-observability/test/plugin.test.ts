import { expect, it } from 'vitest'
import { z } from 'zod'
import { createAgent, defineTool, toolError, toolSuccess, type AgentHooks, type AgentPlugin, type ModelTurnResult } from '@quifox/agent-core'
import { ObservabilityPlugin, compareObservabilityRuns, foldObservability, type ObservabilityEvent } from '../src/index.js'

function model(turns: ModelTurnResult[]): AgentPlugin<string> {
    let index = 0
    const hooks: AgentHooks<string> = { async *model() {
        const result = turns[index++]!
        yield { type: 'usage', usage: result.usage }
        yield { type: 'finish', reason: result.finishReason }
        return result
    } }
    return { id: 'model', hooks }
}

const emptyTurn = (overrides: Partial<ModelTurnResult> = {}): ModelTurnResult => ({
    text: 'done', reasoning: '', toolCalls: [], usage: { inputTokens: 10, outputTokens: 4, totalTokens: 14 }, finishReason: 'stop', ...overrides
})

it('publishes closed run/model/tool metrics without changing the Agent result', async () => {
    const events: ObservabilityEvent[] = []
    let clock = 100
    const tool = defineTool({ name: 'lookup', description: 'lookup', inputSchema: z.object({}).strict(),
        policy: { sideEffect: 'none', approval: 'none' }, execute: async () => toolSuccess('ok') })
    const tools: AgentPlugin<string> = { id: 'tools', hooks: { onInitialize: async ctx => { ctx.tools.register(tool) } } }
    const observer = new ObservabilityPlugin<string>({ sourceId: 'session', now: () => clock += 5, publish: event => { events.push(event) } })
    const result = await createAgent({ plugins: [tools, model([
        emptyTurn({ text: '', toolCalls: [{ id: 'call-1', name: 'lookup', input: {} }], finishReason: 'tool-calls' }),
        emptyTurn()
    ]), observer] }).run('hello')
    expect(result.ok).toBe(true)
    const summary = foldObservability(events)
    expect(summary.runs).toHaveLength(1)
    expect(summary.runs[0]).toMatchObject({
        status: 'success', modelCalls: 2, toolCalls: 1, toolErrors: 0,
        usage: { inputTokens: 20, outputTokens: 8, totalTokens: 28 }
    })
    expect(summary.runs[0]!.durationMs).toBeGreaterThan(0)
    expect(summary.runs[0]!.tools[0]).toMatchObject({ name: 'lookup', status: 'success' })
})

it('classifies tool errors and run failures and keeps publisher failures non-fatal', async () => {
    const events: ObservabilityEvent[] = []
    const bad = defineTool({ name: 'bad', description: 'bad', inputSchema: z.object({}).strict(),
        policy: { sideEffect: 'none', approval: 'none' }, execute: async () => toolError('failed', { code: 'BROKEN' }) })
    const tools: AgentPlugin<string> = { id: 'tools', hooks: { onInitialize: async ctx => { ctx.tools.register(bad) } } }
    const observer = new ObservabilityPlugin<string>({ sourceId: 'session', publish: event => {
        events.push(event)
        if (event.type === 'tool') throw new Error('sink failed')
    } })
    const result = await createAgent({ plugins: [tools, model([
        emptyTurn({ text: '', toolCalls: [{ id: 'call-1', name: 'bad', input: {} }], finishReason: 'tool-calls' }),
        emptyTurn()
    ]), observer] }).run('hello')
    expect(result.ok).toBe(true)
    expect(observer.publishError).toBeInstanceOf(Error)
    expect(foldObservability(events).runs[0]).toMatchObject({ toolCalls: 1, toolErrors: 1, status: 'success' })
})

it('records recovery and evaluator facts and compares variants', () => {
    const events: ObservabilityEvent[] = []
    const observer = new ObservabilityPlugin({ sourceId: 'session', variant: () => 'model-a', publish: event => { events.push(event) } })
    observer.recordRecovery('continue')
    observer.recordEvaluation({ evaluator: 'task-pass', score: .8, passed: true, note: 'synthetic' })
    const folded = foldObservability([
        ...events,
        { type: 'run-start', sourceId: 's', runId: 'a', timestampMs: 0, variant: 'model-a' },
        { type: 'run-end', sourceId: 's', runId: 'a', timestampMs: 100, durationMs: 100, status: 'success' },
        { type: 'evaluation', sourceId: 's', runId: 'a', timestampMs: 101, evaluator: 'task-pass', score: .8, passed: true },
        { type: 'run-start', sourceId: 's', runId: 'b', timestampMs: 0, variant: 'model-b' },
        { type: 'run-end', sourceId: 's', runId: 'b', timestampMs: 200, durationMs: 200, status: 'failed' }
    ])
    const compared = compareObservabilityRuns(folded.runs)
    expect(compared.find(item => item.variant === 'model-a')).toMatchObject({ runs: 1, successRate: 1, averageDurationMs: 100, evaluationPassRate: 1 })
    expect(compared.find(item => item.variant === 'model-b')).toMatchObject({ runs: 1, successRate: 0, averageDurationMs: 200 })
})

it.each(['composition', 'variant', 'now', 'runId'] as const)('keeps a failed %s observation callback out of the Agent outcome', async field => {
    const observer = new ObservabilityPlugin<string>({ sourceId: 's', [field]: () => { throw new Error('Synthetic observer failure') } })
    const result = await createAgent({ plugins: [model([emptyTurn()]), observer] }).run('hello')
    expect(result.ok).toBe(true)
    expect(observer.publishError).toBeInstanceOf(Error)
})

it('closes failed, interrupted and consumer-stopped runs and can observe a later run', async () => {
    const events: ObservabilityEvent[] = []
    const observer = new ObservabilityPlugin<string>({ sourceId: 's', publish: event => { events.push(event) } })
    const failing: AgentPlugin<string> = { id: 'failing-model', hooks: { model: async function* () { throw new Error('Synthetic model failure') } } }
    const failed = await createAgent({ plugins: [failing, observer] }).run('fail')
    expect(failed.ok).toBe(false)
    const interrupt: AgentPlugin<string> = { id: 'interrupt', hooks: { beforeStep: async () => ({ action: 'stop', value: { kind: 'interrupt', reason: 'user-stop' } }) } }
    await createAgent({ plugins: [interrupt, model([emptyTurn()]), observer] }).run('interrupt')
    for await (const event of createAgent({ plugins: [model([emptyTurn()]), observer] }).stream('stop')) { if (event.type === 'usage') break }
    await createAgent({ plugins: [model([emptyTurn()]), observer] }).run('later')
    expect(foldObservability(events).runs.map(run => run.status)).toEqual(['failed', 'interrupted', 'stopped', 'success'])
    expect(foldObservability(events).runs[0]?.errors.length).toBeGreaterThan(0)
    expect(events.find(event => event.type === 'run-end' && event.status === 'interrupted')).toMatchObject({ interruptReason: 'user-stop' })
})

it('does not compare an unfinished run as a failed zero-duration result', () => {
    const folded = foldObservability([
        { type: 'run-start', sourceId: 's', runId: 'completed', timestampMs: 0, variant: 'a' },
        { type: 'run-end', sourceId: 's', runId: 'completed', timestampMs: 100, durationMs: 100, status: 'success' },
        { type: 'run-start', sourceId: 's', runId: 'active', timestampMs: 200, variant: 'a' }
    ])
    expect(compareObservabilityRuns(folded.runs)).toEqual([expect.objectContaining({ runs: 1, successRate: 1, averageDurationMs: 100 })])
})

it('reports an in-flight model call before the first model response and keeps its missing receipt visible after stop', async () => {
    const events: ObservabilityEvent[] = []
    const observer = new ObservabilityPlugin<string>({ sourceId: 's', publish: event => { events.push(event) } })
    const stream = createAgent({ plugins: [model([emptyTurn()]), observer] }).stream('observe')
    for await (const event of stream) {
        if (event.type !== 'usage') continue
        expect(foldObservability(events).runs[0]).toMatchObject({ status: 'running', modelCalls: 1, pendingModels: [{ index: 1 }] })
        break
    }
    expect(foldObservability(events).runs[0]).toMatchObject({ status: 'stopped', pendingModels: [{ index: 1 }] })
})

it('keeps aggregate Tokens unknown when only part of the model calls report usage', () => {
    const summary = foldObservability([
        { type: 'run-start', sourceId: 's', runId: 'run', timestampMs: 0 },
        { type: 'model', sourceId: 's', runId: 'run', timestampMs: 1, index: 1, durationMs: 1, usage: {}, finishReason: 'tool-calls' },
        { type: 'model', sourceId: 's', runId: 'run', timestampMs: 2, index: 2, durationMs: 1, usage: { totalTokens: 40 }, finishReason: 'stop' },
        { type: 'run-end', sourceId: 's', runId: 'run', timestampMs: 3, durationMs: 3, status: 'success' }
    ])
    expect(summary.runs[0]?.usage.totalTokens).toBeUndefined()
    expect(summary.runs[0]?.models[1]?.usage.totalTokens).toBe(40)
    expect(compareObservabilityRuns(summary.runs)[0]?.averageTotalTokens).toBeUndefined()
})

it('allows one observer instance to observe two Agents with separate contexts concurrently', async () => {
    const events: ObservabilityEvent[] = []
    const observer = new ObservabilityPlugin<string>({ sourceId: 'shared', publish: event => { events.push(event) } })
    const results = await Promise.all([
        createAgent({ plugins: [model([emptyTurn()]), observer] }).run('first'),
        createAgent({ plugins: [model([emptyTurn()]), observer] }).run('second')
    ])
    expect(results.every(result => result.ok)).toBe(true)
    expect(foldObservability(events).runs.map(run => ({ status: run.status, models: run.modelCalls }))).toEqual([
        { status: 'success', models: 1 }, { status: 'success', models: 1 }
    ])
})

it('marks ambiguous shared-Context observations incomplete without rejecting either execution', async () => {
    const events: ObservabilityEvent[] = []
    const observer = new ObservabilityPlugin<string>({ sourceId: 'shared', publish: event => { events.push(event) } })
    const agent = createAgent({ plugins: [model([emptyTurn(), emptyTurn()]), observer] })
    const results = await Promise.all([agent.run('first'), agent.run('second')])
    const summary = foldObservability(events)
    expect(results.every(result => result.ok)).toBe(true)
    expect(summary.runs).toHaveLength(2)
    expect(summary.runs.every(run => run.incomplete && run.status === 'success')).toBe(true)
    expect(compareObservabilityRuns(summary.runs)).toEqual([])
})

it('retains the real error outcome when overlapping runs share one Context', async () => {
    const events: ObservabilityEvent[] = []
    let calls = 0
    const response: AgentPlugin<string> = { id: 'model', hooks: { async *model() {
        if (calls++ === 0) throw new Error('Synthetic model failure')
        const turn = emptyTurn(); yield { type: 'finish', reason: turn.finishReason }; return turn
    } } }
    const observer = new ObservabilityPlugin<string>({ sourceId: 'shared', publish: event => { events.push(event) } })
    const agent = createAgent({ plugins: [response, observer] })
    const results = await Promise.all([agent.run('first'), agent.run('second')])
    expect(results.map(result => result.ok).sort()).toEqual([false, true])
    const failed = foldObservability(events).runs.find(run => run.status === 'failed')!
    expect(failed.incomplete).toBe(true)
    expect(failed.errors).toContainEqual(expect.objectContaining({ phase: 'run', code: 'MODEL_FAILED' }))
})
