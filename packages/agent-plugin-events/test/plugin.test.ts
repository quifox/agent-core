import type { AgentRunOutcome, ModelTurnResult } from '@quifox/agent-core'
import { expect, it } from 'vitest'
import { AgentError, createAgent, defineTool, StreamClosedError, toolSuccess, type AgentEvent, type AgentPlugin } from '@quifox/agent-core'
import { z } from 'zod'
import { EventPublisherPlugin, type PublishedEvent } from '../src/index.js'

/** @param text - 最终文本。 */
function result(text: string): ModelTurnResult { return { text, reasoning: '', usage: {}, toolCalls: [], finishReason: 'stop' } }

it('独立 Agent 的原 run 发布增量和最终事实，原结果对象保持不变', async () => {
    const events: PublishedEvent[] = []
    const final = result('你好')
    const generation: AgentPlugin<string> = { id: 'source', hooks: { async *model() {
        yield { type: 'text-delta', delta: '你' }; yield { type: 'text-delta', delta: '好' }; return (final)
    } } }
    const publisher = new EventPublisherPlugin<string>({ sourceId: 'A', publish: event => { events.push(event) } })
    const agent = createAgent({ plugins: [generation, publisher] })
    const run = agent.run
    const stream = agent.stream
    expect(await agent.run('输入').then(expectModelResult)).toBe(final)
    expect(agent.run).toBe(run); expect(agent.stream).toBe(stream)
    expect(events.filter(event => event.event.type === 'text-delta').map(event => event.event)).toEqual([{ type: 'text-delta', delta: '你' }, { type: 'text-delta', delta: '好' }])
    expect(events.map(event => event.sequence)).toEqual(events.map((_event, index) => index + 1))
    expect(events.every(event => event.sourceId === 'A')).toBe(true)
    expect(events.at(-1)!.event).toEqual({ type: 'run-ending', ok: true, finishReason: 'stop' })
})

it('不同 Agent 使用独立发布出口，正常工具只执行一次', async () => {
    const eventsA: PublishedEvent[] = []
    const eventsB: PublishedEvent[] = []
    let calls = 0
    let turn = 0
    const source: AgentPlugin<string> = { id: 'tools-and-model', hooks: {
        onInitialize: async ctx => { ctx.tools.register(defineTool({ name: 'echo', description: '回声', inputSchema: z.object({}),
            policy: { sideEffect: 'none', approval: 'none' }, execute: async () => { calls += 1; return toolSuccess('真实回执') } })) },
        async *model() {
            if (++turn === 1) { return ({ ...result(''), toolCalls: [{ id: 'echo-1', name: 'echo', input: {} }], finishReason: 'tool-calls' }) }
            return (result('完成'))
        }
    } }
    const a = createAgent({ plugins: [source, new EventPublisherPlugin<string>({ sourceId: 'A', publish: event => { eventsA.push(event) } })] })
    const b = createAgent({ plugins: [{ id: 'B-source', hooks: { async *model() { return (result('B')) } } }, new EventPublisherPlugin<string>({ sourceId: 'B', publish: event => { eventsB.push(event) } })] })
    await Promise.all([a.run('A输入').then(expectModelResult), b.run('B输入').then(expectModelResult)])
    expect(calls).toBe(1)
    expect(eventsA.some(event => event.event.type === 'tool-result' && event.event.run.result.content === '真实回执')).toBe(true)
    expect(eventsB.every(event => event.sourceId === 'B')).toBe(true)
    expect(eventsB.some(event => event.event.type === 'tool-result')).toBe(false)
})

it('提前关闭 Core stream 也关闭委托生成器，不追加虚假结果', async () => {
    let closed = 0
    const events: PublishedEvent[] = []
    const source: AgentPlugin<string> = { id: 'source', hooks: { async *model() {
        try { yield { type: 'text-delta', delta: '部分输出' }; return (result('完整输出')) } finally { closed += 1 }
    } } }
    const stream = createAgent({ plugins: [source, new EventPublisherPlugin<string>({ sourceId: 'A', publish: event => { events.push(event) } })] }).stream('输入')
    while (true) { const next = await stream.next(); if (next.done || next.value.type === 'text-delta') { break } }
    await stream.return({ ok: false, error: new StreamClosedError(), errors: [] })
    expect(closed).toBe(1)
    expect(events.some(event => event.event.type === 'model-result')).toBe(false)
    expect(events.at(-1)!.event).toEqual({ type: 'run-ending', ok: false })
})

