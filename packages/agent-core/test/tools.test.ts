import { expect, it, vi } from 'vitest'
import { z } from 'zod'
import { createAgent, defineTool, toolSuccess, toolError, ToolRegistry, type AgentContext, type AgentPlugin, type AgentHooks, type ToolResult, type ToolRunResult } from '../src/index.js'
import { collectEvents, scripted, turn } from './fixtures.js'

const schema = z.object({ value: z.number() })
const policy = { sideEffect: 'none', approval: 'none' } as const

it('get/values 返回原工具引用，读取快照不改变注册表，初始化后仍可读取', async () => {
    const tool = defineTool({ name: 'save', description: '', inputSchema: schema, policy, execute: async () => toolSuccess('saved') })
    let registry!: ToolRegistry
    const outcome = await createAgent({ plugins: [scripted(), { id: 'tools', hooks: {
        onInitialize: async ctx => { registry = ctx.tools; registry.register(tool) }
    } }] }).run(null)
    expect(outcome.ok).toBe(true)
    expect(registry.get('save')).toBe(tool)
    expect(registry.get('missing')).toBeUndefined()
    const snapshot = registry.values()
    expect(snapshot).toEqual([tool])
    expect(snapshot[0]).toBe(tool)
    snapshot.pop()
    expect(registry.values()).toEqual([tool])
    const removed = new ToolRegistry().register(tool)
    const beforeRemoval = removed.values()
    removed.remove('save')
    expect(removed.get('save')).toBeUndefined()
    expect(removed.values()).toEqual([])
    expect(beforeRemoval[0]).toBe(tool)
    expect(() => registry.remove('save')).toThrow('固定')
})

it('读取原对象后可 prepare/execute，保留自定义 Prepared 和方法 this，不自动调度工具钩子', async () => {
    const beforeTool = vi.fn(async () => ({ action: 'continue' as const }))
    const afterTool = vi.fn(async () => ({ action: 'continue' as const }))
    const tool = {
        name: 'save', description: '', inputSchema: schema, policy, offset: 10,
        async prepare(_ctx: AgentContext, raw: unknown) { return { secret: schema.parse(raw).value + this.offset } },
        async execute(prepared: { secret: number }, _ctx: AgentContext) { return toolSuccess(String(prepared.secret + this.offset)) }
    }
    const events = await collectEvents(createAgent({ plugins: [{ id: 'direct', hooks: {
        onInitialize: async ctx => { ctx.tools.register(tool) },
        async *model(ctx) {
            const read = ctx.tools.get('save')
            if (!read) { throw new Error('没有注册 save。') }
            const prepared = await read.prepare(ctx, { value: 2 })
            const result = await read.execute(prepared, ctx)
            expect(result.content).toBe('22')
            return turn([], result.content)
        },
        beforeTool, afterTool
    } }] }).stream(null))
    expect(beforeTool).not.toHaveBeenCalled()
    expect(afterTool).not.toHaveBeenCalled()
    expect(events.some(event => event.type === 'tool-start' || event.type === 'tool-result')).toBe(false)
    expect(events.find(event => event.type === 'run-end')).toMatchObject({ outcome: { ok: true, value: { text: '22' } } })
})

it('读取真实对象不改变已注册的执行绑定和策略副本', async () => {
    const original = vi.fn(async () => toolSuccess('registered'))
    const replacement = vi.fn(async () => toolSuccess('replacement'))
    const tool = defineTool({ name: 'save', description: '', inputSchema: schema,
        policy: { ...policy, retrySafe: true }, execute: original })
    const outcome = await agentFor({
        onInitialize: async ctx => {
            ctx.tools.register(tool)
            const read = ctx.tools.get('save')
            if (!read) { throw new Error('没有注册 save。') }
            read.execute = replacement
            read.policy.retrySafe = false
            expect(ctx.tools.policy('save')?.retrySafe).toBe(true)
            const direct = await read.execute(await read.prepare(ctx, { value: 2 }), ctx)
            expect(direct.content).toBe('replacement')
        },
        afterTool: async (_ctx, run) => { expect(run.result.content).toBe('registered'); return { action: 'continue' } }
    }).run(null)
    expect(outcome.ok).toBe(true)
    expect(original).toHaveBeenCalledTimes(1)
    expect(replacement).toHaveBeenCalledTimes(1)
})

