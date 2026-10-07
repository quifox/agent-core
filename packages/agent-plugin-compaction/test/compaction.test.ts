import type { AgentRunOutcome, ModelTurnResult } from '@quifox/agent-core'
import { expect, it, vi } from 'vitest'
import { z } from 'zod'
import { createAgent, defineTool, toolSuccess, ToolRegistry } from '@quifox/agent-core'
import { type AgentMessage, type ModelRequest } from '@quifox/agent-core'
import { ChatModelPlugin } from '@quifox/agent-plugin-model'
import { chatModelOptions, type ScriptedModel as LanguageModel } from '../../../test/support/chat-model.mjs'
import { ChatSessionHistory, ChatSessionPlugin, ChatConversationPlugin, copySessionValue, type ConversationContext } from '@quifox/agent-plugin-session'
import { CompactionPlugin, ChatCompactionSource } from '../src/index.js'

/** @param messages - 已接纳历史。 @param model - 摘要与主模型脚本。 */
function fixture(messages: AgentMessage[], model: LanguageModel) {
    const history = new ChatSessionHistory({})
    for (const message of messages) { history.append(message) }
    const memory = new ChatSessionPlugin({ id: 's', ownerId: 'u', history })
    const generation = new ChatModelPlugin({ session: memory, ...chatModelOptions(model), settings: { maxOutputTokens: 500 }, contextWindow: 3000 })
    const conversation = new ChatConversationPlugin({ session: memory, generation, compaction: (session, model) =>
        new ChatCompactionSource(session, model, request => request.messages.reduce((size, message) => size + message.content.length, 0)) })
    const compression = new CompactionPlugin()
    return { memory, generation, conversation, compression, agent: createAgent({ plugins: [conversation, compression] }) }
}

it('两次候选保留工具且不执行，第三次 none；保留原记录与检查点，恢复不展开原文', async () => {
    const requests: ModelRequest[] = []
    const model: LanguageModel = { provider: 'test', modelId: 'test', async *stream(request) {
        requests.push(copySessionValue(request))
        if (requests.length < 3) { yield { type: 'tool-call', call: { id: 'danger', name: 'danger', input: {} } }; yield { type: 'finish', reason: 'tool-calls' } }
        else { yield { type: 'text-delta', delta: requests.length === 3 ? '摘要' : '完成' }; yield { type: 'finish', reason: 'stop' } }
    } }
    const f = fixture([{ role: 'system', content: '规则' }, { role: 'user', content: '旧'.repeat(2050) }], model)
    await f.agent.run({ prompt: '新'.repeat(500) }).then(expectModelResult)
    expect(requests).toHaveLength(4)
    expect(requests[2]!.tools).toEqual([])
    expect(requests[2]!.toolChoice).toBe('none')
    expect(requests[3]!.messages.map(message => message.content)).toEqual(['规则', '摘要', '新'.repeat(500)])
    expect(f.memory.snapshot().history.some(entry => entry.message.content.length === 2050)).toBe(true)
    expect(f.memory.snapshot().history.some(entry => entry.compaction)).toBe(true)
    const restored = new ChatSessionPlugin({ id: 's', ownerId: 'u', snapshot: f.memory.snapshot() })
    expect(restored.messages.map(message => message.content)).toEqual(['规则', '摘要', '新'.repeat(500), '完成'])
    const child = restored.fork('child')
    expect(child.snapshot().history).toEqual(restored.snapshot().history)
    expect(child.messages).not.toBe(restored.messages)
})

it('压缩保留最近整个工具批次，多个调用及 reasoning 一同保留', async () => {
    const requests: ModelRequest[] = []
    const model: LanguageModel = { provider: 'test', modelId: 'test', async *stream(request) {
        requests.push(copySessionValue(request))
        yield { type: 'text-delta', delta: '摘要' }; yield { type: 'finish', reason: 'stop' }
    } }
    const batch: AgentMessage[] = [
        { role: 'assistant', content: 'thinking', reasoning: 'reason', toolCalls: [{ id: 'a', name: 'read', input: {} }, { id: 'b', name: 'read', input: {} }] },
        { role: 'tool', toolCallId: 'a', toolName: 'read', content: 'A'.repeat(300) },
        { role: 'tool', toolCallId: 'b', toolName: 'read', content: 'B'.repeat(300) }
    ]
    const f = fixture([{ role: 'user', content: '旧'.repeat(2000) }, ...batch], model)
    // 模拟 while 中工具回执完成后，先准备下一步请求，再进行 beforeModel 压缩。
    const generate = f.generation.hooks.beforeStep
    if (typeof generate !== 'function') { throw Error('missing generation hook') }
    await generate({ tools: new ToolRegistry(), plugins: [] })
    const handler = f.compression.hooks.beforeModel
    if (typeof handler !== 'function') { throw Error('missing hook') }
    const ctx: ConversationContext = { tools: new ToolRegistry(), plugins: [], conversation: f.conversation, modelInfo: f.generation.info }
    await handler(ctx)
    expect(f.generation.request.messages.slice(1)).toEqual(batch)
    expect(f.memory.snapshot().history.some(entry => entry.message.content.length === 2000)).toBe(true)
})

