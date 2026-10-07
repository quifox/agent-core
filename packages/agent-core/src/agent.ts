import { fail, succeed, StreamClosedError, type AgentContext, type AgentRunOutcome } from './context.js'
import { AgentError, normalizeAgentError } from './errors.js'
import type { AgentEvent } from './events.js'
import { HookRunner, type ContinueOrStop } from './hooks.js'
import { preparePlugins, type AgentPlugin } from './plugins.js'
import { executeTool } from './tool-executor.js'
import { ToolRegistry, type ToolRunResult } from './tools.js'

/** Core 只装配插件；输入与能力由插件提供。 */
export interface AgentOptions<Input, Ctx extends AgentContext = AgentContext> {
    plugins: AgentPlugin<Input, Ctx>[]
}

/** 保留一个 Context 和一组插件对象的默认循环。 */
export class Agent<Input = unknown, Ctx extends AgentContext = AgentContext> {
    private readonly candidates: AgentPlugin<Input, Ctx>[]
    private readonly ctx: Ctx
    private initialization: Promise<HookRunner<Input, Ctx>> | undefined
    private hooks: HookRunner<Input, Ctx> | undefined
    private plugins: readonly AgentPlugin<Input, Ctx>[] = []

    /** @param options - 调用方构造的有序插件对象。 */
    constructor(options: AgentOptions<Input, Ctx>) {
        this.candidates = [...options.plugins]
        const owner = this
        this.ctx = { tools: new ToolRegistry(), get plugins() { return owner.plugins } } as Ctx
    }

    /** 完整消费同一执行流并返回 Outcome。 @param input - 插件定义的输入。 */
    async run(input: Input): Promise<AgentRunOutcome> {
        const stream = this.stream(input)
        while (true) {
            const next = await stream.next()
            if (next.done) { return next.value }
        }
    }

    /** @param input - Core 不解释的新输入。 */
    async *stream(input: Input): AsyncGenerator<AgentEvent, AgentRunOutcome, void> {
        const ctx = this.ctx
        const outcome: AgentRunOutcome = { ok: false, error: new StreamClosedError(), errors: [] }
        let hooks: HookRunner<Input, Ctx> | undefined
        let value: unknown
        let endingEvents: AgentEvent[] = []
        /** @param decision - 插件的停止决定。 */
        const stop = (decision: Extract<ContinueOrStop, { action: 'stop' }>): void => {
            if ('value' in decision) { value = decision.value }
        }
        try {
            hooks = await (this.initialization ??= this.initialize())
            yield { type: 'run-start' }
            const start = yield* hooks.control('onRunStart', ctx, input, outcome)
            if (start.action === 'stop') { stop(start) }
            else {
                runLoop: while (true) {
                    const beforeStep = yield* hooks.control('beforeStep', ctx)
                    if (beforeStep.action === 'stop') { stop(beforeStep); break }
                    const beforeModel = yield* hooks.control('beforeModel', ctx)
                    if (beforeModel.action === 'stop') { stop(beforeModel); break }
                    if (!hooks.model) { throw new AgentError({ code: 'MODEL_FAILED', phase: 'model', message: '当前 Agent 没有可执行的 model Hook。' }) }
                    const modelResult = yield* hooks.model(ctx)
                    const afterModel = yield* hooks.control('afterModel', ctx, modelResult)
                    value = modelResult
                    if (afterModel.action === 'stop') { stop(afterModel); break }
                    for (const call of modelResult.toolCalls) {
                        const callId = call.id
                        yield { type: 'tool-start', call }
                        const decision = yield* hooks.control('beforeTool', ctx, call)
                        if (call.id !== callId) { call.id = callId; throw new Error('工具钩子不能修改调用 ID。') }
                        if (decision.action === 'stop') { stop(decision); break runLoop }
                        const run: ToolRunResult = { call, result: decision.action === 'result'
                            ? decision.result : await executeTool(ctx, call) }
                        const afterTool = await hooks.afterTool(ctx, run)
                        if (run.call.id !== callId) { throw new Error('afterTool 不能修改调用 ID。') }
                        yield* afterTool.events
                        yield { type: 'tool-result', run }
                        if (afterTool.decision.action === 'stop') { stop(afterTool.decision); break runLoop }
                    }
                    const afterStep = yield* hooks.control('afterStep', ctx)
                    if (afterStep.action === 'stop') { stop(afterStep); break }
                    if (!modelResult.toolCalls.length) { break }
                }
            }
            succeed(outcome, value)
        } catch (cause) {
            hooks ??= this.hooks
            const error = normalizeAgentError(cause, { code: 'MODEL_FAILED', phase: 'run', message: 'Agent 执行失败。' })
            fail(outcome, error)
            if (hooks) { yield* await hooks.error(ctx, error, outcome) }
        } finally {
            // 不在 finally yield；提前关闭仍完成所有收尾。
            if (hooks) { endingEvents = await hooks.finish(ctx, outcome) }
        }
        yield* endingEvents
        yield { type: 'run-end', outcome }
        return outcome
    }

    /** 注册和初始化只执行一次，始终使用长期 Context。 */
    private async initialize(): Promise<HookRunner<Input, Ctx>> {
        const plugins = await preparePlugins([...this.candidates])
        this.plugins = Object.freeze([...plugins])
        const hooks = new HookRunner([...this.plugins])
        this.hooks = hooks
        try { await hooks.initialize(this.ctx) } finally { this.ctx.tools.seal() }
        return hooks
    }
}

/** @param options - 显式插件组合。 */
export function createAgent<Input = unknown, Ctx extends AgentContext = AgentContext>(options: AgentOptions<Input, Ctx>): Agent<Input, Ctx> {
    return new Agent(options)
}
