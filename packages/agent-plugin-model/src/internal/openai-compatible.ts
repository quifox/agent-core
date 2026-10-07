import { AgentError, type ToolCall } from '@quifox/agent-core'
import { MODEL_ERROR_CODE as AGENT_ERROR_CODE, MODEL_ERROR_PHASE as AGENT_ERROR_PHASE } from './errors.js'
import { MESSAGE_ROLE, type AgentMessage, type ModelEvent, type ModelFinishReason, type ModelReasoning, type ModelRequest, type ModelUsage } from '@quifox/agent-core'
import type { LanguageModel } from './model.js'
import {
    FetchHttpTransport,
    type HttpStreamResponse,
    type HttpTransport
} from './http.js'
import type { LanguageModelProvider } from './provider.js'
import { findReservedProviderOption } from './provider-options.js'
import { parseSse } from './sse.js'
import { collectUtf8 } from './utf8.js'
import { parseToolArguments } from './tool-arguments.js'

/**
 * 根据当前模型请求计算额外 HTTP 请求头。
 *
 * @param request - 即将发送给 Provider 的统一模型请求。
 * @returns 固定或异步取得的字符串请求头。
 */
export type HeaderResolver = (
    request: ModelRequest
) => Readonly<Record<string, string>> |
    Promise<Readonly<Record<string, string>>>

/** Provider 使用的固定或按次计算请求头。 */
export type HeaderSource =
    | Readonly<Record<string, string>>
    | HeaderResolver

/** 后续 Tool 回合中回传 Assistant 推理内容的供应商字段。 */
export type AssistantReasoningField = 'reasoning_content' | 'reasoning'

/** OpenAI Chat Completions compatible Provider 的共享配置。 */
export interface OpenAICompatibleProviderOptions {
    /** Caller-defined connection identifier. */
    readonly id: string
    /** API 基础地址，例如 https://example.com/v1。 */
    readonly baseUrl: string
    /** 可选 Bearer Token；长期密钥不得编译进客户端。 */
    readonly apiKey?: string
    /** Chat Completions 路径，默认 /chat/completions。 */
    readonly path?: string
    /** 宿主提供的 HTTP 字节流实现。 */
    readonly transport?: HttpTransport
    /** 固定或按请求动态计算的额外请求头。 */
    readonly headers?: HeaderSource
    /** 是否请求 usage-only 流事件；默认开启。 */
    readonly includeUsage?: boolean
    /** 需要在后续 Tool 回合回传推理内容时使用的 Assistant 字段。 */
    readonly assistantReasoningField?: AssistantReasoningField
}

interface ResolvedProviderOptions {
    readonly id: string
    readonly url: string
    readonly apiKey: string | undefined
    readonly transport: HttpTransport
    readonly headers: HeaderSource | undefined
    readonly includeUsage: boolean
    readonly assistantReasoningField: AssistantReasoningField | undefined
}

interface PendingToolCall {
    id: string
    name: string
    arguments: string
}

/**
 * Provider 输出的稳定模型事件字符串。
 *
 * 此处不读取 Core 的运行时常量对象：Provider 在小程序 bundle 中独立编译，
 * 直接遵守公开字符串契约可以避免跨包导出初始化时机影响流式事件。
 */
const PROVIDER_MODEL_EVENT_TYPE = {
    TEXT_DELTA: 'text-delta',
    REASONING_DELTA: 'reasoning-delta',
    TOOL_CALL: 'tool-call',
    USAGE: 'usage',
    FINISH: 'finish'
} as const

/** Provider 输出的稳定模型结束原因字符串。 */
const PROVIDER_MODEL_FINISH_REASON = {
    STOP: 'stop',
    TOOL_CALLS: 'tool-calls',
    LENGTH: 'length',
    CONTENT_FILTER: 'content-filter',
    CANCELLED: 'cancelled',
    ERROR: 'error',
    UNKNOWN: 'unknown'
} as const

/** OpenAI-compatible SSE chunk 的宽松、平台无关形状。 */
interface ProviderChunk {
    readonly choices?: readonly ProviderChoice[] | undefined
    readonly usage?: ProviderUsage | null | undefined
    readonly error?: ProviderError | undefined
}

/** Provider 单个候选输出的已校验字段。 */
interface ProviderChoice {
    readonly delta?: ProviderDelta | null | undefined
    readonly finish_reason?: string | null | undefined
}

/** Provider 增量文本与 Tool Call 的已校验字段。 */
interface ProviderDelta {
    readonly content?: string | null | undefined
    readonly reasoning_content?: string | null | undefined
    readonly reasoning?: string | null | undefined
    readonly tool_calls?: readonly ProviderToolCallDelta[] | null | undefined
}

