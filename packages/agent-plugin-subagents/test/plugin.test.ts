import type { AgentRunOutcome, ModelTurnResult } from '@quifox/agent-core'
import { expect, it, vi } from 'vitest'
import { createAgent, type AgentContext } from '@quifox/agent-core'
import { type ModelRequest } from '@quifox/agent-core'
import { ChatModelPlugin } from '@quifox/agent-plugin-model'
import { chatModelOptions, type ScriptedModel as LanguageModel } from '../../../test/support/chat-model.mjs'
import { ChatConversationPlugin, ChatSessionPlugin, ChatSessionHistory, copySessionValue } from '@quifox/agent-plugin-session'
import { SubAgentsPlugin } from '../src/index.js'

it('工具入口启动 fork 子 Agent 并等待最终输出；父历史不包含子任务消息', async () => {
    const requests: ModelRequest[] = []
    let parentTurns = 0
    const model: LanguageModel = { provider: 'test', modelId: 'chat', async *stream(request) {
        requests.push(copySessionValue(request))
        if (request.messages.at(-1)?.content === '子任务') {
            yield { type: 'text-delta', delta: '子任务完成' }; yield { type: 'finish', reason: 'stop' }; return
        }
        if (++parentTurns === 1) {
            yield { type: 'tool-call', call: { id: 'start', name: 'subagent_start', input: { prompt: '子任务', mode: 'fork' } } }; yield { type: 'finish', reason: 'tool-calls' }
        } else if (parentTurns === 2) {
            yield { type: 'tool-call', call: { id: 'wait', name: 'subagent_wait', input: { taskId: 'task-1' } } }; yield { type: 'finish', reason: 'tool-calls' }
        } else { yield { type: 'text-delta', delta: '父任务完成' }; yield { type: 'finish', reason: 'stop' } }
    } }
    const memory = new ChatSessionPlugin({ id: 'p', ownerId: 'u' })
    const conversation = new ChatConversationPlugin({ session: memory, generation: new ChatModelPlugin({ session: memory, ...chatModelOptions(model) }) })
    const subagents = new SubAgentsPlugin({ plugins: child => [child] })
    await createAgent({ plugins: [conversation, subagents] }).run({ prompt: '父任务' }).then(expectModelResult)
    const childRequest = requests.find(request => request.messages.at(-1)?.content === '子任务')!
    expect(childRequest.messages.map(message => message.content)).toEqual(['父任务', '子任务'])
    expect(memory.messages.some(message => message.role === 'user' && message.content === '子任务')).toBe(false)
    expect(memory.messages.find(message => message.role === 'tool' && message.toolName === 'subagent_start')?.content).toContain('task-1')
    expect(memory.messages.find(message => message.role === 'tool' && message.toolName === 'subagent_wait')?.content).toBe('子任务完成')
})

it('empty 子任务等待超时后继续运行，再次等待得到同一结果并清理计时器', async () => {
    vi.useFakeTimers()
    try {
        let finish: (() => void) | undefined
        const requests: ModelRequest[] = []
        const model: LanguageModel = { provider: 'test', modelId: 'chat', async *stream(request) {
            requests.push(copySessionValue(request)); await new Promise<void>(resolve => { finish = resolve })
            yield { type: 'text-delta', delta: '完成' }; yield { type: 'finish', reason: 'stop' }
        } }
        const session = new ChatSessionPlugin({ id: 'p', ownerId: 'u' })
        const generation = new ChatModelPlugin({ session, ...chatModelOptions(model) })
        const conversation = new ChatConversationPlugin({ session, generation })
        const plugin = new SubAgentsPlugin({ plugins: child => [child] })
        const ctx: AgentContext = { tools: new (await import('@quifox/agent-core')).ToolRegistry(), plugins: [conversation] }
        Object.assign(ctx, { conversation, modelInfo: generation.info })
        const id = await plugin.start(ctx, 'empty', 'empty')
        const first = plugin.wait(id)
        await vi.advanceTimersByTimeAsync(10000)
        expect((await first).data).toEqual({ status: 'running' })
        expect(requests[0]!.messages.map(message => message.content)).toEqual(['empty'])
        finish!()
        expect((await plugin.wait(id)).data).toEqual({ status: 'completed', text: '完成' })
        expect((await plugin.wait(id)).data).toEqual({ status: 'completed', text: '完成' })
        expect(vi.getTimerCount()).toBe(0)
    } finally { vi.useRealTimers() }
})

