import { describe, expect, it, vi } from 'vitest'
import { createAgent, defineTool, toolSuccess } from '@quifox/agent-core'
import type {
    AgentContext, AgentEvent, AgentPlugin, AgentRunOutcome, ModelTurnResult, ToolCall, ToolResult, ToolRunResult
} from '@quifox/agent-core'
import { PluginCompositionPlugin } from '@quifox/agent-plugin-composition'
import { ChatConversationPlugin, ChatSessionPlugin } from '@quifox/agent-plugin-session'
import { ChatModelPlugin } from '@quifox/agent-plugin-model'
import { chatModelOptions } from '../../../test/support/chat-model.mjs'
import type { ChatInput } from '@quifox/agent-plugin-session'
import { z } from 'zod'
import { CodeModePlugin } from '../src/index.js'
import type { CodeModeEnvironment } from '../src/index.js'

interface Input { code: string }
interface Context extends AgentContext { code: string; turn: number; output?: string }
type Plugin = AgentPlugin<Input, Context>

type Script = (...values: unknown[]) => Promise<unknown>
const AsyncFunction = Object.getPrototypeOf(async () => {}).constructor as new (...parts: string[]) => Script

// 测试 Host 的同进程执行器，不属于生产插件包。
async function execute<Ctx extends AgentContext>(code: string, environment: CodeModeEnvironment<Ctx>): Promise<unknown> {
    return new AsyncFunction(...Object.keys(environment), code)(...Object.values(environment))
}

function model(): Plugin {
    return { id: 'test-model', hooks: {
        onRunStart: async (ctx, input) => {
            ctx.code = input.code; ctx.turn = 0; delete ctx.output
            return { action: 'continue' }
        },
        model: async function* (ctx): AsyncGenerator<never, ModelTurnResult, void> {
            const toolCalls = ctx.turn++ === 0 ? [{ id: 'outer', name: 'execute_code', input: { code: ctx.code } }] : []
            return { text: ctx.output ?? '', reasoning: '', toolCalls, usage: {}, finishReason: toolCalls.length ? 'tool-calls' : 'stop' }
        },
        afterTool: async (ctx, receipt) => {
            if (receipt.call.name === 'execute_code') { ctx.output = receipt.result.content }
            return { action: 'continue' }
        }
    } }
}

function numberTool(name: string, executeTool: (input: { n: number }, ctx: Context) => Promise<ToolResult>): Plugin {
    return { id: name, hooks: { onInitialize: async ctx => {
        ctx.tools.register(defineTool({ name, description: name, inputSchema: z.object({ n: z.number() }),
            policy: { sideEffect: 'none', approval: 'none' }, execute: executeTool }))
    } } }
}

function text(outcome: AgentRunOutcome): string {
    if (!outcome.ok) { throw outcome.error }
    return (outcome.value as ModelTurnResult).text
}

function host(plugins: Plugin[] = [], bindings?: (ctx: Context) => Record<string, unknown>) {
    const codeMode = new CodeModePlugin<Input, Context>({ execute, ...(bindings ? { bindings } : {}) })
    const runtime = { agent: createAgent({ plugins: [codeMode, model(), ...plugins] }) }
    return { runtime, codeMode }
}