/** Provider Tool Call 增量的已校验字段。 */
interface ProviderToolCallDelta {
    readonly index?: number | undefined
    readonly id?: string | null | undefined
    readonly function?: ProviderToolFunction | null | undefined
}

/** Provider Tool Call 函数描述的已校验字段。 */
interface ProviderToolFunction {
    readonly name?: string | null | undefined
    readonly arguments?: string | null | undefined
}

/** Provider 返回的模型用量字段。 */
interface ProviderUsage {
    readonly prompt_tokens?: number | undefined
    readonly completion_tokens?: number | undefined
    readonly total_tokens?: number | undefined
    readonly prompt_tokens_details?: ProviderTokenDetails | null | undefined
    readonly completion_tokens_details?: ProviderTokenDetails | null | undefined
}

/** Provider 返回的细粒度 token 用量字段。 */
interface ProviderTokenDetails {
    readonly cached_tokens?: number | undefined
    readonly reasoning_tokens?: number | undefined
}

/** Provider 错误事件的已校验字段。 */
interface ProviderError {
    readonly message?: string | undefined
    readonly type?: string | undefined
    readonly code?: unknown
}

/**
 * Project a Session-owned message into Chat Completions format.
 *
 * @param message - Message supplied by the cooperating Session plugin.
 * @param assistantReasoningField - Optional vendor reasoning field.
 * @returns A protocol message without lifecycle control fields.
 */
function mapMessage(
    message: AgentMessage,
    assistantReasoningField: AssistantReasoningField | undefined
): Record<string, unknown> {
    if (
        message.role === MESSAGE_ROLE.SYSTEM ||
        message.role === MESSAGE_ROLE.USER
    ) {
        return { role: message.role, content: message.content }
    }
    if (message.role === MESSAGE_ROLE.TOOL) {
        return {
            role: 'tool',
            tool_call_id: message.toolCallId,
            content: message.content
        }
    }
    return {
        role: 'assistant',
        content: message.content.length === 0 ? null : message.content,
        ...(message.reasoning === undefined || assistantReasoningField === undefined
            ? {}
            : { [assistantReasoningField]: message.reasoning }),
        ...(message.toolCalls === undefined
            ? {}
            : {
                tool_calls: message.toolCalls.map((call) => ({
                    id: call.id,
                    type: 'function',
                    function: {
                        name: call.name,
                        arguments: JSON.stringify(call.input)
                    }
                }))
            })
    }
}

/**
 * 将统一推理配置映射为兼容协议字段。
 *
 * @param reasoning - Core 提供的 Provider 无关推理配置。
 * @returns 可合并进请求体的兼容字段。
 */
function mapReasoning(
    reasoning: ModelReasoning | undefined
): Readonly<Record<string, unknown>> {
    if (reasoning === undefined) {
        return {}
    }
    if (reasoning.type === 'effort') {
        return { reasoning_effort: reasoning.effort }
    }
    if (reasoning.type === 'budget') {
        return { reasoning: { max_tokens: reasoning.budgetTokens } }
    }
    if (reasoning.type === 'toggle') {
        return { reasoning: { enabled: reasoning.enabled } }
    }
    return { reasoning: reasoning.value }
}

/**
 * 将供应商结束原因归一为 Core 稳定枚举。
 *
 * @param reason - OpenAI-compatible 原始结束原因。
 * @returns Agent Core 支持的结束原因。
 */
function mapFinishReason(reason: string): ModelFinishReason {
    if (reason === 'stop') {
        return PROVIDER_MODEL_FINISH_REASON.STOP
    }
    if (reason === 'tool_calls' || reason === 'function_call') {
        return PROVIDER_MODEL_FINISH_REASON.TOOL_CALLS
    }
    if (reason === 'length') {
        return PROVIDER_MODEL_FINISH_REASON.LENGTH
    }
    if (reason === 'content_filter') {
        return PROVIDER_MODEL_FINISH_REASON.CONTENT_FILTER
    }
    if (reason === 'cancelled' || reason === 'canceled') {
        return PROVIDER_MODEL_FINISH_REASON.CANCELLED
    }
    if (reason === 'error') {
        return PROVIDER_MODEL_FINISH_REASON.ERROR
    }
    return PROVIDER_MODEL_FINISH_REASON.UNKNOWN
}

/**
 * 将协议 usage 映射为 Core 用量字段。
 *
 * @param usage - 已通过 Zod 校验的供应商 usage。
 * @returns 只包含供应商实际提供数值的统一用量。
 */
