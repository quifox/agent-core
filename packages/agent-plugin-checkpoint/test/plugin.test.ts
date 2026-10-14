import type { AgentRunOutcome, ModelTurnResult } from '@quifox/agent-core'
import { EventPublisherPlugin } from '@quifox/agent-plugin-events'
import { expect, it } from 'vitest'
import { z } from 'zod'
import { createAgent, defineTool, toolSuccess, type AgentPlugin } from '@quifox/agent-core'
import { ChatModelPlugin } from '@quifox/agent-plugin-model'
import { chatModelOptions, type ScriptedModel as LanguageModel } from '../../../test/support/chat-model.mjs'
import { ChatConversationPlugin, ChatSessionPlugin, type ChatInput } from '@quifox/agent-plugin-session'
import { getInterruptRunValue, InterruptPlugin } from '@quifox/agent-plugin-interrupt'
import { ExecutionCheckpointPlugin } from '../src/index.js'

it('a failed model request can continue its accepted context without a fabricated tool checkpoint', async () => {
    let requests = 0
    const inputs: string[][] = []
    const f = fixture({ provider: 'test', modelId: 'chat', async *stream(request) {
        inputs.push(request.messages.map(message => message.content))
        if (++requests === 1) throw new Error('Synthetic model failure')
        yield { type: 'text-delta', delta: 'done' }; yield { type: 'finish', reason: 'stop' }
    } }, async value => value)
    expect((await f.agent.run({ prompt: 'original' })).ok).toBe(false)
    expect(f.checkpoint.snapshot()).toBeUndefined()
    expect((await f.agent.run({ resume: true })).ok).toBe(true)
    expect(inputs).toEqual([['original'], ['original']])
})

/** @param model - 已脚本化模型。 @param execute - 可观察的业务工具。 @param retrySafe - 工具的可选安全重试声明。 */
function fixture(model: LanguageModel, execute: (id: string) => Promise<string>, retrySafe?: boolean) {
    const session = new ChatSessionPlugin({ id: 's', ownerId: 'u' })
    const generation = new ChatModelPlugin({ session, ...chatModelOptions(model) })
    const conversation = new ChatConversationPlugin({ session, generation })
    const checkpoint = new ExecutionCheckpointPlugin(undefined, { canResumeModel: () => !!session.snapshot().pendingInput && session.messages.at(-1)?.role !== 'assistant' })
    const interrupt = new InterruptPlugin()
    const tools: AgentPlugin<ChatInput> = { id: 'tools', hooks: { onInitialize: async ctx => {
        ctx.tools.register(defineTool({ name: 'work', description: '', inputSchema: z.object({ id: z.string() }),
            policy: { sideEffect: 'external', approval: 'none', ...(retrySafe === undefined ? {} : { retrySafe }) }, execute: async input => toolSuccess(await execute(input.id)) }))
    } } }
    return { session, generation, conversation, checkpoint, interrupt, tools, agent: createAgent({ plugins: [conversation, checkpoint, interrupt, tools, new EventPublisherPlugin<ChatInput>({ sourceId: 'test' })] }) }
}

it('三个工具仅完成一个后关闭流；Fork 后继续剩余两个，不重复 assistant 或已完成业务', async () => {
    const executed: string[] = []
    let modelCalls = 0
    const f = fixture({ provider: 'test', modelId: 'chat', async *stream() {
        if (++modelCalls === 1) {
            for (const id of ['a', 'b', 'c']) { yield { type: 'tool-call', call: { id, name: 'work', input: { id } } } }
            yield { type: 'finish', reason: 'tool-calls' }
        } else { yield { type: 'text-delta', delta: '完成' }; yield { type: 'finish', reason: 'stop' } }
    } }, async id => { executed.push(id); return id })
    const stream = f.agent.stream({ prompt: '三个操作' })
    for await (const event of stream) { if (event.type === 'tool-result') { break } }
    expect(executed).toEqual(['a'])
    const parentSnapshot = f.session.snapshot()
    const child = await f.conversation.fork({ boundary: 'resume' })
    const childCheckpoint = f.checkpoint.fork()
    await createAgent({ plugins: [child, childCheckpoint, f.tools] }).run({ resume: true }).then(expectModelResult)
    expect(executed).toEqual(['a', 'b', 'c'])
    expect(modelCalls).toBe(2)
    expect(f.session.snapshot()).toEqual(parentSnapshot)
    expect(childCheckpoint.snapshot()).toBeUndefined()
    expect(child.readOutput()).toBe('完成')
    expect(f.checkpoint.snapshot()?.calls.map(call => call.status)).toEqual(['completed', 'not-started', 'not-started'])
})

