import { AgentError, StreamClosedError, type AgentContext, type AgentEvent as CoreEvent, type AgentHooks, type AgentPlugin, type AgentRunOutcome, type ModelEvent, type ModelTurnResult, type ToolCall, type ToolRunResult } from '@quifox/agent-core'
import type { PublicAgentError } from './events.js'

export { AGENT_EVENT_TYPE, LIFECYCLE_END_STATUS } from './events.js'
export type { AgentEvent, LifecycleEndStatus, PublicAgentError } from './events.js'

/** 钩子中的观察事实；传输和存储由出口负责。 */
export type ExecutionEvent = ModelEvent
    | { type: 'run-input'; input: unknown }
    | { type: 'model-start' }
    | { type: 'model-result'; result: ModelTurnResult }
    | { type: 'tool-planned'; call: ToolCall }
    | { type: 'tool-result'; run: ToolRunResult }
    | { type: 'error'; code: string; phase: string }
    | { type: 'run-ending'; ok: boolean; finishReason?: string; interruptReason?: string }

export interface PublishedEvent { sourceId: string; sequence: number; event: ExecutionEvent }
export interface EventPublisherOptions {
    sourceId: string
    /** @param event - 当前事实；出口需要快照时立即编码。 */
    publish?(event: PublishedEvent): void | Promise<void>
}

interface Observation {
    outcome: AgentRunOutcome
    step: number
    openStep: boolean
    openModel: boolean
    observedError: boolean
}

/** 显式安装的事件投影与可选发布出口；Core 不维护阶段状态。 */
export class EventPublisherPlugin<Input = unknown, Ctx extends AgentContext = AgentContext> implements AgentPlugin<Input, Ctx> {
    id = 'event-publisher'
    readonly hooks: AgentHooks<Input, Ctx>
    private sequence = 0
    private failure: unknown
    private observation: Observation | undefined

    /** @param options - 独立事件身份与可选出口；省略出口仍产出 stream 事件。 */
    constructor(private readonly options: EventPublisherOptions) {
        if (!options.sourceId.trim()) { throw new Error('事件来源名称不能为空。') }
        const publisher = this
        this.hooks = {
            async *onRunStart(_ctx, input, outcome) {
                if (publisher.observation?.outcome === outcome) { return { action: 'continue' } }
                if (publisher.observation) { throw new Error('事件插件正在观察一个活动运行。') }
                publisher.observation = { outcome, step: 0, openStep: false, openModel: false, observedError: false }
                publisher.emit({ type: 'run-input', input })
                return { action: 'continue' }
            },
            async *beforeStep() {
                const state = publisher.state()
                state.step += 1; state.openStep = true
                yield { type: 'step-start', step: state.step }
                return { action: 'continue' }
            },
            async *beforeModel(ctx) {
                publisher.source(ctx)
                const state = publisher.state()
                state.openModel = true
                publisher.emit({ type: 'model-start' })
                yield { type: 'model-start', step: state.step }
                return { action: 'continue' }
            },
            async *model(ctx) {
                return yield* publisher.delegate(ctx)
            },
            async *afterModel(_ctx, result) {
                const state = publisher.state()
                state.openModel = false
                publisher.emit({ type: 'model-result', result })
                yield { type: 'model-end', step: state.step, status: 'completed', result }
                return { action: 'continue' }
            },
            async *beforeTool(_ctx, call) {
                publisher.emit({ type: 'tool-planned', call })
                return { action: 'continue' }
            },
            async *afterTool(_ctx, run) {
                publisher.emit({ type: 'tool-result', run })
                return { action: 'continue' }
            },
            async *afterStep() {
                const state = publisher.state()
                state.openStep = false
                yield { type: 'step-end', step: state.step, status: 'completed' }
                return { action: 'continue' }
            },
            async *onError(_ctx, cause, outcome) {
                if (publisher.observation?.outcome !== outcome) { return }
                publisher.observation.observedError = true
                const error = publicError(cause)
                publisher.emit({ type: 'error', code: error.code, phase: error.phase })
                yield { type: 'error', error, secondary: false }
            },
            async *onRunEnd(_ctx, outcome) {
                const state = publisher.observation
                if (state?.outcome !== outcome) { return }
                publisher.observation = undefined
                const status = !outcome.ok && !(outcome.error instanceof StreamClosedError) ? 'failed' : 'stopped'
                if (state.openModel) { yield { type: 'model-end', step: state.step, status } }
                if (state.openStep) { yield { type: 'step-end', step: state.step, status } }
                if (!outcome.ok && !state.observedError && !(outcome.error instanceof StreamClosedError)) {
                    yield { type: 'error', error: publicError(outcome.error), secondary: false }
                }
                for (const error of outcome.errors) { yield { type: 'error', error: publicError(error), secondary: true } }
                const value = outcome.ok ? outcome.value as { kind?: string; finishReason?: string; reason?: string } | undefined : undefined
                publisher.emit({ type: 'run-ending', ok: outcome.ok,
                    ...(value?.finishReason ? { finishReason: value.finishReason } : {}),
                    ...(value?.kind === 'interrupt' && value.reason !== undefined ? { interruptReason: value.reason } : {}) })
            }
        }
    }

    /** 最近一次发布错误；出口失败不改变运行策略。 */
    get publishError(): unknown { return this.failure }

    /** 每轮计数和阶段配对仅存在本插件。 */
    private state(): Observation {
        if (!this.observation) { throw new Error('事件插件尚未接纳本次运行。') }
        return this.observation
    }

    /** @param ctx - 不改变原生成钩子的委托上下文。 */
    private async *delegate(ctx: Ctx): AsyncGenerator<CoreEvent | ModelEvent, ModelTurnResult, void> {
        const upstream: AsyncIterator<CoreEvent | ModelEvent, ModelTurnResult, void> = this.source(ctx)(ctx)
        let finished = false
        try {
            while (true) {
                const next = await upstream.next()
                if (next.done) { finished = true; return next.value }
                this.emit(next.value as ModelEvent)
                yield next.value
            }
        } finally { if (!finished) { await upstream.return?.() } }
    }

    /** @param ctx - 最终插件数组，调用顺序由装配方负责。 */
    private source(ctx: Ctx): NonNullable<AgentHooks<Input, Ctx>['model']> {
        const sources = (ctx.plugins as readonly AgentPlugin<Input, Ctx>[]).filter(plugin => plugin.hooks?.model)
        if (sources.at(-1) !== this) { throw new Error('事件插件必须是最后一个 model 实现。') }
        const upstream = sources.slice(0, -1).at(-1)?.hooks?.model
        if (!upstream || upstream === this.hooks.model) { throw new Error('事件插件前面没有可委托的 model。') }
        return upstream
    }

    /** @param event - 不阻塞执行的出口事件。 */
    private emit(event: ExecutionEvent): void {
        try {
            const pending = this.options.publish?.({ sourceId: this.options.sourceId, sequence: ++this.sequence, event })
            if (pending) { void Promise.resolve(pending).catch(error => { this.failure = error }) }
        } catch (error) { this.failure = error }
    }
}

/** @param cause - 可见错误保持安全摘要，不泄漏输入或堆栈。 */
function publicError(cause: unknown): PublicAgentError {
    return cause instanceof AgentError
        ? { code: cause.code, phase: cause.phase }
        : { code: 'HOOK_FAILED', phase: 'run' }
}