function mapUsage(usage: NonNullable<ProviderChunk['usage']>): ModelUsage {
    const mapped: ModelUsage = {}
    if (usage.prompt_tokens !== undefined) {
        mapped.inputTokens = usage.prompt_tokens
    }
    if (usage.completion_tokens !== undefined) {
        mapped.outputTokens = usage.completion_tokens
    }
    if (usage.total_tokens !== undefined) {
        mapped.totalTokens = usage.total_tokens
    }
    if (usage.prompt_tokens_details?.cached_tokens !== undefined) {
        mapped.cachedInputTokens =
            usage.prompt_tokens_details.cached_tokens
    }
    if (usage.completion_tokens_details?.reasoning_tokens !== undefined) {
        mapped.reasoningTokens =
            usage.completion_tokens_details.reasoning_tokens
    }
    return mapped
}

/**
 * 创建 Provider 协议错误。
 *
 * @param message - 稳定、无敏感请求信息的错误描述。
 * @param cause - 可选原始异常。
 * @param details - 可选限长诊断详情。
 * @returns Provider 阶段的协议异常。
 */
function protocolError(
    message: string,
    cause?: unknown,
    details?: Readonly<Record<string, unknown>>
): AgentError {
    return new AgentError({
        code: AGENT_ERROR_CODE.PROVIDER_PROTOCOL_ERROR,
        phase: AGENT_ERROR_PHASE.PROVIDER,
        message,
        ...(cause === undefined ? {} : { cause }),
        ...(details === undefined ? {} : { details })
    })
}

/**
 * 创建 Provider 调用失败错误。
 *
 * @param message - 稳定、无认证信息的失败描述。
 * @param options - 可选原因、重试属性与限长详情。
 * @returns Provider 阶段的模型调用异常。
 */
function modelFailure(
    message: string,
    options: {
        readonly cause?: unknown
        readonly retryable?: boolean
        readonly details?: Readonly<Record<string, unknown>>
    } = {}
): AgentError {
    return new AgentError({
        code: AGENT_ERROR_CODE.MODEL_FAILED,
        phase: AGENT_ERROR_PHASE.PROVIDER,
        message,
        ...(options.cause === undefined ? {} : { cause: options.cause }),
        ...(options.retryable === undefined
            ? {}
            : { retryable: options.retryable }),
        ...(options.details === undefined
            ? {}
            : { details: options.details })
    })
}

/**
 * 判断未知值是否为可读取字段的普通协议对象。
 *
 * @param value - 待检查的未知值。
 * @returns 是否为非数组对象。
 */
function isRecord(value: unknown): value is Record<string, unknown> {
    return typeof value === 'object' && value !== null && !Array.isArray(value)
}

/**
 * 读取可选的字符串或 null 协议字段。
 *
 * @param record - 当前协议对象。
 * @param field - 待读取的字段名。
 * @returns 未出现、字符串或 null。
 * @throws 当字段不是允许的协议类型时抛出 Provider 协议错误。
 */
function readOptionalNullableString(
    record: Record<string, unknown>,
    field: string
): string | null | undefined {
    const value = record[field]
    if (value === undefined || value === null || typeof value === 'string') {
        return value
    }
    throw protocolError('OpenAI-compatible provider returned an invalid chunk')
}

/**
 * 读取不可为 null 的可选字符串协议字段。
 *
 * @param record - 当前协议对象。
 * @param field - 待读取的字段名。
 * @returns 未出现或字符串。
 * @throws 当字段为 null 或其他类型时抛出 Provider 协议错误。
 */
function readOptionalString(
    record: Record<string, unknown>,
    field: string
): string | undefined {
    const value = record[field]
    if (value === undefined || typeof value === 'string') {
        return value
    }
    throw protocolError('OpenAI-compatible provider returned an invalid chunk')
}

/**
 * 读取可选的有限数值协议字段。
 *
 * @param record - 当前协议对象。
 * @param field - 待读取的字段名。
 * @returns 未出现或有限数值。
 * @throws 当字段不是有限数值时抛出 Provider 协议错误。
 */
function readOptionalFiniteNumber(
    record: Record<string, unknown>,
    field: string
): number | undefined {
    const value = record[field]
    if (value === undefined) {
        return undefined
    }
    if (typeof value === 'number' && Number.isFinite(value)) {
        return value
    }
    throw protocolError('OpenAI-compatible provider returned an invalid chunk')
}

/**
 * 读取可选的对象或 null 协议字段。
 *
 * @param record - 当前协议对象。
 * @param field - 待读取的字段名。
 * @returns 未出现、对象或 null。
 * @throws 当字段不是对象或 null 时抛出 Provider 协议错误。
 */