it('读取接口允许使用者直接 execute，不解析参数也不强制 prepare', async () => {
    const prepare = vi.fn(async () => { throw new Error('本例不使用 prepare。') })
    const execute = vi.fn(async (input: { secret: number }) => toolSuccess(String(input.secret)))
    const tool = defineTool({ name: 'direct', description: '', inputSchema: schema, policy, prepare, execute })
    const registry = new ToolRegistry().register(tool)
    const ctx: AgentContext = { tools: registry, plugins: [] }
    const read = registry.get('direct')
    if (!read) { throw new Error('没有注册 direct。') }
    const result = await read.execute({ secret: 7 }, ctx)
    expect(result.content).toBe('7')
    expect(prepare).not.toHaveBeenCalled()
    expect(execute).toHaveBeenCalledWith({ secret: 7 }, ctx)
})

/** @param hooks - 本例具体工具和钩子。 */
function agentFor(hooks: AgentHooks = {}) {
    return createAgent({ plugins: [scripted([turn([{ id: 'a', name: 'save', input: { value: 2 } }]), turn()]), { id: 'tools', hooks }] })
}

it('有序 beforeTool、工具 prepare/execute、afterTool 共享同一个 ctx', async () => {
    const trace: string[] = []
    const contexts: AgentContext[] = []
    const tool = defineTool({
        name: 'save', description: '', inputSchema: schema, policy,
        prepare: async (ctx, raw) => { trace.push('prepare'); contexts.push(ctx); return schema.parse(raw) },
        execute: async (input, ctx) => { trace.push('execute'); contexts.push(ctx); return toolSuccess(String(input.value)) }
    })
    const result = await agentFor({
        onInitialize: async ctx => { ctx.tools.register(tool) },
        beforeTool: [
            async (ctx, call) => { trace.push('beforeTool:route'); contexts.push(ctx); call.input = { value: 3 }; return { action: 'continue' } },
            async (ctx, call) => { trace.push('beforeTool:admit'); contexts.push(ctx); expect(call.input).toEqual({ value: 3 }); return { action: 'continue' } }
        ],
        afterTool: async (ctx, run) => { trace.push('afterTool'); contexts.push(ctx); expect(run.result.content).toBe('3'); return { action: 'continue' } }
    }).run(null)
    expect(trace).toEqual(['beforeTool:route', 'beforeTool:admit', 'prepare', 'execute', 'afterTool'])
    expect(new Set(contexts).size).toBe(1)
    expect(result.ok).toBe(true)
})

it('beforeTool result 跳过 prepare 和 execute，仍执行 afterTool', async () => {
    const prepare = vi.fn(async () => ({ value: 1 }))
    const execute = vi.fn(async () => toolSuccess('real'))
    const after = vi.fn(async (_ctx, run) => { run.result.content += '-modified'; return { action: 'continue' as const } })
    const events = await collectEvents(agentFor({
        onInitialize: async ctx => { ctx.tools.register(defineTool({ name: 'save', description: '', inputSchema: schema, policy, prepare, execute })) },
        beforeTool: async () => ({ action: 'result', result: toolSuccess('shortcut') }),
        afterTool: after
    }).stream(null))
    expect(prepare).not.toHaveBeenCalled(); expect(execute).not.toHaveBeenCalled()
    expect(after).toHaveBeenCalledTimes(1)
    expect(events.find(event => event.type === 'tool-result')).toMatchObject({ run: { result: { content: 'shortcut-modified' } } })
    expect(JSON.stringify(events)).not.toMatch(/attempts|runId|retrySafe/)
})

it.each(['beforeTool', 'afterTool'] as const)('%s stop 退出整个循环而非只退出工具 for', async name => {
    const execute = vi.fn(async () => toolSuccess('real'))
    const agent = agentFor({
        onInitialize: async ctx => { ctx.tools.register(defineTool({ name: 'save', description: '', inputSchema: schema, policy, execute })) },
        [name]: async () => ({ action: 'stop' })
    })
    expect((await agent.run(null)).ok).toBe(true)
    expect(execute).toHaveBeenCalledTimes(name === 'afterTool' ? 1 : 0)
})

it('工具自定义准备值无需是 Schema 输出，Loop 不持有中间值', async () => {
    const execute = vi.fn(async (prepared: { secret: number }) => toolSuccess(String(prepared.secret)))
    await agentFor({
        onInitialize: async ctx => {
            ctx.tools.register(defineTool({
                name: 'save', description: '', inputSchema: schema, policy,
                prepare: async (_ctx, raw) => ({ secret: schema.parse(raw).value + 10 }), execute
            }))
        }
    }).run(null)
    expect(execute.mock.calls[0]?.[0]).toEqual({ secret: 12 })
})

