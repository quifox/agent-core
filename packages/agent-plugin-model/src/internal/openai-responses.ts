import { AgentError, type AgentToolDefinition, type ToolCall } from '@quifox/agent-core'
import { MODEL_ERROR_CODE as AGENT_ERROR_CODE, MODEL_ERROR_PHASE as AGENT_ERROR_PHASE } from './errors.js'
import { MESSAGE_ROLE, MODEL_EVENT_TYPE, MODEL_FINISH_REASON, type AgentMessage, type ModelEvent, type ModelReasoning, type ModelRequest, type ModelUsage } from '@quifox/agent-core'
import type { LanguageModel } from './model.js'

import {
    FetchHttpTransport,
    type HttpStreamResponse,
    type HttpTransport
} from './http.js'
import type { HeaderSource } from './openai-compatible.js'
import type { LanguageModelProvider } from './provider.js'
import { findReservedProviderOption } from './provider-options.js'
import { parseSse } from './sse.js'
import { collectUtf8 } from './utf8.js'
import { parseToolArguments } from './tool-arguments.js'

/** OpenAI Responses Provider 的连接配置。 */
export interface OpenAIResponsesProviderOptions {
    /** 对外可见的 Provider 标识。 */
    readonly id: string
    /** Responses API 基础 URL。 */
    readonly baseUrl: string
    /** 可选 Bearer Token；长期密钥不得编译进客户端。 */
    readonly apiKey?: string
    /** Responses 路径，默认 `/responses`。 */
    readonly path?: string
    /** 宿主提供的 HTTP 字节流实现。 */
    readonly transport?: HttpTransport
    /** 固定或按请求动态计算的额外请求头。 */
    readonly headers?: HeaderSource

}

/** Responses 的具体请求；游标不进入 Agent Core 通用请求。 */
export interface ResponsesModelRequest extends ModelRequest {
    readonly previousResponseId?: string
}

/** 具体 Provider 完成事件保留响应引用，由会话插件消费。 */
export type ResponsesModelEvent = Exclude<ModelEvent, { type: 'finish' }>
    | (Extract<ModelEvent, { type: 'finish' }> & { responseId: string })

/** 可由会话插件包装的 Responses 编解码接口。 */
export interface ResponsesLanguageModel extends LanguageModel {
    /** @param request - 当前增量和私有续接引用。 */
    stream(request: ResponsesModelRequest): AsyncIterable<ResponsesModelEvent>
}

/** 创建具体 Responses 模型的 Provider。 */
export interface ResponsesProvider extends LanguageModelProvider {
    /** @param modelId - 模型标识。 */
    languageModel(modelId: string): ResponsesLanguageModel
}

/** Responses 请求的可复用网络形状。 */
export interface OpenAIResponsesRequestBody {
    readonly model: string
    readonly input: readonly (Record<string, unknown> & { type: string })[]
    readonly stream: boolean
    readonly tools: readonly (Record<string, unknown> & { type: string })[]
    readonly previous_response_id?: string
    readonly tool_choice?: 'auto' | 'none' | 'required'
    readonly [key: string]: unknown
}

/**
 * 投影完整 Responses 网络请求；宿主会话准备复用同一增量选择。
 * @param request - Responses request prepared by model and Session plugins.
 * @param modelId - 模型提示标识。
 * @returns 不含认证或取消信号的 JSON 请求。
 */
export function toResponsesRequest(request: ResponsesModelRequest, modelId: string): OpenAIResponsesRequestBody {
    const reservedOption = findReservedProviderOption(request.providerOptions)
    if (reservedOption !== undefined) { throw protocolError(`Provider option cannot override reserved field: ${reservedOption}`) }
    return {
        model: modelId,
        input: selectResponsesInputMessages(request).map(mapMessage),
        stream: true,
        ...(request.previousResponseId === undefined
            ? {}
            : { previous_response_id: request.previousResponseId }),
        tools: mapTools(request.tools),
        ...(request.toolChoice === undefined ? {} : { tool_choice: request.toolChoice }),
        ...(request.temperature === undefined ? {} : { temperature: request.temperature }),
        ...(request.maxOutputTokens === undefined ? {} : { max_output_tokens: request.maxOutputTokens }),
        ...(request.stopSequences === undefined ? {} : { stop: request.stopSequences }),
        ...mapReasoning(request.reasoning),
        ...request.providerOptions
    }
}


