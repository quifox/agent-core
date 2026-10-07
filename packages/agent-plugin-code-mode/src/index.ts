import { defineTool, toolError, toolSuccess } from '@quifox/agent-core'
import type {
    AgentContext, AgentError, AgentEvent, AgentHooks, AgentPlugin, AgentRunOutcome,
    BeforeToolDecision, ContinueOrStop, HookOutput, ModelTurnResult, ToolCall, ToolResult, ToolRunResult
} from '@quifox/agent-core'
import { z } from 'zod'

/** 同一注册表中原 Tool 的异步代理；参数仍由 Tool 自己准备。 */
export type CodeModeTools = Record<string, (input: unknown) => Promise<ToolResult>>

/** Host 执行环境；额外绑定可以包含真实对象或回调。 */
export interface CodeModeEnvironment<Ctx extends AgentContext = AgentContext> {
    ctx: Ctx
    tools: CodeModeTools
    [binding: string]: unknown
}

/** 执行器属于 Host；本包不决定 Node、浏览器、编译器或沙箱。 */
export interface CodeModeOptions<Ctx extends AgentContext = AgentContext> {
    /** @param code - 模型提供的代码。 @param environment - 当前真实 Context、代理与 Host 绑定。 */
    execute(code: string, environment: CodeModeEnvironment<Ctx>): Promise<unknown>
    /** @param ctx - 当前真实 Context；ctx/tools 由本插件提供。 */
    bindings?(ctx: Ctx): Record<string, unknown>
}

interface Run<Ctx extends AgentContext> {
    ctx: Ctx
    events: AgentEvent[]
    serial: Promise<void>
    counter: number
    outerCall?: string
    modelResult?: ModelTurnResult
    stop?: Extract<ContinueOrStop, { action: 'stop' }>
}

/** 只在本插件内部展开已有 Hook 的 stop，不作为 Core 错误。 */
class CodeStopped extends Error {}

/** 通过普通工具执行代码，开放真实 CTX，并生成异步 Tool 代理。 */
export class CodeModePlugin<Input = unknown, Ctx extends AgentContext = AgentContext> implements AgentPlugin<Input, Ctx> {
    readonly id = 'code-mode'
    readonly hooks: AgentHooks<Input, Ctx>
    private readonly runs = new Map<AgentRunOutcome, Run<Ctx>>()
    private readonly calls = new WeakMap<ToolCall, Run<Ctx>>()

    /** @param options - Host 的执行器和额外代码绑定。 */
    constructor(private readonly options: CodeModeOptions<Ctx>) {
        const owner = this
        const toolName = 'execute_code'
        const executeCode = defineTool({
            name: toolName,
            description: '执行代码；ctx 是真实 Context，tools[name](input) 是经过工具钩子的异步代理。代码须 await 工具回执，可使用 Host 提供的其他绑定。',
            inputSchema: z.object({ code: z.string() }),
            policy: { sideEffect: 'external', approval: 'host' },
            execute: async ({ code }, ctx: Ctx) => {
                const run = this.current(ctx)
                const tools: CodeModeTools = Object.create(null) as CodeModeTools
                let accepting = true
                for (const definition of ctx.tools.definitions()) {
                    if (ctx.tools.get(definition.name) === executeCode) { continue }
                    tools[definition.name] = input => {
                        if (!accepting) {
                            return Promise.reject(new Error('工具代理只在当前代码执行中可用；新插件应使用其 Hook 参数中的 CTX。'))
                        }
                        const request = run.serial.then(() => this.invokeTool(run, definition.name, input))
                        run.serial = request.then(() => undefined, () => undefined)
                        return request
                    }
                }
                let value: unknown
                try {
                    value = await this.options.execute(code, { ...this.options.bindings?.(ctx), ctx, tools })
                } catch (cause) {
                    if (!(cause instanceof CodeStopped)) { throw cause }
                } finally {
                    accepting = false
                    // 未消费的调用也必须收尾，不能让 execute_code 提前结束。
                    await run.serial
                }
                if (run.stop) { return toolError('代码执行在工具钩子处停止。', { code: 'CODE_STOPPED', data: value }) }
                const content = typeof value === 'string' ? value : JSON.stringify(value) ?? '代码执行完成。'
                return toolSuccess(content, value)
            }
        })
        this.hooks = {
            onInitialize: async ctx => {
                if (!ctx.tools.isRegistered(executeCode)) { ctx.tools.register(executeCode) }
            },
            onRunStart: async (ctx, _input, outcome) => {
                if (!this.runs.has(outcome)) {
                    this.runs.set(outcome, { ctx, events: [], serial: Promise.resolve(), counter: 0 })
                }
                return { action: 'continue' }
            },
            beforeTool: async (ctx, call) => {
                if (call.name === toolName) {
                    const run = this.current(ctx)
                    run.outerCall = call.id
                    this.calls.set(call, run)
                }
                return { action: 'continue' }
            },
            afterModel: async (ctx, result) => {
                this.current(ctx).modelResult = result
                return { action: 'continue' }
            },
            afterTool: async function* (ctx: Ctx, receipt: ToolRunResult): AsyncGenerator<AgentEvent, ContinueOrStop, void> {
                if (receipt.call.name !== toolName) { return { action: 'continue' } }
                const run = owner.calls.get(receipt.call) ?? owner.current(ctx)
                owner.calls.delete(receipt.call)
                yield* run.events.splice(0)
                return run.stop ?? { action: 'continue' }
            },
            onError: async function* (_ctx: Ctx, _error: AgentError, outcome: AgentRunOutcome): AsyncGenerator<AgentEvent, void, void> {
                const run = owner.runs.get(outcome)
                if (run) { yield* run.events.splice(0) }
            },
            onRunEnd: async (_ctx, outcome) => {
                this.runs.delete(outcome)
            }
        }
    }