it('同步发布异常和异步拒绝不改变 Agent 执行，也不泄漏错误堆栈', async () => {
    for (const asyncFailure of [false, true]) {
        const failure = new Error('sink failed')
        const publisher = new EventPublisherPlugin<string>({ sourceId: 'A', publish: () => {
            if (asyncFailure) { return Promise.reject(failure) }
            throw failure
        } })
        const source: AgentPlugin<string> = { id: 'source', hooks: { async *model() { return (result('完成')) } } }
        expect((await createAgent({ plugins: [source, publisher] }).run('输入').then(expectModelResult)).finishReason).toBe('stop')
        await Promise.resolve()
        expect(publisher.publishError).toBe(failure)
    }
    const events: PublishedEvent[] = []
    const streamed: AgentEvent[] = []
    const secret = new AgentError({ code: 'MODEL_FAILED', phase: 'model', message: 'private details',
        details: { authorization: 'secret-token' }, cause: { response: 'private body' } })
    const source: AgentPlugin<string> = { id: 'failing', hooks: { async *model() { throw secret } } }
    const stream = createAgent({ plugins: [source, new EventPublisherPlugin<string>({ sourceId: 'A', publish: event => { events.push(event) } })] }).stream('输入')
    while (true) { const next = await stream.next(); if (next.done) { expect(next.value.ok).toBe(false); break }; streamed.push(next.value) }
    const error = events.find(event => event.event.type === 'error')!
    expect(Object.keys(error.event).sort()).toEqual(['code', 'phase', 'type'])
    expect(JSON.stringify(error)).not.toContain('private details')
    const visible = streamed.find(event => event.type === 'error') as { type: 'error'; error: unknown }
    expect(visible.error).toEqual({ code: 'MODEL_FAILED', phase: 'model' })
    expect(JSON.stringify(visible)).not.toMatch(/private details|secret-token|private body/)
})

it('并发调用在接纳前被拒绝时不污染当前运行的发布出口', async () => {
    let entered!: () => void
    let release!: () => void
    const active = new Promise<void>(resolve => { entered = resolve })
    const gate = new Promise<void>(resolve => { release = resolve })
    const published: PublishedEvent[] = []
    const source: AgentPlugin<string> = { id: 'source', hooks: { async *model() {
        entered(); await gate; return result('完成')
    } } }
    const publisher = new EventPublisherPlugin<string>({ sourceId: 'A', publish: event => { published.push(event) } })
    const agent = createAgent({ plugins: [source, publisher] })
    const first = agent.run('第一轮')
    await active
    const second = await agent.run('第二轮')
    expect(second.ok).toBe(false)
    expect(published.some(event => event.event.type === 'error')).toBe(false)
    release()
    await first.then(expectModelResult)
})

it('run-ending 保留显式空字符串中断原因', async () => {
    const published: PublishedEvent[] = []
    const publisher = new EventPublisherPlugin<string>({ sourceId: 'A', publish: event => { published.push(event) } })
    const stop: AgentPlugin<string> = { id: 'stop', hooks: {
        beforeModel: async () => ({ action: 'stop', value: { kind: 'interrupt', reason: '' } })
    } }

    expect(await createAgent({ plugins: [stop, publisher] }).run('输入')).toMatchObject({
        ok: true, value: { kind: 'interrupt', reason: '' }
    })
    expect(published.at(-1)?.event).toEqual({ type: 'run-ending', ok: true, interruptReason: '' })
})

it('仅在模型阶段要求上游，提前停止仍使用现有钩子；后置模型覆盖会明确失败', async () => {
    const events = new EventPublisherPlugin<string>({ sourceId: 'A', publish: () => {} })
    const stopped = createAgent({ plugins: [{ id: 'stop', hooks: { beforeModel: async () => ({ action: 'stop', value: { kind: 'test-stop' } }) } }, events] })
    expect(await stopped.run('输入')).toMatchObject({ ok: true, value: { kind: 'test-stop' } })
    await expect(createAgent({ plugins: [new EventPublisherPlugin<string>({ sourceId: 'B', publish: () => {} })] }).run('输入').then(expectModelResult)).rejects.toThrow()
    let called = false
    const late: AgentPlugin<string> = { id: 'late-source', hooks: { async *model() { called = true; return (result('后置')) } } }
    await expect(createAgent({ plugins: [new EventPublisherPlugin<string>({ sourceId: 'C', publish: () => {} }), late] }).run('输入').then(expectModelResult)).rejects.toThrow()
    expect(called).toBe(false)
})

/** 仅供测试消费标准 Outcome；不包装模型结果。 */
function expectModelResult(outcome: AgentRunOutcome): ModelTurnResult {
    if (!outcome.ok) { throw outcome.error }
    return outcome.value as ModelTurnResult
}
