import type { AgentRunOutcome, ModelTurnResult } from '@quifox/agent-core'
import { expect, it, vi } from 'vitest'
import { z } from 'zod'
import { createAgent, defineTool, toolSuccess, type AgentContext } from '@quifox/agent-core'
import { type ModelRequest } from '@quifox/agent-core'
import { ChatModelPlugin } from '@quifox/agent-plugin-model'
import { chatModelOptions, type ScriptedModel as LanguageModel } from '../../../test/support/chat-model.mjs'
import { ChatSessionPlugin, ChatConversationPlugin, copySessionValue, getConversation } from '../src/index.js'
import { createToolEntryPlugin, deriveToolPlugin } from '@quifox/agent-plugin-tools'

it('steering appends only at the next complete request boundary without changing the sent request', async () => {
    const requests: ModelRequest[] = []
    const model: LanguageModel = { provider: 'test', modelId: 'chat', async *stream(request) {
        requests.push(copySessionValue(request))
        if (requests.length === 1) {
            yield { type: 'tool-call', call: { id: 'read', name: 'read', input: {} } }; yield { type: 'finish', reason: 'tool-calls' }
        } else { yield { type: 'text-delta', delta: 'done' }; yield { type: 'finish', reason: 'stop' } }
    } }
    const session = new ChatSessionPlugin({ id: 's', ownerId: 'o' })
    const generation = new ChatModelPlugin({ session, ...chatModelOptions(model) })
    const conversation = new ChatConversationPlugin({ session, generation })
    let boundary = 0
    const agent = createAgent({ plugins: [conversation, { id: 'steer', hooks: {
        onInitialize: async ctx => { ctx.tools.register(defineTool({ name: 'read', description: 'Read synthetic data.', inputSchema: z.object({}).strict(),
            policy: { sideEffect: 'none', approval: 'none' }, execute: async () => toolSuccess('read result') })) },
        beforeModel: async ctx => { if (++boundary === 2) getConversation(ctx).conversation.appendSteeringMessages(['new direction']); return { action: 'continue' } }
    } }] })
    expect((await agent.run({ prompt: 'original task' })).ok).toBe(true)
    expect(requests[0]!.messages.map(message => message.content)).toEqual(['original task'])
    expect(requests[1]!.messages.map(message => message.content)).toEqual(['original task', '', 'read result', 'new direction'])
    expect(session.messages.at(-2)).toEqual({ role: 'user', content: 'new direction' })
})

it('单组合保留组件生命周期，跨轮 Context 重新获得能力；empty/fork 的模型重绑对应 Session', async () => {
    const requests: ModelRequest[] = []
    const model: LanguageModel = { provider: 'test', modelId: 'chat', async *stream(request) {
        requests.push(copySessionValue(request)); yield { type: 'text-delta', delta: 'reply' }; yield { type: 'finish', reason: 'stop' }
    } }
    const session = new ChatSessionPlugin({ id: 'parent', ownerId: 'user' })
    const generation = new ChatModelPlugin({ session, ...chatModelOptions(model), settings: { maxOutputTokens: 100 }, contextWindow: 10000 })
    const conversation = new ChatConversationPlugin({ session, generation })
    const contexts: AgentContext[] = []
    const initialized = vi.fn()
    const agent = createAgent({ plugins: [conversation, { id: 'observe', hooks: {
        onInitialize: async () => { initialized() }, onRunStart: async ctx => {
            contexts.push(ctx); expect(getConversation(ctx).conversation).toBe(conversation)
            expect(getConversation(ctx).modelInfo.contextWindow).toBe(10000); return { action: 'continue' }
        }
    } }] })
    await agent.run({ prompt: 'one' }).then(expectModelResult); await agent.run({ prompt: 'two' }).then(expectModelResult)
    expect(initialized).toHaveBeenCalledTimes(1)
    expect(contexts[0]).toBe(contexts[1])
    expect('messages' in conversation).toBe(false)
    const parent = session.snapshot()
    const child = await conversation.fork()
    await createAgent({ plugins: [child] }).run({ prompt: 'branch' }).then(expectModelResult)
    expect(requests[2]!.messages.map(message => message.content)).toEqual(['one', 'reply', 'two', 'reply', 'branch'])
    const empty = await conversation.empty()
    await createAgent({ plugins: [empty] }).run({ prompt: 'empty' }).then(expectModelResult)
    expect(requests[3]!.messages.map(message => message.content)).toEqual(['empty'])
    expect(session.snapshot()).toEqual(parent)
})

