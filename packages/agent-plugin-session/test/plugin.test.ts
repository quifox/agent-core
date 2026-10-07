import type { AgentRunOutcome, ModelTurnResult } from '@quifox/agent-core'
import type { ToolRunResult } from '@quifox/agent-core'
import { expect, it, vi } from 'vitest'
import { createAgent, defineTool, toolSuccess, type AgentPlugin } from '@quifox/agent-core'
import { type ModelRequest } from '@quifox/agent-core'
import { ChatModelPlugin } from '@quifox/agent-plugin-model'
import { chatModelOptions, type ScriptedModel as LanguageModel } from '../../../test/support/chat-model.mjs'
import { ChatSessionPlugin, copySessionValue, type ChatInput, type ChatSessionSnapshot } from '../src/index.js'
import { z } from 'zod'

/** @param source - 可选脚本模型。 @param store - 观察持久化。 */
function fixture(source?: LanguageModel, store?: { save(snapshot: ChatSessionSnapshot): void | Promise<void> }) {
    const requests: ModelRequest[] = []
    const model: LanguageModel = source ?? { provider: 'test', modelId: 'test', async *stream(request) {
        requests.push(copySessionValue(request)); yield { type: 'text-delta', delta: 'reply' }; yield { type: 'finish', reason: 'stop' }
    } }
    const memory = new ChatSessionPlugin({ id: 'a', ownerId: 'u', ...(store ? { store } : {}) })
    const generation = new ChatModelPlugin({ session: memory, ...chatModelOptions(model) })
    const create = (...plugins: AgentPlugin<ChatInput>[]) => createAgent({ plugins: [memory, generation, ...plugins] })
    return { memory, generation, model, requests, create }
}

it('消息由 Session 保存；重复 run 复用整组插件实例', async () => {
    const f = fixture()
    let count = 0
    const agent = f.create({ id: 'counter', hooks: { onRunStart: async () => { count++; return { action: 'continue' } } } })
    await agent.run({ prompt: 'one' }).then(expectModelResult); await agent.run({ prompt: 'two' }).then(expectModelResult)
    expect(count).toBe(2)
    expect(f.requests[1]!.messages.map(message => message.content)).toEqual(['one', 'reply', 'two'])
    expect(f.memory.snapshot().history.map(entry => entry.message.content)).toEqual(['one', 'reply', 'two', 'reply'])
})

it('最终请求接纳晚于所有 beforeModel；生成插件不需在数组末尾', async () => {
    const f = fixture()
    const agent = f.create({ id: 'late', hooks: { beforeModel: async () => {
        f.generation.request.messages = [{ role: 'system', content: 'rule' }, ...f.generation.request.messages.map(message => ({ ...message, content: message.content + '!' }))]
        return { action: 'continue' }
    } } })
    await agent.run({ prompt: 'one' }).then(expectModelResult)
    expect(f.memory.snapshot().history.slice(0, 2).map(entry => entry.message)).toEqual(f.requests[0]!.messages)
    expect(f.requests[0]!.messages.map(message => message.content)).toEqual(['rule', 'one!'])
})

it('首次请求前追加独立 user 消息并保持顺序，请求冻结后拒绝追加', async () => {
    const f = fixture()
    let appended = false
    const agent = f.create({ id: 'append-users', hooks: { beforeModel: async () => {
        if (!appended) {
            appended = true
            f.memory.appendUserMessages(['two', 'three'])
        }
        return { action: 'continue' }
    }, afterModel: async () => {
        expect(() => f.memory.appendUserMessages(['late'])).toThrow('首次模型请求前')
        return { action: 'continue' }
    } } })
    await agent.run({ prompt: 'one' }).then(expectModelResult)
    await agent.run({ prompt: 'next' }).then(expectModelResult)
    expect(f.requests[0]!.messages.map(message => [message.role, message.content])).toEqual([
        ['user', 'one'], ['user', 'two'], ['user', 'three']
    ])
})