function readOptionalNullableRecord(
    record: Record<string, unknown>,
    field: string
): Record<string, unknown> | null | undefined {
    const value = record[field]
    if (value === undefined || value === null) {
        return value
    }
    if (isRecord(value)) {
        return value
    }
    throw protocolError('OpenAI-compatible provider returned an invalid chunk')
}

/**
 * 将 token 细节对象收敛为 Provider 使用的有限数值字段。
 *
 * @param value - 已验证为对象或 null 的协议字段。
 * @returns token 细节，或 null。
 */
function parseTokenDetails(
    value: Record<string, unknown> | null
): ProviderTokenDetails | null {
    if (value === null) {
        return null
    }
    return {
        ...(readOptionalFiniteNumber(value, 'cached_tokens') === undefined
            ? {}
            : { cached_tokens: readOptionalFiniteNumber(value, 'cached_tokens') }),
        ...(readOptionalFiniteNumber(value, 'reasoning_tokens') === undefined
            ? {}
            : { reasoning_tokens: readOptionalFiniteNumber(value, 'reasoning_tokens') })
    }
}

/**
 * 将 Tool Call 函数对象收敛为协议允许的字段。
 *
 * @param value - 已验证为对象或 null 的函数字段。
 * @returns 函数描述，或 null。
 */
function parseToolFunction(
    value: Record<string, unknown> | null
): ProviderToolFunction | null {
    if (value === null) {
        return null
    }
    const name = readOptionalNullableString(value, 'name')
    const argumentsText = readOptionalNullableString(value, 'arguments')
    return {
        ...(name === undefined ? {} : { name }),
        ...(argumentsText === undefined ? {} : { arguments: argumentsText })
    }
}

/**
 * 将 Provider SSE 数据解析为跨运行时的协议字段。
 *
 * 小程序 AppService 已验证 Zod 4.4.3 在此深层宽松 schema 上会抛出内部
 * TypeError；该网络边界改用等价的原生检查，Tool 的 Zod schema 不受影响。
 *
 * @param data - SSE data 字段。
 * @returns 已通过协议字段校验的 Provider chunk。
 */
function parseChunk(data: string): ProviderChunk {
    let parsed: unknown
    try {
        parsed = JSON.parse(data)
    } catch (cause) {
        throw protocolError('OpenAI-compatible provider returned invalid JSON', cause)
    }
    if (!isRecord(parsed)) {
        throw protocolError('OpenAI-compatible provider returned an invalid chunk')
    }

    const rawChoices = parsed.choices
    const choices = rawChoices === undefined
        ? undefined
        : Array.isArray(rawChoices)
            ? rawChoices.map((choice) => {
                if (!isRecord(choice)) {
                    throw protocolError('OpenAI-compatible provider returned an invalid chunk')
                }
                const rawDelta = readOptionalNullableRecord(choice, 'delta')
                const finishReason = readOptionalNullableString(choice, 'finish_reason')
                const rawToolCalls = rawDelta?.tool_calls
                if (rawToolCalls !== undefined && rawToolCalls !== null && !Array.isArray(rawToolCalls)) {
                    throw protocolError('OpenAI-compatible provider returned an invalid chunk')
                }
                const toolCalls = rawToolCalls === undefined || rawToolCalls === null
                    ? rawToolCalls
                    : rawToolCalls.map((toolCall) => {
                        if (!isRecord(toolCall)) {
                            throw protocolError('OpenAI-compatible provider returned an invalid chunk')
                        }
                        const index = readOptionalFiniteNumber(toolCall, 'index')
                        if (index !== undefined && (!Number.isInteger(index) || index < 0)) {
                            throw protocolError('OpenAI-compatible provider returned an invalid chunk')
                        }
                        const id = readOptionalNullableString(toolCall, 'id')
                        const functionValue = parseToolFunction(
                            readOptionalNullableRecord(toolCall, 'function') ?? null
                        )
                        return {
                            ...(index === undefined ? {} : { index }),
                            ...(id === undefined ? {} : { id }),
                            ...(toolCall.function === undefined ? {} : { function: functionValue })
                        }
                    })
                const delta = rawDelta === undefined
                    ? undefined
                    : rawDelta === null
                        ? null
                        : {
                            ...(readOptionalNullableString(rawDelta, 'content') === undefined
                                ? {}
                                : { content: readOptionalNullableString(rawDelta, 'content') }),
                            ...(readOptionalNullableString(rawDelta, 'reasoning_content') === undefined
                                ? {}
                                : { reasoning_content: readOptionalNullableString(rawDelta, 'reasoning_content') }),
                            ...(readOptionalNullableString(rawDelta, 'reasoning') === undefined
                                ? {}
                                : { reasoning: readOptionalNullableString(rawDelta, 'reasoning') }),
                            ...(toolCalls === undefined ? {} : { tool_calls: toolCalls })
                        }
                return {
                    ...(delta === undefined ? {} : { delta }),
                    ...(finishReason === undefined ? {} : { finish_reason: finishReason })
                }
            })
            : (() => { throw protocolError('OpenAI-compatible provider returned an invalid chunk') })()

    const rawUsage = readOptionalNullableRecord(parsed, 'usage')
    const usage = rawUsage === undefined
        ? undefined
        : rawUsage === null
            ? null
            : {
                ...(readOptionalFiniteNumber(rawUsage, 'prompt_tokens') === undefined ? {} : { prompt_tokens: readOptionalFiniteNumber(rawUsage, 'prompt_tokens') }),
                ...(readOptionalFiniteNumber(rawUsage, 'completion_tokens') === undefined ? {} : { completion_tokens: readOptionalFiniteNumber(rawUsage, 'completion_tokens') }),
                ...(readOptionalFiniteNumber(rawUsage, 'total_tokens') === undefined ? {} : { total_tokens: readOptionalFiniteNumber(rawUsage, 'total_tokens') }),
                ...(rawUsage.prompt_tokens_details === undefined ? {} : { prompt_tokens_details: parseTokenDetails(readOptionalNullableRecord(rawUsage, 'prompt_tokens_details') ?? null) }),
                ...(rawUsage.completion_tokens_details === undefined ? {} : { completion_tokens_details: parseTokenDetails(readOptionalNullableRecord(rawUsage, 'completion_tokens_details') ?? null) })
            }

    const rawError = parsed.error
    if (rawError !== undefined && !isRecord(rawError)) {
        throw protocolError('OpenAI-compatible provider returned an invalid chunk')
    }
    const error = rawError === undefined
        ? undefined
        : {
            ...(readOptionalString(rawError, 'message') === undefined ? {} : { message: readOptionalString(rawError, 'message') }),
            ...(readOptionalString(rawError, 'type') === undefined ? {} : { type: readOptionalString(rawError, 'type') }),
            ...(rawError.code === undefined ? {} : { code: rawError.code })
        }
    return {
        ...(choices === undefined ? {} : { choices }),
        ...(usage === undefined ? {} : { usage }),
        ...(error === undefined ? {} : { error })
    }
}