/** Responses Provider 中可用的内部输出项。 */
interface ResponseOutputItem {
    readonly type?: string
    readonly id?: string
    readonly call_id?: string
    readonly name?: string
    readonly arguments?: string
    readonly role?: string
    readonly content?: readonly ResponseContent[]
}

/** Responses message content 的最小形状。 */
interface ResponseContent {
    readonly type?: string
    readonly text?: string
}

/** Responses Provider 需要读取的完成事件形状。 */
interface ResponseCompletedEvent {
    readonly type?: string
    readonly response_id?: string
    readonly response?: {
        readonly id?: string
        readonly status?: string
        readonly output?: readonly ResponseOutputItem[]
        readonly usage?: ResponseUsage
    }
}

/** Responses usage 的兼容字段。 */
interface ResponseUsage {
    readonly input_tokens?: number
    readonly output_tokens?: number
    readonly total_tokens?: number
    readonly inputTokens?: number
    readonly outputTokens?: number
    readonly totalTokens?: number
}

/** Responses Provider 内部持有的已解析配置。 */
interface ResolvedResponsesOptions {
    readonly id: string
    readonly url: string
    readonly apiKey: string | undefined
    readonly transport: HttpTransport
    readonly headers: HeaderSource | undefined
}

/** 创建 Provider 阶段的协议错误。 */
function protocolError(message: string, cause?: unknown): AgentError {
    return new AgentError({
        code: AGENT_ERROR_CODE.PROVIDER_PROTOCOL_ERROR,
        phase: AGENT_ERROR_PHASE.PROVIDER,
        message,
        ...(cause === undefined ? {} : { cause })
    })
}

/**
 * 创建模型请求失败，配置与鉴权类 HTTP 错误不能消耗摘要候选重试。
 * @param message - 限长的公开诊断。
 * @param cause - 内部原因。
 * @param status - HTTP 状态；仅网络失败时省略。
 */
function modelFailure(message: string, cause?: unknown, status?: number): AgentError {
    return new AgentError({
        code: AGENT_ERROR_CODE.MODEL_FAILED,
        phase: AGENT_ERROR_PHASE.PROVIDER,
        message,
        retryable: status === undefined || status >= 500 || status === 429,
        ...(status === undefined ? {} : { details: { status } }),
        ...(cause === undefined ? {} : { cause })
    })
}

/** 将一个未知值安全视为 JSON object。 */
function asObject(value: unknown): Record<string, unknown> | undefined {
    return value !== null && typeof value === 'object' && !Array.isArray(value)
        ? value as Record<string, unknown>
        : undefined
}

/** 读取 JSON object 中的可选字符串字段。 */
function readString(value: unknown): string | undefined {
    return typeof value === 'string' ? value : undefined
}

/** 读取 Responses output message 中的文本。 */
function readOutputText(item: ResponseOutputItem): string {
    return (item.content ?? [])
        .filter((content) => content.type === 'output_text' || content.type === 'reasoning_text'
            || content.type === undefined)
        .map((content) => content.text ?? '')
        .join('')
}

/** Project a plugin-supplied message into a Responses input item. */
function mapMessage(message: AgentMessage): Record<string, unknown> & { type: string } {
    if (message.role === MESSAGE_ROLE.TOOL) {
        return {
            type: 'function_call_output',
            call_id: message.toolCallId,
            output: message.content
        }
    }

    const item: Record<string, unknown> & { type: string } = {
        type: 'message',
        role: message.role,
        content: [{
            type: message.role === MESSAGE_ROLE.ASSISTANT ? 'output_text' : 'input_text',
            text: message.content
        }]
    }
    if (message.role === MESSAGE_ROLE.ASSISTANT && message.toolCalls !== undefined) {
        item.tool_calls = message.toolCalls.map((call) => ({
            id: call.id,
            type: 'function',
            function: {
                name: call.name,
                arguments: JSON.stringify(call.input)
            }
        }))
    }
    return item
}

