import type { AgentRunOutcome, ModelTurnResult } from '@quifox/agent-core'
import type { ToolRunResult } from '@quifox/agent-core'
import { expect, it, vi } from 'vitest'
import { z } from 'zod'
import { createAgent, defineTool, toolSuccess, type AgentEvent, type AgentPlugin, type ToolResult } from '@quifox/agent-core'
import { getInterruptRunValue, INTERRUPT_MODE, InterruptPlugin, type InterruptMode } from '../src/index.js'

/** @param execute - 本次真实操作。 */
function fixture(execute: () => Promise<ToolResult>, mode: InterruptMode = INTERRUPT_MODE.PAUSE) {
    const interrupt = new InterruptPlugin({ mode })
    let turns = 0
    const model: AgentPlugin = { id: 'model', hooks: { async *model() {
        return ({ text: '', reasoning: '', usage: {}, toolCalls: turns++ === 0 ? ['a', 'b', 'c'].map(id => ({ id, name: 'work', input: {} })) : [], finishReason: turns === 1 ? 'tool-calls' : 'stop' })
    } } }
    const tools: AgentPlugin = { id: 'tools', hooks: { onInitialize: async ctx => { ctx.tools.register(defineTool({
        name: 'work', description: '', inputSchema: z.object({}), policy: { sideEffect: 'external', approval: 'none' }, execute
    })) } } }
    return { interrupt, agent: createAgent({ plugins: [model, interrupt, tools] }) }
}

it('按钮闭包调用 requestStop，保留正在执行的真实回执并跳过余下调用', async () => {
    let begin!: () => void, finish!: (result: ToolResult) => void
    const started = new Promise<void>(resolve => { begin = resolve })
    const receipt = new Promise<ToolResult>(resolve => { finish = resolve })
    const execute = vi.fn(async () => { begin(); return receipt })
    const f = fixture(execute)
    const events: AgentEvent[] = []
    const work = (async () => { for await (const event of f.agent.stream(null)) { events.push(event) } })()
    await started
    const button = () => f.interrupt.requestStop()
    button(); finish(toolSuccess('saved'))
    await work
    const results = events.filter(event => event.type === 'tool-result')
    expect(results.map(event => (event.run as ToolRunResult).result.code ?? (event.run as ToolRunResult).result.status)).toEqual(['success'])
    expect(execute).toHaveBeenCalledTimes(1)
    expect(events.at(-1)).toMatchObject({ type: 'run-end', outcome: { ok: true, value: { reason: 'stop' } } })
    expect((await f.agent.run(null).then(expectModelResult)).finishReason).toBe('stop')
})

it('terminate 模式保留当前真实回执，并为后续调用写入中断结果', async () => {
    let begin!: () => void, finish!: (result: ToolResult) => void
    const started = new Promise<void>(resolve => { begin = resolve })
    const receipt = new Promise<ToolResult>(resolve => { finish = resolve })
    const execute = vi.fn(async () => { begin(); return receipt })
    const f = fixture(execute, INTERRUPT_MODE.TERMINATE)
    const events: AgentEvent[] = []
    const work = (async () => { for await (const event of f.agent.stream(null)) { events.push(event) } })()
    await started
    f.interrupt.requestStop()
    finish(toolSuccess('saved'))
    await work
    const results = events.filter(event => event.type === 'tool-result').map(event => (event.run as ToolRunResult).result)
    expect(results).toEqual([
        toolSuccess('saved'),
        { status: 'error', code: 'USER_INTERRUPTED', reason: 'stop', content: '工具未执行：本轮已被中断。' },
        { status: 'error', code: 'USER_INTERRUPTED', reason: 'stop', content: '工具未执行：本轮已被中断。' }
    ])
    expect(execute).toHaveBeenCalledTimes(1)
    expect(events.at(-1)).toMatchObject({ type: 'run-end', outcome: { ok: true, value: { reason: 'stop' } } })
})

