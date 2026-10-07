import { MODEL_ERROR_CODE as AGENT_ERROR_CODE, MODEL_ERROR_PHASE as AGENT_ERROR_PHASE } from '../src/internal/errors.js'
import { MESSAGE_ROLE, MODEL_EVENT_TYPE, type ModelEvent, type ModelRequest } from '@quifox/agent-core'
import type { LanguageModel } from '../src/internal/model.js'
import { describe, expect, it } from 'vitest'

import {
    DEEPSEEK_FLASH_HIGH_THINKING_SETTINGS,
    createDeepSeekProvider,
    createOpenAICompatibleProvider,
    type HttpRequest,
    type HttpStreamResponse,
    type HttpTransport
} from '../src/internal/index.js'

/** 记录请求并返回固定 SSE 响应的测试 Transport。 */
class RecordingTransport implements HttpTransport {
    /** Transport 收到的平台无关请求。 */
    readonly requests: HttpRequest[] = []
    /** 本次测试返回的固定响应或按次响应工厂。 */
    private readonly response: HttpStreamResponse | (() => HttpStreamResponse)

    /**
     * 创建固定响应 Transport。
     *
     * @param response - 固定响应或每次请求调用的响应工厂。
     */
    constructor(response: HttpStreamResponse | (() => HttpStreamResponse)) {
        this.response = response
    }

    /**
     * 记录请求并返回固定响应。
     *
     * @param request - Provider 发出的 HTTP 请求。
     * @returns 构造时提供的固定响应。
     */
    async stream(request: HttpRequest): Promise<HttpStreamResponse> {
        this.requests.push(request)
        return typeof this.response === 'function'
            ? this.response()
            : this.response
    }
}

/**
 * 将测试文本编码为单个 UTF-8 字节块。
 *
 * @param text - 要编码的 SSE 文本。
 * @returns 只产生一个 chunk 的异步字节流。
 */
async function* utf8Body(text: string): AsyncGenerator<Uint8Array> {
    yield new TextEncoder().encode(text)
}

/** 模拟 `.length` 不可靠、但 TypedArray 迭代正常的小程序字节视图。 */
class IterableByteChunk extends Uint8Array {
    get length(): never {
        return undefined as never
    }
}

/** 生成 `.length` 不可用、但可迭代的 UTF-8 字节块。 */
async function* iterableUtf8Body(
    text: string
): AsyncGenerator<Uint8Array> {
    yield new IterableByteChunk(new TextEncoder().encode(text))
}

/**
 * 将测试文本拆成逐字节 UTF-8 网络流。
 *
 * @param text - 要编码并切分的 SSE 文本。
 * @returns 每次只产生一个字节的异步流。
 */
async function* bytewiseUtf8Body(text: string): AsyncGenerator<Uint8Array> {
    const bytes = new TextEncoder().encode(text)
    for (const byte of bytes) {
        yield Uint8Array.of(byte)
    }
}

/**
 * 完整消费模型事件流。
 *
 * @param events - Provider 返回的模型事件流。
 * @returns 保持原始顺序的事件数组。
 */
async function collectModelEvents(
    events: AsyncIterable<ModelEvent>
): Promise<ModelEvent[]> {
    const collected: ModelEvent[] = []
    for await (const event of events) {
        collected.push(event)
    }
    return collected
}

/**
 * 用指定响应创建不依赖真实网络的测试模型。
 *
 * @param response - fake Transport 返回的 HTTP 响应。
 * @returns 绑定到测试 Provider 的统一 LanguageModel。
 */
function createTestModel(response: HttpStreamResponse): LanguageModel {
    return createOpenAICompatibleProvider({
        id: 'test-provider',
        baseUrl: 'https://example.test/v1',
        transport: new RecordingTransport(response)
    }).languageModel('test-model')
}

