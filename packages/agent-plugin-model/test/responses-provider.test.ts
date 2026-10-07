import type { ResponsesModelRequest as ModelRequest } from '../src/internal/index.js'
import { MODEL_ERROR_CODE as AGENT_ERROR_CODE } from '../src/internal/errors.js'
import { MESSAGE_ROLE, MODEL_EVENT_TYPE, type ModelEvent } from '@quifox/agent-core'
import { describe, expect, it } from 'vitest'

import {
    createOpenAIResponsesProvider,
    type HttpRequest,
    type HttpStreamResponse,
    type HttpTransport
} from '../src/internal/index.js'

it('Responses 禁用工具请求保留明确的空数组和 none', async () => {
    const transport = new RecordingTransport(() => ({ status: 200, headers: {}, body: body('data: {"type":"response.completed","response":{"id":"resp-none","status":"completed","output":[]}}\n\ndata: [DONE]\n\n') }))
    const model = createOpenAIResponsesProvider({ id: 'test', baseUrl: 'https://example.test', transport }).languageModel('test')
    await collect(model.stream({ messages: [], tools: [], toolChoice: 'none' }))
    expect(JSON.parse(transport.requests[0]!.body!)).toMatchObject({ tools: [], tool_choice: 'none' })
})

it.each([
    { messages: [{ role: MESSAGE_ROLE.SYSTEM, content: '基础指令' }] },
    { messages: [{ role: MESSAGE_ROLE.SYSTEM, content: '基础指令' }, { role: MESSAGE_ROLE.ASSISTANT, content: '已完成' }] }
])('Responses 空增量续接不重发历史消息：%j', async ({ messages }) => {
    const transport = new RecordingTransport(() => ({ status: 200, headers: {}, body: body('data: {"type":"response.completed","response":{"id":"resp-next","status":"completed","output":[]}}\n\ndata: [DONE]\n\n') }))
    const model = createOpenAIResponsesProvider({ id: 'test', baseUrl: 'https://example.test', transport }).languageModel('test')
    await collect(model.stream({ messages, tools: [], previousResponseId: 'resp-previous' }))
    expect(JSON.parse(transport.requests[0]!.body!)).toMatchObject({ previous_response_id: 'resp-previous', input: [] })
})

