import type { AgentRunOutcome, ModelTurnResult } from '@quifox/agent-core'
import { expect, it, vi } from 'vitest'
import { createAgent } from '@quifox/agent-core'
import { ResponsesModelPlugin, type ResponsesModelEvent as ModelEvent, type ResponsesModelRequest as ModelRequest, type HttpTransport } from '@quifox/agent-plugin-model'
import { createFormalBackendPlugin, type FormalBackendApi } from '../src/index.js'
import { ResponsesSessionContext } from '../src/responses-session-context.js'

interface LanguageModel {
    provider: string
    modelId: string
    stream(request: ModelRequest): AsyncIterable<ModelEvent>
}

function connection(model: LanguageModel, bind: (id: string, purpose: 'summary' | 'responses') => LanguageModel = () => model) {
    const transport: HttpTransport = { async stream(http) {
        const wire = JSON.parse(http.body!) as { input: { type: string; role?: string; content?: { text: string }[] | string; call_id?: string; output?: string }[];
            instructions?: string; previous_response_id?: string; max_output_tokens?: number }
        const messages: ModelRequest['messages'][number][] = wire.instructions ? [{ role: 'system', content: wire.instructions }] : []
        for (const item of wire.input) {
            if (item.type === 'function_call_output') {
                messages.push({ role: 'tool', toolCallId: item.call_id!, toolName: '', content: item.output! })
            } else if (item.type === 'message') {
                messages.push({ role: item.role as 'user' | 'assistant' | 'system',
                    content: typeof item.content === 'string' ? item.content : item.content?.map(part => part.text).join('') ?? '' })
            }
        }
        const request: ModelRequest = { messages, tools: [],
            ...(wire.previous_response_id ? { previousResponseId: wire.previous_response_id } : {}),
            ...(wire.max_output_tokens ? { maxOutputTokens: wire.max_output_tokens } : {}),
            ...(http.signal ? { signal: http.signal } : {}) }
        const path = /\/contexts\/([^/]+)\/(summary|responses)$/.exec(http.url)
        const target = path ? bind(decodeURIComponent(path[1]!), path[2] as 'summary' | 'responses') : model
        let text = ''
        let responseId = ''
        for await (const event of target.stream(request)) {
            if (event.type === 'text-delta') { text += event.delta }
            if (event.type === 'finish') { responseId = event.responseId }
        }
        const completed = { type: 'response.completed', response: { id: responseId, status: 'completed',
            output: text ? [{ type: 'message', content: [{ type: 'output_text', text }] }] : [] } }
        return { status: 200, headers: {}, body: (async function* () {
            if (text) { yield new TextEncoder().encode(`data: ${JSON.stringify({ type: 'response.output_text.delta', delta: text })}\n\n`) }
            yield new TextEncoder().encode(`data: ${JSON.stringify(completed)}\n\n`)
        })() }
    } }
    return { model: model.modelId, baseUrl: 'https://example.test', transport }
}

const request: ModelRequest = { messages: [{ role: 'user', content: '新问题' }], tools: [], previousResponseId: 'source', maxOutputTokens: 3000 }
const candidate: ModelTurnResult = { text: '摘要', reasoning: '', toolCalls: [], usage: {}, finishReason: 'stop' }
const plan = { required: true, context_id: 'fork', input_tokens: 9000, context_window: 10000, summary_max_output_tokens: 1000 }

/** 创建记录实际流路由的后端 Context 测试配置。 @returns Context 配置和观测值。 */
function fixture() {
    const routes: string[] = []
    const requests: ModelRequest[] = []
    const model: LanguageModel = { provider: 'test', modelId: 'test',
        async *stream(): AsyncIterable<ModelEvent> {
            routes.push('base'); yield { type: 'finish', reason: 'stop', responseId: 'base-response' }
        } }
    const api = { prepareAgentContext: vi.fn(async () => plan),
        commitAgentCheckpoint: vi.fn(async () => ({ accepted: true, context_id: 'checkpoint' })) }
    const bind = (id: string, purpose: 'summary' | 'responses'): LanguageModel => ({ ...model,
        async *stream(input): AsyncIterable<ModelEvent> {
            routes.push(`${id}/${purpose}`); requests.push(input)
            yield { type: 'text-delta', delta: purpose === 'summary' ? '摘要' : '完成' }
            yield { type: 'finish', reason: 'stop', responseId: purpose === 'summary' ? 'summary-response' : 'main-response' }
        } })
    const config = connection(model, bind)
    return { model: new ResponsesModelPlugin(config), api, connection: config,
        bind: (id: string, purpose: 'summary' | 'responses') => new ResponsesModelPlugin({
            ...config, path: `/contexts/${encodeURIComponent(id)}/${purpose}`
        }), routes, requests, isCurrent: () => true }
}

