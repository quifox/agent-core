import { expect, it, vi } from 'vitest'
import { createAgent, type AgentPlugin, type AgentContext } from '../src/index.js'
import { scripted, turn } from './fixtures.js'

it('完整候选可删除未注册的后项；被删项不注册、不初始化', async () => {
    const removed = vi.fn(async () => {})
    const b: AgentPlugin = { id: 'b', hooks: { onRegister: removed, onInitialize: removed } }
    const a: AgentPlugin = { id: 'a', hooks: { onRegister: async plugins => { expect(plugins).toContain(b); plugins.splice(plugins.indexOf(b), 1) } } }
    await createAgent({ plugins: [a, b, scripted()] }).run(null)
    expect(removed).not.toHaveBeenCalled()
})

it('注册动态插入前项并插缝，同对象注册初始化一次而运行按位置执行', async () => {
    const calls: string[] = []
    const registration = vi.fn(async () => {})
    const initialization = vi.fn(async () => {})
    const t: AgentPlugin = { id: 'trace', hooks: { onRegister: registration, onInitialize: initialization, beforeModel: async () => { calls.push('T'); return { action: 'continue' } } } }
    const a: AgentPlugin = { id: 'a', hooks: { beforeModel: async () => { calls.push('A'); return { action: 'continue' } } } }
    const b: AgentPlugin = { id: 'b', hooks: { beforeModel: async () => { calls.push('B'); return { action: 'continue' } } } }
    const insertion: AgentPlugin = { id: 'insert', hooks: { onRegister: async plugins => {
        const index = plugins.indexOf(insertion); plugins.splice(index, 1)
        plugins.splice(0, 2, t, a, t, b, t)
    } } }
    await createAgent({ plugins: [a, b, insertion, scripted()] }).run(null)
    expect(calls).toEqual(['T', 'A', 'T', 'B', 'T'])
    expect(registration).toHaveBeenCalledTimes(1)
    expect(initialization).toHaveBeenCalledTimes(1)
})

it('after 不影响数组顺序，同名 id 不代替对象身份', async () => {
    const seen: number[] = []
    const plugins: AgentPlugin[] = [1, 2].map(value => ({ id: 'same', after: 'missing', hooks: { beforeModel: async () => { seen.push(value); return { action: 'continue' } } } }))
    await createAgent({ plugins: [...plugins, scripted()] }).run(null)
    expect(seen).toEqual([1, 2])
})

it('初始化惰性且一次，整组对象复用，Context 每轮共享且无旧字段', async () => {
    const contexts: AgentContext[] = []
    const start = vi.fn(async (ctx: AgentContext) => { contexts.push(ctx) })
    const plugin: AgentPlugin = { id: 'state', hooks: { onInitialize: start, onRunStart: async ctx => { contexts.push(ctx); return { action: 'continue' } } } }
    const candidates = [plugin, scripted([turn(), turn()])]
    const agent = createAgent({ plugins: candidates })
    candidates.length = 0
    expect(start).not.toHaveBeenCalled()
    await agent.run('one'); await agent.run('two')
    expect(start).toHaveBeenCalledTimes(1)
    expect(contexts[0]).toBe(contexts[1])
    expect(contexts[1]).toBe(contexts[2])
    expect(Object.keys(contexts[1]!)).toEqual(['tools', 'plugins'])
    expect(contexts[1]!.plugins.map(item => item.id)).toEqual(['state', 'generation'])
    expect(contexts[2]!.plugins).toBe(contexts[1]!.plugins)
})

it('异步初始化失败形成 Outcome 并且不重试副作用', async () => {
    const error = Error('init failed')
    const init = vi.fn(async () => { throw error })
    const agent = createAgent({ plugins: [scripted(), { id: 'init', hooks: { onInitialize: init } }] })
    expect(await agent.run(null)).toMatchObject({ ok: false, error: { code: 'HOOK_FAILED', cause: error } })
    expect(await agent.run(null)).toMatchObject({ ok: false, error: { code: 'HOOK_FAILED', cause: error } })
    expect(init).toHaveBeenCalledTimes(1)
})

it('没有 model 可在前置钩子停止，真正进入模型阶段时报告错误', async () => {
    const init = vi.fn(async () => {})
    const stopped = createAgent({ plugins: [{ id: 'none', hooks: {
        onInitialize: init, onRunStart: async () => ({ action: 'stop' })
    } }] })
    expect((await stopped.run(null)).ok).toBe(true)
    expect(init).toHaveBeenCalledTimes(1)

    let observed: unknown
    const missing = createAgent({ plugins: [{ id: 'none', hooks: {
        onError: async (_ctx, error) => { observed = error }
    } }] })
    const outcome = await missing.run(null)
    expect(outcome).toMatchObject({ ok: false, error: expect.objectContaining({ message: expect.stringContaining('没有可执行的 model Hook') }) })
    expect(!outcome.ok && outcome.error).toBe(observed)
})

it('多个 model 按最终插件数组选择最后一个', async () => {
    const result = await createAgent({ plugins: [scripted([turn([], 'first')]), scripted([turn([], 'last')])] }).run(null)
    expect(result.ok && result.value).toMatchObject({ text: 'last', finishReason: 'stop' })
})