/** 只选择游标之后的新输入，不重放服务端历史。 @param request - 具体 Responses 请求。 */
export function selectResponsesInputMessages(request: ResponsesModelRequest): readonly AgentMessage[] {
    if (request.previousResponseId === undefined) {
        return request.messages
    }

    let lastAssistant = -1
    for (let index = request.messages.length - 1; index >= 0; index -= 1) {
        if (request.messages[index]?.role === MESSAGE_ROLE.ASSISTANT) {
            lastAssistant = index
            break
        }
    }
    const incremental = lastAssistant >= 0
        ? request.messages.slice(lastAssistant + 1)
        : request.messages.filter((message) => message.role !== MESSAGE_ROLE.SYSTEM)
    return incremental
}

/** 读取并转换 Responses usage。 */
function mapUsage(usage: ResponseUsage | undefined): ModelUsage {
    if (usage === undefined) {
        return {}
    }
    const inputTokens = usage.input_tokens ?? usage.inputTokens
    const outputTokens = usage.output_tokens ?? usage.outputTokens
    const totalTokens = usage.total_tokens ?? usage.totalTokens
    return {
        ...(inputTokens === undefined ? {} : { inputTokens }),
        ...(outputTokens === undefined ? {} : { outputTokens }),
        ...(totalTokens === undefined ? {} : { totalTokens })
    }
}

/** 将 Responses output function_call 转换为 Core ToolCall。 */
function mapToolCall(item: ResponseOutputItem): ToolCall | undefined {
    if (item.type !== 'function_call') { return undefined }
    if (!item.name?.trim()) { throw protocolError('Responses function_call is missing name') }
    let input: unknown = {}
    if (item.arguments !== undefined && item.arguments.length > 0) {
        try {
            input = parseToolArguments(item.arguments)
        } catch (cause) {
            throw protocolError('Responses function_call arguments are not valid JSON', cause)
        }
    }
    if (!item.call_id?.trim()) {
        throw protocolError('Responses function_call is missing call_id')
    }
    return {
        id: item.call_id,
        name: item.name,
        input
    }
}

/** 把 Responses output item 解析为文本、ToolCall 和推理文本。 */
function readCompletedOutput(output: readonly ResponseOutputItem[] | undefined): {
    text: string
    reasoning: string
    toolCalls: readonly ToolCall[]
} {
    const text: string[] = []
    const reasoning: string[] = []
    const toolCalls: ToolCall[] = []
    const callIds = new Set<string>()
    for (const item of output ?? []) {
        if (item.type === 'message') {
            text.push(readOutputText(item))
        } else if (item.type === 'reasoning') {
            reasoning.push(readOutputText(item))
        } else {
            const call = mapToolCall(item)
            if (call !== undefined) {
                if (callIds.has(call.id)) {
                    throw protocolError(`Responses function_call has duplicate call_id: ${call.id}`)
                }
                callIds.add(call.id)
                toolCalls.push(call)
            }
        }
    }
    return { text: text.join(''), reasoning: reasoning.join(''), toolCalls }
}

/** 生成 Responses 请求中稳定的 Tool 定义。 */
function mapTools(tools: readonly AgentToolDefinition[]): readonly (Record<string, unknown> & { type: string })[] {
    return tools.map((tool) => ({
        type: 'function',
        name: tool.name,
        description: tool.description,
        parameters: tool.inputSchema,
        strict: false
    }))
}

/** 将 Core 推理设置映射为 Responses 的标准 reasoning 字段。 */
function mapReasoning(reasoning: ModelReasoning | undefined): Readonly<Record<string, unknown>> {
    if (reasoning === undefined) {
        return {}
    }
    if (reasoning.type === 'effort') {
        return { reasoning: { effort: reasoning.effort } }
    }
    if (reasoning.type === 'budget') {
        return { reasoning: { max_tokens: reasoning.budgetTokens } }
    }
    if (reasoning.type === 'toggle') {
        return { reasoning: { enabled: reasoning.enabled } }
    }
    return reasoning.value !== null && typeof reasoning.value === 'object'
        ? { reasoning: reasoning.value }
        : {}
}