/**
 * 将已拼接的 Tool Call 参数解析为 Core ToolCall。
 *
 * @param pending - 按 index 聚合后的 Tool Call。
 * @returns 可交给 Agent Core 的结构化 ToolCall。
 */
function parseToolCall(pending: PendingToolCall): ToolCall {
    if (pending.id.length === 0 || pending.name.length === 0) {
        throw protocolError(
            'OpenAI-compatible provider returned an incomplete tool call'
        )
    }

    try {
        return {
            id: pending.id,
            name: pending.name,
            input: parseToolArguments(pending.arguments)
        }
    } catch (cause) {
        throw protocolError(
            'OpenAI-compatible provider returned invalid tool arguments for ' +
                pending.name,
            cause
        )
    }
}

/**
 * 按 Tool Call index 产生稳定顺序的统一事件。
 *
 * @param pending - 尚未发布的 Tool Call 聚合表。
 * @returns 按 index 排序的 Tool Call 事件。
 */
function flushToolCalls(
    pending: ReadonlyMap<number, PendingToolCall>
): readonly ModelEvent[] {
    return [...pending.entries()].sort(
        ([left], [right]) => left - right
    ).map(([, call]) => (
        {
            type: PROVIDER_MODEL_EVENT_TYPE.TOOL_CALL,
            call: parseToolCall(call)
        }
    ))
}

/**
 * 合并单个 Tool Call delta。
 *
 * @param pending - 当前请求的 Tool Call 聚合表。
 * @param delta - 已校验的 OpenAI-compatible Tool Call delta。
 */
function mergeToolCallDelta(
    pending: Map<number, PendingToolCall>,
    delta: ProviderToolCallDelta
): void {
    const index = delta.index ?? 0
    const current = pending.get(index) ?? {
        id: '',
        name: '',
        arguments: ''
    }
    if (delta.id) {
        current.id = delta.id
    }
    if (delta.function?.name) {
        current.name += delta.function.name
    }
    if (delta.function?.arguments) {
        current.arguments += delta.function.arguments
    }
    pending.set(index, current)
}

/**
 * 计算当前模型调用的额外请求头。
 *
 * @param source - 固定请求头或按次解析器。
 * @param request - 当前统一模型请求。
 * @returns 独立的字符串请求头记录。
 */