it('不合格候选不替换主历史；三次摘要都不执行业务工具', async () => {
    let calls = 0
    const model: LanguageModel = { provider: 'test', modelId: 'test', async *stream() {
        calls++; yield { type: 'tool-call', call: { id: 'danger', name: 'danger', input: {} } }; yield { type: 'finish', reason: 'tool-calls' }
    } }
    const f = fixture([{ role: 'user', content: '旧'.repeat(2050) }], model)
    await expect(f.agent.run({ prompt: '新'.repeat(500) }).then(expectModelResult)).rejects.toThrow()
    expect(calls).toBe(3)
    expect(f.memory.snapshot().history.some(entry => entry.compaction)).toBe(false)
    expect(f.memory.messages[0]!.content).toHaveLength(2050)
})

it('摘要期间主状态变化拒绝过期提交，原始记录保留', async () => {
    let mutate = () => {}
    const model: LanguageModel = { provider: 'test', modelId: 'test', async *stream() {
        mutate(); yield { type: 'text-delta', delta: '摘要' }; yield { type: 'finish', reason: 'stop' }
    } }
    const f = fixture([{ role: 'user', content: '旧'.repeat(2050) }], model)
    mutate = () => { f.memory.messages.push({ role: 'user', content: 'concurrent' }) }
    await expect(f.agent.run({ prompt: '新'.repeat(500) }).then(expectModelResult)).rejects.toThrow()
    expect(f.memory.snapshot().history.some(entry => entry.compaction)).toBe(false)
})

it('摘要输出没有减少预算不提交；不可拆开的超大当前输入明确失败', async () => {
    const model: LanguageModel = { provider: 'test', modelId: 'test', async *stream() {
        yield { type: 'text-delta', delta: '长'.repeat(2600) }; yield { type: 'finish', reason: 'stop' }
    } }
    const f = fixture([{ role: 'user', content: '旧'.repeat(2050) }], model)
    await expect(f.agent.run({ prompt: '新'.repeat(500) }).then(expectModelResult)).rejects.toThrow()
    expect(f.memory.snapshot().history.some(entry => entry.compaction)).toBe(false)
    const other = fixture([{ role: 'user', content: '旧' }], model)
    await expect(other.agent.run({ prompt: '新'.repeat(4000) }).then(expectModelResult)).rejects.toThrow()
})

it('独立输入上限比上下文窗口更小时，仍在主请求前触发压缩', async () => {
    const requests: ModelRequest[] = []
    const model: LanguageModel = { provider: 'test', modelId: 'chat', async *stream(request) {
        requests.push(copySessionValue(request)); yield { type: 'text-delta', delta: requests.length === 1 ? '摘要' : '完成' }
        yield { type: 'finish', reason: 'stop' }
    } }
    const history = new ChatSessionHistory({})
    history.append({ role: 'user', content: '旧'.repeat(950) })
    const session = new ChatSessionPlugin({ id: 's', ownerId: 'u', history })
    const generation = new ChatModelPlugin({ session, ...chatModelOptions(model), contextWindow: 10000, maxInputTokens: 1300, settings: { maxOutputTokens: 500 } })
    const conversation = new ChatConversationPlugin({ session, generation, compaction: (memory, model) =>
        new ChatCompactionSource(memory, model, request => request.messages.reduce((total, message) => total + message.content.length, 0)) })
    await createAgent({ plugins: [conversation, new CompactionPlugin({ instruction: '压缩' })] }).run({ prompt: '新'.repeat(500) }).then(expectModelResult)
    expect(requests).toHaveLength(2)
    expect(requests[1]!.messages.map(message => message.content)).toEqual(['摘要', '新'.repeat(500)])
})