it('摘要候选和接纳后的主调用使用独立路由，主游标仅由主 Response 推进', async () => {
    const options = fixture()
    const memory = createFormalBackendPlugin({ id: 's', ownerId: 'u', ...options.connection, settings: { maxOutputTokens: 3000 },
        snapshot: { version: 1, id: 's', ownerId: 'u', responseId: 'source' },
        api: options.api })
    const outcome = await createAgent({ plugins: [memory] }).run({ prompt: '新问题' }).then(expectModelResult)
    expect(options.routes).toEqual(['fork/summary', 'checkpoint/responses'])
    expect(options.requests[1]?.previousResponseId).toBe('source')
    expect(memory.snapshot().responseId).toBe('main-response')
    expect(outcome).not.toHaveProperty('responseId')
    expect(options.api.commitAgentCheckpoint).toHaveBeenCalledWith({ contextId: 'fork',
        agentCheckpointRequest: { candidate_response_id: 'summary-response' } }, expect.anything())
    expect(options.api.prepareAgentContext).toHaveBeenCalledWith(expect.objectContaining({
        request: expect.objectContaining({ stream: false, previous_response_id: 'source' })
    }), expect.anything())
})

it.each(['stale', 'abort', 'changed'] as const)('%s 候选不提交检查点', async mode => {
    const options = fixture()
    let current = true
    const controller = new AbortController()
    const input = { ...request, messages: [...request.messages], signal: controller.signal }
    const context = new ResponsesSessionContext({ ...options, isCurrent: () => current })
    const fork = (await context.prepare(input))!
    if (mode === 'stale') { current = false }
    if (mode === 'abort') { controller.abort() }
    if (mode === 'changed') { input.messages.push({ role: 'user', content: '变化' }) }
    await expect(fork.accept(candidate)).rejects.toThrow()
    expect(options.api.commitAgentCheckpoint).not.toHaveBeenCalled()
    expect(options.routes).toEqual([])
})

it('检查点拒绝时保留原始请求路由，不使用候选游标', async () => {
    const options = fixture()
    const api: FormalBackendApi = { ...options.api, commitAgentCheckpoint: vi.fn(async () => ({ accepted: false })) }
    const context = new ResponsesSessionContext({ ...options, api })
    const fork = (await context.prepare(request))!
    for await (const _event of fork.stream(fork.request)) { /* 候选引用属于后端对象。 */ }
    expect(await fork.accept(candidate)).toBeUndefined()
    for await (const _event of context.stream(request)) { /* 消费主请求。 */ }
    expect(options.routes).toEqual(['fork/summary', 'base'])
})

it('预检绑定的请求被后续 Hook 改动时，不发出主请求', async () => {
    const options = fixture()
    const api: FormalBackendApi = { ...options.api, prepareAgentContext: vi.fn(async () => ({ ...plan, required: false })) }
    const context = new ResponsesSessionContext({ ...options, api })
    await context.prepare(request)
    const consume = async () => {
        for await (const _event of context.stream({ ...request, maxOutputTokens: 2000 })) { /* 消费主请求。 */ }
    }
    await expect(consume()).rejects.toThrow('变化')
    expect(options.routes).toEqual([])
})

it('注册初始化不创建远端会话；公开组合将 Context 路由、鉴权和传输配对', async () => {
    const requests: string[] = []
    const transport = { stream: vi.fn(async (input: { url: string }) => {
        requests.push(input.url)
        return { status: 200, headers: {}, body: (async function* () {
            yield new TextEncoder().encode('data: {"type":"response.completed","response":{"id":"main","status":"completed","output":[]}}\n\n')
        })() }
    }) }
    const api: FormalBackendApi = { prepareAgentContext: vi.fn(async () => ({ ...plan, required: false, context_id: 'ctx/1' })),
        commitAgentCheckpoint: vi.fn(async () => ({ accepted: false })) }
    const memory = createFormalBackendPlugin({ id: 's', ownerId: 'u', model: 'test', baseUrl: 'https://example.test/v1/agent', transport, api })
    const agent = createAgent({ plugins: [memory] })
    expect(api.prepareAgentContext).not.toHaveBeenCalled()
    expect(transport.stream).not.toHaveBeenCalled()
    await agent.run({ prompt: '真实输入' }).then(expectModelResult)
    expect(requests).toEqual(['https://example.test/v1/agent/contexts/ctx%2F1/responses'])
    expect(memory.snapshot().responseId).toBe('main')
})