async function resolveHeaders(
    source: HeaderSource | undefined,
    request: ModelRequest
): Promise<Readonly<Record<string, string>>> {
    if (source === undefined) {
        return {}
    }
    const headers = typeof source === 'function'
        ? await source(request)
        : source
    return { ...headers }
}

/**
 * 规范化 Provider endpoint。
 *
 * @param baseUrl - Provider 基础 URL。
 * @param path - 可选 Chat Completions 路径。
 * @returns 无重复分隔符的完整 endpoint。
 */
function resolveUrl(baseUrl: string, path: string | undefined): string {
    const normalizedBase = baseUrl.replace(/\/+$/, '')
    const normalizedPath = path ?? '/chat/completions'
    return normalizedPath.startsWith('/')
        ? normalizedBase + normalizedPath
        : normalizedBase + '/' + normalizedPath
}

/**
 * 判断 HTTP 状态是否通常适合由外层策略重试。
 *
 * @param status - Provider HTTP 状态码。
 * @returns 限流或服务端错误是否可重试。
 */
function isRetryableStatus(status: number): boolean {
    return status === 429 || status >= 500
}

/**
 * 从非 2xx 响应构造限长、安全的模型失败。
 *
 * @param response - Provider 返回的非成功 HTTP 响应。
 * @returns 始终拒绝的模型失败 Promise。
 */
async function httpFailure(response: HttpStreamResponse): Promise<never> {
    const body = await collectUtf8(response.body, 2_048)
    throw modelFailure(
        'Model request failed with HTTP ' + String(response.status),
        {
            retryable: isRetryableStatus(response.status),
            details: {
                status: response.status,
                ...(body.length === 0 ? {} : { body })
            }
        }
    )
}

/**
 * 将成功响应中的 SSE chunk 归一为 ModelEvent。
 *
 * @param body - Transport 返回的成功响应字节流。
 * @returns text、reasoning、usage、Tool Call 与最终 finish 事件。
 */
async function* normalizeResponse(
    body: AsyncIterable<Uint8Array>
): AsyncGenerator<ModelEvent> {
    const pendingToolCalls = new Map<number, PendingToolCall>()
    let finish: {
        readonly reason: ModelFinishReason
        readonly rawReason: string
    } | undefined
    let receivedDone = false
    let sseEventCount = 0
    for await (const event of parseSse(body)) {
        sseEventCount += 1
        if (event.data === '[DONE]') {
            receivedDone = true
            break
        }
        const chunk = parseChunk(event.data)
        if (chunk.error) {
            const message = chunk.error.message?.slice(0, 512) ??
                'OpenAI-compatible provider returned an error payload'
            throw modelFailure(message, {
                details: {
                    ...(chunk.error.type === undefined
                        ? {}
                        : { type: chunk.error.type }),
                    ...(chunk.error.code === undefined
                        ? {}
                        : { code: chunk.error.code })
                }
            })
        }
        if (chunk.usage) {
            yield {
                type: PROVIDER_MODEL_EVENT_TYPE.USAGE,
                usage: mapUsage(chunk.usage)
            }
        }

        const choice = chunk.choices?.[0]
        const delta = choice?.delta
        if (delta?.content) {
            yield {
                type: PROVIDER_MODEL_EVENT_TYPE.TEXT_DELTA,
                delta: delta.content
            }
        }
        const reasoning = delta?.reasoning_content ?? delta?.reasoning
        if (reasoning) {
            yield {
                type: PROVIDER_MODEL_EVENT_TYPE.REASONING_DELTA,
                delta: reasoning
            }
        }
        for (const toolDelta of delta?.tool_calls ?? []) {
            mergeToolCallDelta(pendingToolCalls, toolDelta)
        }
        if (choice?.finish_reason && finish === undefined) {
            finish = {
                reason: mapFinishReason(choice.finish_reason),
                rawReason: choice.finish_reason
            }
        }
    }

    // 微信小程序的 async generator 转译会把同步子生成器的结束值作为一次
    // yield 转交；显式逐项产生事件，避免 `undefined` 落入 Core 的事件流。
    for (const toolEvent of flushToolCalls(pendingToolCalls)) {
        yield toolEvent
    }
    if (finish === undefined) {
        throw protocolError(receivedDone
            ? 'OpenAI-compatible provider received [DONE] without finish reason'
            : 'OpenAI-compatible provider stream ended before [DONE] and finish reason',
        undefined,
        {
            sseEventCount,
            receivedDone,
            receivedFinishReason: false
        })
    }
    // Emit usage-only chunks before the protocol's single final event.
    yield {
        type: PROVIDER_MODEL_EVENT_TYPE.FINISH,
        reason: finish.reason,
        rawReason: finish.rawReason
    }
}