it('失败后使用相同输入重试时冻结最终消息，原 user 不重复', async () => {
    const requests: ModelRequest[] = []
    const f = fixture({ provider: 'test', modelId: 'test', async *stream(request) {
        requests.push(copySessionValue(request))
        if (requests.length === 1) { throw Error('offline') }
        yield { type: 'finish', reason: 'stop' }
    } })
    let injected = 0
    const agent = f.create({ id: 'inject', hooks: { beforeModel: async () => {
        if (f.memory.shouldPrepareInput()) { injected++; f.memory.messages.at(-1)!.content += injected }
        return { action: 'continue' }
    } } })
    await expect(agent.run({ prompt: 'one' }).then(expectModelResult)).rejects.toThrow()
    await agent.run({ prompt: 'one' }).then(expectModelResult)
    expect(requests[1]!.messages).toEqual(requests[0]!.messages)
    expect(f.memory.snapshot().history.filter(entry => entry.message.role === 'user')).toHaveLength(1)
    await agent.run({ prompt: 'new' }).then(expectModelResult)
    expect(injected).toBe(2)
})

it('Fork 和恢复复制消息与检查点，子会话不复用父存储回调', async () => {
    const save = vi.fn()
    const f = fixture(undefined, { save })
    await f.create().run({ prompt: 'source' }).then(expectModelResult)
    const saved = save.mock.calls.length
    const child = f.memory.fork('child')
    await createAgent({ plugins: [child, f.generation.fork(child)] }).run({ prompt: 'branch' }).then(expectModelResult)
    expect(save).toHaveBeenCalledTimes(saved)
    expect(f.memory.snapshot().history).toHaveLength(2)
    expect(child.snapshot().history).toHaveLength(4)
    const snapshot = child.snapshot(); snapshot.history[0]!.message.content = 'changed'
    expect(child.snapshot().history[0]!.message.content).toBe('source')
    const restored = new ChatSessionPlugin({ id: 'child', ownerId: 'u', snapshot: child.snapshot() })
    await createAgent({ plugins: [restored, f.generation.fork(restored)] }).run({ prompt: 'restore' }).then(expectModelResult)
    expect(restored.snapshot().history).toHaveLength(6)
    expect(() => new ChatSessionPlugin({ id: 'child', ownerId: 'other', snapshot: child.snapshot() })).toThrow('不一致')
})

it('保存请求失败不开始网络，失败后重试不重复 user', async () => {
    let fail = true
    const f = fixture(undefined, { save: () => { if (fail) { throw Error('store failed') } } })
    const agent = f.create()
    await expect(agent.run({ prompt: 'go' }).then(expectModelResult)).rejects.toThrow()
    expect(f.requests).toHaveLength(0)
    fail = false
    await agent.run({ prompt: 'go' }).then(expectModelResult)
    expect(f.requests[0]!.messages.filter(message => message.role === 'user')).toHaveLength(1)
})

it('未知写入保留 pending；核实保存失败不改变状态；成功后原输入续接不重执工具', async () => {
    let calls = 0
    let failStore = false
    const f = fixture({ provider: 'test', modelId: 'test', async *stream() {
        if (++calls === 1) { yield { type: 'tool-call', call: { id: 'write', name: 'write', input: {} } }; yield { type: 'finish', reason: 'tool-calls' } }
        else { yield { type: 'finish', reason: 'stop' } }
    } }, { save: () => { if (failStore) { throw Error('store failed') } } })
    const execute = vi.fn(async () => { throw Error('unknown write') })
    const agent = f.create({ id: 'tools', hooks: { onInitialize: async ctx => { ctx.tools.register(defineTool({
        name: 'write', description: '', inputSchema: z.object({}), policy: { sideEffect: 'external', approval: 'none' }, execute
    })) } } })
    await expect(agent.run({ prompt: 'go' }).then(expectModelResult)).rejects.toThrow()
    expect(f.memory.pendingToolCalls).toHaveLength(1)
    await expect(agent.run({ prompt: 'next' }).then(expectModelResult)).rejects.toThrow()
    expect(() => f.memory.fork('child')).toThrow()
    const results = [{ role: 'tool' as const, toolCallId: 'write', toolName: 'write', content: '已核实' }]
    failStore = true
    await expect(f.memory.completePendingTools(results)).rejects.toThrow()
    expect(f.memory.pendingToolCalls).toHaveLength(1)
    failStore = false
    await f.memory.completePendingTools(results)
    await agent.run({ prompt: 'go' }).then(expectModelResult)
    expect(execute).toHaveBeenCalledTimes(1)
    expect(f.memory.snapshot().history.filter(entry => entry.message.role === 'user')).toHaveLength(1)
})

