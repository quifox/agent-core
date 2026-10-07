import { fail, type AgentContext, type AgentRunOutcome } from './context.js'
import { AgentError, normalizeAgentError } from './errors.js'
import type { AgentEvent } from './events.js'
import type { ModelEvent, ModelTurnResult, ToolCall } from './model.js'
import type { AgentPlugin } from './plugins.js'
import type { ToolResult, ToolRunResult } from './tools.js'

export type HookOrHooks<Handler> = Handler | Handler[]
export type HookOutput<Value> = Promise<Value> | AsyncGenerator<AgentEvent, Value, void>
export type ContinueOrStop = { action: 'continue' } | { action: 'stop'; reason?: string; value?: unknown }
export type BeforeToolDecision = ContinueOrStop | { action: 'result'; result: ToolResult }

/** 一套钩子合同；插件可以产生自己的观察事件。 */
export interface AgentHooks<Input = unknown, Ctx extends AgentContext = AgentContext> {
    onRegister?: HookOrHooks<(plugins: AgentPlugin<Input, Ctx>[]) => Promise<void>>
    onInitialize?: HookOrHooks<(ctx: Ctx) => Promise<void>>
    onRunStart?: HookOrHooks<(ctx: Ctx, input: Input, outcome: AgentRunOutcome) => HookOutput<ContinueOrStop>>
    beforeStep?: HookOrHooks<(ctx: Ctx) => HookOutput<ContinueOrStop>>
    beforeModel?: HookOrHooks<(ctx: Ctx) => HookOutput<ContinueOrStop>>
    model?: (ctx: Ctx) => AsyncGenerator<ModelEvent | AgentEvent, ModelTurnResult, void>
    afterModel?: HookOrHooks<(ctx: Ctx, result: ModelTurnResult) => HookOutput<ContinueOrStop>>
    beforeTool?: HookOrHooks<(ctx: Ctx, call: ToolCall) => HookOutput<BeforeToolDecision>>
    afterTool?: HookOrHooks<(ctx: Ctx, run: ToolRunResult) => HookOutput<ContinueOrStop>>
    afterStep?: HookOrHooks<(ctx: Ctx) => HookOutput<ContinueOrStop>>
    onError?: HookOrHooks<(ctx: Ctx, error: AgentError, outcome: AgentRunOutcome) => HookOutput<void>>
    onRunEnd?: HookOrHooks<(ctx: Ctx, outcome: AgentRunOutcome) => HookOutput<void>>
}

/** @param value - 单处理器或有序列表。 @internal */
export function handlers<Handler>(value: HookOrHooks<Handler> | undefined): Handler[] {
    return value === undefined ? [] : Array.isArray(value) ? value : [value]
}

/** @param output - 普通异步结果或插件生成器。 @internal */
async function* invoke<Value>(output: HookOutput<Value>): AsyncGenerator<AgentEvent, Value, void> {
    if ('next' in output) { return yield* output }
    return await output
}

/** 装配和调度，不解释插件的业务策略。 @internal */
export class HookRunner<Input, Ctx extends AgentContext> {
    readonly model: AgentHooks<Input, Ctx>['model']

    /** @param plugins - 最终有序插件对象列表。 */
    constructor(private readonly plugins: AgentPlugin<Input, Ctx>[]) {
        this.model = plugins.flatMap(plugin => plugin.hooks?.model ? [plugin.hooks.model] : []).at(-1)
    }

    /** @param ctx - Agent 长期保留的共享对象。 */
    async initialize(ctx: Ctx): Promise<void> {
        for (const plugin of new Set(this.plugins)) {
            for (const handler of handlers(plugin.hooks?.onInitialize)) {
                try { await handler(ctx) } catch (cause) { throw hookError(cause, 'onInitialize') }
            }
        }
    }