/** 将基础地址与 Responses 路径组合为完整 URL。 */
function resolveUrl(baseUrl: string, path: string | undefined): string {
    const normalizedBase = baseUrl.replace(/\/+$/u, '')
    const normalizedPath = path ?? '/responses'
    return normalizedPath.startsWith('/')
        ? normalizedBase + normalizedPath
        : normalizedBase + '/' + normalizedPath
}

/** 读取 HTTP 非成功响应并转换为不泄露正文的模型错误。 */
async function ensureSuccess(response: HttpStreamResponse): Promise<void> {
    if (response.status >= 200 && response.status < 300) {
        return
    }
    await collectUtf8(response.body, 512)
    throw modelFailure(`Responses request failed with HTTP ${String(response.status)}`, undefined, response.status)
}

/** 从 Responses SSE 生成 Core ModelEvent。 */
async function* parseResponseEvents(
    body: AsyncIterable<Uint8Array>
): AsyncGenerator<ResponsesModelEvent> {
    let responseId: string | undefined
    let completed: ResponseCompletedEvent | undefined
    let receivedDone = false

    for await (const event of parseSse(body)) {
        if (event.data === '[DONE]') {
            receivedDone = true
            break
        }
        let parsed: unknown
        try {
            parsed = JSON.parse(event.data)
        } catch (cause) {
            throw protocolError('Responses event is not valid JSON', cause)
        }
        const object = asObject(parsed)
        if (object === undefined) {
            throw protocolError('Responses event must be a JSON object')
        }
        const type = readString(object.type)
        if (type === 'response.created') {
            const response = asObject(object.response)
            responseId = readString(object.response_id) ?? readString(response?.id)
        } else if (type === 'response.output_text.delta') {
            const delta = readString(object.delta)
            if (delta !== undefined && delta.length > 0) {
                yield { type: MODEL_EVENT_TYPE.TEXT_DELTA, delta }
            }
        } else if (type === 'response.reasoning_text.delta' || type === 'response.reasoning.delta') {
            const delta = readString(object.delta)
            if (delta !== undefined && delta.length > 0) {
                yield { type: MODEL_EVENT_TYPE.REASONING_DELTA, delta }
            }
        } else if (type === 'response.completed') {
            const completedResponse = asObject(object.response) as ResponseCompletedEvent['response']
            const completedResponseId = readString(object.response_id)
            completed = {
                type,
                ...(completedResponseId === undefined
                    ? {}
                    : { response_id: completedResponseId }),
                ...(completedResponse === undefined
                    ? {}
                    : { response: completedResponse })
            }
            responseId = completedResponseId ?? completedResponse?.id ?? responseId
        }
    }

    if (!completed?.response) {
        throw protocolError(receivedDone
            ? 'Responses stream ended without response.completed'
            : 'Responses stream ended before response.completed')
    }
    if (responseId === undefined || responseId.trim() === '') {
        throw protocolError('Responses completed event is missing response.id')
    }
    const completedResponse = completed.response
    const status = completedResponse.status
    if (status !== 'completed' && status !== 'failed' &&
        status !== 'cancelled' && status !== 'incomplete') {
        throw protocolError(`Responses completed event has an invalid status: ${String(status)}`)
    }
    // 未完成终态不能因参数容错变成可执行 ToolCall。
    const output = status === 'completed'
        ? readCompletedOutput(completedResponse.output)
        : { toolCalls: [] }
    for (const call of output.toolCalls) {
        yield { type: MODEL_EVENT_TYPE.TOOL_CALL, call }
    }
    const usage = mapUsage(completedResponse.usage)
    if (Object.keys(usage).length > 0) {
        yield { type: MODEL_EVENT_TYPE.USAGE, usage }
    }
    const reason = status === 'failed'
        ? MODEL_FINISH_REASON.ERROR
        : status === 'cancelled'
            ? MODEL_FINISH_REASON.CANCELLED
            : output.toolCalls.length > 0
                ? MODEL_FINISH_REASON.TOOL_CALLS
                : status === 'incomplete'
                    ? MODEL_FINISH_REASON.LENGTH
                    : MODEL_FINISH_REASON.STOP
    yield {
        type: MODEL_EVENT_TYPE.FINISH,
        reason,
        responseId
    }
}