it('prepare 抛错形成失败 Outcome；缺失工具保持原有错误回执', async () => {
    const execute = vi.fn(async () => toolSuccess('real'))
    const after = vi.fn(async () => ({ action: 'continue' as const }))
    const invalid = await agentFor({
        onInitialize: async ctx => { ctx.tools.register(defineTool({ name: 'save', description: '', inputSchema: z.object({ value: z.string() }), policy, execute })) },
        afterTool: after
    }).run(null)
    expect(invalid).toMatchObject({ ok: false, error: { code: 'TOOL_FAILED', cause: expect.any(z.ZodError) } })
    expect(await agentFor().run(null)).toMatchObject({ ok: true })
    expect(execute).not.toHaveBeenCalled()
    expect(after).not.toHaveBeenCalled()
})

it('重命名后使用最终目标的准备、策略和业务；不继承原目标能力', async () => {
    const execute = vi.fn(async () => toolSuccess('target'))
    await agentFor({
        onInitialize: async ctx => { ctx.tools.register(defineTool({ name: 'other', description: '', inputSchema: schema, policy: { sideEffect: 'external', approval: 'host' }, execute })) },
        beforeTool: [
            async (_ctx, call) => { call.name = 'other'; return { action: 'continue' } },
            async (ctx, call) => { expect(ctx.tools.policy(call.name)?.approval).toBe('host'); return { action: 'continue' } }
        ]
    }).run(null)
    expect(execute).toHaveBeenCalledTimes(1)
})

it('准备之外的未知业务异常不伪装成未执行；不重试也不重复 afterTool', async () => {
    const execute = vi.fn(async () => { throw new Error('unknown receipt') })
    const after = vi.fn(async () => ({ action: 'continue' as const }))
    expect((await agentFor({
        onInitialize: async ctx => { ctx.tools.register(defineTool({ name: 'save', description: '', inputSchema: schema, policy: { ...policy, retrySafe: true }, execute })) },
        afterTool: after
    }).run(null)).ok).toBe(false)
    expect(execute).toHaveBeenCalledTimes(1); expect(after).not.toHaveBeenCalled()
})

it.each([undefined, false, true])('retrySafe=%s 可选元数据可查询且不进入模型工具定义', retrySafe => {
    const runtimePolicy = { ...policy, ...(retrySafe === undefined ? {} : { retrySafe }) }
    const registry = new ToolRegistry().register(defineTool({ name: 'save', description: '', inputSchema: schema, policy: runtimePolicy, execute: async () => toolSuccess('ok') }))
    expect(registry.policy('save')).toEqual(runtimePolicy)
    expect(registry.definitions()[0]).not.toHaveProperty('policy')
    expect(JSON.stringify(registry.definitions())).not.toContain('retrySafe')
})

it('可预期业务失败不自动重试，afterTool 可原地改写且后项看到相同对象', async () => {
    const execute = vi.fn(async () => toolError('expected'))
    const first = vi.fn(async (_ctx, run) => { run.result.content = 'adjusted'; return { action: 'continue' as const } })
    await agentFor({
        onInitialize: async ctx => { ctx.tools.register(defineTool({ name: 'save', description: '', inputSchema: schema, policy, execute })) },
        afterTool: [first, async (_ctx, run) => { expect(run).toBe(first.mock.calls[0]![1]); expect(run.result.content).toBe('adjusted'); return { action: 'continue' } }]
    }).run(null)
    expect(execute).toHaveBeenCalledTimes(1)
})

it('afterTool 全部处理器完成后再应用 stop', async () => {
    const later = vi.fn(async () => ({ action: 'continue' as const }))
    const result = await agentFor({
        onInitialize: async ctx => { ctx.tools.register(defineTool({ name: 'save', description: '', inputSchema: schema, policy, execute: async () => toolSuccess('saved') })) },
        afterTool: [async () => ({ action: 'stop', value: { done: true } }), later]
    }).run(null)
    expect(later).toHaveBeenCalledTimes(1)
    expect(result).toMatchObject({ ok: true, value: { done: true } })
})

