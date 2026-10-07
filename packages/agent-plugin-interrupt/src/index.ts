import { toolError, type AgentRunOutcome, type AgentContext, type AgentHooks, type AgentPlugin, type BeforeToolDecision, type ContinueOrStop, type ToolCall } from '@quifox/agent-core'

export const INTERRUPT_RESULT_CODE = { USER_INTERRUPTED: 'USER_INTERRUPTED' } as const
export const INTERRUPT_MODE = { PAUSE: 'pause', TERMINATE: 'terminate' } as const
export type InterruptMode = typeof INTERRUPT_MODE[keyof typeof INTERRUPT_MODE]
export interface InterruptPluginOptions { mode?: InterruptMode }

/** 中断插件自己的终止产物；previous 保留前一插件产物但不解释它。 */
export interface InterruptRunValue { kind: 'interrupt'; reason: string; previous?: unknown }

/** @param outcome - 已完成的运行。 @returns 本插件的中断产物。 */
export function getInterruptRunValue(outcome: import('@quifox/agent-core').AgentRunOutcome): InterruptRunValue {
    if (!outcome.ok) { throw outcome.error }
    const value = outcome.value as Partial<InterruptRunValue> | undefined
    if (value?.kind !== 'interrupt' || typeof value.reason !== 'string') { throw new Error('运行没有中断插件产物。') }
    return value as InterruptRunValue
}

/** 用户按钮操作具体插件对象；Core 只认识通用 stop/result 决策。 */
export class InterruptPlugin implements AgentPlugin {
    id = 'user-interrupt'
    private active: AgentRunOutcome | undefined
    private value: unknown
    private requested: string | undefined
    private readonly mode: InterruptMode
    /** @param options - 中断后的工具批次处理方式。 */
    constructor(options: InterruptPluginOptions = {}) { this.mode = options.mode ?? INTERRUPT_MODE.PAUSE }
    readonly hooks: AgentHooks = {
        onRunStart: async (_ctx, _input, outcome) => {
            if (this.active === outcome) { return { action: 'continue' } }
            if (this.active) { throw new Error('中断插件已绑定一个活动运行。') }
            this.active = outcome; this.requested = undefined; this.value = undefined
            return { action: 'continue' }
        },
        beforeStep: async () => this.boundary(),
        beforeModel: async () => this.boundary(),
        afterModel: async (_ctx, result) => { this.value = result; return { action: 'continue' } },
        beforeTool: async (ctx, call) => this.tool(ctx, call),
        afterTool: async () => this.requested !== undefined && this.mode === INTERRUPT_MODE.TERMINATE
            ? { action: 'continue' } : this.boundary(),
        afterStep: async () => this.boundary(),
        onRunEnd: async (_ctx, outcome) => { if (this.active === outcome) { this.active = undefined; this.requested = undefined } }
    }

    /** 空闲时不记录请求，避免停止意图污染下一轮。 */
    requestStop(reason = 'stop'): void { if (this.active) { this.requested = reason } }

    /** 无待处理工具批次的停止边界。 */
    private boundary(): ContinueOrStop { return this.requested !== undefined ? this.stop(this.requested) : { action: 'continue' } }

    /** @param reason - 本插件的停止类别。 */
    private stop(reason: string): ContinueOrStop {
        return { action: 'stop', reason, value: { kind: 'interrupt', reason,
            ...(this.value === undefined ? {} : { previous: this.value }) } satisfies InterruptRunValue }
    }

    /** @param ctx - 可选的协作恢复能力。 @param call - 前面插件已改写的目标调用。 */
    private tool(ctx: AgentContext, call: ToolCall): BeforeToolDecision {
        if (this.requested !== undefined) {
            return this.mode === INTERRUPT_MODE.TERMINATE
                ? { action: 'result', result: toolError('工具未执行：本轮已被中断。', {
                    code: INTERRUPT_RESULT_CODE.USER_INTERRUPTED, reason: this.requested
                }) }
                : this.boundary()
        }
        // 只约定需要的查询，不导入或隐式安装具体执行记录插件。
        const execution = (ctx as AgentContext & { execution?: { requiresRetry?(callId: string): boolean } }).execution
        if (execution?.requiresRetry?.(call.id) && ctx.tools.policy(call.name)?.retrySafe !== true) {
            return this.stop('tool-result-unknown')
        }
        return { action: 'continue' }
    }
}

/** 创建一个可由按钮闭包持有的普通插件对象。 */
export function createInterruptPlugin(options: InterruptPluginOptions = {}): InterruptPlugin { return new InterruptPlugin(options) }