it.each([undefined, false])('retrySafe=%s 的未知调用由策略插件停止，核实后继续', async retrySafe => {
    const executed: string[] = []
    let calls = 0
    let fail = true
    const f = fixture({ provider: 'test', modelId: 'chat', async *stream() {
        if (++calls === 1) {
            for (const id of ['a', 'b']) { yield { type: 'tool-call', call: { id, name: 'work', input: { id } } } }
            yield { type: 'finish', reason: 'tool-calls' }
        } else { yield { type: 'text-delta', delta: '完成' }; yield { type: 'finish', reason: 'stop' } }
    } }, async id => { executed.push(id); if (fail) { throw Error('回执未知') }; return id }, retrySafe)
    await expect(f.agent.run({ prompt: '执行' }).then(expectModelResult)).rejects.toThrow()
    expect(await f.agent.run({ resume: true }).then(getInterruptRunValue)).toMatchObject({ reason: 'tool-result-unknown' })
    expect(executed).toEqual(['a'])
    expect(f.checkpoint.snapshot()?.calls.map(call => call.status)).toEqual(['started', 'not-started'])
    await f.conversation.confirmTool('a', toolSuccess('已核实完成'))
    f.checkpoint.confirm('a', toolSuccess('已核实完成'))
    fail = false
    await f.agent.run({ resume: true }).then(expectModelResult)
    expect(executed).toEqual(['a', 'b'])
    expect(f.session.pendingToolCalls).toEqual([])
    expect(f.checkpoint.snapshot()).toBeUndefined()
})

it.each([true, false])('安全恢复跳过已完成调用；Checkpoint 在 Interrupt 前=%s', async checkpointFirst => {
    const executed: string[] = []
    let modelCalls = 0
    let fail = true
    const f = fixture({ provider: 'test', modelId: 'chat', async *stream() {
        if (++modelCalls === 1) {
            for (const id of ['a', 'b', 'c']) { yield { type: 'tool-call', call: { id, name: 'work', input: { id } } } }
            yield { type: 'finish', reason: 'tool-calls' }
        } else { yield { type: 'text-delta', delta: '完成' }; yield { type: 'finish', reason: 'stop' } }
    } }, async id => {
        executed.push(id)
        if (id === 'b' && fail) { fail = false; throw Error('回执未知') }
        return id
    }, true)
    const agent = checkpointFirst ? f.agent : createAgent({ plugins: [f.conversation, f.interrupt, f.checkpoint, f.tools] })
    await expect(agent.run({ prompt: '执行' }).then(expectModelResult)).rejects.toThrow()
    expect(executed).toEqual(['a', 'b'])
    expect(f.checkpoint.snapshot()?.calls.map(call => call.status)).toEqual(['completed', 'started', 'not-started'])
    expect((await agent.run({ resume: true }).then(expectModelResult)).finishReason).toBe('stop')
    expect(executed).toEqual(['a', 'b', 'b', 'c'])
    expect(modelCalls).toBe(2)
    expect(f.session.messages.filter(message => message.role === 'tool').map(message => message.toolCallId)).toEqual(['a', 'b', 'c'])
    expect(f.session.messages.filter(message => message.role === 'assistant' && message.toolCalls?.length)).toHaveLength(1)
    expect(f.checkpoint.snapshot()).toBeUndefined()
})

it.each(['before', 'after', 'repeated'])('前置停止不留下错误 started，Checkpoint 位置=%s', async position => {
    const executed: string[] = []
    let modelCalls = 0
    let stop = true
    const f = fixture({ provider: 'test', modelId: 'chat', async *stream() {
        if (++modelCalls === 1) { yield { type: 'tool-call', call: { id: 'a', name: 'work', input: { id: 'a' } } }; yield { type: 'finish', reason: 'tool-calls' } }
        else { yield { type: 'text-delta', delta: '完成' }; yield { type: 'finish', reason: 'stop' } }
    } }, async id => { executed.push(id); return id })
    const stopping: AgentPlugin<ChatInput> = { id: 'stop', hooks: { beforeTool: async () => stop ? { action: 'stop', value: { kind: 'test-stop' } } : { action: 'continue' } } }
    const order = position === 'before' ? [f.checkpoint, stopping] : position === 'after' ? [stopping, f.checkpoint] : [f.checkpoint, f.checkpoint, stopping]
    const agent = createAgent({ plugins: [f.conversation, ...order, f.interrupt, f.tools] })
    expect(await agent.run({ prompt: '执行' })).toMatchObject({ ok: true, value: { kind: 'test-stop' } })
    expect(executed).toEqual([])
    expect(f.checkpoint.snapshot()?.calls[0]?.status).toBe('not-started')
    stop = false
    await agent.run({ resume: true }).then(expectModelResult)
    expect(executed).toEqual(['a'])
})

