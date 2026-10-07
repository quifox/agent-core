import { describe, expect, it, vi } from 'vitest'
import { createAgent, defineTool, toolSuccess } from '@quifox/agent-core'
import type { AgentContext, AgentPlugin, AgentRunOutcome, ModelTurnResult, ToolCall, ToolRunResult } from '@quifox/agent-core'
import { ChatConversationPlugin, ChatSessionPlugin } from '@quifox/agent-plugin-session'
import { ChatModelPlugin } from '@quifox/agent-plugin-model'
import { chatModelOptions } from '../../../test/support/chat-model.mjs'
import type { ChatInput } from '@quifox/agent-plugin-session'
import { z } from 'zod'
import { PluginCompositionPlugin } from '../src/index.js'

interface Input { calls?: ToolCall[] }
interface Context extends AgentContext { input: Input; turn: number; receipts: ToolRunResult[] }
type Plugin = AgentPlugin<Input, Context>

function generation(action?: (ctx: Context) => void | Promise<void>): Plugin {
    return { id: 'model', hooks: {
        onRunStart: async (ctx, input) => {
            ctx.input = input; ctx.turn = 0; ctx.receipts = []
            return { action: 'continue' }
        },
        model: async function* (ctx): AsyncGenerator<never, ModelTurnResult, void> {
            let calls: ToolCall[] = []
            if (ctx.turn++ === 0) { await action?.(ctx); calls = ctx.input.calls ?? [] }
            return { text: 'done', reasoning: '', toolCalls: calls, usage: {}, finishReason: calls.length ? 'tool-calls' : 'stop' }
        },
        afterTool: async (ctx, receipt) => { ctx.receipts.push(receipt); return { action: 'continue' } }
    } }
}

function deferred() {
    let resolve!: () => void
    const promise = new Promise<void>(accept => { resolve = accept })
    return { promise, resolve }
}