it('初始化可删除工具；运行后禁止注册变更，模型定义不泄漏 policy', async () => {
    const tool = defineTool({ name: 'save', description: '', inputSchema: schema, policy, execute: async () => toolSuccess('ok') })
    let registry!: ToolRegistry
    const plugin: AgentPlugin = { id: 'tools', hooks: {
        onInitialize: async ctx => { registry = ctx.tools; registry.register(tool); expect(registry.isRegistered(tool)).toBe(true); expect(registry.isRegistered({ ...tool })).toBe(false); registry.remove('save') },
        beforeModel: async ctx => { expect(ctx.tools.definitions()).toEqual([]); return { action: 'continue' } }
    } }
    await createAgent({ plugins: [scripted(), plugin] }).run(null)
    expect(() => registry.register(tool)).toThrow('固定')
    const available = new ToolRegistry().register(tool)
    expect(available.definitions()[0]).not.toHaveProperty('policy')
    expect('resolve' in available || 'execute' in available).toBe(false)
})

it('多个调用严格串行，所有返回值都经过 afterTool', async () => {
    const trace: string[] = []
    const calls = ['a', 'b'].map(id => ({ id, name: 'save', input: { value: id } }))
    await createAgent({ plugins: [scripted([turn(calls), turn()]), { id: 'tools', hooks: {
        onInitialize: async ctx => { ctx.tools.register(defineTool({ name: 'save', description: '', inputSchema: z.object({ value: z.string() }), policy, execute: async input => { trace.push(input.value); await Promise.resolve(); return toolSuccess(input.value) } })) },
        afterTool: async (_ctx, run) => { trace.push('after-' + run.call.id); return { action: 'continue' } }
    } }] }).run(null)
    expect(trace).toEqual(['a', 'after-a', 'b', 'after-b'])
})

it('prepare 内部接纳校验失败后仍交给 execute，由工具返回反馈而非 Core 抛错', async () => {
    const business = vi.fn()
    const onError = vi.fn(async () => {})
    const after = vi.fn(async (_ctx: AgentContext, run: ToolRunResult) => {
        expect(run.result).toMatchObject({ status: 'error', content: '请给出文本值。' })
        return { action: 'continue' as const }
    })
    const inputSchema = z.object({ value: z.string() })
    const outcome = await agentFor({
        onInitialize: async ctx => { ctx.tools.register(defineTool({
            name: 'save', description: '', inputSchema, policy,
            prepare: async (_ctx, raw) => inputSchema.safeParse(raw),
            execute: async prepared => {
                if (!prepared.success) { return toolError('请给出文本值。') }
                business(prepared.data)
                return toolSuccess('saved')
            }
        })) },
        afterTool: after,
        onError
    }).run(null)
    expect(outcome.ok).toBe(true)
    expect(after).toHaveBeenCalledTimes(1)
    expect(business).not.toHaveBeenCalled()
    expect(onError).not.toHaveBeenCalled()
})

it('Core 不在 afterTool 前校验工具结果，协作 Hook 可以先适配自定义产物', async () => {
    const custom = { payload: 'adapted' }
    const after: AgentHooks['afterTool'] = [
        async (_ctx, run) => {
            expect(run.result).toBe(custom)
            run.result = toolSuccess(custom.payload)
            return { action: 'continue' }
        },
        async (_ctx, run) => {
            expect(run.result).toEqual(toolSuccess('adapted'))
            return { action: 'continue' }
        }
    ]
    const outcome = await agentFor({
        onInitialize: async ctx => { ctx.tools.register(defineTool({
            name: 'save', description: '', inputSchema: schema, policy,
            execute: async () => custom as unknown as ToolResult
        })) },
        afterTool: after
    }).run(null)
    expect(outcome.ok).toBe(true)
})

it('afterTool 抛错仍让后项保存真实回执，之后失败且不执行下一工具', async () => {
    const error = Error('post-processing')
    const execute = vi.fn(async () => toolSuccess('saved'))
    const saved: string[] = []
    const onError = vi.fn(async () => {})
    const onRunEnd = vi.fn(async () => {})
    const outcome = await createAgent({ plugins: [
        scripted([turn([{ id: 'a', name: 'save', input: {} }, { id: 'b', name: 'save', input: {} }])]),
        { id: 'results', hooks: {
            onInitialize: async ctx => { ctx.tools.register(defineTool({ name: 'save', description: '', inputSchema: z.object({}), policy, execute })) },
            afterTool: [
                async () => { throw error },
                async (_ctx, run) => { saved.push(run.result.content); return { action: 'continue' } }
            ],
            onError,
            onRunEnd
        } }
    ] }).run(null)
    expect(outcome).toMatchObject({ ok: false, error: { code: 'HOOK_FAILED', cause: error } })
    expect(saved).toEqual(['saved'])
    expect(execute).toHaveBeenCalledTimes(1)
    expect(onError).toHaveBeenCalledTimes(1)
    expect(onRunEnd).toHaveBeenCalledTimes(1)
})
