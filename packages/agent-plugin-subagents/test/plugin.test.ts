import type { AgentEvent, AgentRunOutcome, ModelTurnResult } from '@quifox/agent-core'
import { expect, it, vi } from 'vitest'
import { createAgent, defineTool, toolSuccess, ToolRegistry, type AgentContext } from '@quifox/agent-core'
import { z } from 'zod'
import { type ModelRequest } from '@quifox/agent-core'
import { ChatModelPlugin } from '@quifox/agent-plugin-model'
import { chatModelOptions, type ScriptedModel as LanguageModel } from '../../../test/support/chat-model.mjs'
import { ChatConversationPlugin, ChatSessionPlugin, ChatSessionHistory, copySessionValue } from '@quifox/agent-plugin-session'
import { SubAgentsPlugin } from '../src/index.js'

it('reserves concurrent names before child I/O and exposes the actual automatic name in receipts', async () => {
    let requests = 0, creations = 0
    const session = new ChatSessionPlugin({ id: 'parent', ownerId: 'owner' })
    const generation = new ChatModelPlugin({ session, ...chatModelOptions({ provider: 'test', modelId: 'chat', async *stream() {
        requests += 1; yield { type: 'text-delta', delta: 'done' }; yield { type: 'finish', reason: 'stop' }
    } }) })
    const conversation = new ChatConversationPlugin({ session, generation })
    const plugin = new SubAgentsPlugin({ plugins: child => [child], createConversation: async parent => { creations += 1; return parent.empty() } })
    const ctx = { tools: new ToolRegistry(), plugins: [], conversation, modelInfo: generation.info }
    const pair = await Promise.allSettled([plugin.fork(ctx, 'empty', { name: 'Curie' }), plugin.fork(ctx, 'empty', { name: 'ｃｕｒｉｅ' })])
    expect(pair.map(result => result.status)).toEqual(['fulfilled', 'rejected'])
    expect(pair[1]).toMatchObject({ reason: { code: 'SUBAGENT_NAME_TAKEN' } })
    expect(creations).toBe(1); expect(requests).toBe(0)
    const automatic = await plugin.fork(ctx)
    expect(plugin.send(automatic, 'inspect', ctx)).toMatchObject({ data: { taskId: automatic, name: 'Turing', status: 'queued' } })
    expect((await plugin.wait(automatic, ctx)).data).toMatchObject({ status: 'completed', text: 'done' })
    expect(requests).toBe(1)
})

it('reports rejected Host admission without starting a child model or exposing private errors', async () => {
    let calls = 0
    const session = new ChatSessionPlugin({ id: 'parent', ownerId: 'owner' })
    const generation = new ChatModelPlugin({ session, ...chatModelOptions({ provider: 'test', modelId: 'test', async *stream() {
        calls += 1; yield { type: 'text-delta', delta: 'unexpected' }; yield { type: 'finish', reason: 'stop' }
    } }) })
    const conversation = new ChatConversationPlugin({ session, generation })
    const plugin = new SubAgentsPlugin({ plugins: child => [child], onInput: async () => { throw new Error('private Host failure') } })
    const ctx = { tools: new ToolRegistry(), plugins: [], conversation, modelInfo: generation.info }
    const taskId = await plugin.fork(ctx)
    const receipt = await plugin.sendAsync(taskId, 'rejected input', ctx)
    expect(receipt).toMatchObject({ status: 'error', code: 'SUBAGENT_ADMISSION_FAILED' })
    expect(receipt.content).not.toContain('private Host failure'); expect(calls).toBe(0)
    expect((await plugin.wait(taskId, ctx)).data).toEqual({ status: 'idle' })
    await expect(plugin.start(ctx, 'rejected first input')).rejects.toThrow('was not admitted')
    expect(calls).toBe(0)
})

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
    expect(JSON.parse(memory.messages.find(message => message.role === 'tool' && message.toolName === 'subagent_start')!.content)).toMatchObject({ name: 'Turing', taskId: 'task-1', status: 'running' })
    expect(memory.messages.find(message => message.role === 'tool' && message.toolName === 'subagent_wait')?.content).toBe('子任务完成')
})