describe('最后收尾的自动插件交接', () => {
    it('所有旧收尾后自动切换，当前工具仍可调用，新工具只在下一轮初始化', async () => {
        const phases: string[] = []
        let initialized = 0
        const fresh: Plugin = { id: 'fresh', hooks: { onInitialize: async ctx => {
            initialized++
            ctx.tools.register(defineTool({ name: 'fresh', description: '', inputSchema: z.object({}),
                policy: { sideEffect: 'none', approval: 'none' }, execute: async () => toolSuccess('new') }))
        } } }
        const oldTool: Plugin = { id: 'old', hooks: { onInitialize: async ctx => {
            ctx.tools.register(defineTool({ name: 'old', description: '', inputSchema: z.object({}),
                policy: { sideEffect: 'none', approval: 'none' }, execute: async () => { phases.push('old-tool'); return toolSuccess('old') } }))
        }, onRunEnd: async () => { phases.push('old-cleanup'); expect(runtime.agent).toBe(original) } } }
        const manager = new PluginCompositionPlugin<Input, Context>({ replaceAgent: next => {
            expect(initialized).toBe(0); phases.push('replace'); runtime.agent = next
        } })
        const model = generation(ctx => {
            if (ctx.input.calls?.[0]?.name === 'old') {
                manager.setNextPlugins([model, manager, fresh])
                expect(ctx.tools.get('fresh')).toBeUndefined()
            }
        })
        const runtime = { agent: createAgent({ plugins: [manager, model, oldTool] }) }
        const original = runtime.agent
        expect((await runtime.agent.run({ calls: [{ id: 'old-1', name: 'old', input: {} }] })).ok).toBe(true)
        expect(phases).toEqual(['old-tool', 'old-cleanup', 'replace'])
        expect(runtime.agent).not.toBe(original)
        expect(initialized).toBe(0)
        expect((await runtime.agent.run({ calls: [{ id: 'new-1', name: 'fresh', input: {} }] })).ok).toBe(true)
        expect(initialized).toBe(1)
    })

    it('完整数组最后一次为准，保留同名对象与重复位置，只移除自己的内部尾部对象', async () => {
        const a: Plugin = { id: 'same' }
        const b: Plugin = { id: 'same' }
        const first: Plugin[] = []
        let nextContext: Context | undefined
        const probe: Plugin = { id: 'probe', hooks: { onInitialize: async ctx => { nextContext = ctx } } }
        const manager = new PluginCompositionPlugin<Input, Context>({ replaceAgent: next => { runtime.agent = next } })
        let staged = false
        const model = generation(ctx => {
            if (staged) { return }
            staged = true
            manager.setNextPlugins([model, manager, a])
            first.push(model, manager, manager, a, a, b, probe, ...ctx.plugins.filter(p => p.id === 'plugin-composition-tail') as Plugin[])
            manager.setNextPlugins(first)
            first.push({ id: 'too-late' })
        })
        const runtime = { agent: createAgent({ plugins: [model, manager] }) }
        await runtime.agent.run({})
        expect((await runtime.agent.run({})).ok).toBe(true)
        expect(nextContext?.plugins.filter(p => p === manager)).toHaveLength(2)
        expect(nextContext?.plugins.filter(p => p === a)).toHaveLength(2)
        expect(nextContext?.plugins.filter(p => p === b)).toHaveLength(1)
        expect(nextContext?.plugins.filter(p => p.id === 'plugin-composition-tail')).toHaveLength(1)
        expect(nextContext?.plugins.some(p => p.id === 'too-late')).toBe(false)
    })

    it('允许删除本插件，下一轮不残留它的尾部对象', async () => {
        let nextContext: Context | undefined
        const probe: Plugin = { id: 'probe', hooks: { onInitialize: async ctx => { nextContext = ctx } } }
        const manager = new PluginCompositionPlugin<Input, Context>({ replaceAgent: next => { runtime.agent = next } })
        let staged = false
        const model = generation(() => { if (!staged) { staged = true; manager.setNextPlugins([model, probe]) } })
        const runtime = { agent: createAgent({ plugins: [manager, model] }) }
        await runtime.agent.run({})
        await runtime.agent.run({})
        expect(nextContext?.plugins.map(p => p.id)).toEqual(['model', 'probe'])
        expect(() => manager.setNextPlugins([])).toThrow('没有当前')
    })

    it('允许空组合，下一轮缺少 model 的失败保持 Core 原行为', async () => {
        const manager = new PluginCompositionPlugin<Input, Context>({ replaceAgent: next => { runtime.agent = next } })
        const runtime = { agent: createAgent({ plugins: [manager, generation(() => manager.setNextPlugins([]))] }) }
        expect((await runtime.agent.run({})).ok).toBe(true)
        expect((await runtime.agent.run({})).ok).toBe(false)
    })

    it('前面的任一收尾失败就不替换，下一轮没有遗留提案', async () => {
        const replaceAgent = vi.fn()
        const manager = new PluginCompositionPlugin<Input, Context>({ replaceAgent })
        let stage = true
        const broken: Plugin = { id: 'broken', hooks: { onRunEnd: async () => { if (stage) { stage = false; throw new Error('cleanup') } } } }
        const agent = createAgent({ plugins: [manager, generation(() => { if (stage) { manager.setNextPlugins([]) } }), broken] })
        expect((await agent.run({})).ok).toBe(false)
        expect(replaceAgent).not.toHaveBeenCalled()
        expect((await agent.run({})).ok).toBe(true)
        expect(replaceAgent).not.toHaveBeenCalled()
    })

    it('执行异常不替换，统一 onError 后仍完成最后收尾', async () => {
        const replaceAgent = vi.fn()
        const onError = vi.fn(async () => undefined)
        const manager = new PluginCompositionPlugin<Input, Context>({ replaceAgent })
        const failed: Plugin = { id: 'failed', hooks: { onError, onInitialize: async ctx => {
            ctx.tools.register(defineTool({ name: 'fail', description: '', inputSchema: z.object({}),
                policy: { sideEffect: 'none', approval: 'none' }, execute: async () => { throw new Error('tool') } }))
        } } }
        const agent = createAgent({ plugins: [manager, generation(() => manager.setNextPlugins([])), failed] })
        expect((await agent.run({ calls: [{ id: 'f', name: 'fail', input: {} }] })).ok).toBe(false)
        expect(onError).toHaveBeenCalledOnce()
        expect(replaceAgent).not.toHaveBeenCalled()
    })

    it('消费者提前关闭事件流时收尾但不替换', async () => {
        const replaceAgent = vi.fn()
        const manager = new PluginCompositionPlugin<Input, Context>({ replaceAgent })
        const tool: Plugin = { id: 'tool', hooks: { onInitialize: async ctx => {
            ctx.tools.register(defineTool({ name: 'echo', description: '', inputSchema: z.object({}),
                policy: { sideEffect: 'none', approval: 'none' }, execute: async () => toolSuccess('ok') }))
        } } }
        const agent = createAgent({ plugins: [manager, generation(() => manager.setNextPlugins([])), tool] })
        const stream = agent.stream({ calls: [{ id: 'e', name: 'echo', input: {} }] })
        while (true) {
            const next = await stream.next()
            if (!next.done && next.value.type === 'tool-result') { break }
        }
        await stream.return({ ok: true, errors: [] })
        expect(replaceAgent).not.toHaveBeenCalled()
    })

    it('后续注册破坏末尾顺序时明确失败，不静默重排其他 owner', async () => {
        const replaceAgent = vi.fn()
        const manager = new PluginCompositionPlugin<Input, Context>({ replaceAgent })
        const late: Plugin = { id: 'late', hooks: { onRegister: async plugins => { plugins.push({ id: 'after-tail', hooks: { onRunEnd: async () => undefined } }) } } }
        const register: Plugin = { id: 'register', hooks: { onRegister: async plugins => { plugins.push(late) } } }
        const outcome = await createAgent({ plugins: [manager, generation(), register] }).run({})
        expect(outcome.ok).toBe(false)
        expect(replaceAgent).not.toHaveBeenCalled()
    })

    it('尾部之后的被动对象没有 onRunEnd 时不限制其位置', async () => {
        const replaceAgent = vi.fn()
        const manager = new PluginCompositionPlugin<Input, Context>({ replaceAgent })
        const late: Plugin = { id: 'late', hooks: { onRegister: async plugins => { plugins.push({ id: 'passive' }) } } }
        const register: Plugin = { id: 'register', hooks: { onRegister: async plugins => { plugins.push(late) } } }
        const outcome = await createAgent({ plugins: [manager, generation(() => manager.setNextPlugins([])), register] }).run({})
        expect(outcome.ok).toBe(true)
        expect(replaceAgent).toHaveBeenCalledOnce()
    })

    it('运行中新增更晚的收尾处理器时不提前交接，并释放本轮提案', async () => {
        const replaceAgent = vi.fn()
        const manager = new PluginCompositionPlugin<Input, Context>({ replaceAgent })
        const passive: Plugin = { id: 'passive', hooks: {} }
        const late: Plugin = { id: 'late', hooks: { onRegister: async plugins => { plugins.push(passive) } } }
        const register: Plugin = { id: 'register', hooks: { onRegister: async plugins => { plugins.push(late) } } }
        const model = generation(() => {
            manager.setNextPlugins([])
            passive.hooks!.onRunEnd = async () => undefined
        })
        expect((await createAgent({ plugins: [manager, model, register] }).run({})).ok).toBe(false)
        expect(replaceAgent).not.toHaveBeenCalled()
        expect(() => manager.setNextPlugins([])).toThrow('没有当前')
    })

    it('不拒绝第二次调用，另一轮收尾不能清掉第一轮已暂存的提案', async () => {
        const started = deferred()
        const release = deferred()
        const replaceAgent = vi.fn()
        const manager = new PluginCompositionPlugin<Input, Context>({ replaceAgent })
        let firstCall = true
        const model = generation(async () => {
            if (firstCall) { firstCall = false; manager.setNextPlugins([]); started.resolve(); await release.promise }
        })
        const agent = createAgent({ plugins: [manager, model] })
        const first = agent.run({})
        await started.promise
        expect((await agent.run({})).ok).toBe(true)
        expect(replaceAgent).not.toHaveBeenCalled()
        release.resolve()
        expect((await first).ok).toBe(true)
        expect(replaceAgent).toHaveBeenCalledOnce()
    })

    it('并发接纳由独立插件决定，未进入本插件的调用不清掉已有提案', async () => {
        const started = deferred()
        const release = deferred()
        let active: AgentRunOutcome | undefined
        const admission: Plugin = { id: 'admission', hooks: {
            onRunStart: async (_ctx, _input, outcome) => {
                if (active) { return { action: 'stop', value: 'handled-by-admission' } }
                active = outcome
                return { action: 'continue' }
            },
            onRunEnd: async (_ctx, outcome) => { if (active === outcome) { active = undefined } }
        } }
        const replaceAgent = vi.fn()
        const manager = new PluginCompositionPlugin<Input, Context>({ replaceAgent })
        const model = generation(async () => { manager.setNextPlugins([]); started.resolve(); await release.promise })
        const agent = createAgent({ plugins: [admission, manager, model] })
        const first = agent.run({})
        await started.promise
        expect(await agent.run({})).toMatchObject({ ok: true, value: 'handled-by-admission' })
        expect(replaceAgent).not.toHaveBeenCalled()
        release.resolve()
        expect((await first).ok).toBe(true)
        expect(replaceAgent).toHaveBeenCalledOnce()
    })

    it('替换回调抛错形成收尾失败，不泄漏提案到后续运行', async () => {
        const replaceAgent = vi.fn(async () => { throw new Error('host') })
        const manager = new PluginCompositionPlugin<Input, Context>({ replaceAgent })
        let stage = true
        const agent = createAgent({ plugins: [manager, generation(() => { if (stage) { stage = false; manager.setNextPlugins([]) } })] })
        expect((await agent.run({})).ok).toBe(false)
        expect((await agent.run({})).ok).toBe(true)
        expect(replaceAgent).toHaveBeenCalledOnce()
    })

    it('复用真实 Chat 会话对象，新 Agent 保留历史但使用自己的 CTX', async () => {
        let requested = 0
        const messages: string[] = []
        const session = new ChatSessionPlugin({ id: 'session', ownerId: 'owner' })
        const conversation = new ChatConversationPlugin({ session, generation: new ChatModelPlugin({ session,
            ...chatModelOptions({ provider: 'test', modelId: 'test', async *stream(request) {
                requested++
                messages.push(JSON.stringify(request.messages))
                yield { type: 'text-delta', delta: requested === 1 ? 'first' : 'second' }
                yield { type: 'finish', reason: 'stop' }
            } })
        }) })
        let firstContext: AgentContext | undefined
        let secondContext: AgentContext | undefined
        const probe: AgentPlugin<ChatInput> = { id: 'probe', hooks: { onInitialize: async ctx => {
            if (!firstContext) { firstContext = ctx } else { secondContext = ctx }
        } } }
        const manager = new PluginCompositionPlugin<ChatInput>({ replaceAgent: next => { runtime.agent = next } })
        let staged = false
        const stage: AgentPlugin<ChatInput> = { id: 'stage', hooks: { beforeModel: async ctx => {
            if (!staged) { staged = true; manager.setNextPlugins([...ctx.plugins] as AgentPlugin<ChatInput>[]) }
            return { action: 'continue' }
        } } }
        const runtime = { agent: createAgent({ plugins: [manager, probe, stage, conversation] }) }
        await runtime.agent.run({ prompt: 'hello' })
        await runtime.agent.run({ prompt: 'continue' })
        expect(secondContext).not.toBe(firstContext)
        expect(messages[1]).toContain('hello')
        expect(messages[1]).toContain('first')
        expect(messages[1]).toContain('continue')
    })
})