it('未类型化调用携带本地 resume 标记时明确拒绝，不把它当成新输入', async () => {
    const options = fixture()
    const memory = createFormalBackendPlugin({ id: 's', ownerId: 'u', ...options.connection })
    const input = { prompt: '不应发送', resume: true } as unknown as { prompt: string }

    const outcome = await createAgent({ plugins: [memory] }).run(input)

    expect(outcome).toMatchObject({ ok: false, error: {
        code: 'HOOK_FAILED', cause: { message: '当前 Responses 插件不支持本地工具续跑，请使用后端恢复能力。' }
    } })
    expect(options.routes).toEqual([])
})

it('所有 beforeModel 修改先完成，后端预检和实际发送使用相同请求', async () => {
    const options = fixture()
    options.api.prepareAgentContext.mockResolvedValue({ ...plan, required: false })
    const memory = createFormalBackendPlugin({ id: 's', ownerId: 'u', ...options.connection, api: options.api })
    const agent = createAgent({ plugins: [memory, { id: 'later', hooks: {
        beforeModel: async () => {
            memory.request.messages = [{ role: 'system', content: '后置规则' }, ...memory.request.messages.map(m => ({ ...m, content: m.content + '修订' }))]
            return { action: 'continue' }
        }
    } }] })
    await agent.run({ prompt: 'input' }).then(expectModelResult)
    const input = (options.api.prepareAgentContext.mock.calls as unknown[][])[0]?.[0]
    expect(JSON.stringify(input)).toContain('input修订')
    expect(JSON.stringify(input)).toContain('后置规则')
    expect(memory.snapshot().responseId).toBe('main-response')
})

it('失败重试保留最终输入，跨轮及 Fork 只续接各自最新引用', async () => {
    const requests: ModelRequest[] = []
    const model: LanguageModel = { provider: 'test', modelId: 'test', async *stream(request) {
        requests.push(request)
        if (requests.length === 1) throw new Error('offline')
        yield { type: 'finish', reason: 'stop', responseId: `r${requests.length}` }
    } }
    const memory = createFormalBackendPlugin({ id: 's', ownerId: 'u', ...connection(model) })
    const agent = createAgent({ plugins: [memory, { id: 'prompt', hooks: {
        beforeModel: async () => {
            memory.request.messages = [{ role: 'system', content: 'rule' }, ...memory.request.messages]
            return { action: 'continue' }
        }
    } }] })
    await expect(agent.run({ prompt: 'one' }).then(expectModelResult)).rejects.toThrow()
    await agent.run({ prompt: 'one' }).then(expectModelResult)
    expect(requests[1]!.messages).toEqual(requests[0]!.messages)
    const child = memory.fork('child')
    await createAgent({ plugins: [child] }).run({ prompt: 'branch' }).then(expectModelResult)
    expect(requests[2]!.previousResponseId).toBe('r2')
    expect(memory.snapshot().responseId).toBe('r2')
    await agent.run({ prompt: 'two' }).then(expectModelResult)
    expect(requests[3]).toMatchObject({ previousResponseId: 'r2', messages: [{ role: 'user', content: 'two' }] })
    expect(child.snapshot().responseId).toBe('r3')
    expect('run' in memory).toBe(false)
})

it('核实工具恢复先持久化，原输入重试只提交缺失输出而不重发已接纳 user', async () => {
    const requests: ModelRequest[] = []
    const model: LanguageModel = { provider: 'test', modelId: 'test', async *stream(request) {
        requests.push(request); yield { type: 'finish', reason: 'stop', responseId: 'next' }
    } }
    let fail = true
    const memory = createFormalBackendPlugin({ id: 's', ownerId: 'u', ...connection(model),
        snapshot: { version: 1, id: 's', ownerId: 'u', responseId: 'source',
            pendingInput: { original: [{ role: 'user', content: 'go' }], prepared: [{ role: 'user', content: 'go plus context' }], accepted: true },
            toolExchange: { responseId: 'source', calls: [{ id: 'a', name: 'read', input: {} }], results: [] }
        }, store: { save() { if (fail) throw new Error('storage') } } })
    const results = [{ role: 'tool', toolCallId: 'a', toolName: 'read', content: 'verified' }] as const
    await expect(memory.completePendingTools(results)).rejects.toThrow('storage')
    expect(memory.pendingToolCalls.map(call => call.id)).toEqual(['a'])
    fail = false; await memory.completePendingTools(results)
    await createAgent({ plugins: [memory] }).run({ prompt: 'go' }).then(expectModelResult)
    expect(requests[0]).toMatchObject({ previousResponseId: 'source', messages: [
        { role: 'tool', toolCallId: 'a', content: 'verified' }
    ] })
    expect(memory.snapshot().pendingInput).toBeUndefined()
})

/** 仅供测试消费标准 Outcome；不包装模型结果。 */
function expectModelResult(outcome: AgentRunOutcome): ModelTurnResult {
    if (!outcome.ok) { throw outcome.error }
    return outcome.value as ModelTurnResult
}