it('用户停止后保存 A 的真实结果，B/C 不补回执，原 Agent 可以续跑', async () => {
    const executed: string[] = []
    let modelCalls = 0
    const f = fixture({ provider: 'test', modelId: 'chat', async *stream() {
        if (++modelCalls === 1) {
            for (const id of ['a', 'b', 'c']) { yield { type: 'tool-call', call: { id, name: 'work', input: { id } } } }
            yield { type: 'finish', reason: 'tool-calls' }
        } else { yield { type: 'text-delta', delta: '完成' }; yield { type: 'finish', reason: 'stop' } }
    } }, async id => { executed.push(id); if (id === 'a') { f.interrupt.requestStop() }; return id })
    expect(await f.agent.run({ prompt: '执行' }).then(getInterruptRunValue)).toMatchObject({ reason: 'stop' })
    expect(executed).toEqual(['a'])
    expect(f.checkpoint.snapshot()?.calls.map(call => call.status)).toEqual(['completed', 'not-started', 'not-started'])
    expect(f.session.messages.filter(message => message.role === 'tool').map(message => message.toolCallId)).toEqual(['a'])
    expect((await f.agent.run({ resume: true }).then(expectModelResult)).finishReason).toBe('stop')
    expect(executed).toEqual(['a', 'b', 'c'])
})

it.each([true, false])('拒绝并发调用不清除活动续跑的安全检查；Checkpoint 在 Interrupt 前=%s', async checkpointFirst => {
    const calls = ['safe', 'unsafe'].map(name => ({ id: name, name, input: {} }))
    const turn: ModelTurnResult = { text: '', reasoning: '', usage: {}, finishReason: 'tool-calls', toolCalls: calls }
    const session = new ChatSessionPlugin({ id: 'resume-overlap', ownerId: 'u', snapshot: {
        version: 1, id: 'resume-overlap', ownerId: 'u', history: [
            { id: '1', message: { role: 'user', content: '原任务' } },
            { id: '2', message: { role: 'assistant', content: '', toolCalls: calls } }
        ]
    } })
    const model: LanguageModel = { provider: 'test', modelId: 'chat', async *stream() {
        yield { type: 'text-delta', delta: '完成' }; yield { type: 'finish', reason: 'stop' }
    } }
    const conversation = new ChatConversationPlugin({ session,
        generation: new ChatModelPlugin({ session, ...chatModelOptions(model) }) })
    const checkpoint = new ExecutionCheckpointPlugin({ turn, calls: calls.map(call => ({ id: call.id, status: 'started' })) })
    const interrupt = new InterruptPlugin()
    let release!: () => void
    let entered!: () => void
    const gate = new Promise<void>(resolve => { release = resolve })
    const started = new Promise<void>(resolve => { entered = resolve })
    const executed: string[] = []
    const tools: AgentPlugin<ChatInput> = { id: 'tools', hooks: { onInitialize: async ctx => {
        for (const name of ['safe', 'unsafe']) {
            ctx.tools.register(defineTool({ name, description: '', inputSchema: z.object({}),
                policy: { sideEffect: 'external', approval: 'none', retrySafe: name === 'safe' },
                execute: async () => {
                    executed.push(name)
                    if (name === 'safe') { entered(); await gate }
                    return toolSuccess(name)
                } }))
        }
    } } }
    const order = checkpointFirst ? [checkpoint, interrupt] : [interrupt, checkpoint]
    const agent = createAgent({ plugins: [conversation, ...order, tools] })
    const first = agent.run({ resume: true })
    await started
    let outcome: AgentRunOutcome | undefined
    try {
        const before = checkpoint.snapshot()
        expect(checkpoint.requiresRetry('unsafe')).toBe(true)
        const rejected = await agent.run({ prompt: '并发输入' })
        expect(rejected.ok).toBe(false)
        expect(checkpoint.snapshot()).toEqual(before)
        expect(checkpoint.replaying).toBe(true)
        expect(checkpoint.requiresRetry('unsafe')).toBe(true)
    } finally { release(); outcome = await first }
    expect(getInterruptRunValue(outcome)).toMatchObject({ reason: 'tool-result-unknown' })
    expect(executed).toEqual(['safe'])
    expect(checkpoint.snapshot()?.calls.map(call => call.status)).toEqual(['completed', 'started'])
})

it('最终回复已经保存，在 model-end 关闭流不会留下待恢复工具轮', async () => {
    let modelCalls = 0
    const f = fixture({ provider: 'test', modelId: 'chat', async *stream() {
        modelCalls += 1
        yield { type: 'text-delta', delta: '完成' }; yield { type: 'finish', reason: 'stop' }
    } }, async id => id)
    for await (const event of f.agent.stream({ prompt: '回复' })) {
        if (event.type === 'model-end') { break }
    }
    expect(f.conversation.readOutput()).toBe('完成')
    expect(f.checkpoint.snapshot()).toBeUndefined()
    await expect(f.agent.run({ resume: true }).then(expectModelResult)).rejects.toThrow()
    expect(modelCalls).toBe(1)
})

/** 仅供测试消费标准 Outcome；不包装模型结果。 */
function expectModelResult(outcome: AgentRunOutcome): ModelTurnResult {
    if (!outcome.ok) { throw outcome.error }
    return outcome.value as ModelTurnResult
}
