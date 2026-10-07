import { expect, it } from 'vitest'
import { createAgent, type AgentContext, type AgentPlugin } from '../src/index.js'
import { collectEvents, scripted, turn } from './fixtures.js'

it('beforeModel 无 request 参数，afterModel 直接修改生成器 return 的同一个结果', async () => {
    const result = turn()
    const seen: AgentContext[] = []
    const plugin: AgentPlugin = { id: 'mutate', hooks: {
        beforeModel: async (...args) => { expect(args.length).toBe(1); seen.push(args[0]); return { action: 'continue' } },
        afterModel: async (ctx, value) => { expect(value).toBe(result); expect(ctx).toBe(seen[0]); value.text = 'edited'; return { action: 'continue' } }
    } }
    const outcome = await createAgent({ plugins: [scripted([result]), plugin] }).run(null)
    expect(outcome.ok && outcome.value).toBe(result)
    expect(result.text).toBe('edited')
})

it('普通钩子必须显式返回 continue/stop，拒绝旧返回替换协议', async () => {
    const invalid = { id: 'invalid', hooks: { beforeModel: async () => undefined } } as unknown as AgentPlugin
    expect((await createAgent({ plugins: [scripted(), invalid] }).run(null)).ok).toBe(false)
})

it('不同输入类型直接交给 onRunStart，不强制 prompt 或 messages 包装', async () => {
    const payload = { attachments: [{ base64: 'image' }] }
    const plugin: AgentPlugin<typeof payload> = { id: 'input', hooks: {
        onRunStart: async (_ctx, input) => { expect(input).toBe(payload); return { action: 'stop' } }
    } }
    expect((await createAgent({ plugins: [plugin, scripted()] }).run(payload)).ok).toBe(true)
})

it('前置控制 Hook 事件交付前完成整条链，消费者退出不撤回已运行的后项', async () => {
    const trace: string[] = []
    const model = scripted()
    const original = model.hooks!.model!
    let generated = false
    model.hooks!.model = async function* (ctx) { generated = true; return yield* original(ctx) }
    const plugin: AgentPlugin = { id: 'preparation', hooks: { beforeModel: [
        async function* () {
            trace.push('first')
            yield { type: 'prepared' }
            return { action: 'continue' }
        },
        async () => { trace.push('second'); return { action: 'continue' } }
    ] } }
    for await (const event of createAgent({ plugins: [plugin, model] }).stream(null)) {
        if (event.type === 'prepared') {
            expect(trace).toEqual(['first', 'second'])
            break
        }
    }
    expect(generated).toBe(false)
})

it('前置 stop 短路当前 Hook 链，后项不运行但仍执行收尾', async () => {
    const trace: string[] = []
    const plugin: AgentPlugin = { id: 'stop-before-model', hooks: {
        beforeModel: [
            async () => { trace.push('stop'); return { action: 'stop' } },
            async () => { trace.push('unreachable'); return { action: 'continue' } }
        ],
        onRunEnd: async () => { trace.push('end') }
    } }
    await collectEvents(createAgent({ plugins: [plugin, scripted()] }).stream(null))
    expect(trace).toEqual(['stop', 'end'])
})
