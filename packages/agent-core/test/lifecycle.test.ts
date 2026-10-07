import { expect, it, vi } from 'vitest'
import { z } from 'zod'
import { AgentError, MODEL_FINISH_REASON, createAgent, defineTool, toolSuccess, type AgentPlugin, StreamClosedError, type AgentRunOutcome } from '../src/index.js'
import { collectEvents, scripted, turn } from './fixtures.js'

it('run 与 stream 运行同一条插件链，模型只执行一次', async () => {
    const events = await collectEvents(createAgent({ plugins: [scripted()] }).stream({ image: 'attachment' }))
    expect(events.map(event => event.type)).toEqual(['run-start', 'text-delta', 'run-end'])
    expect(await createAgent({ plugins: [scripted()] }).run(123)).toMatchObject({ ok: true, value: { text: 'done', finishReason: 'stop' } })
})

it.each(['onRunStart', 'beforeStep', 'beforeModel', 'afterModel', 'afterStep'] as const)('%s stop 不开始下一轮且 finally 一次', async name => {
    const end = vi.fn(async () => {})
    const plugin: AgentPlugin = { id: 'stop', hooks: { [name]: async () => ({ action: 'stop', value: { requested: true } }), onRunEnd: end } }
    expect(await createAgent({ plugins: [scripted(), plugin] }).run(null)).toMatchObject({ ok: true, value: { requested: true } })
    expect(end).toHaveBeenCalledTimes(1)
})

it('消费者在真实结果事件退出时保留真实回执，不为余下工具伪造结果', async () => {
    const execute = vi.fn(async () => toolSuccess('saved'))
    const results: string[] = []
    let outcome: AgentRunOutcome | undefined
    const plugin: AgentPlugin = { id: 'tools', hooks: {
        onInitialize: async ctx => { ctx.tools.register(defineTool({ name: 'save', description: '', inputSchema: z.object({}), policy: { sideEffect: 'external', approval: 'none' }, execute })) },
        afterTool: async (_ctx, run) => { results.push(run.result.content); return { action: 'continue' } },
        onRunEnd: async (_ctx, result) => { outcome = result }
    } }
    const agent = createAgent({ plugins: [scripted([turn([{ id: 'a', name: 'save', input: {} }, { id: 'b', name: 'save', input: {} }]) ]), plugin] })
    for await (const event of agent.stream(null)) { if (event.type === 'tool-result') { break } }
    expect(execute).toHaveBeenCalledTimes(1)
    expect(results).toEqual(['saved'])
    expect(outcome).toMatchObject({ ok: false, error: expect.any(StreamClosedError) })
})

it('消费者在入口前退出不会开始工具；生成器资源也被关闭', async () => {
    const close = vi.fn()
    const end = vi.fn(async () => {})
    const plugin: AgentPlugin = { id: 'stream', hooks: {
        async *model() { try { yield { type: 'text-delta', delta: 'x' }; return turn() } finally { close() } },
        onRunEnd: end
    } }
    for await (const event of createAgent({ plugins: [plugin] }).stream(null)) { if (event.type === 'text-delta') { break } }
    expect(close).toHaveBeenCalledTimes(1)
    expect(end).toHaveBeenCalledTimes(1)
})

it('正常运行清理失败仍执行全部清理并返回错误 Outcome', async () => {
    const next = vi.fn(async () => {})
    const error = Error('failed cleanup')
    const outcome = await createAgent({ plugins: [scripted(), { id: 'cleanup', hooks: { onRunEnd: [async () => { throw error }, next] } }] }).run(null)
    expect(outcome).toMatchObject({ ok: false, error: { code: 'HOOK_FAILED', cause: error } })
    expect(next).toHaveBeenCalledTimes(1)
})

it.each(Object.values(MODEL_FINISH_REASON))('Core 不按 finishReason=%s 分类，无调用时 afterStep.continue 不强制再生成', async finishReason => {
    const result = { ...turn(), finishReason }
    const outcome = await createAgent({ plugins: [scripted([result]), {
        id: 'continue-step', hooks: { afterStep: async () => ({ action: 'continue' }) }
    }] }).run(null)
    expect(outcome.ok).toBe(true)
    expect(outcome.ok && outcome.value).toBe(result)
})

it('主错误保持同一 AgentError，观察和收尾失败均不阻断后项且 Outcome 身份一致', async () => {
    const primary = new AgentError({ code: 'MODEL_FAILED', phase: 'model', message: 'primary' })
    const observationError = Error('observer')
    const cleanupError = Error('cleanup')
    const trace: string[] = []
    const outcomes: AgentRunOutcome[] = []
    const plugin: AgentPlugin = { id: 'failure', hooks: {
        onRunStart: async (_ctx, _input, outcome) => { outcomes.push(outcome); return { action: 'continue' } },
        async *model() { throw primary },
        onError: [
            async (_ctx, error, outcome) => {
                expect(error).toBe(primary); outcomes.push(outcome); trace.push('error:first'); throw observationError
            },
            async () => { trace.push('error:second') }
        ],
        onRunEnd: [
            async (_ctx, outcome) => { outcomes.push(outcome); trace.push('end:first'); throw cleanupError },
            async () => { trace.push('end:second') }
        ]
    } }
    const outcome = await createAgent({ plugins: [plugin] }).run(null)
    expect(outcome.ok).toBe(false)
    expect(!outcome.ok && outcome.error).toBe(primary)
    expect(outcome.errors.map(error => error.cause)).toEqual([observationError, cleanupError])
    expect(outcomes.every(value => value === outcome)).toBe(true)
    expect(trace).toEqual(['error:first', 'error:second', 'end:first', 'end:second'])
})