/**
 * 过滤微信小程序 async generator 转译器插入的空迭代值。
 *
 * 该运行时偶尔会在 `for await` 循环边界返回
 * `{ done: false, value: undefined }`，也可能把内部 IteratorResult 本身作为
 * 普通 value 泄漏出来。前者不属于 ModelEvent；后者的 value 可能经过多层
 * IteratorResult 包装，若最终为合法模型事件，则应在公开边界解包。其他未知对象仍
 * 由 Core 报为协议错误。
 *
 * @param events - Provider 内部产生的模型事件流。
 * @returns 不含转译占位值的模型事件流。
 */
function withoutUndefinedIteratorArtifacts(
    events: AsyncIterable<ModelEvent>
): AsyncIterable<ModelEvent> {
    return {
        [Symbol.asyncIterator](): AsyncIterator<ModelEvent> {
            const iterator = events[Symbol.asyncIterator]()
            return {
                async next(): Promise<IteratorResult<ModelEvent>> {
                    while (true) {
                        const result = await iterator.next()
                        if (result.done) {
                            return result
                        }
                        const artifact = readIteratorArtifact(result.value)
                        if (artifact?.kind === 'empty') {
                            continue
                        }
                        if (artifact?.kind === 'model-event') {
                            return { done: false, value: artifact.event }
                        }
                        if (artifact === undefined) {
                            return result
                        }
                    }
                },
                async return(value?: ModelEvent): Promise<IteratorResult<ModelEvent>> {
                    if (iterator.return === undefined) {
                        return { done: true, value: value as ModelEvent }
                    }
                    return iterator.return(value)
                }
            }
        }
    }
}

/** 读取小程序转译器泄漏的 IteratorResult 占位或其内嵌模型事件。 */
function readIteratorArtifact(value: unknown):
    | { readonly kind: 'empty' }
    | { readonly kind: 'model-event'; readonly event: ModelEvent }
    | undefined {
    if (value === undefined) {
        return { kind: 'empty' }
    }
    if (value === null || typeof value !== 'object') {
        return undefined
    }
    let nestedValue: unknown = value
    for (let depth = 0; depth < 8; depth += 1) {
        if (nestedValue === null || typeof nestedValue !== 'object') {
            return undefined
        }
        const candidate = nestedValue as {
            readonly type?: unknown
            readonly done?: unknown
            readonly value?: unknown
        }
        if (candidate.type !== undefined || typeof candidate.done !== 'boolean') {
            return undefined
        }
        if (candidate.value === undefined) {
            return { kind: 'empty' }
        }
        if (candidate.value !== null && typeof candidate.value === 'object' &&
            typeof (candidate.value as { readonly type?: unknown }).type === 'string') {
            return { kind: 'model-event', event: candidate.value as ModelEvent }
        }
        nestedValue = candidate.value
    }
    return undefined
}

/** OpenAI-compatible 协议的统一 LanguageModel 实现。 */
class OpenAICompatibleLanguageModel implements LanguageModel {
    /** Provider identifier used by this internal protocol client. */
    readonly provider: string
    /** 供应商侧模型 ID。 */
    readonly modelId: string
    /** Provider 共享且已规范化的连接配置。 */
    private readonly options: ResolvedProviderOptions

    /**
     * 创建绑定到一个模型 ID 的轻量 LanguageModel。
     *
     * @param modelId - 供应商侧模型 ID。
     * @param options - Provider 共享连接配置。
     */
    constructor(modelId: string, options: ResolvedProviderOptions) {
        this.provider = options.id
        this.modelId = modelId
        this.options = options
    }

    /**
     * 将一次统一模型请求转换为 OpenAI-compatible 事件流。
     *
     * @param request - Request prepared by the model plugin and its collaborators.
     * @returns Provider 无关的增量 ModelEvent 流。
     */
    stream(request: ModelRequest): AsyncIterable<ModelEvent> {
        return withoutUndefinedIteratorArtifacts(this.streamRaw(request))
    }