    /** @param ctx - 普通工具执行入口传入的 Context。 */
    private current(ctx: Ctx): Run<Ctx> {
        const run = [...this.runs.values()].filter(run => run.ctx === ctx).at(-1)
        if (!run) { throw new Error('Code Mode 没有当前运行。') }
        return run
    }

    /** @param run - 所属物理运行。 @param name - 原工具名。 @param input - 代码提供的原始输入。 */
    private async invokeTool(run: Run<Ctx>, name: string, input: unknown): Promise<ToolResult> {
        if (run.stop) { throw new CodeStopped() }
        let id: string
        do { id = `${run.outerCall ?? 'code'}:code:${++run.counter}` }
        while (run.modelResult?.toolCalls.some(call => call.id === id))
        const call: ToolCall = { id, name, input }
        const callId = call.id
        run.events.push({ type: 'tool-start', call })
        const plugins = run.ctx.plugins as readonly AgentPlugin<Input, Ctx>[]
        let decision: BeforeToolDecision = { action: 'continue' }
        before: for (const plugin of plugins) {
            if (plugin === this) { continue }
            for (const callback of handlers(plugin.hooks?.beforeTool)) {
                decision = await consume(callback(run.ctx, call), run.events)
                if (decision.action !== 'continue') { break before }
            }
        }
        if (call.id !== callId) { call.id = callId; throw new Error('工具钩子不能修改调用 ID。') }
        if (decision.action === 'stop') {
            run.stop = decision
            throw new CodeStopped()
        }
        let result: ToolResult
        if (decision.action === 'result') { result = decision.result }
        else {
            if (call.name === 'execute_code') { throw new Error('Code Mode 工具代理不能递归执行 execute_code。') }
            const tool = run.ctx.tools.get(call.name)
            if (!tool) { throw new Error(`Code Mode 找不到工具：${call.name}`) }
            const prepared = await tool.prepare(run.ctx, call.input)
            result = await tool.execute(prepared, run.ctx)
        }
        const receipt: ToolRunResult = { call, result }
        let stop: Extract<ContinueOrStop, { action: 'stop' }> | undefined
        const failures: unknown[] = []
        for (const plugin of plugins) {
            if (plugin === this) { continue }
            for (const callback of handlers(plugin.hooks?.afterTool)) {
                try {
                    const after = await consume(callback(run.ctx, receipt), run.events)
                    if (after.action === 'stop') { stop ??= after }
                } catch (cause) { failures.push(cause) }
            }
        }
        if (failures.length) { throw failures[0] }
        if (receipt.call.id !== callId) { throw new Error('afterTool 不能修改调用 ID。') }
        run.events.push({ type: 'tool-result', run: receipt })
        if (stop) {
            run.stop = stop
            throw new CodeStopped()
        }
        return receipt.result
    }
}

/** @param value - 一个或多个有序 Hook。 */
function handlers<Handler>(value: Handler | Handler[] | undefined): Handler[] {
    return value === undefined ? [] : Array.isArray(value) ? value : [value]
}

/** @param output - 公开 Hook 的返回。 @param events - 当前 Code Mode 的观察缓冲。 */
async function consume<Value>(output: HookOutput<Value>, events: AgentEvent[]): Promise<Value> {
    if ('next' in output) {
        while (true) {
            const next = await output.next()
            if (next.done) { return next.value }
            events.push(next.value)
        }
    }
    return await output
}
