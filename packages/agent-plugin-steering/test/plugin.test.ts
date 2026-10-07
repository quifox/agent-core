import type { AgentRunOutcome, ModelTurnResult } from '@quifox/agent-core'
import { createAgent, defineTool, toolSuccess, type AgentPlugin, type ModelEvent, type ModelRequest, type ToolResult } from '@quifox/agent-core'
import { ChatModelPlugin } from '@quifox/agent-plugin-model'
import { chatModelOptions, type ScriptedModel as LanguageModel } from '../../../test/support/chat-model.mjs'
import { ExecutionCheckpointPlugin } from '@quifox/agent-plugin-checkpoint'
import { EventPublisherPlugin, type PublishedEvent } from '@quifox/agent-plugin-events'
import { getInterruptRunValue } from '@quifox/agent-plugin-interrupt'
import { ChatConversationPlugin, ChatSessionPlugin, copySessionValue, type ChatInput } from '@quifox/agent-plugin-session'
import { expect, it, vi } from 'vitest'
import { z } from 'zod'
import { RunSteeringPlugin } from '../src/index.js'

/** @param turn - 按请求次数生成完整模型事件。 */
function model(turn: (request: ModelRequest, index: number) => ModelEvent[]) {
    const requests: ModelRequest[] = []
    const adapter: LanguageModel = { provider: 'test', modelId: 'steering', async *stream(request) {
        requests.push(copySessionValue(request))
        for (const event of turn(request, requests.length)) { yield event }
    } }
    return { adapter, requests }
}

/** @param text - 最终文本。 */
function done(text: string): ModelEvent[] {
    return [{ type: 'text-delta', delta: text }, { type: 'finish', reason: 'stop' }]
}

/** @param ids - 同一轮的串行工具调用。 */
function calls(ids: string[]): ModelEvent[] {
    return [...ids.map(id => ({ type: 'tool-call' as const, call: { id, name: 'work', input: { id } } })),
        { type: 'finish', reason: 'tool-calls' }]
}

/** 用 Promise 控制真实异步边界。 */
function gate<Value = void>() {
    let release!: (value: Value) => void
    const promise = new Promise<Value>(resolve => { release = resolve })
    return { promise, release }
}

/** 创建真实 Session、Model 与事件组合。 */
function fixture(adapter: LanguageModel, plugins: AgentPlugin<ChatInput>[] = []) {
    const session = new ChatSessionPlugin({ id: 'steering', ownerId: 'test' })
    const conversation = new ChatConversationPlugin({ session, generation: new ChatModelPlugin({ session, ...chatModelOptions(adapter) }) })
    const steering = new RunSteeringPlugin()
    const events: PublishedEvent[] = []
    const publisher = new EventPublisherPlugin<ChatInput>({ sourceId: 'steering', publish: event => { events.push(event) } })
    const agent = createAgent<ChatInput>({ plugins: [steering, ...plugins, conversation, publisher] })
    return { agent, session, steering, events }
}

it('首次模型请求前连续 run 合为一批，保留三条 user 消息并共享一次模型结果', async () => {
    const entered = gate()
    const proceed = gate()
    const blocker: AgentPlugin<ChatInput> = { id: 'before-model-gate', hooks: { beforeStep: async () => {
        entered.release(); await proceed.promise; return { action: 'continue' }
    } } }
    const source = model(() => done('合并完成'))
    const f = fixture(source.adapter, [blocker])
    const first = f.agent.run({ prompt: '第一条' })
    await entered.promise
    const second = f.agent.run({ prompt: '第二条' })
    const third = f.agent.run({ prompt: '第三条' })
    proceed.release()
    const outcomes = await Promise.all([first, second, third])
    expect(outcomes[1]).not.toBe(outcomes[0])
    expect(outcomes[2]).not.toBe(outcomes[1])
    const results = outcomes.map(expectModelResult)
    expect(source.requests).toHaveLength(1)
    expect(source.requests[0]!.messages.map(message => [message.role, message.content])).toEqual([
        ['user', '第一条'], ['user', '第二条'], ['user', '第三条']
    ])
    expect(results.every(result => result === results[0])).toBe(true)
    expect(f.events.filter(event => event.event.type === 'run-input')).toHaveLength(1)
})

it('工具执行中连续 run：等待当前回执、停止剩余工具，并在下一轮一起插入两条消息', async () => {
    const started = gate()
    const finish = gate<ToolResult>()
    const executed: string[] = []
    const source = model((_request, index) => index === 1 ? calls(['a', 'b', 'c']) : done('新消息已处理'))
    const checkpoint = new ExecutionCheckpointPlugin()
    const tools: AgentPlugin<ChatInput> = { id: 'tools', hooks: { onInitialize: async ctx => {
        ctx.tools.register(defineTool({ name: 'work', description: '', inputSchema: z.object({ id: z.string() }),
            policy: { sideEffect: 'external', approval: 'none' }, execute: async input => {
                executed.push(input.id)
                if (input.id === 'a') { started.release(); return await finish.promise }
                return toolSuccess(`${input.id}完成`)
            } }))
    } } }
    const f = fixture(source.adapter, [checkpoint, tools])
    const first = f.agent.run({ prompt: '原任务' })
    await started.promise
    const second = f.agent.run({ prompt: '补充条件一' })
    const third = f.agent.run({ prompt: '补充条件二' })
    finish.release(toolSuccess('A完成'))
    expect(await first.then(getInterruptRunValue)).toMatchObject({ reason: 'stop' })
    const [secondResult, thirdResult] = await Promise.all([second, third]).then(values => values.map(expectModelResult))
    expect(secondResult).toBe(thirdResult)
    expect(secondResult!.text).toBe('新消息已处理')
    expect(executed).toEqual(['a'])
    expect(source.requests).toHaveLength(2)
    expect(source.requests[1]!.messages.slice(-2).map(message => [message.role, message.content])).toEqual([
        ['user', '补充条件一'], ['user', '补充条件二']
    ])
    const toolMessages = f.session.messages.filter(message => message.role === 'tool')
    expect(toolMessages.map(message => [message.toolCallId, message.content, message.isError ?? false])).toEqual([
        ['a', 'A完成', false],
        ['b', '工具未执行：本轮已被中断。', true],
        ['c', '工具未执行：本轮已被中断。', true]
    ])
    expect(checkpoint.snapshot()).toBeUndefined()
    expect(f.events.filter(event => event.event.type === 'run-input')).toHaveLength(2)
})

