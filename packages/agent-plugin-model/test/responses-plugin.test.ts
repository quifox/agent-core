import { expect, it } from 'vitest'
import { createAgent } from '@quifox/agent-core'
import { ResponsesModelPlugin } from '../src/index.js'

it('Responses 通过模型插件钩子运行，客户端和工厂不参与 Agent 构造', async () => {
    let request: unknown
    const plugin = new ResponsesModelPlugin({ model: 'test', baseUrl: 'https://example.test',
        transport: { async stream(input) {
            request = JSON.parse(input.body!)
            return { status: 200, headers: {}, body: (async function* () {
                yield new TextEncoder().encode('data: {"type":"response.output_text.delta","delta":"hello"}\n\n')
                yield new TextEncoder().encode('data: {"type":"response.completed","response":{"id":"response-1","status":"completed","output":[]}}\n\n')
            })() }
        } } })
    const outcome = await createAgent({ plugins: [plugin] }).run({ messages: [{ role: 'user', content: 'go' }], tools: [] })
    expect(outcome).toMatchObject({ ok: true, value: { text: 'hello', toolCalls: [] } })
    if (outcome.ok) { expect(outcome.value).not.toHaveProperty('responseId') }
    expect(request).toMatchObject({ model: 'test' })
})

it('重叠 run 不覆盖活动请求，被拒绝的 Outcome 不能释放首轮状态', async () => {
    let release!: () => void
    let entered!: () => void
    const held = new Promise<void>(resolve => { release = resolve })
    const started = new Promise<void>(resolve => { entered = resolve })
    const requests: unknown[] = []
    const plugin = new ResponsesModelPlugin({ model: 'test', baseUrl: 'https://example.test',
        transport: { async stream(input) {
            requests.push(JSON.parse(input.body!))
            entered()
            await held
            return { status: 200, headers: {}, body: (async function* () {
                yield new TextEncoder().encode('data: {"type":"response.completed","response":{"id":"response-1","status":"completed","output":[]}}\n\n')
            })() }
        } } })
    const agent = createAgent({ plugins: [plugin] })
    const first = agent.run({ messages: [{ role: 'user', content: 'first' }], tools: [] })
    await started
    try {
        const second = await agent.run({ messages: [{ role: 'user', content: 'second' }], tools: [] })
        expect(second).toMatchObject({ ok: false, error: { cause: { message: 'Responses model plugin is already handling a run.' } } })
        const third = await agent.run({ messages: [{ role: 'user', content: 'third' }], tools: [] })
        expect(third.ok).toBe(false)
        expect(requests).toHaveLength(1)
        expect(JSON.stringify(requests[0])).toContain('first')
        expect(plugin.request.messages[0]?.content).toBe('first')
    } finally { release() }
    expect((await first).ok).toBe(true)
    expect((await agent.run({ messages: [{ role: 'user', content: 'next' }], tools: [] })).ok).toBe(true)
    expect(requests).toHaveLength(2)
    expect(JSON.stringify(requests[1])).toContain('next')
})