it('空闲停止不影响下一次运行，工具入口事件暂停时停止不进入 prepare', async () => {
    const execute = vi.fn(async () => toolSuccess('ok'))
    const f = fixture(execute)
    f.interrupt.requestStop()
    for await (const event of f.agent.stream(null)) {
        if (event.type === 'tool-start') { f.interrupt.requestStop() }
    }
    expect(execute).not.toHaveBeenCalled()
    expect((await f.agent.run(null).then(expectModelResult)).finishReason).toBe('stop')
})

it('空字符串也是一次有效停止请求', async () => {
    const interrupt = new InterruptPlugin()
    const stop: AgentPlugin = { id: 'request-empty-reason', hooks: { onRunStart: async () => {
        interrupt.requestStop('')
        return { action: 'continue' }
    } } }
    const model = vi.fn(async function* () { return ({ text: '', reasoning: '', usage: {}, toolCalls: [], finishReason: 'stop' as const }) })
    const outcome = await createAgent({ plugins: [interrupt, stop, { id: 'model', hooks: { model } }] }).run(null)
    expect(getInterruptRunValue(outcome)).toMatchObject({ reason: '' })
    expect(model).not.toHaveBeenCalled()
})

it('无 I/O 取消时协作停止等当前操作完成，不把未知异常伪装成未执行', async () => {
    const execute = vi.fn(async () => { throw Error('unknown write') })
    const f = fixture(execute)
    await expect(f.agent.run(null).then(expectModelResult)).rejects.toThrow()
    expect(execute).toHaveBeenCalledTimes(1)
    f.interrupt.requestStop()
    expect((await f.agent.run(null).then(expectModelResult)).finishReason).toBe('stop')
})

it('恢复策略读取前面钩子改写后的目标元数据，不继承原工具的安全重试声明', async () => {
    const execute = vi.fn(async () => toolSuccess('written'))
    const interrupt = new InterruptPlugin()
    const model: AgentPlugin = { id: 'replay', hooks: {
        onRunStart: async ctx => { Object.assign(ctx, { execution: { requiresRetry: () => true } }); return { action: 'continue' } },
        async *model() { return ({ text: '', reasoning: '', usage: {}, toolCalls: [{ id: 'a', name: 'safe', input: {} }], finishReason: 'tool-calls' }) }
    } }
    const tools: AgentPlugin = { id: 'tools', hooks: { onInitialize: async ctx => {
        for (const name of ['safe', 'unsafe']) {
            ctx.tools.register(defineTool({ name, description: '', inputSchema: z.object({}),
                policy: { sideEffect: 'external', approval: 'none', retrySafe: name === 'safe' }, execute }))
        }
    } } }
    const route: AgentPlugin = { id: 'route', hooks: { beforeTool: async (_ctx, call) => { call.name = 'unsafe'; return { action: 'continue' } } } }
    expect(await createAgent({ plugins: [model, tools, route, interrupt] }).run(null).then(getInterruptRunValue)).toMatchObject({ reason: 'tool-result-unknown' })
    expect(execute).not.toHaveBeenCalled()
})

it('同一 Interrupt 对象重复插入时幂等绑定，不清除前面位置已经收到的停止请求', async () => {
    const interrupt = new InterruptPlugin()
    const model = vi.fn(async function* () { return ({ text: '', reasoning: '', usage: {}, toolCalls: [], finishReason: 'stop' as const }) })
    let stopOnStart = true
    const notify: AgentPlugin = { id: 'notify', hooks: { onRunStart: async () => {
        if (stopOnStart) { interrupt.requestStop() }
        return { action: 'continue' }
    } } }
    const agent = createAgent({ plugins: [interrupt, notify, interrupt, { id: 'model', hooks: { model } }] })
    expect(await agent.run(null).then(getInterruptRunValue)).toMatchObject({ reason: 'stop' })
    expect(model).not.toHaveBeenCalled()
    stopOnStart = false
    expect((await agent.run(null).then(expectModelResult)).finishReason).toBe('stop')
    expect(model).toHaveBeenCalledTimes(1)
})

/** 仅供测试消费标准 Outcome；不包装模型结果。 */
function expectModelResult(outcome: AgentRunOutcome): ModelTurnResult {
    if (!outcome.ok) { throw outcome.error }
    return outcome.value as ModelTurnResult
}