it('并发 resume 不作为用户消息合批', async () => {
    const entered = gate()
    const proceed = gate()
    const source = model(() => done('完成'))
    const blocker: AgentPlugin<ChatInput> = { id: 'gate', hooks: { beforeStep: async () => {
        entered.release(); await proceed.promise; return { action: 'continue' }
    } } }
    const f = fixture(source.adapter, [blocker])
    const running = f.agent.run({ prompt: '任务' })
    await entered.promise
    await expect(f.agent.run({ resume: true }).then(expectModelResult)).rejects.toMatchObject({ code: 'HOOK_FAILED' })
    proceed.release()
    await running.then(expectModelResult)
})

it('后续输入只在全部异步 onRunEnd 完成后进入下一批', async () => {
    vi.useFakeTimers()
    try {
        const modelEntered = gate()
        const modelRelease = gate()
        const cleanupEntered = gate()
        const cleanupRelease = gate()
        let requests = 0
        let ends = 0
        const adapter: LanguageModel = { provider: 'test', modelId: 'steering', async *stream() {
            requests += 1
            if (requests === 1) { modelEntered.release(); await modelRelease.promise }
            yield { type: 'finish', reason: 'stop' }
        } }
        const slowCleanup: AgentPlugin<ChatInput> = { id: 'slow-cleanup', hooks: { onRunEnd: async () => {
            if (++ends === 1) { cleanupEntered.release(); await cleanupRelease.promise }
        } } }
        const f = fixture(adapter, [slowCleanup])
        const first = f.agent.run({ prompt: '第一轮' })
        await modelEntered.promise
        let secondSettled = false
        const second = f.agent.run({ prompt: '第二轮' }).then(outcome => { secondSettled = true; return outcome })
        modelRelease.release()
        await cleanupEntered.promise
        await vi.advanceTimersByTimeAsync(1)
        expect(secondSettled).toBe(false)
        expect(requests).toBe(1)
        cleanupRelease.release()
        await first.then(expectModelResult)
        await second.then(expectModelResult)
        expect(requests).toBe(2)
    } finally { vi.useRealTimers() }
})

it('首次 beforeModel 前结束时把尚未接纳的合批输入转入下一批', async () => {
    const entered = gate()
    const proceed = gate()
    let first = true
    const stopOnce: AgentPlugin<ChatInput> = { id: 'stop-once', hooks: { beforeStep: async () => {
        if (first) { first = false; entered.release(); await proceed.promise; return { action: 'stop', value: { kind: 'early-stop' } } }
        return { action: 'continue' }
    } } }
    const source = model(() => done('后续输入已处理'))
    const f = fixture(source.adapter, [stopOnce])
    const original = f.agent.run({ prompt: '原输入' })
    await entered.promise
    const followUp = f.agent.run({ prompt: '不能丢失' })
    proceed.release()
    expect(await original).toMatchObject({ ok: true, value: { kind: 'early-stop' } })
    expect((await followUp.then(expectModelResult)).text).toBe('后续输入已处理')
    expect(source.requests).toHaveLength(1)
    expect(source.requests[0]!.messages.at(-1)).toEqual({ role: 'user', content: '不能丢失' })
})

it('同一 Steering 实例重复注册时明确失败而不是自等待', async () => {
    const source = model(() => done('不应调用'))
    const session = new ChatSessionPlugin({ id: 'duplicate', ownerId: 'test' })
    const conversation = new ChatConversationPlugin({ session, generation: new ChatModelPlugin({ session, ...chatModelOptions(source.adapter) }) })
    const steering = new RunSteeringPlugin()
    const result = await Promise.race([
        createAgent<ChatInput>({ plugins: [steering, steering, conversation] }).run({ prompt: '输入' }),
        new Promise<'timeout'>(resolve => setTimeout(() => resolve('timeout'), 100))
    ])
    expect(result).not.toBe('timeout')
    expect(result).toMatchObject({ ok: false, error: { code: 'MODEL_FAILED' } })
    expect(source.requests).toHaveLength(0)
})

/** 只消费标准 Outcome，不包装模型结果。 */
function expectModelResult(outcome: AgentRunOutcome): ModelTurnResult {
    if (!outcome.ok) { throw outcome.error }
    return outcome.value as ModelTurnResult
}