describe('Responses 工具参数语法容错', () => {
    it.each([
        '{value:', "{value: 'unfinished}", '{value:}', '{value: NaN}',
        '{outer: [{value: Infinity}]}', '{"value":1e400}', 'call({value:20})'
    ])('完成响应仍拒绝截断、缺值、非有限数字或表达式：%s', async argumentsText => {
        const completed = { type: 'response.completed', response: { id: 'resp-invalid', status: 'completed', output: [{ type: 'function_call', call_id: 'call-invalid', name: 'todo_create', arguments: argumentsText }] } }
        const model = createOpenAIResponsesProvider({
            id: 'responses', baseUrl: 'https://example.test/v1',
            transport: new RecordingTransport(() => ({ status: 200, headers: {}, body: body(`data: ${JSON.stringify(completed)}\n\ndata: [DONE]\n\n`) }))
        }).languageModel('test-model')

        await expect(collect(model.stream({ messages: [], tools: [] }))).rejects.toMatchObject({ code: AGENT_ERROR_CODE.PROVIDER_PROTOCOL_ERROR })
    })

    it.each([['failed', 'error'], ['cancelled', 'cancelled']] as const)(
        '%s 终态不解析畸形函数参数、不发布工具调用，保留 %s 原因', async (status, reason) => {
            const completed = { type: 'response.completed', response: { id: 'resp-terminal', status, output: [{ type: 'function_call', call_id: 'call-terminal', name: 'todo_create', arguments: '{value:' }] } }
            const model = createOpenAIResponsesProvider({
                id: 'responses', baseUrl: 'https://example.test/v1',
                transport: new RecordingTransport(() => ({ status: 200, headers: {}, body: body(`data: ${JSON.stringify(completed)}\n\ndata: [DONE]\n\n`) }))
            }).languageModel('test-model')

            const events = await collect(model.stream({ messages: [], tools: [] }))

            expect(events.some(event => event.type === MODEL_EVENT_TYPE.TOOL_CALL)).toBe(false)
            expect(events.at(-1)).toMatchObject({ type: MODEL_EVENT_TYPE.FINISH, reason })
        }
    )

    it('未完成响应中的函数调用不能覆盖长度终态并进入业务执行', async () => {
        const completed = {
            type: 'response.completed',
            response: { id: 'resp-incomplete', status: 'incomplete', output: [{ type: 'function_call', call_id: 'call-incomplete', name: 'todo_create', arguments: '{"title":"复习"}' }] }
        }
        const model = createOpenAIResponsesProvider({
            id: 'responses', baseUrl: 'https://example.test/v1',
            transport: new RecordingTransport(() => ({ status: 200, headers: {}, body: body(`data: ${JSON.stringify(completed)}\n\ndata: [DONE]\n\n`) }))
        }).languageModel('test-model')

        const events = await collect(model.stream({ messages: [], tools: [] }))

        expect(events.some(event => event.type === MODEL_EVENT_TYPE.TOOL_CALL)).toBe(false)
        expect(events.at(-1)).toMatchObject({ type: MODEL_EVENT_TYPE.FINISH, reason: 'length' })
    })

    it('仅从完成响应解析完整的 JSON5 参数', async () => {
        const completed = {
            type: 'response.completed',
            response: { id: 'resp-repair', status: 'completed', output: [{ type: 'function_call', call_id: 'call-repair', name: 'todo_create', arguments: "{title: '复习', estimatedMinutes: '20',}" }] }
        }
        const model = createOpenAIResponsesProvider({
            id: 'responses', baseUrl: 'https://example.test/v1',
            transport: new RecordingTransport(() => ({ status: 200, headers: {}, body: body(`data: ${JSON.stringify(completed)}\n\ndata: [DONE]\n\n`) }))
        }).languageModel('test-model')

        const events = await collect(model.stream({ messages: [], tools: [] }))

        expect(events).toContainEqual({ type: MODEL_EVENT_TYPE.TOOL_CALL, call: { id: 'call-repair', name: 'todo_create', input: { title: '复习', estimatedMinutes: '20' } } })
        expect(events.at(-1)).toMatchObject({ type: MODEL_EVENT_TYPE.FINISH, reason: 'tool-calls' })
    })

    it('函数调用缺少 call_id 时拒绝，不使用 output item id 代替', async () => {
        const completed = {
            type: 'response.completed',
            response: { id: 'resp-missing-call-id', status: 'completed', output: [
                { type: 'function_call', id: 'item-id', name: 'todo_create', arguments: '{"title":"复习"}' }
            ] }
        }
        const model = createOpenAIResponsesProvider({
            id: 'responses', baseUrl: 'https://example.test/v1',
            transport: new RecordingTransport(() => ({ status: 200, headers: {}, body: body(`data: ${JSON.stringify(completed)}\n\ndata: [DONE]\n\n`) }))
        }).languageModel('test-model')

        await expect(collect(model.stream({ messages: [], tools: [] }))).rejects.toMatchObject({
            code: AGENT_ERROR_CODE.PROVIDER_PROTOCOL_ERROR
        })
    })

    it.each([
        { output: [{ type: 'function_call', call_id: 'call-without-name', arguments: '{}' }] },
        { output: [
            { type: 'function_call', call_id: 'call-duplicate', name: 'first', arguments: '{}' },
            { type: 'function_call', call_id: 'call-duplicate', name: 'second', arguments: '{}' }
        ] }
    ])('函数调用缺少名称或重复 call_id 时拒绝：$output', async ({ output }) => {
        const completed = { type: 'response.completed', response: { id: 'resp-invalid-call', status: 'completed', output } }
        const model = createOpenAIResponsesProvider({
            id: 'responses', baseUrl: 'https://example.test/v1',
            transport: new RecordingTransport(() => ({ status: 200, headers: {}, body: body(`data: ${JSON.stringify(completed)}\n\ndata: [DONE]\n\n`) }))
        }).languageModel('test-model')

        await expect(collect(model.stream({ messages: [], tools: [] }))).rejects.toMatchObject({
            code: AGENT_ERROR_CODE.PROVIDER_PROTOCOL_ERROR
        })
    })
})

