import type { AgentToolDefinition } from './tools.js'

/** Agent 内部统一使用的消息角色。 */
export const MESSAGE_ROLE = {
    SYSTEM: 'system',
    USER: 'user',
    ASSISTANT: 'assistant',
    TOOL: 'tool'
} as const

/** 模型产生的一次结构化 Tool 调用。 */
export interface ToolCall {
    id: string
    name: string
    input: unknown
}

/** 插件之间共享的消息数据类型；Core 不持有或构造消息。 */
export type AgentMessage =
    | { role: typeof MESSAGE_ROLE.SYSTEM; content: string }
    | { role: typeof MESSAGE_ROLE.USER; content: string }
    | {
        role: typeof MESSAGE_ROLE.ASSISTANT
        content: string
        reasoning?: string
        toolCalls?: readonly ToolCall[]
    }
    | {
        role: typeof MESSAGE_ROLE.TOOL
        toolCallId: string
        toolName: string
        content: string
        isError?: boolean
    }

/** Reasoning settings shared by model plugins. */
export type ModelReasoning =
    | { type: 'effort'; effort: string }
    | { type: 'budget'; budgetTokens: number }
    | { type: 'toggle'; enabled: boolean }
    | { type: 'provider'; value: unknown }

/** 生成插件可以交给模型的通用参数。 */
export interface ModelSettings {
    temperature?: number
    /** 本次调用的工具选择；省略沿用供应商默认，none 明确禁止生成调用。 */
    toolChoice?: 'auto' | 'none' | 'required'
    maxOutputTokens?: number
    reasoning?: ModelReasoning
    stopSequences?: readonly string[]
    providerOptions?: Readonly<Record<string, unknown>>
}

/** 生成插件发送给模型 Adapter 的请求，不是 Agent 入口或 Context。 */
export interface ModelRequest extends ModelSettings {
    messages: readonly AgentMessage[]
    tools: readonly AgentToolDefinition[]
    signal?: AbortSignal
}

/** 一次或多次模型调用的 Token 用量。 */
export interface ModelUsage {
    inputTokens?: number
    outputTokens?: number
    totalTokens?: number
    cachedInputTokens?: number
    reasoningTokens?: number
}

/** Normalized finish reasons produced by model plugins. */
export const MODEL_FINISH_REASON = {
    STOP: 'stop',
    TOOL_CALLS: 'tool-calls',
    LENGTH: 'length',
    CONTENT_FILTER: 'content-filter',
    CANCELLED: 'cancelled',
    ERROR: 'error',
    UNKNOWN: 'unknown'
} as const

export type ModelFinishReason = typeof MODEL_FINISH_REASON[keyof typeof MODEL_FINISH_REASON]

const MODEL_FINISH_REASONS: ReadonlySet<unknown> = new Set(
    Object.values(MODEL_FINISH_REASON)
)

/**
 * Check whether a value belongs to the shared finish-reason contract.
 *
 * @param value - Finish reason supplied by a model plugin.
 * @returns Whether the value is a known ModelFinishReason.
 */
export function isModelFinishReason(value: unknown): value is ModelFinishReason {
    return MODEL_FINISH_REASONS.has(value)
}

/** 模型插件输出的事件。 */
export const MODEL_EVENT_TYPE = {
    TEXT_DELTA: 'text-delta',
    REASONING_DELTA: 'reasoning-delta',
    TOOL_CALL: 'tool-call',
    USAGE: 'usage',
    FINISH: 'finish'
} as const

export type ModelEvent =
    | { type: typeof MODEL_EVENT_TYPE.TEXT_DELTA; delta: string }
    | { type: typeof MODEL_EVENT_TYPE.REASONING_DELTA; delta: string }
    | { type: typeof MODEL_EVENT_TYPE.TOOL_CALL; call: ToolCall }
    | { type: typeof MODEL_EVENT_TYPE.USAGE; usage: ModelUsage }
    | {
        type: typeof MODEL_EVENT_TYPE.FINISH
        reason: ModelFinishReason
        rawReason?: string
    }

/** 一个完整 Model Turn 的聚合结果。 */
export interface ModelTurnResult {
    text: string
    reasoning: string
    toolCalls: ToolCall[]
    usage: ModelUsage
    finishReason: ModelFinishReason
    rawFinishReason?: string
}
