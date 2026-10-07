/** Agent Core 中可能产生错误的稳定阶段。 */
export const AGENT_ERROR_PHASE = {
    RUN: 'run',
    STEP: 'step',
    MODEL: 'model',
    TOOL: 'tool',
    HOOK: 'hook',
    SCHEMA: 'schema'
} as const

/** Agent 错误所属阶段。 */
export type AgentErrorPhase = string

/** Core 对外暴露的稳定错误码。 */
export const AGENT_ERROR_CODE = {
    ABORTED: 'ABORTED',
    MODEL_FAILED: 'MODEL_FAILED',
    TOOL_NOT_FOUND: 'TOOL_NOT_FOUND',
    TOOL_INPUT_INVALID: 'TOOL_INPUT_INVALID',
    TOOL_FAILED: 'TOOL_FAILED',
    HOOK_FAILED: 'HOOK_FAILED'
} as const

/** Agent 错误码类型。 */
export type AgentErrorCode = string

/** 创建 `AgentError` 时使用的结构化参数。 */
export interface AgentErrorOptions {
    code: AgentErrorCode
    phase: AgentErrorPhase
    message: string
    cause?: unknown
    retryable?: boolean
    details?: Readonly<Record<string, unknown>>
}

/** Agent Core 的统一异常。 */
export class AgentError extends Error {
    /** 供宿主稳定分支处理的错误码。 */
    readonly code: AgentErrorCode
    /** 错误发生的生命周期阶段。 */
    readonly phase: AgentErrorPhase
    /** 当前错误是否适合由外层策略重试。 */
    readonly retryable: boolean
    /** 不进入用户可见消息的结构化诊断信息。 */
    readonly details: Readonly<Record<string, unknown>> | undefined
    /** 触发当前错误的原始原因。 */
    override readonly cause: unknown

    /**
     * 创建包含稳定错误码和阶段信息的 Core 异常。
     *
     * @param options - 错误码、阶段、消息及可选原因和详情。
     */
    constructor(options: AgentErrorOptions) {
        super(options.message)
        this.name = 'AgentError'
        this.code = options.code
        this.phase = options.phase
        this.retryable = options.retryable ?? false
        this.details = options.details
        this.cause = options.cause
    }
}

/**
 * 将未知异常归一为稳定的 `AgentError`。
 *
 * @param error - 捕获到的未知异常。
 * @param fallback - 非 `AgentError` 异常使用的稳定错误信息。
 * @returns 原 `AgentError`，或由 fallback 创建的新错误。
 */
export function normalizeAgentError(
    error: unknown,
    fallback: Omit<AgentErrorOptions, 'cause'>
): AgentError {
    if (error instanceof AgentError) {
        return error
    }

    return new AgentError({ ...fallback, cause: error })
}