/** OpenAI Responses API 的统一 LanguageModel。 */
class OpenAIResponsesLanguageModel implements ResponsesLanguageModel {
    readonly provider: string
    readonly modelId: string
    /** Responses Provider 只保留当前输入和服务端返回的 Response ID。 */
    private readonly options: ResolvedResponsesOptions

    /** 创建绑定到一个模型 ID 的 Responses 模型。 */
    constructor(modelId: string, options: ResolvedResponsesOptions) {
        this.provider = options.id
        this.modelId = modelId
        this.options = options
    }

    /** 发起一次只携带当前输入和上一次 Response 游标的模型请求。 */
    stream(request: ResponsesModelRequest): AsyncIterable<ResponsesModelEvent> {
        return this.streamRaw(request)
    }

    /** 发送 Responses 请求并归一化 SSE。 */
    private async *streamRaw(request: ResponsesModelRequest): AsyncGenerator<ResponsesModelEvent> {
        const reservedOption = findReservedProviderOption(request.providerOptions)
        if (reservedOption !== undefined) {
            throw protocolError(`Provider option cannot override reserved field: ${reservedOption}`)
        }
        const extraHeaders = this.options.headers === undefined
            ? {}
            : typeof this.options.headers === 'function'
                ? await this.options.headers(request)
                : this.options.headers
        const body = toResponsesRequest(request, this.modelId)
        let response: HttpStreamResponse
        try {
            response = await this.options.transport.stream({
                url: this.options.url,
                method: 'POST',
                headers: {
                    'content-type': 'application/json',
                    ...(this.options.apiKey === undefined
                        ? {}
                        : { authorization: 'Bearer ' + this.options.apiKey }),
                    ...extraHeaders
                },
                body: JSON.stringify(body),
                ...(request.signal === undefined ? {} : { signal: request.signal })
            })
        } catch (cause) {
            if (request.signal?.aborted) {
                throw request.signal.reason ?? cause
            }
            throw modelFailure('Responses request could not be sent', cause)
        }

        await ensureSuccess(response)
        try {
            for await (const event of parseResponseEvents(response.body)) {
                yield event
            }
        } catch (cause) {
            if (request.signal?.aborted) {
                throw request.signal.reason ?? cause
            }
            if (cause instanceof AgentError) {
                throw cause
            }
            throw modelFailure('Responses stream failed', cause)
        }
    }
}

/** 持有共享 endpoint、认证与 Transport 的 Responses Provider。 */
class OpenAIResponsesProvider implements ResponsesProvider {
    readonly id: string
    private readonly options: ResolvedResponsesOptions

    /** 创建 Responses Provider。 */
    constructor(options: ResolvedResponsesOptions) {
        this.id = options.id
        this.options = options
    }

    /** 使用共享配置创建一个 Responses LanguageModel。 */
    languageModel(modelId: string): ResponsesLanguageModel {
        if (modelId.trim().length === 0) {
            throw new TypeError('modelId must not be empty')
        }
        return new OpenAIResponsesLanguageModel(modelId, this.options)
    }
}

/** 创建 OpenAI Responses-compatible Provider。 */
export function createOpenAIResponsesProvider(
    options: OpenAIResponsesProviderOptions
): ResponsesProvider {
    if (options.id.trim().length === 0) {
        throw new TypeError('provider id must not be empty')
    }
    if (options.baseUrl.trim().length === 0) {
        throw new TypeError('baseUrl must not be empty')
    }
    return new OpenAIResponsesProvider({
        id: options.id,
        url: resolveUrl(options.baseUrl, options.path),
        apiKey: options.apiKey,
        transport: options.transport ?? new FetchHttpTransport(),
        headers: options.headers
    })
}