it('摘要网络错误与取消同时发生时保留取消语义，不重试或发送主请求', async () => {
    const controller = new AbortController()
    let requests = 0
    const model: LanguageModel = { provider: 'test', modelId: 'chat', async *stream() {
        requests += 1; controller.abort(); throw Error('transport closed')
    } }
    const history = new ChatSessionHistory({})
    history.append({ role: 'user', content: '旧'.repeat(2050) })
    const session = new ChatSessionPlugin({ id: 's', ownerId: 'u', history })
    const generation = new ChatModelPlugin({ session, ...chatModelOptions(model), contextWindow: 3000, settings: { maxOutputTokens: 500 }, signal: () => controller.signal })
    const conversation = new ChatConversationPlugin({ session, generation, compaction: (memory, model) =>
        new ChatCompactionSource(memory, model, request => request.messages.reduce((total, message) => total + message.content.length, 0)) })
    await expect(createAgent({ plugins: [conversation, new CompactionPlugin()] }).run({ prompt: '新'.repeat(500) }).then(expectModelResult)).rejects.toMatchObject({ code: 'ABORTED' })
    expect(requests).toBe(1)
    expect(session.snapshot().history.some(entry => entry.compaction)).toBe(false)
})

it('新输入达到阈值时主请求等待摘要完成，压缩后后续插件仍可原地追加内容', async () => {
    let release: (() => void) | undefined
    const requests: ModelRequest[] = []
    const f = fixture([{ role: 'user', content: '旧'.repeat(2050) }], { provider: 'test', modelId: 'test', async *stream(request) {
        requests.push(copySessionValue(request))
        if (request.messages.at(-1)?.content.includes('当前请求用于生成会话检查点')) {
            await new Promise<void>(resolve => { release = resolve })
            yield { type: 'text-delta', delta: '摘要' }
        } else { yield { type: 'text-delta', delta: '完成' } }
        yield { type: 'finish', reason: 'stop' }
    } })
    const agent = createAgent({ plugins: [f.conversation, f.compression, { id: 'late-context', hooks: { beforeModel: async () => {
        f.conversation.addSystemPrompt('后续系统提示词'); f.conversation.appendUserContext('后续补充'); return { action: 'continue' }
    } } }] })
    const running = agent.run({ prompt: '新'.repeat(500) }).then(expectModelResult)
    await vi.waitFor(() => expect(release).toBeDefined())
    expect(requests).toHaveLength(1)
    release!()
    await running
    expect(requests).toHaveLength(2)
    expect(requests[1]!.messages.at(-1)!.content).toContain('后续补充')
    expect(requests[1]!.messages[0]!.content).toBe('后续系统提示词')
    expect(requests[1]!.messages[1]!.content).toBe('摘要')
})

it('两个工具结果使上下文达到阈值，完成整个批次后压缩并保留全部回执', async () => {
    const requests: ModelRequest[] = []
    let main = 0
    const f = fixture([{ role: 'user', content: '旧'.repeat(1100) }], { provider: 'test', modelId: 'test', async *stream(request) {
        requests.push(copySessionValue(request))
        if (request.messages.at(-1)?.content.includes('当前请求用于生成会话检查点')) {
            yield { type: 'text-delta', delta: '摘要' }; yield { type: 'finish', reason: 'stop' }
        } else if (++main === 1) {
            for (const id of ['a', 'b']) { yield { type: 'tool-call', call: { id, name: 'read', input: {} } } }
            yield { type: 'finish', reason: 'tool-calls' }
        } else { yield { type: 'text-delta', delta: '完成' }; yield { type: 'finish', reason: 'stop' } }
    } })
    await createAgent({ plugins: [f.conversation, { id: 'tools', hooks: { onInitialize: async ctx => {
        ctx.tools.register(defineTool({ name: 'read', description: '', inputSchema: z.object({}), policy: { sideEffect: 'none', approval: 'none' }, execute: async () => toolSuccess('结果'.repeat(400)) }))
    } } }, f.compression] }).run({ prompt: '读取' }).then(expectModelResult)
    expect(requests).toHaveLength(3)
    const final = requests[2]!.messages
    expect(final[0]!.content).toBe('摘要')
    expect(final.filter(message => message.role === 'tool').map(message => message.toolCallId)).toEqual(['a', 'b'])
    expect(final.some(message => message.content === '旧'.repeat(1100))).toBe(false)
})

/** 仅供测试消费标准 Outcome；不包装模型结果。 */
function expectModelResult(outcome: AgentRunOutcome): ModelTurnResult {
    if (!outcome.ok) { throw outcome.error }
    return outcome.value as ModelTurnResult
}