describe('createOpenAICompatibleProvider', () => {
    it.each([
        '{value:',
        "{value: 'unfinished}",
        '{value:}',
        '{value: NaN}',
        '{outer: [{value: Infinity}]}',
        '{"value":1e400}',
        'call({value:20})'
    ])('语法容错仍拒绝截断、缺值、非有限数字或表达式：%s', async argumentsText => {
        const chunk = { choices: [{ delta: { tool_calls: [{ index: 0, id: 'call-invalid', function: { name: 'todo_create', arguments: argumentsText } }] }, finish_reason: 'tool_calls' }] }
        const model = createTestModel({ status: 200, headers: {}, body: utf8Body(`data: ${JSON.stringify(chunk)}\n\ndata: [DONE]\n\n`) })

        await expect(collectModelEvents(model.stream({ messages: [], tools: [] }))).rejects.toMatchObject({
            code: AGENT_ERROR_CODE.PROVIDER_PROTOCOL_ERROR,
            phase: AGENT_ERROR_PHASE.PROVIDER
        })
    })

    it('收齐完整工具参数后接受有限 JSON5 语法，不修改字段的实际值', async () => {
        const chunk = {
            choices: [{
                delta: { tool_calls: [{ index: 0, id: 'call-repair', function: { name: 'todo_create', arguments: "{title: '复习', estimatedMinutes: '20',}" } }] },
                finish_reason: 'tool_calls'
            }]
        }
        const model = createTestModel({
            status: 200, headers: {}, body: utf8Body(`data: ${JSON.stringify(chunk)}\n\ndata: [DONE]\n\n`)
        })

        const events = await collectModelEvents(model.stream({ messages: [], tools: [] }))

        expect(events).toContainEqual({
            type: MODEL_EVENT_TYPE.TOOL_CALL,
            call: { id: 'call-repair', name: 'todo_create', input: { title: '复习', estimatedMinutes: '20' } }
        })
        expect(events.at(-1)).toMatchObject({ type: MODEL_EVENT_TYPE.FINISH, reason: 'tool-calls' })
    })

    it.each(['tools', 'messages', 'additional_tools'])('Chat 拒绝 providerOptions 改写 %s', async (field) => {
        const transport = new RecordingTransport({
            status: 200,
            headers: {},
            body: utf8Body('')
        })
        const model = createOpenAICompatibleProvider({
            id: 'chat',
            baseUrl: 'https://example.test/v1',
            transport
        }).languageModel('test-model')

        await expect(collectModelEvents(model.stream({
            messages: [{ role: MESSAGE_ROLE.USER, content: 'hello' }],
            tools: [],
            providerOptions: { [field]: [] }
        }))).rejects.toMatchObject({ code: AGENT_ERROR_CODE.PROVIDER_PROTOCOL_ERROR })
        expect(transport.requests).toEqual([])
    })

    it('DeepSeek Provider 回传 Tool 前 Assistant 的 reasoning_content', async () => {
        const transport = new RecordingTransport({
            status: 200,
            headers: { 'content-type': 'text/event-stream' },
            body: utf8Body([
                'data: {"choices":[{"delta":{},"finish_reason":"stop"}]}',
                '',
                'data: [DONE]',
                '',
                ''
            ].join('\n'))
        })
        const model = createDeepSeekProvider({
            baseUrl: 'https://api.deepseek.com/v1',
            transport
        }).languageModel('deepseek-flash')

        await collectModelEvents(model.stream({
            messages: [{
                role: MESSAGE_ROLE.ASSISTANT,
                content: '',
                reasoning: '先读取当前页面。',
                toolCalls: [{
                    id: 'call-snapshot',
                    name: 'snapshot',
                    input: {}
                }]
            }, {
                role: MESSAGE_ROLE.TOOL,
                toolCallId: 'call-snapshot',
                toolName: 'snapshot',
                content: '当前页面为首页。'
            }],
            tools: [],
            ...DEEPSEEK_FLASH_HIGH_THINKING_SETTINGS
        }))

        expect(JSON.parse(transport.requests[0]?.body ?? '')).toEqual({
            model: 'deepseek-flash',
            tools: [],
            messages: [{
                role: 'assistant',
                content: null,
                reasoning_content: '先读取当前页面。',
                tool_calls: [{
                    id: 'call-snapshot',
                    type: 'function',
                    function: {
                        name: 'snapshot',
                        arguments: '{}'
                    }
                }]
            }, {
                role: 'tool',
                tool_call_id: 'call-snapshot',
                content: '当前页面为首页。'
            }],
            stream: true,
            stream_options: { include_usage: true },
            max_tokens: 65_536,
            reasoning_effort: 'high',
            thinking: { type: 'enabled' }
        })
    })

    it('在循环外按模型 ID 创建 LanguageModel 并映射请求', async () => {
        const transport = new RecordingTransport({
            status: 200,
            headers: { 'content-type': 'text/event-stream' },
            body: utf8Body([
                'data: {"choices":[{"delta":{},"finish_reason":"stop"}]}',
                '',
                'data: [DONE]',
                '',
                ''
            ].join('\n'))
        })
        let headerCalls = 0
        const provider = createOpenAICompatibleProvider({
            id: 'chat-fixture',
            baseUrl: 'https://example.test/v1/',
            apiKey: 'not-a-real-key',
            transport,
            headers: async () => {
                headerCalls += 1
                return {
                    authorization: 'Bearer short-lived-token',
                    'x-request-source': 'test'
                }
            }
        })
        const fastModel = provider.languageModel('deepseek-v4-flash')
        const preciseModel = provider.languageModel('deepseek-v4')
        const request: ModelRequest = {
            messages: [
                { role: MESSAGE_ROLE.SYSTEM, content: '你是助手。' },
                { role: MESSAGE_ROLE.USER, content: '查询天气' },
                {
                    role: MESSAGE_ROLE.ASSISTANT,
                    content: '',
                    toolCalls: [{
                        id: 'call-1',
                        name: 'get_weather',
                        input: { city: '杭州' }
                    }]
                },
                {
                    role: MESSAGE_ROLE.TOOL,
                    toolCallId: 'call-1',
                    toolName: 'get_weather',
                    content: '晴天'
                }
            ],
            tools: [{
                name: 'get_weather',
                description: '查询城市天气',
                inputSchema: {
                    type: 'object',
                    properties: { city: { type: 'string' } },
                    required: ['city']
                }
            }],
            temperature: 0.2,
            maxOutputTokens: 300,
            stopSequences: ['END'],
            reasoning: { type: 'effort', effort: 'high' },
            providerOptions: {
                top_p: 0.8,
                max_tokens: 128
            }
        }

        const events = await collectModelEvents(fastModel.stream(request))

        expect(provider.id).toBe('chat-fixture')
        expect(fastModel.provider).toBe('chat-fixture')
        expect(fastModel.modelId).toBe('deepseek-v4-flash')
        expect(preciseModel.provider).toBe('chat-fixture')
        expect(preciseModel.modelId).toBe('deepseek-v4')
        expect(headerCalls).toBe(1)
        expect(events).toEqual([{
            type: MODEL_EVENT_TYPE.FINISH,
            reason: 'stop',
            rawReason: 'stop'
        }])
        expect(transport.requests).toHaveLength(1)
        const captured = transport.requests[0]
        expect(captured?.url).toBe(
            'https://example.test/v1/chat/completions'
        )
        expect(captured?.headers).toEqual({
            'content-type': 'application/json',
            authorization: 'Bearer short-lived-token',
            'x-request-source': 'test'
        })
        expect(JSON.parse(captured?.body ?? '')).toEqual({
            model: 'deepseek-v4-flash',
            messages: [
                { role: 'system', content: '你是助手。' },
                { role: 'user', content: '查询天气' },
                {
                    role: 'assistant',
                    content: null,
                    tool_calls: [{
                        id: 'call-1',
                        type: 'function',
                        function: {
                            name: 'get_weather',
                            arguments: '{"city":"杭州"}'
                        }
                    }]
                },
                {
                    role: 'tool',
                    tool_call_id: 'call-1',
                    content: '晴天'
                }
            ],
            stream: true,
            stream_options: { include_usage: true },
            tools: [{
                type: 'function',
                function: {
                    name: 'get_weather',
                    description: '查询城市天气',
                    parameters: {
                        type: 'object',
                        properties: { city: { type: 'string' } },
                        required: ['city']
                    }
                }
            }],
            temperature: 0.2,
            max_tokens: 128,
            stop: ['END'],
            reasoning_effort: 'high',
            top_p: 0.8
        })
    })

    it('每次模型请求都重新计算动态认证请求头', async () => {
        const transport = new RecordingTransport(() => ({
            status: 200,
            headers: {},
            body: utf8Body(
                'data: {"choices":[{"delta":{},' +
                '"finish_reason":"stop"}]}\n\n' +
                'data: [DONE]\n\n'
            )
        }))
        let tokenVersion = 0
        const model = createOpenAICompatibleProvider({
            id: 'dynamic-token',
            baseUrl: 'https://example.test/v1',
            transport,
            headers: () => {
                tokenVersion += 1
                return { authorization: 'Bearer token-' + tokenVersion }
            }
        }).languageModel('test-model')
        const request: ModelRequest = { messages: [], tools: [] }

        await collectModelEvents(model.stream(request))
        await collectModelEvents(model.stream(request))

        expect(transport.requests.map(
            (captured) => captured.headers?.authorization
        )).toEqual(['Bearer token-1', 'Bearer token-2'])
    })

    it('逐字节解码中文与增补平面字符并解析 SSE 事件', async () => {
        const sse = [
            ': keep-alive\r\n',
            'data: {"choices":[{"delta":{"reasoning_content":"先思考"},\r\n',
            'data: "finish_reason":null}]}\r\n\r\n',
            'data: {"choices":[{"delta":{"content":"你好，世界😀"},\r\n',
            'data: "finish_reason":"stop"}]}\r\n\r\n',
            'data: [DONE]'
        ].join('')
        const model = createTestModel({
            status: 200,
            headers: {},
            body: bytewiseUtf8Body(sse)
        })

        const events = await collectModelEvents(model.stream({
            messages: [{ role: MESSAGE_ROLE.USER, content: '你好' }],
            tools: []
        }))

        expect(events).toEqual([
            {
                type: MODEL_EVENT_TYPE.REASONING_DELTA,
                delta: '先思考'
            },
            {
                type: MODEL_EVENT_TYPE.TEXT_DELTA,
                delta: '你好，世界😀'
            },
            {
                type: MODEL_EVENT_TYPE.FINISH,
                reason: 'stop',
                rawReason: 'stop'
            }
        ])
    })

    it('通过 TypedArray 迭代解码小程序 SSE 字节块', async () => {
        const model = createTestModel({
            status: 200,
            headers: {},
            body: iterableUtf8Body(
                'data: {"choices":[{"delta":{},"finish_reason":"stop"}]}\n\n' +
                'data: [DONE]\n\n'
            )
        })

        await expect(collectModelEvents(model.stream({
            messages: [],
            tools: []
        }))).resolves.toContainEqual({
            type: MODEL_EVENT_TYPE.FINISH,
            reason: 'stop',
            rawReason: 'stop'
        })
    })

    it('按 index 聚合交错到达的多个 Tool Call', async () => {
        const chunks = [
            {
                choices: [{
                    delta: {
                        tool_calls: [
                            {
                                index: 1,
                                id: 'call-search',
                                function: {
                                    name: 'se',
                                    arguments: '{"query":'
                                }
                            },
                            {
                                index: 0,
                                id: 'call-weather',
                                function: {
                                    name: 'get_',
                                    arguments: '{"city":"杭'
                                }
                            }
                        ]
                    },
                    finish_reason: null
                }]
            },
            {
                choices: [{
                    delta: {
                        tool_calls: [
                            {
                                index: 0,
                                function: {
                                    name: 'weather',
                                    arguments: '州"}'
                                }
                            },
                            {
                                index: 1,
                                function: {
                                    name: 'arch',
                                    arguments: '"agent"}'
                                }
                            }
                        ]
                    },
                    finish_reason: 'tool_calls'
                }]
            }
        ]
        const sse = chunks
            .map((chunk) => 'data: ' + JSON.stringify(chunk) + '\n\n')
            .join('') + 'data: [DONE]\n\n'
        const model = createTestModel({
            status: 200,
            headers: {},
            body: utf8Body(sse)
        })

        const events = await collectModelEvents(model.stream({
            messages: [],
            tools: []
        }))

        expect(events).toEqual([
            {
                type: MODEL_EVENT_TYPE.TOOL_CALL,
                call: {
                    id: 'call-weather',
                    name: 'get_weather',
                    input: { city: '杭州' }
                }
            },
            {
                type: MODEL_EVENT_TYPE.TOOL_CALL,
                call: {
                    id: 'call-search',
                    name: 'search',
                    input: { query: 'agent' }
                }
            },
            {
                type: MODEL_EVENT_TYPE.FINISH,
                reason: 'tool-calls',
                rawReason: 'tool_calls'
            }
        ])
    })

    it('消费 raw finish 之后的 usage-only chunk 并最后发布统一 finish', async () => {
        const sse = [
            {
                choices: [{
                    delta: { content: '完成' },
                    finish_reason: 'stop'
                }]
            },
            {
                choices: [],
                usage: {
                    prompt_tokens: 11,
                    completion_tokens: 7,
                    total_tokens: 18,
                    prompt_tokens_details: { cached_tokens: 3 },
                    completion_tokens_details: { reasoning_tokens: 2 }
                }
            }
        ].map((chunk) => 'data: ' + JSON.stringify(chunk) + '\n\n')
            .join('') + 'data: [DONE]\n\n'
        const model = createTestModel({
            status: 200,
            headers: {},
            body: utf8Body(sse)
        })

        const events = await collectModelEvents(model.stream({
            messages: [],
            tools: []
        }))

        expect(events).toEqual([
            { type: MODEL_EVENT_TYPE.TEXT_DELTA, delta: '完成' },
            {
                type: MODEL_EVENT_TYPE.USAGE,
                usage: {
                    inputTokens: 11,
                    outputTokens: 7,
                    totalTokens: 18,
                    cachedInputTokens: 3,
                    reasoningTokens: 2
                }
            },
            {
                type: MODEL_EVENT_TYPE.FINISH,
                reason: 'stop',
                rawReason: 'stop'
            }
        ])
        expect(events.at(-1)?.type).toBe(MODEL_EVENT_TYPE.FINISH)
    })

    it.each([
        ['stop', 'stop'],
        ['tool_calls', 'tool-calls'],
        ['length', 'length'],
        ['content_filter', 'content-filter'],
        ['provider_specific_reason', 'unknown']
    ] as const)(
        '将结束原因 %s 归一为 %s',
        async (rawReason, normalizedReason) => {
            const chunk = {
                choices: [{ delta: {}, finish_reason: rawReason }]
            }
            const model = createTestModel({
                status: 200,
                headers: {},
                body: utf8Body(
                    'data: ' + JSON.stringify(chunk) + '\n\n' +
                    'data: [DONE]\n\n'
                )
            })

            const events = await collectModelEvents(model.stream({
                messages: [],
                tools: []
            }))

            expect(events.at(-1)).toEqual({
                type: MODEL_EVENT_TYPE.FINISH,
                reason: normalizedReason,
                rawReason
            })
        }
    )

    it.each([
        [
            '非法 JSON',
            'data: {not-json}\n\n',
            'invalid JSON'
        ],
        [
            '不符合 Zod 结构的 chunk',
            'data: {"choices":"invalid"}\n\n',
            'invalid chunk'
        ],
        [
            '非法 Tool arguments',
            [
                'data: {"choices":[{"delta":{"tool_calls":[',
                '{"index":0,"id":"call-1","function":',
                '{"name":"search","arguments":"{bad-json}"}}]},',
                '"finish_reason":"tool_calls"}]}\n\n',
                'data: [DONE]\n\n'
            ].join(''),
            'invalid tool arguments'
        ],
        [
            '缺少 finish reason',
            'data: {"choices":[{"delta":{"content":"partial"}}]}\n\n' +
                'data: [DONE]\n\n',
            'without finish reason'
        ]
    ])('将%s归类为 Provider 协议错误', async (_label, sse, message) => {
        const model = createTestModel({
            status: 200,
            headers: {},
            body: utf8Body(sse)
        })

        await expect(collectModelEvents(model.stream({
            messages: [],
            tools: []
        }))).rejects.toMatchObject({
            code: AGENT_ERROR_CODE.PROVIDER_PROTOCOL_ERROR,
            phase: AGENT_ERROR_PHASE.PROVIDER,
            message: expect.stringContaining(message)
        })
    })

    it('区分传输在 [DONE] 前结束与协议终态缺失', async () => {
        const model = createTestModel({
            status: 200,
            headers: {},
            body: utf8Body('data: {"choices":[{"delta":{"content":"partial"}}]}\n\n')
        })

        await expect(collectModelEvents(model.stream({
            messages: [],
            tools: []
        }))).rejects.toMatchObject({
            code: AGENT_ERROR_CODE.PROVIDER_PROTOCOL_ERROR,
            phase: AGENT_ERROR_PHASE.PROVIDER,
            message: 'OpenAI-compatible provider stream ended before [DONE] and finish reason',
            details: {
                sseEventCount: 1,
                receivedDone: false,
                receivedFinishReason: false
            }
        })
    })

    it('将 2xx error payload 归类为模型调用失败', async () => {
        const model = createTestModel({
            status: 200,
            headers: {},
            body: utf8Body(
                'data: {"error":{"message":"quota exceeded",' +
                '"type":"rate_limit","code":"quota"}}\n\n'
            )
        })

        await expect(collectModelEvents(model.stream({
            messages: [],
            tools: []
        }))).rejects.toMatchObject({
            code: AGENT_ERROR_CODE.MODEL_FAILED,
            phase: AGENT_ERROR_PHASE.PROVIDER,
            message: 'quota exceeded',
            details: { type: 'rate_limit', code: 'quota' }
        })
    })

    it('将非 2xx 响应限长收集为可重试模型失败', async () => {
        const model = createTestModel({
            status: 503,
            headers: {},
            body: utf8Body('upstream unavailable')
        })

        await expect(collectModelEvents(model.stream({
            messages: [],
            tools: []
        }))).rejects.toMatchObject({
            code: AGENT_ERROR_CODE.MODEL_FAILED,
            phase: AGENT_ERROR_PHASE.PROVIDER,
            retryable: true,
            details: {
                status: 503,
                body: 'upstream unavailable'
            }
        })
    })

    it('将响应流中途失败归类为可重试模型失败', async () => {
        const networkFailure = new Error('socket reset')
        /** 产生一个合法事件后模拟网络断流。 */
        async function* failingBody(): AsyncGenerator<Uint8Array> {
            yield new TextEncoder().encode(
                'data: {"choices":[{"delta":{"content":"partial"}}]}\n\n'
            )
            throw networkFailure
        }
        const model = createTestModel({
            status: 200,
            headers: {},
            body: failingBody()
        })

        await expect(collectModelEvents(model.stream({
            messages: [],
            tools: []
        }))).rejects.toMatchObject({
            code: AGENT_ERROR_CODE.MODEL_FAILED,
            phase: AGENT_ERROR_PHASE.PROVIDER,
            retryable: true,
            cause: networkFailure
        })
    })

})