/** 测试用固定响应 Transport。 */
class RecordingTransport implements HttpTransport {
    readonly requests: HttpRequest[] = []

    /** @param response - 模拟 Responses SSE 响应工厂。 */
    constructor(private readonly response: () => HttpStreamResponse) {}

    /** @param request - Provider 发出的 HTTP 请求。 @returns 固定响应。 */
    async stream(request: HttpRequest): Promise<HttpStreamResponse> {
        this.requests.push(request)
        return this.response()
    }
}

/** @param text - SSE 文本。 @returns 单块 UTF-8 流。 */
async function* body(text: string): AsyncGenerator<Uint8Array> {
    yield new TextEncoder().encode(text)
}

/** @param events - 模型事件流。 @returns 事件数组。 */
async function collect(events: AsyncIterable<ModelEvent>): Promise<ModelEvent[]> {
    const output: ModelEvent[] = []
    for await (const event of events) {
        output.push(event)
    }
    return output
}

describe('createOpenAIResponsesProvider', () => {
    it.each(['tools', 'input', 'additional_tools'])('拒绝 providerOptions 改写 %s', async (field) => {
        const transport = new RecordingTransport(() => ({
            status: 200,
            headers: {},
            body: body('')
        }))
        const model = createOpenAIResponsesProvider({
            id: 'responses',
            baseUrl: 'https://example.test/v1',
            transport
        }).languageModel('test-model')

        await expect(collect(model.stream({
            messages: [{ role: MESSAGE_ROLE.USER, content: 'hello' }],
            tools: [],
            providerOptions: { [field]: [] }
        }))).rejects.toMatchObject({ code: AGENT_ERROR_CODE.PROVIDER_PROTOCOL_ERROR })
        expect(transport.requests).toEqual([])
    })

    it('将 failed 完成状态归一为模型失败，而不是成功 stop', async () => {
        const transport = new RecordingTransport(() => ({
            status: 200,
            headers: { 'content-type': 'text/event-stream' },
            body: body([
                'event: response.completed',
                'data: {"type":"response.completed","response":{"id":"resp_failed","status":"failed","output":[]}}',
                '',
                'data: [DONE]',
                '',
                ''
            ].join('\n'))
        }))
        const model = createOpenAIResponsesProvider({
            id: 'responses',
            baseUrl: 'https://example.test/v1',
            transport
        }).languageModel('test-model')

        await expect(collect(model.stream({
            messages: [{ role: MESSAGE_ROLE.USER, content: 'hello' }],
            tools: []
        }))).resolves.toEqual([{
            type: MODEL_EVENT_TYPE.FINISH,
            reason: 'error',
            responseId: 'resp_failed'
        }])
    })

    it('将 cancelled 完成状态归一为取消，而不是成功 stop', async () => {
        const transport = new RecordingTransport(() => ({
            status: 200,
            headers: { 'content-type': 'text/event-stream' },
            body: body([
                'event: response.completed',
                'data: {"type":"response.completed","response":{"id":"resp_cancelled","status":"cancelled","output":[]}}',
                '',
                'data: [DONE]',
                '',
                ''
            ].join('\n'))
        }))
        const model = createOpenAIResponsesProvider({
            id: 'responses',
            baseUrl: 'https://example.test/v1',
            transport
        }).languageModel('test-model')

        await expect(collect(model.stream({
            messages: [{ role: MESSAGE_ROLE.USER, content: 'hello' }],
            tools: []
        }))).resolves.toEqual([{
            type: MODEL_EVENT_TYPE.FINISH,
            reason: 'cancelled',
            responseId: 'resp_cancelled'
        }])
    })

    it('拒绝缺少终态 status 的 Responses 完成事件', async () => {
        const transport = new RecordingTransport(() => ({
            status: 200,
            headers: { 'content-type': 'text/event-stream' },
            body: body([
                'event: response.completed',
                'data: {"type":"response.completed","response":{"id":"resp_missing_status","output":[]}}',
                '',
                'data: [DONE]',
                '',
                ''
            ].join('\n'))
        }))
        const model = createOpenAIResponsesProvider({
            id: 'responses',
            baseUrl: 'https://example.test/v1',
            transport
        }).languageModel('test-model')

        await expect(collect(model.stream({
            messages: [{ role: MESSAGE_ROLE.USER, content: 'hello' }],
            tools: []
        }))).rejects.toMatchObject({
            code: AGENT_ERROR_CODE.PROVIDER_PROTOCOL_ERROR
        })
    })

    it('拒绝缺少 Response 游标的完成事件，避免 Tool 后续链断开', async () => {
        const transport = new RecordingTransport(() => ({
            status: 200,
            headers: { 'content-type': 'text/event-stream' },
            body: body([
                'event: response.completed',
                'data: {"type":"response.completed","response":{"status":"completed","output":[{"type":"function_call","call_id":"call_1","name":"snapshot","arguments":"{}"}]}}',
                '',
                'data: [DONE]',
                '',
                ''
            ].join('\n'))
        }))
        const model = createOpenAIResponsesProvider({
            id: 'responses',
            baseUrl: 'https://example.test/v1',
            transport
        }).languageModel('test-model')

        await expect(collect(model.stream({
            messages: [{ role: MESSAGE_ROLE.USER, content: 'snapshot' }],
            tools: []
        }))).rejects.toMatchObject({
            code: AGENT_ERROR_CODE.PROVIDER_PROTOCOL_ERROR
        })
    })

    it('首轮发送 input，后续只发送工具结果并保留 Response 游标', async () => {
        const transport = new RecordingTransport(() => ({
            status: 200,
            headers: { 'content-type': 'text/event-stream' },
            body: body([
                'event: response.created',
                'data: {"type":"response.created","response":{"id":"resp_1"}}',
                '',
                'event: response.output_text.delta',
                'data: {"type":"response.output_text.delta","response_id":"resp_1","delta":"ok"}',
                '',
                'event: response.completed',
                'data: {"type":"response.completed","response":{"id":"resp_1","status":"completed","output":[{"type":"message","content":[{"type":"output_text","text":"ok"}]}]}}',
                '',
                'data: [DONE]',
                '',
                ''
            ].join('\n'))
        }))
        const model = createOpenAIResponsesProvider({
            id: 'responses-fixture',
            baseUrl: 'https://example.test/v1',
            transport
        }).languageModel('deepseek-v4.1-flash')
        const request: ModelRequest = {
            messages: [
                { role: MESSAGE_ROLE.SYSTEM, content: '你是助手。' },
                { role: MESSAGE_ROLE.USER, content: '读取页面' }
            ],
            tools: [],
            reasoning: { type: 'effort', effort: 'high' }
        }

        const events = await collect(model.stream(request))
        expect(events).toEqual([
            { type: MODEL_EVENT_TYPE.TEXT_DELTA, delta: 'ok' },
            { type: MODEL_EVENT_TYPE.FINISH, reason: 'stop', responseId: 'resp_1' }
        ])
        expect(JSON.parse(transport.requests[0]?.body ?? '')).toMatchObject({
            model: 'deepseek-v4.1-flash',
            stream: true,
            input: [
                { type: 'message', role: 'system' },
                { type: 'message', role: 'user' }
            ],
            reasoning: { effort: 'high' }
        })

        const followUp: ModelRequest = {
            ...request,
            previousResponseId: 'resp_1',
            messages: [
                ...request.messages,
                {
                    role: MESSAGE_ROLE.ASSISTANT,
                    content: '',
                    toolCalls: [{ id: 'call_1', name: 'snapshot', input: {} }]
                },
                {
                    role: MESSAGE_ROLE.TOOL,
                    toolCallId: 'call_1',
                    toolName: 'snapshot',
                    content: '页面快照'
                }
            ]
        }
        await collect(model.stream(followUp))
        const followUpBody = JSON.parse(transport.requests[1]?.body ?? '') as Record<string, unknown>
        expect(followUpBody.previous_response_id).toBe('resp_1')
        expect(followUpBody.input).toEqual([
            { type: 'function_call_output', call_id: 'call_1', output: '页面快照' }
        ])
    })
})