describe('外部 Code Mode 插件', () => {
    it('JS 循环通过异步工具代理，复用有序 before/prepare/execute/after 和实际 CTX', async () => {
        const phases: string[] = []
        const ids: string[] = []
        const actualContexts: Context[] = []
        const tool = numberTool('add', async ({ n }, ctx) => {
            phases.push('execute'); actualContexts.push(ctx); return toolSuccess(String(n), n)
        })
        const hooks: Plugin = { id: 'hooks', hooks: {
            beforeTool: async (_ctx, call) => {
                if (call.name === 'add') { phases.push('before'); ids.push(call.id); (call.input as { n: number }).n++ }
                return { action: 'continue' }
            },
            afterTool: async (_ctx, receipt) => {
                if (receipt.call.name === 'add') { phases.push('after'); receipt.result.data = Number(receipt.result.data) * 2 }
                return { action: 'continue' }
            }
        } }
        const { runtime } = host([tool, hooks], ctx => ({ reference: ctx }))
        expect(text(await runtime.agent.run({ code: 'if (ctx !== reference) throw Error("ctx"); let sum = 0; for (const n of [1,2,3]) sum += (await tools.add({n})).data; return sum;' }))).toBe('18')
        expect(phases).toEqual(['before', 'execute', 'after', 'before', 'execute', 'after', 'before', 'execute', 'after'])
        expect(new Set(ids).size).toBe(3)
        expect(ids.every(id => id.startsWith('outer:code:'))).toBe(true)
        expect(actualContexts.every(ctx => ctx === actualContexts[0])).toBe(true)
    })

    it('初始化排在 Code Mode 后面的工具仍被扫描，注册名与原对象的可变 name 不混用', async () => {
        const tool = numberTool('original', async ({ n }) => toolSuccess('ok', n))
        const mutate: Plugin = { id: 'mutate', hooks: { beforeModel: async ctx => {
            ctx.tools.get('original')!.name = 'changed-source-name'
            return { action: 'continue' }
        } } }
        const { runtime } = host([tool, mutate])
        expect(text(await runtime.agent.run({ code: 'return (await tools.original({n:7})).data;' }))).toBe('7')
    })

    it('beforeTool 可直接返回回执，原工具不执行，afterTool 仍可处理', async () => {
        const executeTool = vi.fn(async () => toolSuccess('unexpected'))
        const deny: Plugin = { id: 'deny', hooks: {
            beforeTool: async (_ctx, call) => call.name === 'work' ? { action: 'result', result: toolSuccess('cached', 9) } : { action: 'continue' },
            afterTool: async (_ctx, run) => {
                if (run.call.name === 'work') { run.result.data = 10 }
                return { action: 'continue' }
            }
        } }
        const { runtime } = host([numberTool('work', executeTool), deny])
        expect(text(await runtime.agent.run({ code: 'return (await tools.work({n:1})).data;' }))).toBe('10')
        expect(executeTool).not.toHaveBeenCalled()
    })

    it('beforeTool stop 交回 Core，并阻止后续代理执行', async () => {
        const executeTool = vi.fn(async () => toolSuccess('unexpected'))
        const stop: Plugin = { id: 'stop', hooks: { beforeTool: async (_ctx, call) =>
            call.name === 'work' ? { action: 'stop', reason: 'stop', value: 'paused' } : { action: 'continue' } } }
        const { runtime } = host([numberTool('work', executeTool), stop])
        const outcome = await runtime.agent.run({ code: 'await tools.work({n:1}); await tools.work({n:2});' })
        expect(outcome.ok).toBe(true)
        if (!outcome.ok) { throw outcome.error }
        expect(outcome.value).toBe('paused')
        expect(executeTool).not.toHaveBeenCalled()
    })

    it('afterTool stop 保留已执行事实，后面的 afterTool 仍执行，但后续工具不执行', async () => {
        const executeTool = vi.fn(async ({ n }: { n: number }) => toolSuccess('done', n))
        const observed: number[] = []
        let outerReceipt: ToolResult | undefined
        const stop: Plugin = { id: 'stop', hooks: { afterTool: async (_ctx, run) =>
            run.call.name === 'work' ? { action: 'stop', value: 'done-one' } : { action: 'continue' } } }
        const observer: Plugin = { id: 'observer', hooks: { afterTool: async (_ctx, run) => {
            if (run.call.name === 'work') { observed.push(Number(run.result.data)) }
            if (run.call.name === 'execute_code') { outerReceipt = run.result }
            return { action: 'continue' }
        } } }
        const { runtime } = host([numberTool('work', executeTool), stop, observer])
        const outcome = await runtime.agent.run({ code: 'await tools.work({n:1}); await tools.work({n:2});' })
        if (!outcome.ok) { throw outcome.error }
        expect(outcome.value).toBe('done-one')
        expect(executeTool).toHaveBeenCalledOnce()
        expect(observed).toEqual([1])
        expect(outerReceipt?.status).toBe('error')
        expect(outerReceipt?.code).toBe('CODE_STOPPED')
    })

    it('工具自己的 prepare 可以接收任意原始输入，不增加 Core 参数校验', async () => {
        const plugin: Plugin = { id: 'custom', hooks: { onInitialize: async ctx => {
            ctx.tools.register(defineTool({ name: 'custom', description: '', inputSchema: z.object({ n: z.number() }),
                policy: { sideEffect: 'none', approval: 'none' }, prepare: async (_ctx, raw) => ({ n: String(raw).length }),
                execute: async ({ n }, actual: Context) => toolSuccess(actual === ctx ? 'same' : 'wrong', n) }))
        } } }
        const { runtime } = host([plugin])
        expect(text(await runtime.agent.run({ code: 'return (await tools.custom("hello")).data;' }))).toBe('5')
    })

    it('直接读取原 Tool 并调用 execute 保持自由，不自动经过代理钩子或 prepare', async () => {
        let prepared = 0
        let before = 0
        const plugin: Plugin = { id: 'direct', hooks: {
            onInitialize: async ctx => {
                ctx.tools.register(defineTool({ name: 'direct', description: '', inputSchema: z.object({ n: z.number() }),
                    policy: { sideEffect: 'none', approval: 'none' }, prepare: async () => { prepared++; throw new Error('prepare') },
                    execute: async ({ n }, _ctx: Context) => toolSuccess('direct', n) }))
            },
            beforeTool: async (_ctx, call) => { if (call.name === 'direct') { before++ }; return { action: 'continue' } }
        } }
        const { runtime } = host([plugin])
        expect(text(await runtime.agent.run({ code: 'return (await ctx.tools.get("direct").execute({n:4},ctx)).data;' }))).toBe('4')
        expect(prepared).toBe(0)
        expect(before).toBe(0)
    })

    it('代码内部捕获工具异常就继续，不捕获才进入统一 onError', async () => {
        const onError = vi.fn(async () => undefined)
        const { runtime } = host([
            numberTool('fail', async () => { throw new Error('tool-failed') }),
            { id: 'observer', hooks: { onError } }
        ])
        expect(text(await runtime.agent.run({ code: 'try { await tools.fail({n:1}); } catch { return "handled"; }' }))).toBe('handled')
        expect(onError).not.toHaveBeenCalled()
        expect((await runtime.agent.run({ code: 'await tools.fail({n:1});' })).ok).toBe(false)
        expect(onError).toHaveBeenCalledOnce()
    })

    it('beforeTool 可以改写目标工具，不使用最初代理捕获的 execute', async () => {
        const first = vi.fn(async () => toolSuccess('first'))
        const redirect: Plugin = { id: 'redirect', hooks: { beforeTool: async (_ctx, call) => {
            if (call.name === 'first') { call.name = 'second' }
            return { action: 'continue' }
        } } }
        const { runtime } = host([numberTool('first', first), numberTool('second', async () => toolSuccess('second')), redirect])
        expect(text(await runtime.agent.run({ code: 'return (await tools.first({n:1})).content;' }))).toBe('second')
        expect(first).not.toHaveBeenCalled()
    })

    it('所有 afterTool 收尾先完成，再传播其中的异常', async () => {
        const phases: string[] = []
        const a: Plugin = { id: 'a', hooks: { afterTool: async (_ctx, run) => {
            if (run.call.name === 'work') { phases.push('failed'); throw new Error('after') }
            return { action: 'continue' }
        } } }
        const b: Plugin = { id: 'b', hooks: { afterTool: async (_ctx, run) => {
            if (run.call.name === 'work') { phases.push('later') }
            return { action: 'continue' }
        } } }
        const { runtime } = host([numberTool('work', async () => toolSuccess('ok')), a, b])
        expect((await runtime.agent.run({ code: 'await tools.work({n:1});' })).ok).toBe(false)
        expect(phases).toEqual(['failed', 'later'])
    })

    it('Hook 事件与子工具回执通过 Code Mode 缓冲输出，调用 ID 区分内外', async () => {
        const observer: Plugin = { id: 'observer', hooks: { beforeTool: async function* (_ctx, call) {
            if (call.name === 'work') { yield { type: 'step-start' } }
            return { action: 'continue' }
        } } }
        const { runtime } = host([numberTool('work', async () => toolSuccess('ok')), observer])
        const stream = runtime.agent.stream({ code: 'return (await tools.work({n:1})).content;' })
        const events: AgentEvent[] = []
        let outcome: AgentRunOutcome | undefined
        while (true) {
            const next = await stream.next()
            if (next.done) { outcome = next.value; break }
            events.push(next.value)
        }
        expect(outcome?.ok).toBe(true)
        expect(events.filter(e => e.type === 'tool-start').map(e => (e.call as ToolCall).id)).toEqual(['outer', 'outer:code:1'])
        expect(events.filter(e => e.type === 'tool-result').map(e => (e.run as ToolRunResult).call.id)).toEqual(['outer:code:1', 'outer'])
        expect(events.some(e => e.type === 'step-start')).toBe(true)
    })

    it('Promise.all 的代理调用也保持串行执行', async () => {
        let active = 0
        let peak = 0
        const { runtime } = host([numberTool('work', async ({ n }) => {
            active++; peak = Math.max(peak, active)
            await Promise.resolve()
            active--
            return toolSuccess(String(n), n)
        })])
        expect(text(await runtime.agent.run({ code: 'return (await Promise.all([1,2,3].map(n => tools.work({n})))).map(r=>r.data);' }))).toBe('[1,2,3]')
        expect(peak).toBe(1)
    })

    it('await 返回前完成已排队调用，不把后台工具留给下一轮', async () => {
        const done: number[] = []
        const { runtime } = host([numberTool('work', async ({ n }) => { await Promise.resolve(); done.push(n); return toolSuccess('ok') })])
        expect(text(await runtime.agent.run({ code: 'tools.work({n:1}); tools.work({n:2}); return "queued";' }))).toBe('queued')
        expect(done).toEqual([1,2])
    })

    it('execute_code 不生成自己的递归代理，额外绑定不覆盖实际 ctx/tools', async () => {
        const { runtime } = host([], () => ({ ctx: null, tools: null, answer: 42 }))
        expect(text(await runtime.agent.run({ code: 'if (!ctx.tools || tools.execute_code) throw Error("scope"); return answer;' }))).toBe('42')
    })

    it('工具回执在 afterTool 前不做业务形状校验', async () => {
        const bad: Plugin = { id: 'raw', hooks: { onInitialize: async ctx => {
            ctx.tools.register(defineTool({ name: 'raw', description: '', inputSchema: z.object({}),
                policy: { sideEffect: 'none', approval: 'none' }, execute: async () => ({ custom: 8 }) as unknown as ToolResult }))
        }, afterTool: async (_ctx, run) => {
            if (run.call.name === 'raw') {
                const custom = (run.result as unknown as { custom: number }).custom
                run.result = toolSuccess('repaired-by-owner', custom)
            }
            return { action: 'continue' }
        } } }
        const { runtime } = host([bad])
        expect(text(await runtime.agent.run({ code: 'return (await tools.raw({})).data;' }))).toBe('8')
    })

    it('真实 Chat Session 只接收外层代码回执，子工具数据供代码汇总', async () => {
        const requests: string[] = []
        let turn = 0
        const session = new ChatSessionPlugin({ id: 'chat', ownerId: 'owner' })
        const conversation = new ChatConversationPlugin({ session, generation: new ChatModelPlugin({ session,
            ...chatModelOptions({ provider: 'test', modelId: 'test', async *stream(request) {
                requests.push(JSON.stringify(request.messages))
                if (turn++ === 0) {
                    yield { type: 'tool-call', call: { id: 'real-code', name: 'execute_code', input: { code: 'return (await tools.work({n:2})).data;' } } }
                    yield { type: 'finish', reason: 'tool-calls' }
                } else { yield { type: 'text-delta', delta: 'done' }; yield { type: 'finish', reason: 'stop' } }
            } })
        }) })
        const codeMode = new CodeModePlugin<ChatInput>({ execute })
        const tool: AgentPlugin<ChatInput> = { id: 'tool', hooks: { onInitialize: async ctx => {
            ctx.tools.register(defineTool({ name: 'work', description: '', inputSchema: z.object({ n: z.number() }),
                policy: { sideEffect: 'none', approval: 'none' }, execute: async ({ n }) => toolSuccess('value', n * 3) }))
        } } }
        const outcome = await createAgent({ plugins: [codeMode, tool, conversation] }).run({ prompt: 'code' })
        expect(outcome.ok).toBe(true)
        expect(requests).toHaveLength(2)
        const history = JSON.parse(requests[1]!) as { role: string; toolCallId?: string; content: string }[]
        expect(history.filter(m => m.role === 'tool').map(m => [m.toolCallId, m.content])).toEqual([['real-code', '6']])
    })

    it('目标改写不能绕过 execute_code 自递归限制', async () => {
        const redirect: Plugin = { id: 'redirect', hooks: { beforeTool: async (_ctx, call) => {
            if (call.name === 'work') { call.name = 'execute_code'; call.input = { code: 'return 1;' } }
            return { action: 'continue' }
        } } }
        const { runtime } = host([numberTool('work', async () => toolSuccess('unused')), redirect])
        const outcome = await runtime.agent.run({ code: 'await tools.work({n:1});' })
        expect(outcome.ok).toBe(false)
        if (!outcome.ok) { expect(String(outcome.error.cause)).toContain('递归执行') }
    })

    it('子调用避免碰撞原生模型 ID，不错误闭合 Session 的另一条待执行调用', async () => {
        let turn = 0
        let history: { role: string; toolCallId?: string; content: string }[] = []
        const seen: string[] = []
        const session = new ChatSessionPlugin({ id: 'collision', ownerId: 'owner' })
        const conversation = new ChatConversationPlugin({ session, generation: new ChatModelPlugin({ session,
            ...chatModelOptions({ provider: 'test', modelId: 'test', async *stream(request) {
                if (turn++ === 0) {
                    yield { type: 'tool-call', call: { id: 'real-code', name: 'execute_code', input: { code: 'return (await tools.work({n:2})).data;' } } }
                    yield { type: 'tool-call', call: { id: 'real-code:code:1', name: 'work', input: { n: 3 } } }
                    yield { type: 'finish', reason: 'tool-calls' }
                } else {
                    history = JSON.parse(JSON.stringify(request.messages)) as typeof history
                    yield { type: 'text-delta', delta: 'done' }; yield { type: 'finish', reason: 'stop' }
                }
            } })
        }) })
        const codeMode = new CodeModePlugin<ChatInput>({ execute })
        const tool: AgentPlugin<ChatInput> = { id: 'tool', hooks: {
            onInitialize: async ctx => {
                ctx.tools.register(defineTool({ name: 'work', description: '', inputSchema: z.object({ n: z.number() }),
                    policy: { sideEffect: 'none', approval: 'none' }, execute: async ({ n }) => toolSuccess(String(n * 3), n * 3) }))
            },
            beforeTool: async (_ctx, call) => { if (call.name === 'work') { seen.push(call.id) }; return { action: 'continue' } }
        } }
        expect((await createAgent({ plugins: [codeMode, tool, conversation] }).run({ prompt: 'collision' })).ok).toBe(true)
        expect(seen).toEqual(['real-code:code:2', 'real-code:code:1'])
        expect(history.filter(m => m.role === 'tool').map(m => [m.toolCallId, m.content])).toEqual([['real-code', '6'], ['real-code:code:1', '9']])
    })

    it('代码执行结束后不允许捕获的代理访问旧运行', async () => {
        let captured: ((input: unknown) => Promise<ToolResult>) | undefined
        const mode = new CodeModePlugin<Input, Context>({ execute: async (_code, environment) => {
            captured = environment.tools.work
            return 'done'
        } })
        const call = vi.fn(async () => toolSuccess('unexpected'))
        const agent = createAgent({ plugins: [mode, model(), numberTool('work', call)] })
        expect(text(await agent.run({ code: '' }))).toBe('done')
        await expect(captured!({ n: 1 })).rejects.toThrow('当前代码执行')
        expect(call).not.toHaveBeenCalled()
    })

    it('不拒绝第二次调用，另一轮不输出或清掉第一轮的缓冲事件', async () => {
        let release!: () => void
        let started!: () => void
        const gate = new Promise<void>(accept => { release = accept })
        const ready = new Promise<void>(accept => { started = accept })
        const { runtime } = host([numberTool('work', async () => {
            started(); await gate; return toolSuccess('done')
        })])
        const first = runtime.agent.stream({ code: 'return (await tools.work({n:1})).content;' })
        await first.next()
        await first.next()
        const pending = first.next()
        await ready
        const secondEvents: AgentEvent[] = []
        const second = runtime.agent.stream({ code: 'return 0;' })
        let secondOutcome: AgentRunOutcome | undefined
        while (true) {
            const next = await second.next()
            if (next.done) { secondOutcome = next.value; break }
            secondEvents.push(next.value)
        }
        expect(secondOutcome?.ok).toBe(true)
        expect(secondEvents).not.toContainEqual(expect.objectContaining({ type: 'tool-start', call: expect.objectContaining({ name: 'work' }) }))
        expect(secondEvents).not.toContainEqual(expect.objectContaining({ type: 'tool-result', run: expect.objectContaining({ call: expect.objectContaining({ name: 'work' }) }) }))
        release()
        const resumed = await pending
        expect(resumed.done).toBe(false)
        expect(resumed.value).toMatchObject({ type: 'tool-start', call: { id: 'outer:code:1' } })
        let outcome: AgentRunOutcome | undefined
        while (true) {
            const next = await first.next()
            if (next.done) { outcome = next.value; break }
        }
        expect(outcome?.ok).toBe(true)
    })

    it('两个 Agent 共享 Code Mode 对象时，代码队列与收尾互不覆盖', async () => {
        let release!: () => void
        let started!: () => void
        const gate = new Promise<void>(accept => { release = accept })
        const ready = new Promise<void>(accept => { started = accept })
        const codeMode = new CodeModePlugin<Input, Context>({ execute })
        const work = numberTool('work', async ({ n }) => {
            if (n === 1) { started(); await gate }
            return toolSuccess(String(n), n)
        })
        const a = createAgent({ plugins: [codeMode, model(), work] })
        const b = createAgent({ plugins: [codeMode, model(), work] })
        const first = a.run({ code: 'return (await tools.work({n:1})).data;' })
        await ready
        expect(text(await b.run({ code: 'return (await tools.work({n:2})).data;' }))).toBe('2')
        release()
        expect(text(await first)).toBe('1')
    })

    it('组合热更新：JS 创建真实插件，最后收尾自动交接，再用 JS 删除它', async () => {
        const phases: string[] = []
        const composition = new PluginCompositionPlugin<Input, Context>({ replaceAgent: next => {
            phases.push('replace'); runtime.agent = next
        } })
        const codeMode = new CodeModePlugin<Input, Context>({ execute, bindings: () => ({
            setNextPlugins: (plugins: Plugin[]) => composition.setNextPlugins(plugins),
            defineTool, z, phases
        }) })
        const cleanup: Plugin = { id: 'cleanup', hooks: { onRunEnd: async () => { phases.push('cleanup') } } }
        const runtime = { agent: createAgent({ plugins: [codeMode, model(), cleanup, composition] }) }
        const original = runtime.agent
        const add = `
const plugin = { id: 'generated', hooks: { onInitialize: async nextCtx => {
    phases.push('new-initialize');
    nextCtx.tools.register(defineTool({
        name: 'generated', description: '', inputSchema: z.object({n:z.number()}),
        policy: {sideEffect:'none',approval:'none'},
        execute: async ({n}) => ({status:'success',content:'generated',data:n*10})
    }));
}}};
setNextPlugins([...ctx.plugins, plugin]);
return !!ctx.tools.get('generated');
`
        expect(text(await runtime.agent.run({ code: add }))).toBe('false')
        expect(runtime.agent).not.toBe(original)
        expect(phases).toEqual(['cleanup', 'replace'])
        expect(text(await runtime.agent.run({ code: 'return (await tools.generated({n:3})).data;' }))).toBe('30')
        expect(phases).toContain('new-initialize')
        expect(text(await runtime.agent.run({ code: 'setNextPlugins(ctx.plugins.filter(p=>p.id!=="generated")); return "removed";' }))).toBe('removed')
        expect(text(await runtime.agent.run({ code: 'return !!tools.generated;' }))).toBe('false')
    })
})
