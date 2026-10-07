import { expect, it, vi } from 'vitest'
import { z } from 'zod'
import { createAgent, defineTool, toolSuccess } from '@quifox/agent-core'
import { ChatModelPlugin, type HttpRequest, type HttpTransport } from '@quifox/agent-plugin-model'
import { ChatSessionPlugin, ChatConversationPlugin } from '../src/index.js'

function transport(reply: (request: HttpRequest, turn: number) => unknown): HttpTransport & { requests: HttpRequest[] } {
    const requests: HttpRequest[] = []
    return { requests, async stream(request) {
        requests.push(request)
        const chunk = reply(request, requests.length)
        return { status: 200, headers: {}, body: (async function* () {
            yield new TextEncoder().encode(`data: ${JSON.stringify(chunk)}\n\ndata: [DONE]\n\n`)
        })() }
    } }
}

it('组合直接配置模型连接，保留真实请求地址、认证和多轮历史', async () => {
    const http = transport(() => ({ choices: [{ delta: { content: 'Hello World', reasoning_content: 'thinking' }, finish_reason: 'stop' }] }))
    const session = new ChatSessionPlugin({ id: 'chat', ownerId: 'test' })
    const model = new ChatModelPlugin({ session, model: 'deepseek-flash', baseUrl: 'https://example.test/v1', apiKey: 'test-key', transport: http, assistantReasoningField: 'reasoning_content' })
    const conversation = new ChatConversationPlugin({ session, generation: model })
    const agent = createAgent({ plugins: [conversation] })
    expect((await agent.run({ prompt: 'one' })).ok).toBe(true)
    expect((await agent.run({ prompt: 'two' })).ok).toBe(true)
    expect(http.requests[0]).toMatchObject({ url: 'https://example.test/v1/chat/completions', headers: { authorization: 'Bearer test-key' } })
    expect(JSON.parse(http.requests[1]!.body!)).toMatchObject({
        model: 'deepseek-flash', messages: [{ role: 'user', content: 'one' }, { role: 'assistant', content: 'Hello World', reasoning_content: 'thinking' }, { role: 'user', content: 'two' }]
    })
    expect(conversation.readOutput()).toBe('Hello World')
    expect('model' in model).toBe(false)
})

it('协议语法解析之后由工具 prepare 决定参数转换', async () => {
    const http = transport((_request, turn) => turn === 1
        ? { choices: [{ delta: { tool_calls: [{ index: 0, id: 'call', function: { name: 'minutes', arguments: "{value: '20',}" } }] }, finish_reason: 'tool_calls' }] }
        : { choices: [{ delta: { content: '完成' }, finish_reason: 'stop' }] })
    const execute = vi.fn(async (_input: { value: number }) => toolSuccess('saved'))
    const session = new ChatSessionPlugin({ id: 'tools', ownerId: 'test' })
    const model = new ChatModelPlugin({ session, model: 'test', baseUrl: 'https://example.test', transport: http })
    const schema = z.object({ value: z.number().int().positive() })
    const agent = createAgent({ plugins: [model, { id: 'tools', hooks: {
        onInitialize: async ctx => { ctx.tools.register(defineTool({
            name: 'minutes', description: '', policy: { sideEffect: 'external', approval: 'host' }, inputSchema: schema,
            prepare: async (_ctx, raw) => schema.parse(z.object({ value: z.string().regex(/^[0-9]+$/u).transform(Number) }).parse(raw)), execute
        })) },
        beforeTool: async (_ctx, call) => { expect(call.input).toEqual({ value: '20' }); return { action: 'continue' } }
    } }, session] })
    expect((await agent.run({ prompt: 'go' })).ok).toBe(true)
    expect(execute).toHaveBeenCalledTimes(1)
    expect(execute.mock.calls[0]?.[0]).toEqual({ value: 20 })
    expect(http.requests).toHaveLength(2)
})

it('模型插件保留空工具与显式 none 的请求语义', async () => {
    const http = transport(() => ({ choices: [{ delta: {}, finish_reason: 'stop' }] }))
    const session = new ChatSessionPlugin({ id: 'none', ownerId: 'test' })
    const model = new ChatModelPlugin({ session, model: 'test', baseUrl: 'https://example.test', transport: http, settings: { toolChoice: 'none' } })
    expect((await createAgent({ plugins: [session, model] }).run({ prompt: 'summary' })).ok).toBe(true)
    expect(JSON.parse(http.requests[0]!.body!)).toMatchObject({ tools: [], tool_choice: 'none' })
})