it('子任务失败被插件接纳，等待返回错误，不产生未处理的后台拒绝', async () => {
    const model: LanguageModel = { provider: 'test', modelId: 'chat', async *stream() { throw Error('private detail') } }
    const session = new ChatSessionPlugin({ id: 'p', ownerId: 'u' })
    const generation = new ChatModelPlugin({ session, ...chatModelOptions(model) })
    const conversation = new ChatConversationPlugin({ session, generation })
    const plugin = new SubAgentsPlugin({ plugins: child => [child] })
    const ctx = { tools: new (await import('@quifox/agent-core')).ToolRegistry(), plugins: [], conversation, modelInfo: generation.info }
    const result = await plugin.wait(await plugin.start(ctx, 'fail', 'empty'))
    expect(result.status).toBe('error')
    expect(result.content).not.toContain('private detail')
})

it.each(['onRunStart', 'beforeModel'])('Fork 子任务在 %s 停止时不返回父会话的旧回复', async boundary => {
    const stream = vi.fn(async function* () { yield { type: 'finish' as const, reason: 'stop' as const } })
    const model: LanguageModel = { provider: 'test', modelId: 'chat', stream }
    const history = new ChatSessionHistory({})
    history.record([
        { role: 'user', content: '旧问题' }, { role: 'assistant', content: '父会话旧回复' }
    ])
    const session = new ChatSessionPlugin({ id: 'p', ownerId: 'u', history })
    const generation = new ChatModelPlugin({ session, ...chatModelOptions(model) })
    const conversation = new ChatConversationPlugin({ session, generation })
    const plugin = new SubAgentsPlugin({ plugins: child => boundary === 'onRunStart'
        ? [{ id: 'stop-before-session', hooks: { onRunStart: async () => ({ action: 'stop', value: { kind: 'test-stop' } }) } }, child]
        : [child, { id: 'stop-before-model', hooks: { beforeModel: async () => ({ action: 'stop', value: { kind: 'test-stop' } }) } }] })
    const ctx = { tools: new (await import('@quifox/agent-core')).ToolRegistry(), plugins: [], conversation, modelInfo: generation.info }
    const result = await plugin.wait(await plugin.start(ctx, '新子任务'))
    expect(result.status).toBe('error')
    expect(result.content).not.toContain('父会话旧回复')
    expect(stream).not.toHaveBeenCalled()
})

it('子任务新生成与父历史相同的文本仍然算本轮完成', async () => {
    const stream = vi.fn(async function* () {
        yield { type: 'text-delta' as const, delta: '相同回复' }
        yield { type: 'finish' as const, reason: 'stop' as const }
    })
    const history = new ChatSessionHistory({})
    history.record([{ role: 'user', content: '旧问题' }, { role: 'assistant', content: '相同回复' }])
    const session = new ChatSessionPlugin({ id: 'p', ownerId: 'u', history })
    const generation = new ChatModelPlugin({ session, ...chatModelOptions({ provider: 'test', modelId: 'chat', stream }) })
    const conversation = new ChatConversationPlugin({ session, generation })
    const plugin = new SubAgentsPlugin({ plugins: child => [child] })
    const ctx = { tools: new (await import('@quifox/agent-core')).ToolRegistry(), plugins: [], conversation, modelInfo: generation.info }
    const result = await plugin.wait(await plugin.start(ctx, '新子任务'))
    expect(result).toMatchObject({ status: 'success', data: { status: 'completed', text: '相同回复' } })
    expect(stream).toHaveBeenCalledTimes(1)
})

it('完成任务只保留配置数量，最旧结果到期后不再占用状态', async () => {
    const model: LanguageModel = { provider: 'test', modelId: 'chat', async *stream(request) {
        yield { type: 'text-delta', delta: request.messages.at(-1)?.content ?? '' }
        yield { type: 'finish', reason: 'stop' }
    } }
    const session = new ChatSessionPlugin({ id: 'p', ownerId: 'u' })
    const generation = new ChatModelPlugin({ session, ...chatModelOptions(model) })
    const conversation = new ChatConversationPlugin({ session, generation })
    const plugin = new SubAgentsPlugin({ plugins: child => [child], maxCompletedTasks: 1 })
    const ctx = { tools: new (await import('@quifox/agent-core')).ToolRegistry(), plugins: [], conversation, modelInfo: generation.info }
    const first = await plugin.start(ctx, 'first', 'empty')
    expect((await plugin.wait(first)).data).toMatchObject({ status: 'completed', text: 'first' })
    const second = await plugin.start(ctx, 'second', 'empty')
    expect((await plugin.wait(second)).data).toMatchObject({ status: 'completed', text: 'second' })
    expect(await plugin.wait(first)).toMatchObject({ status: 'error', code: 'SUBAGENT_NOT_FOUND' })
    expect((await plugin.wait(second)).data).toMatchObject({ status: 'completed', text: 'second' })
})

/** 仅供测试消费标准 Outcome；不包装模型结果。 */
function expectModelResult(outcome: AgentRunOutcome): ModelTurnResult {
    if (!outcome.ok) { throw outcome.error }
    return outcome.value as ModelTurnResult
}