    /** @param name - 控制钩子。 @param args - 共享工作参数。 */
    async *control<Name extends 'onRunStart' | 'beforeStep' | 'beforeModel' | 'afterModel' | 'beforeTool' | 'afterStep'>(
        name: Name,
        ...args: Parameters<Extract<NonNullable<AgentHooks<Input, Ctx>[Name]>, (...args: never[]) => unknown>>
    ): AsyncGenerator<AgentEvent, Name extends 'beforeTool' ? BeforeToolDecision : ContinueOrStop, void> {
        type Decision = Name extends 'beforeTool' ? BeforeToolDecision : ContinueOrStop
        const events: AgentEvent[] = []
        let decision: Decision = { action: 'continue' } as Decision
        control: for (const plugin of this.plugins) {
            const callbacks = handlers<unknown>(plugin.hooks?.[name]) as ((...values: typeof args) => HookOutput<Decision>)[]
            for (const handler of callbacks) {
                try {
                    const stream = invoke(handler(...args))
                    while (true) {
                        const next = await stream.next()
                        if (next.done) { decision = next.value; break }
                        events.push(next.value)
                    }
                    if (!decision || !['continue', 'stop', 'result'].includes(decision.action) ||
                        (decision.action === 'result' && name !== 'beforeTool')) {
                        throw new Error(`钩子 ${name} 必须返回有效的控制决策。`)
                    }
                } catch (cause) {
                    throw hookError(cause, name)
                }
                if (decision.action !== 'continue') { break control }
            }
        }
        yield* events
        return decision
    }

    /** 完整处理真实回执后交出缓存事件。 @param ctx - 共享 Context。 @param run - 真实结果。 */
    async afterTool(ctx: Ctx, run: ToolRunResult): Promise<{ decision: ContinueOrStop; events: AgentEvent[] }> {
        let stop: Extract<ContinueOrStop, { action: 'stop' }> | undefined
        let failure: AgentError | undefined
        const events: AgentEvent[] = []
        for (const plugin of this.plugins) {
            for (const handler of handlers(plugin.hooks?.afterTool)) {
                try {
                    const stream = invoke(handler(ctx, run))
                    while (true) {
                        const next = await stream.next()
                        if (next.done) {
                            if (!next.value || !['continue', 'stop'].includes(next.value.action)) {
                                throw new Error('钩子 afterTool 必须返回有效的控制决策。')
                            }
                            if (next.value.action === 'stop' && !stop) { stop = next.value }
                            break
                        }
                        events.push(next.value)
                    }
                } catch (cause) { failure ??= hookError(cause, 'afterTool') }
            }
        }
        if (failure) { throw failure }
        return { decision: stop ?? { action: 'continue' }, events }
    }

    /** @param ctx - 长期 Context。 @param outcome - 本次调用身份与结果。 */
    async finish(ctx: Ctx, outcome: AgentRunOutcome): Promise<AgentEvent[]> {
        const events: AgentEvent[] = []
        for (const plugin of this.plugins) {
            for (const callback of handlers(plugin.hooks?.onRunEnd)) {
                try { for await (const event of invoke(callback(ctx, outcome))) { events.push(event) } }
                catch (cause) {
                    const error = hookError(cause, 'onRunEnd')
                    if (outcome.ok) { fail(outcome, error) }
                    else { outcome.errors.push(error) }
                }
            }
        }
        return events
    }

    /** @param ctx - 长期 Context。 @param error - 主错误。 @param outcome - 本次调用。 */
    async error(ctx: Ctx, error: AgentError, outcome: AgentRunOutcome): Promise<AgentEvent[]> {
        const events: AgentEvent[] = []
        for (const plugin of this.plugins) {
            for (const callback of handlers(plugin.hooks?.onError)) {
                try { for await (const event of invoke(callback(ctx, error, outcome))) { events.push(event) } }
                catch (cause) { outcome.errors.push(hookError(cause, 'onError')) }
            }
        }
        return events
    }
}

/** @param cause - 钩子抛出的未知异常。 @param name - 当前扩展点。 */
function hookError(cause: unknown, name: string): AgentError {
    return normalizeAgentError(cause, { code: 'HOOK_FAILED', phase: 'hook', message: `Hook failed: ${name}` })
}