    /**
     * 产生未过滤的 Provider 模型事件，供公开迭代器包装为稳定契约。
     *
     * @param request - Request prepared by the model plugin and its collaborators.
     * @returns Provider 原始的增量 ModelEvent 流。
     */
    private async *streamRaw(request: ModelRequest): AsyncGenerator<ModelEvent> {
        const reservedOption = findReservedProviderOption(request.providerOptions)
        if (reservedOption !== undefined) {
            throw protocolError(`Provider option cannot override reserved field: ${reservedOption}`)
        }
        let response: HttpStreamResponse
        try {
            const extraHeaders = await resolveHeaders(
                this.options.headers,
                request
            )
            const headers: Record<string, string> = {
                'content-type': 'application/json',
                ...(this.options.apiKey === undefined
                    ? {}
                    : {
                        authorization: 'Bearer ' + this.options.apiKey
                    }),
                ...extraHeaders
            }
            const body = {
                model: this.modelId,
                messages: request.messages.map((message) => (
                    mapMessage(message, this.options.assistantReasoningField)
                )),
                stream: true,
                ...(this.options.includeUsage
                    ? { stream_options: { include_usage: true } }
                    : {}),
                ...(request.tools.length === 0
                    ? { tools: [] }
                    : {
                        tools: request.tools.map((tool) => ({
                            type: 'function',
                            function: {
                                name: tool.name,
                                description: tool.description,
                                parameters: tool.inputSchema
                            }
                        }))
                    }),
                ...(request.temperature === undefined
                    ? {}
                    : { temperature: request.temperature }),
                ...(request.toolChoice === undefined ? {} : { tool_choice: request.toolChoice }),
                ...(request.maxOutputTokens === undefined
                    ? {}
                    : { max_tokens: request.maxOutputTokens }),
                ...(request.stopSequences === undefined
                    ? {}
                    : { stop: request.stopSequences }),
                ...mapReasoning(request.reasoning),
                ...request.providerOptions
            }

            response = await this.options.transport.stream({
                url: this.options.url,
                method: 'POST',
                headers,
                body: JSON.stringify(body),
                ...(request.signal === undefined
                    ? {}
                    : { signal: request.signal })
            })
        } catch (cause) {
            if (request.signal?.aborted) {
                throw request.signal.reason ?? cause
            }
            if (cause instanceof AgentError) {
                throw cause
            }
            throw modelFailure('Model request could not be sent', { cause })
        }

        if (response.status < 200 || response.status >= 300) {
            await httpFailure(response)
        }

        try {
            // 微信小程序的转译器会在 async generator 的 `yield*` 交接处泄漏
            // 内层结束值。这里显式消费并逐项转发，确保流结束不会变成一条
            // `undefined` ModelEvent。
            for await (const event of normalizeResponse(response.body)) {
                yield event
            }
        } catch (cause) {
            if (request.signal?.aborted) {
                throw request.signal.reason ?? cause
            }
            if (cause instanceof AgentError) {
                throw cause
            }
            throw modelFailure('Model response stream failed', {
                cause,
                retryable: true
            })
        }
    }
}

/** 持有共享 endpoint、认证与 Transport 的轻量 Provider 工厂。 */
class OpenAICompatibleProvider implements LanguageModelProvider {
    /** Provider identifier used inside the model plugin. */
    readonly id: string
    /** 所有模型复用的已解析配置。 */
    private readonly options: ResolvedProviderOptions

    /**
     * 创建一个不进入 Agent ReAct 循环的 Provider 工厂。
     *
     * @param options - 已解析的共享 Provider 配置。
     */
    constructor(options: ResolvedProviderOptions) {
        this.id = options.id
        this.options = options
    }

    /**
     * 使用共享配置创建一个统一 LanguageModel。
     *
     * @param modelId - 供应商侧模型 ID。
     * @returns Internal protocol client used by a model plugin.
     */
    languageModel(modelId: string): LanguageModel {
        if (modelId.trim().length === 0) {
            throw new TypeError('modelId must not be empty')
        }
        return new OpenAICompatibleLanguageModel(modelId, this.options)
    }
}

/**
 * Create an internal factory for Chat Completions protocol clients.
 *
 * Model plugins create and own these clients. Agent Core invokes the model Hook
 * and never receives the factory or client.
 *
 * @param options - Internal identifier, endpoint, credentials, and Host transport.
 * @returns Factory used inside model plugins to create protocol clients.
 */
export function createOpenAICompatibleProvider(
    options: OpenAICompatibleProviderOptions
): LanguageModelProvider {
    if (options.id.trim().length === 0) {
        throw new TypeError('provider id must not be empty')
    }
    if (options.baseUrl.trim().length === 0) {
        throw new TypeError('baseUrl must not be empty')
    }

    return new OpenAICompatibleProvider({
        id: options.id,
        url: resolveUrl(options.baseUrl, options.path),
        apiKey: options.apiKey,
        transport: options.transport ?? new FetchHttpTransport(),
        headers: options.headers,
        includeUsage: options.includeUsage ?? true,
        assistantReasoningField: options.assistantReasoningField
    })
}