it('工具成功后下一次模型失败，恢复继续模型，不重复业务和用户消息', async () => {
    let calls = 0
    const f = fixture({ provider: 'test', modelId: 'test', async *stream() {
        if (++calls === 1) { yield { type: 'tool-call', call: { id: 'write', name: 'write', input: {} } }; yield { type: 'finish', reason: 'tool-calls' } }
        else if (calls === 2) { throw Error('offline') }
        else { yield { type: 'finish', reason: 'stop' } }
    } })
    const execute = vi.fn(async () => toolSuccess('saved'))
    const agent = f.create({ id: 'tools', hooks: { onInitialize: async ctx => { ctx.tools.register(defineTool({
        name: 'write', description: '', inputSchema: z.object({}), policy: { sideEffect: 'external', approval: 'none' }, execute
    })) } } })
    await expect(agent.run({ prompt: 'go' }).then(expectModelResult)).rejects.toThrow()
    await agent.run({ prompt: 'go' }).then(expectModelResult)
    expect(execute).toHaveBeenCalledTimes(1)
    expect(f.memory.snapshot().history.filter(entry => entry.message.role === 'user')).toHaveLength(1)
})

it('错误共享会话的第二个 Agent 不能通过 finally 释放首个活动状态', async () => {
    let release!: () => void
    const paused = new Promise<void>(resolve => { release = resolve })
    const f = fixture({ provider: 'test', modelId: 'test', async *stream() { await paused; yield { type: 'finish', reason: 'stop' } } })
    const a = f.create(), b = f.create()
    const first = a.run({ prompt: 'first' }).then(expectModelResult)
    // 等待首个 onRunStart 已绑定，而非依赖定时器。
    while (!f.memory.shouldPrepareInput()) { await Promise.resolve() }
    await expect(b.run({ prompt: 'second' }).then(expectModelResult)).rejects.toThrow()
    await expect(b.run({ prompt: 'third' }).then(expectModelResult)).rejects.toThrow()
    release(); await first
    expect(f.memory.snapshot().history.map(entry => entry.message.content)).toEqual(['first', ''])
})

it('Session 按 afterTool 所在位置保存版本，不偷偷增加最终结果提交协议', async () => {
    let calls = 0
    const f = fixture({ provider: 'test', modelId: 'test', async *stream() {
        if (++calls === 1) { yield { type: 'tool-call', call: { id: 'a', name: 'echo', input: {} } }; yield { type: 'finish', reason: 'tool-calls' } }
        else { yield { type: 'finish', reason: 'stop' } }
    } })
    const agent = f.create({ id: 'later', hooks: {
        onInitialize: async ctx => { ctx.tools.register(defineTool({ name: 'echo', description: '', inputSchema: z.object({}), policy: { sideEffect: 'none', approval: 'none' }, execute: async () => toolSuccess('A') })) },
        afterTool: async (_ctx, run) => { run.result.content = 'B'; return { action: 'continue' } }
    } })
    const results: string[] = []
    for await (const event of agent.stream({ prompt: 'go' })) { if (event.type === 'tool-result') { results.push((event.run as ToolRunResult).result.content) } }
    expect(results).toEqual(['B'])
    expect(f.memory.messages.find(message => message.role === 'tool')?.content).toBe('A')
})

/** 仅供测试消费标准 Outcome；不包装模型结果。 */
function expectModelResult(outcome: AgentRunOutcome): ModelTurnResult {
    if (!outcome.ok) { throw outcome.error }
    return outcome.value as ModelTurnResult
}
