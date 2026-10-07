import type { AgentRunOutcome, ModelTurnResult } from '@quifox/agent-core'
import { expect, it, vi } from 'vitest'
import { z } from 'zod'
import { createAgent, defineTool, toolSuccess, toolDenied, type AgentPlugin, type ToolCall, type ToolRunResult } from '@quifox/agent-core'
import { type ModelRequest } from '@quifox/agent-core'
import { createToolEntryPlugin, deriveToolPlugin, ToolPlugin } from '../src/index.js'

function fixture(calls: { name: string; input: unknown }[], name = 'plugin') {
    const requests: ModelRequest[] = []
    const results: ToolRunResult[] = []
    let request: ModelRequest
    let index = 0
    const generation: AgentPlugin = { id: 'generation', hooks: {
        beforeModel: async ctx => { request = { messages: [], tools: ctx.tools.definitions() }; return { action: 'continue' } },
        async *model() {
            requests.push(JSON.parse(JSON.stringify(request)) as ModelRequest)
            const call = calls[index++]
            return ({ text: '', reasoning: '', usage: {}, toolCalls: call ? [{ id: String(index), ...call }] : [], finishReason: call ? 'tool-calls' : 'stop' })
        }
    } }
    const parent = createToolEntryPlugin(name, () => request)
    const record: AgentPlugin = { id: 'record', hooks: { afterTool: async (_ctx, run) => { results.push(run); return { action: 'continue' } } } }
    return { parent, requests, results, agent: (plugins: AgentPlugin[]) => createAgent({ plugins: [generation, ...plugins, record] }) }
}

function business(id: string, execute = vi.fn(async (_input: { value: number }) => toolSuccess('saved'))) {
    const schema = z.object({ value: z.number() })
    return new ToolPlugin({ id, name: id, description: id + '能力', toolSets: [{ id, tools: [defineTool({
        name: id + '_create', description: '创建', inputSchema: schema, policy: { sideEffect: 'external', approval: 'host' },
        prepare: async (_ctx, raw) => schema.parse({ value: Number((raw as { value: unknown }).value) }),
        execute
    })] }] })
}

it('入口改名，按查询参数逐项补充；隐藏定义，真实执行仍经过工具 prepare', async () => {
    const f = fixture([{ name: 'search', input: {} }, { name: 'search', input: { pluginId: 'todo' } },
        { name: 'search', input: { pluginId: 'todo', tool: 'todo_create', args: { value: '7' } } }], 'search')
    const execute = vi.fn(async (_input: { value: number }) => toolSuccess('saved'))
    const seen: ToolCall[] = []
    const todo = business('todo', execute)
    const hooks: AgentPlugin = { id: 'check', hooks: { beforeTool: async (ctx, call) => {
        if (call.name === 'todo_create') {
            seen.push(call)
            expect(call.input).toEqual({ value: '7' })
            expect(ctx.tools.policy(call.name)).toEqual({ sideEffect: 'external', approval: 'host' })
        }
        return { action: 'continue' }
    } } }
    await f.agent([f.parent, deriveToolPlugin(f.parent, todo), deriveToolPlugin(f.parent, business('note')), hooks]).run(null).then(expectModelResult)
    expect(execute).toHaveBeenCalledTimes(1)
    expect(execute.mock.calls[0]?.[0]).toEqual({ value: 7 })
    expect(seen).toHaveLength(1)
    expect(f.requests.every(request => request.tools.map(tool => tool.name).join() === 'search')).toBe(true)
    expect(JSON.parse(f.results[0]!.result.content).plugins.map((item: { pluginId: string }) => item.pluginId)).toEqual(['todo', 'note'])
    expect(JSON.parse(f.results[1]!.result.content).tools[0].name).toBe('todo_create')
})

it('归属错误、隐藏工具直调、非法信封全部不执行业务', async () => {
    const f = fixture([{ name: 'todo_create', input: { value: 1 } }, { name: 'plugin', input: { pluginId: 'other', tool: 'todo_create', args: {} } },
        { name: 'plugin', input: { pluginId: 'todo', tool: 'other', args: {} } }, { name: 'plugin', input: { tool: 'todo_create' } }])
    const execute = vi.fn(async () => toolSuccess('saved'))
    await f.agent([f.parent, deriveToolPlugin(f.parent, business('todo', execute))]).run(null).then(expectModelResult)
    expect(execute).not.toHaveBeenCalled()
    expect(f.results).toHaveLength(4)
    expect(f.results.every(run => run.result.status === 'error')).toBe(true)
})

it('准入看到最终目标但没有准备值，可短路整个工具入口', async () => {
    const f = fixture([{ name: 'plugin', input: { pluginId: 'todo', tool: 'todo_create', args: { value: 1 } } }])
    const execute = vi.fn(async () => toolSuccess('saved'))
    await f.agent([f.parent, deriveToolPlugin(f.parent, business('todo', execute)), { id: 'approval', hooks: {
        beforeTool: async (ctx, call) => ctx.tools.policy(call.name)?.approval === 'host' ? { action: 'result', result: toolDenied('未授权') } : { action: 'continue' }
    } }]).run(null).then(expectModelResult)
    expect(execute).not.toHaveBeenCalled()
    expect(f.results[0]!.result.content).toBe('未授权')
})

it('后置删除主入口后，衍生插件不能接管同名同 Schema 的其他工具', async () => {
    const f = fixture([{ name: 'plugin', input: {} }, { name: 'plugin', input: { pluginId: 'todo', tool: 'todo_create', args: { value: 1 } } }])
    const execute = vi.fn(async () => toolSuccess('saved'))
    const foreign = vi.fn(async () => toolSuccess('foreign'))
    const tool = { ...f.parent.toolSets[0]!.tools[0]!, execute: foreign }
    const guard: AgentPlugin = { id: 'guard', hooks: { onRegister: async plugins => { plugins.splice(plugins.indexOf(f.parent), 1) } } }
    await f.agent([f.parent, deriveToolPlugin(f.parent, business('todo', execute)), guard, new ToolPlugin({ id: 'foreign', toolSets: [{ id: 'foreign', tools: [tool] }] })]).run(null).then(expectModelResult)
    expect(execute).not.toHaveBeenCalled(); expect(foreign).toHaveBeenCalledTimes(2)
    expect(f.results.map(run => run.result.content)).toEqual(['foreign', 'foreign'])
})

it('缺少主项时自行删除；默认工具注册可 override 并 super 后删除部分工具', async () => {
    const f = fixture([])
    const derived = deriveToolPlugin(f.parent, business('todo'))
    await f.agent([derived]).run(null).then(expectModelResult)
    expect(f.requests[0]!.tools).toEqual([])
    class PartialTools extends ToolPlugin {
        override async onInitialize(ctx: Parameters<ToolPlugin['onInitialize']>[0]) { await super.onInitialize(ctx); ctx.tools.remove('todo_create') }
    }
    const source = business('todo')
    const custom = new PartialTools({ id: source.id, toolSets: source.toolSets })
    const second = fixture([])
    await second.agent([custom]).run(null).then(expectModelResult)
    expect(second.requests[0]!.tools).toEqual([])
})

it('从属插件自己拒绝覆盖不同的关系声明，Core 不排序', () => {
    const f = fixture([])
    expect(() => deriveToolPlugin(f.parent, { ...business('todo'), after: 'other' })).toThrow('after')
})

/** 仅供测试消费标准 Outcome；不包装模型结果。 */
function expectModelResult(outcome: AgentRunOutcome): ModelTurnResult {
    if (!outcome.ok) { throw outcome.error }
    return outcome.value as ModelTurnResult
}