it('父工具执行期间从批次之前 Fork，子历史不携带半批工具；默认 Fork 仍明确失败', async () => {
    let calls = 0
    const requests: ModelRequest[] = []
    const model: LanguageModel = { provider: 'test', modelId: 'chat', async *stream(request) {
        requests.push(copySessionValue(request))
        if (++calls === 1) {
            yield { type: 'tool-call', call: { id: 'fork', name: 'fork', input: {} } }
            yield { type: 'finish', reason: 'tool-calls' }
        } else { yield { type: 'text-delta', delta: 'reply' }; yield { type: 'finish', reason: 'stop' } }
    } }
    const session = new ChatSessionPlugin({ id: 'p', ownerId: 'u' })
    const conversation = new ChatConversationPlugin({ session, generation: new ChatModelPlugin({ session, ...chatModelOptions(model) }) })
    await createAgent({ plugins: [conversation, { id: 'fork-tool', hooks: { onInitialize: async ctx => {
        ctx.tools.register(defineTool({ name: 'fork', description: '', inputSchema: z.object({}), policy: { sideEffect: 'none', approval: 'none' },
            execute: async (_input, context) => {
                const source = getConversation(context).conversation
                await expect(source.fork()).rejects.toThrow('不能 Fork')
                const child = await source.fork({ boundary: 'before-tools' })
                await createAgent({ plugins: [child] }).run({ prompt: 'child' }).then(expectModelResult)
                return toolSuccess(child.readOutput())
            } }))
    } } }] }).run({ prompt: 'parent' }).then(expectModelResult)
    expect(requests[1]!.messages.map(message => message.content)).toEqual(['parent', 'child'])
    expect(session.messages.filter(message => message.role === 'tool')).toHaveLength(1)
    expect(session.messages.some(message => message.content === 'child')).toBe(false)
})

it('衍生工具在组合前改写请求和目录结果，下一模型轮取得改写后的历史', async () => {
    let turns = 0
    const requests: ModelRequest[] = []
    const saved = vi.fn(async (title: string) => title)
    const model: LanguageModel = { provider: 'test', modelId: 'chat', async *stream(request) {
        requests.push(copySessionValue(request))
        turns += 1
        if (turns < 4) {
            const input = turns === 1 ? {} : turns === 2 ? { pluginId: 'todo' } :
                { pluginId: 'todo', tool: 'todo_create', args: { title: '待办' } }
            yield { type: 'tool-call', call: { id: `call-${turns}`, name: 'plugin', input } }
            yield { type: 'finish', reason: 'tool-calls' }
        } else { yield { type: 'text-delta', delta: '完成' }; yield { type: 'finish', reason: 'stop' } }
    } }
    const session = new ChatSessionPlugin({ id: 'p', ownerId: 'u' })
    const generation = new ChatModelPlugin({ session, ...chatModelOptions(model) })
    const conversation = new ChatConversationPlugin({ session, generation })
    const entry = createToolEntryPlugin('plugin', () => generation.request)
    const derived = deriveToolPlugin(entry, { id: 'todo', toolSets: [{ id: 'todo', tools: [defineTool({
        name: 'todo_create', description: '', inputSchema: z.object({ title: z.string() }),
        policy: { sideEffect: 'external', approval: 'none' }, execute: async input => toolSuccess(await saved(input.title))
    })] }] })
    await createAgent({ plugins: [entry, derived, conversation] }).run({ prompt: '创建待办' }).then(expectModelResult)
    expect(requests.every(request => request.tools.map(tool => tool.name).join() === 'plugin')).toBe(true)
    expect(requests[1]!.messages.at(-1)!.content).toContain('"pluginId":"todo"')
    expect(requests[2]!.messages.at(-1)!.content).toContain('todo_create')
    expect(saved).toHaveBeenCalledExactlyOnceWith('待办')
    expect(conversation.readOutput()).toBe('完成')
})

/** 仅供测试消费标准 Outcome；不包装模型结果。 */
function expectModelResult(outcome: AgentRunOutcome): ModelTurnResult {
    if (!outcome.ok) { throw outcome.error }
    return outcome.value as ModelTurnResult
}