it('restores stable child capabilities without model calls and reserves prior default identities', async () => {
    let calls = 0
    const session = new ChatSessionPlugin({ id: 'parent', ownerId: 'owner' })
    const options = chatModelOptions({ provider: 'test', modelId: 'test', async *stream() {
        calls += 1
        yield { type: 'text-delta', delta: 'new child reply' }
        yield { type: 'finish', reason: 'stop' }
    } })
    const generation = new ChatModelPlugin({ session, ...options })
    const parent = new ChatConversationPlugin({ session, generation }), child = await parent.empty()
    const plugin = new SubAgentsPlugin({ plugins: conversation => [conversation] })
    const context = { tools: new ToolRegistry(), plugins: [], conversation: parent, modelInfo: generation.info }
    const foreign = { tools: new ToolRegistry(), plugins: [], conversation: await parent.empty(), modelInfo: generation.info }
    const control = plugin.restore(parent, 'task-1', child, [child], { status: 'unknown' })
    expect(control.signal()).toBeUndefined(); expect((await plugin.wait('task-1', foreign)).status).toBe('error')
    expect((await plugin.wait('task-1', context)).data).toEqual({ status: 'unknown' }); expect(calls).toBe(0)
    plugin.recordResult('task-1', { status: 'completed', text: 'verified preserved reply' })
    expect((await plugin.wait('task-1', context)).content).toBe('verified preserved reply')
    const next = await plugin.fork(context)
    expect(next).toBe('task-2'); expect(calls).toBe(0)
    await plugin.sendAsync(next, 'new child task', context)
    expect((await plugin.wait(next, context)).content).toBe('new child reply'); expect(calls).toBe(1)
    expect(() => plugin.restore(parent, 'task-1', child, [child], { status: 'idle' })).toThrow('恢复')
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

it('a passive fork keeps its plan prefix and performs no generation until messaged', async () => {
    const requests: ModelRequest[] = []
    const model: LanguageModel = { provider: 'test', modelId: 'chat', async *stream(request) {
        requests.push(copySessionValue(request))
        yield { type: 'text-delta', delta: request.messages.at(-1)?.content ?? '' }
        yield { type: 'finish', reason: 'stop' }
    } }
    const history = new ChatSessionHistory({})
    history.record([{ role: 'user', content: 'original plan' }, { role: 'assistant', content: 'approved plan' }])
    const session = new ChatSessionPlugin({ id: 'p', ownerId: 'u', history })
    const generation = new ChatModelPlugin({ session, ...chatModelOptions(model) })
    const conversation = new ChatConversationPlugin({ session, generation })
    const plugin = new SubAgentsPlugin({ plugins: child => [child] })
    const ctx = { tools: new (await import('@quifox/agent-core')).ToolRegistry(), plugins: [], conversation, modelInfo: generation.info }
    const id = await plugin.fork(ctx)
    expect((await plugin.wait(id)).data).toEqual({ status: 'idle' })
    expect(requests).toHaveLength(0)
    await createAgent({ plugins: [conversation] }).run({ prompt: 'parent later change' })
    plugin.send(id, 'review implementation')
    expect((await plugin.wait(id)).data).toMatchObject({ status: 'completed', text: 'review implementation' })
    expect(requests[1]!.messages.map(message => message.content)).toEqual(['original plan', 'approved plan', 'review implementation'])
    plugin.send(id, 'review again')
    expect((await plugin.wait(id)).data).toMatchObject({ status: 'completed', text: 'review again' })
    expect(requests[2]!.messages.map(message => message.content)).toContain('review implementation')
})

it('stops one child model through its own signal while another child completes', async () => {
    let entered!: () => void
    const ready = new Promise<void>(resolve => { entered = resolve })
    const model: LanguageModel = { provider: 'test', modelId: 'chat', async *stream(request) {
        if (request.messages.at(-1)?.content === 'blocked') {
            entered()
            await new Promise<void>((_resolve, reject) => request.signal!.addEventListener('abort', () => reject(request.signal!.reason), { once: true }))
        }
        yield { type: 'text-delta', delta: 'done' }; yield { type: 'finish', reason: 'stop' }
    } }
    const session = new ChatSessionPlugin({ id: 'p', ownerId: 'u' })
    const generation = new ChatModelPlugin({ session, ...chatModelOptions(model) })
    const conversation = new ChatConversationPlugin({ session, generation })
    const plugin = new SubAgentsPlugin({ plugins: child => [child] })
    const ctx = { tools: new (await import('@quifox/agent-core')).ToolRegistry(), plugins: [], conversation, modelInfo: generation.info }
    const first = await plugin.start(ctx, 'blocked', 'empty')
    await ready
    const second = await plugin.start(ctx, 'normal', 'empty')
    expect(plugin.stop(first, ctx).status).toBe('success')
    expect((await plugin.wait(first)).data).toMatchObject({ status: 'cancelled' })
    expect((await plugin.wait(second)).data).toMatchObject({ status: 'completed', text: 'done' })
    expect((await plugin.wait(first, { ...ctx })).code).toBe('SUBAGENT_NOT_FOUND')
    expect(session.messages).toHaveLength(0)
})

it('stopping during a tool preserves its real receipt, closes unstarted calls and permits a followup', async () => {
    let entered!: () => void
    let finish!: () => void
    const ready = new Promise<void>(resolve => { entered = resolve })
    const blocked = new Promise<void>(resolve => { finish = resolve })
    let executions = 0
    const requests: ModelRequest[] = []
    const model: LanguageModel = { provider: 'test', modelId: 'chat', async *stream(request) {
        requests.push(copySessionValue(request))
        if (request.messages.at(-1)?.content === 'blocked tool') {
            yield { type: 'tool-call', call: { id: 'first', name: 'save', input: {} } }
            yield { type: 'tool-call', call: { id: 'second', name: 'save', input: {} } }
            yield { type: 'finish', reason: 'tool-calls' }; return
        }
        yield { type: 'text-delta', delta: 'followup done' }; yield { type: 'finish', reason: 'stop' }
    } }
    const session = new ChatSessionPlugin({ id: 'p', ownerId: 'u' })
    const generation = new ChatModelPlugin({ session, ...chatModelOptions(model) })
    const conversation = new ChatConversationPlugin({ session, generation })
    const events: AgentEvent[] = []
    const plugin = new SubAgentsPlugin({ onEvent: (_task, event) => { events.push(event) }, plugins: child => [child, { id: 'tools', hooks: { onInitialize: async ctx => { ctx.tools.register(defineTool({
        name: 'save', description: 'Save a synthetic value.', inputSchema: z.object({}).strict(), policy: { sideEffect: 'external', approval: 'none' },
        execute: async () => { executions += 1; entered(); await blocked; return toolSuccess('saved') }
    })) } } }] })
    const ctx = { tools: new (await import('@quifox/agent-core')).ToolRegistry(), plugins: [], conversation, modelInfo: generation.info }
    const id = await plugin.start(ctx, 'blocked tool', 'empty')
    await ready
    plugin.stop(id)
    finish()
    expect((await plugin.wait(id)).data).toMatchObject({ status: 'cancelled' })
    plugin.send(id, 'continue with new plan')
    expect((await plugin.wait(id)).data).toMatchObject({ status: 'completed', text: 'followup done' })
    expect(executions).toBe(1)
    const receipts = requests.at(-1)!.messages.filter(message => message.role === 'tool')
    expect(receipts).toEqual([
        { role: 'tool', content: 'saved', toolCallId: 'first', toolName: 'save' },
        { role: 'tool', content: '工具未执行：子 Agent 已请求停止。', toolCallId: 'second', toolName: 'save' }
    ])
    expect(events.filter(event => event.type === 'tool-result')).toMatchObject([
        { run: { call: { id: 'first' }, result: { status: 'success', content: 'saved' } } },
        { run: { call: { id: 'second' }, result: { status: 'error', code: 'USER_INTERRUPTED' } } }
    ])
})

it('does not inject internal stop closures into a reused Host plugin array', async () => {
    const model: LanguageModel = { provider: 'test', modelId: 'chat', async *stream() {
        yield { type: 'text-delta', delta: 'done' }; yield { type: 'finish', reason: 'stop' }
    } }
    const session = new ChatSessionPlugin({ id: 'p', ownerId: 'u' })
    const generation = new ChatModelPlugin({ session, ...chatModelOptions(model) })
    const conversation = new ChatConversationPlugin({ session, generation })
    const shared: import('@quifox/agent-core').AgentPlugin<import('@quifox/agent-plugin-session').ChatInput>[] = []
    const plugin = new SubAgentsPlugin({ plugins: child => { shared[0] = child; return shared } })
    const ctx = { tools: new (await import('@quifox/agent-core')).ToolRegistry(), plugins: [], conversation, modelInfo: generation.info }
    const first = await plugin.start(ctx, 'first', 'empty')
    await plugin.wait(first)
    plugin.stop(first)
    const second = await plugin.start(ctx, 'second', 'empty')
    expect((await plugin.wait(second)).data).toMatchObject({ status: 'completed', text: 'done' })
    expect(shared).toHaveLength(1)
})

it('gracefully waits for a real tool receipt and Host cleanup, reports stopping on timeout and publishes one final result', async () => {
    let entered!: () => void, finish!: () => void, finishCleanup!: () => void, cleaned!: () => void, executions = 0
    const ready = new Promise<void>(resolve => { entered = resolve }), blocked = new Promise<void>(resolve => { finish = resolve })
    const cleanup = new Promise<void>(resolve => { finishCleanup = resolve }), cleanupReady = new Promise<void>(resolve => { cleaned = resolve })
    const events: AgentEvent[] = [], results = vi.fn(); let modelCalls = 0
    const session = new ChatSessionPlugin({ id: 'parent', ownerId: 'owner' })
    const generation = new ChatModelPlugin({ session, ...chatModelOptions({ provider: 'test', modelId: 'chat', async *stream() {
        if (++modelCalls > 1) { yield { type: 'text-delta', delta: 'done' }; yield { type: 'finish', reason: 'stop' }; return }
        yield { type: 'tool-call', call: { id: 'save-one', name: 'save', input: {} } }
        yield { type: 'tool-call', call: { id: 'save-two', name: 'save', input: {} } }
        yield { type: 'finish', reason: 'tool-calls' }
    } }) })
    const conversation = new ChatConversationPlugin({ session, generation })
    const plugin = new SubAgentsPlugin({ onEvent: (_id, event) => { events.push(event) }, onResult: results,
        onStop: async (_id, settled) => { await settled; cleaned(); await cleanup }, plugins: child => [child, { id: 'tools', hooks: { onInitialize: async ctx => {
            ctx.tools.register(defineTool({ name: 'save', description: 'A controlled write.', inputSchema: z.object({}).strict(), policy: { sideEffect: 'external', approval: 'none' },
                execute: async () => { executions += 1; entered(); await blocked; return toolSuccess('actually saved') } }))
        } } }] })
    const ctx = { tools: new ToolRegistry(), plugins: [], conversation, modelInfo: generation.info }
    const id = await plugin.start(ctx, 'save it', 'empty')
    try {
        await ready
        expect((await plugin.stopAndWait(id, ctx, 0)).data).toMatchObject({ taskId: id, name: 'Turing', status: 'stopping' })
        expect(plugin.send(id, 'must not start', ctx).code).toBe('SUBAGENT_STOPPING')
        finish(); await cleanupReady
        expect((await plugin.wait(id, ctx, 0)).data).toEqual({ status: 'stopping' }); expect(results).not.toHaveBeenCalled()
        finishCleanup(); expect((await plugin.wait(id, ctx)).data).toEqual({ status: 'cancelled' })
        expect(executions).toBe(1); expect(results).toHaveBeenCalledExactlyOnceWith(id, { status: 'cancelled' })
        expect(events.filter(event => event.type === 'tool-result')).toMatchObject([
            { run: { call: { id: 'save-one' }, result: { status: 'success', content: 'actually saved' } } },
            { run: { call: { id: 'save-two' }, result: { code: 'USER_INTERRUPTED' } } }
        ])
    } finally { plugin.stop(id, ctx); finish(); finishCleanup(); await plugin.join(id, ctx) }
})

it('does not revive a task when a durable admission finishes after stop was requested', async () => {
    let admitted!: () => void, finishAdmission!: () => void, calls = 0
    const ready = new Promise<void>(resolve => { admitted = resolve }), blocked = new Promise<void>(resolve => { finishAdmission = resolve })
    const session = new ChatSessionPlugin({ id: 'parent', ownerId: 'owner' })
    const generation = new ChatModelPlugin({ session, ...chatModelOptions({ provider: 'test', modelId: 'chat', async *stream() {
        calls += 1; yield { type: 'text-delta', delta: 'unexpected' }; yield { type: 'finish', reason: 'stop' }
    } }) })
    const conversation = new ChatConversationPlugin({ session, generation })
    const plugin = new SubAgentsPlugin({ plugins: child => [child], onInput: async () => { admitted(); await blocked } })
    const ctx = { tools: new ToolRegistry(), plugins: [], conversation, modelInfo: generation.info }, id = await plugin.fork(ctx)
    const receipt = plugin.sendAsync(id, 'late admission', ctx)
    await ready; plugin.stop(id, ctx); finishAdmission()
    expect((await receipt).code).toBe('SUBAGENT_STOPPING'); expect((await plugin.wait(id, ctx)).data).toEqual({ status: 'cancelled' }); expect(calls).toBe(0)
})

/** 仅供测试消费标准 Outcome；不包装模型结果。 */
function expectModelResult(outcome: AgentRunOutcome): ModelTurnResult {
    if (!outcome.ok) { throw outcome.error }
    return outcome.value as ModelTurnResult
}
