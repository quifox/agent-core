import type { AgentRunOutcome } from '@quifox/agent-core'
import type { AgentContext, AgentHooks, AgentMessage, AgentPlugin, ModelEvent, ModelRequest, ModelSettings, ToolCall } from '@quifox/agent-core'
import { AgentError } from '@quifox/agent-core'
import { z } from 'zod'
import { ResponsesModelPlugin, collectModelOutput, type OpenAIResponsesRequestBody, type ResponsesModelRequest,
    type HttpTransport, type HeaderSource } from '@quifox/agent-plugin-model'
import { checkSessionAbort, copySessionValue, closedMessageBoundaries, normalizeRecoveredTools, pendingInputSchema, sessionMessageSchema, isPendingInput } from '@quifox/agent-plugin-session'
import { ResponsesSessionContext } from './responses-session-context.js'

/** 正式后端 Context API 的最小注入面；返回体在适配器内进行运行时校验。 */
export interface FormalBackendApi {
    /** @param input - 最终 Responses 请求和摘要预算。 @param options - 当前运行取消信号。 */
    prepareAgentContext(input: {
        request: OpenAIResponsesRequestBody & { stream: false }
        summary_instruction: string
        summary_max_output_tokens: number
    }, options: { signal?: AbortSignal | undefined }): Promise<unknown>
    /** @param input - 后端选定的摘要候选。 @param options - 当前运行取消信号。 */
    commitAgentCheckpoint(input: {
        contextId: string
        agentCheckpointRequest: { candidate_response_id: string }
    }, options: { signal?: AbortSignal | undefined }): Promise<unknown>
}

/** 配对的基础模型和每 Run Context 工厂，不在 Core 中热切换模型。 */
interface FormalBackendConnection {
    readonly model: ResponsesModelPlugin
    /** @param isCurrent - Host 当前运行检查。 @param summaryInstruction - 可选摘要指令。 */
    readonly createContext: (isCurrent: () => boolean, summaryInstruction?: string) => ResponsesSessionContext
}

/**
 * Compose Responses generation with backend Context/checkpoint routing.
 * @param options - Host-supplied connection parameters and backend API.
 * @returns Internal model plugin and per-run Context factory.
 */
function createFormalBackendConnection(options: FormalBackendPluginOptions & {
    api: FormalBackendApi
}): FormalBackendConnection {
    const model = new ResponsesModelPlugin(options)
    return { model, createContext: (isCurrent, summaryInstruction) => new ResponsesSessionContext({
        model, api: options.api, isCurrent,
        ...(summaryInstruction === undefined ? {} : { summaryInstruction }),
        bind: (id, purpose) => new ResponsesModelPlugin({ ...options,
            path: `/contexts/${encodeURIComponent(id)}/${purpose}` })
    }) }
}

/** 正式客户端只保存最新远端引用和未完成输入/工具增量。 */
export const responsesSessionSnapshotSchema = z.object({
    version: z.literal(1), id: z.string().min(1), ownerId: z.string().min(1),
    responseId: z.string().min(1).optional(),
    pendingInput: pendingInputSchema.extend({ accepted: z.boolean().optional() }).optional(),
    toolExchange: z.object({ responseId: z.string().min(1), calls: z.array(z.object({
        id: z.string().min(1), name: z.string().min(1), input: z.unknown()
    })), results: z.array(sessionMessageSchema).transform(messages => {
        return messages.map(message => {
            if (message.role !== 'tool') { throw new Error('恢复增量只能包含工具结果。') }
            return message
        })
    }) }).optional()
}).strict()
export type ResponsesSessionSnapshot = z.infer<typeof responsesSessionSnapshotSchema>

/** Formal Backend 只接纳新的用户输入；恢复通过后端引用和核实回执完成。 */
export interface FormalBackendInput { prompt: string }

/** 本后端插件的显式配置，不扩展通用 AgentPlugin 合同。 */
export interface FormalBackendPluginOptions {
    readonly id: string
    readonly ownerId: string
    readonly model: string
    readonly baseUrl: string
    readonly apiKey?: string
    readonly headers?: HeaderSource
    readonly transport?: HttpTransport
    readonly path?: string
    readonly api?: FormalBackendApi
    readonly snapshot?: unknown
    readonly store?: { /** @param snapshot - 当前用户的增量恢复记录。 */ save(snapshot: ResponsesSessionSnapshot): void | Promise<void> }
    readonly settings?: ModelSettings
    readonly signal?: () => AbortSignal | undefined
}

/** 后端协议、压缩路由和跨轮游标均封装在本对象中。 */
export class FormalBackendPlugin implements AgentPlugin<FormalBackendInput> {
    readonly id = 'formal-backend'
    private readonly client: ResponsesModelPlugin
    private readonly createContext: FormalBackendConnection['createContext'] | undefined
    readonly hooks: AgentHooks<FormalBackendInput>
    messages: AgentMessage[] = []
    request: ModelRequest = { messages: [], tools: [] }
    private state: ResponsesSessionSnapshot
    private active: { context: AgentContext; outcome: AgentRunOutcome; original: AgentMessage[]; retry: boolean;
        sent: boolean; backend?: ResponsesSessionContext; modelInputLength?: number } | undefined
    private disposed = false
    private recovering = false
    private saveTail = Promise.resolve()

    /** @param options - 本插件绑定的后端连接与会话资源。 */
    constructor(private readonly options: FormalBackendPluginOptions) {
        const connection = options.api ? createFormalBackendConnection({ ...options, api: options.api }) : undefined
        this.client = connection?.model ?? new ResponsesModelPlugin(options)
        this.createContext = connection?.createContext
        this.state = options.snapshot === undefined ? { version: 1, id: options.id, ownerId: options.ownerId } : responsesSessionSnapshotSchema.parse(options.snapshot)
        if (this.state.id !== options.id || this.state.ownerId !== options.ownerId) { throw new Error('恢复记录与当前用户或会话不一致。') }
        const exchange = this.state.toolExchange
        if (exchange) {
            if (exchange.responseId !== this.state.responseId || !exchange.calls.length || new Set(exchange.calls.map(call => call.id)).size !== exchange.calls.length) {
                throw new Error('恢复工具增量与 Responses 游标不一致。')
            }
            const results = new Set<string>()
            for (const result of exchange.results) {
                if (!exchange.calls.some(call => call.id === result.toolCallId && call.name === result.toolName) || results.has(result.toolCallId)) { throw new Error('恢复工具增量的调用和结果不匹配。') }
                results.add(result.toolCallId)
            }
        }
        const plugin = this
        this.hooks = {
            onRunStart: async (ctx, input, outcome) => {
                this.begin(ctx, input, outcome)
                const signal = options.signal?.()
                this.request = { ...options.settings, messages: this.messages, tools: ctx.tools.definitions(), ...(signal ? { signal } : {}) }
                return { action: 'continue' }
            },
            async *model() { return yield* collectModelOutput(plugin.stream(plugin.request), plugin.request.signal) },
            afterModel: async (ctx, result) => {
                this.messages.push({ role: 'assistant', content: result.text,
                    ...(result.reasoning ? { reasoning: result.reasoning } : {}),
                    ...(result.toolCalls.length ? { toolCalls: copySessionValue(result.toolCalls) } : {}) })
                await this.record(ctx)
                return { action: 'continue' }
            },
            afterTool: async (ctx, run) => {
                const call = this.pendingToolCalls.find(item => item.id === run.call.id)
                if (call) {
                    this.messages.push({ role: 'tool', toolCallId: call.id, toolName: call.name,
                        content: run.result.content, ...(run.result.status === 'success' ? {} : { isError: true }) })
                    await this.record(ctx)
                }
                return { action: 'continue' }
            },
            onRunEnd: async (context, outcome) => {
                if (this.active?.outcome !== outcome) { return }
                try {
                    await this.record(context)
                    if (outcome.ok && !this.state.toolExchange && this.active.sent) { delete this.state.pendingInput }
                    await this.persist()
                } finally { this.active = undefined }
            }
        }
    }

    /** @param context - 本次使用后端引用的 Run。 */
    private begin(context: AgentContext, input: FormalBackendInput, outcome: AgentRunOutcome): void {
        if (typeof input === 'object' && input !== null && 'resume' in input) {
            throw new Error('当前 Responses 插件不支持本地工具续跑，请使用后端恢复能力。')
        }
        if (this.disposed) { throw new Error('后端插件已释放。') }
        if (this.active || this.recovering) { throw new Error('同一后端会话不能并发运行。') }
        if (this.pendingToolCalls.length) { throw new Error('工具批次尚未收口，请先核实并调用 completePendingTools。') }
        const original: AgentMessage[] = [{ role: 'user', content: input.prompt }]
        const retry = isPendingInput(this.state.pendingInput, original)
        const active: { context: AgentContext; outcome: AgentRunOutcome; original: AgentMessage[]; retry: boolean; sent: boolean; backend?: ResponsesSessionContext; modelInputLength?: number } = { context, outcome, original, retry, sent: false }
        if (this.createContext) { active.backend = this.createContext(() => this.active === active && !this.disposed) }
        this.active = active
        this.messages = copySessionValue(retry && !this.state.pendingInput?.accepted ? this.state.pendingInput!.prepared : [
            ...(this.state.toolExchange?.results ?? []), ...(retry && this.state.pendingInput?.accepted ? [] : original)
        ])
    }

    /** @param context - 协调提示词插件使用的当前输入判断。 */
    shouldPrepareInput(context?: AgentContext): boolean {
        return !!this.active && (context === undefined || this.active.context === context) && !this.active.retry && !this.active.sent
    }

    /** 最终消息经后端压缩和 Provider 编码后发送；Core 不读取任何游标。 @param request - 完成全部 beforeModel 改写的请求。 */
    private async *stream(request: ModelRequest): AsyncIterable<ModelEvent> {
        const active = this.active
        if (!active || this.disposed) { throw new Error('后端模型必须与所属插件一起注册。') }
        checkSessionAbort(request.signal)
        const messages = copySessionValue(!active.sent && active.retry && !this.state.pendingInput?.accepted ? this.state.pendingInput!.prepared : [...request.messages])
        this.messages = copySessionValue(messages)
        this.request.messages = this.messages
        active.modelInputLength = messages.length
        if (!active.sent && !(active.retry && this.state.pendingInput?.accepted)) {
            this.state.pendingInput = { original: active.original, prepared: copySessionValue(messages) }
        }
        await this.persist()
        checkSessionAbort(request.signal)
        let prepared: ResponsesModelRequest = { ...request, messages,
            ...(this.state.responseId === undefined ? {} : { previousResponseId: this.state.responseId }) }
        prepared = { ...prepared, messages: this.client.inputMessages(prepared) }
        // 压缩必须看到最后一份请求，不能依赖在公共 Hook 数组里排最后。
        if (active.backend) { prepared = await active.backend.prepareRequest(prepared) }
        checkSessionAbort(request.signal)
        active.modelInputLength = this.messages.length
        active.sent = true
        const calls: ToolCall[] = []
        for await (const event of (active.backend ?? this.client).stream(prepared)) {
            if (event.type === 'tool-call') { calls.push(copySessionValue(event.call)) }
            if (event.type === 'finish' && event.reason !== 'error' && event.reason !== 'cancelled' && event.reason !== 'unknown') {
                if (!('responseId' in event) || typeof event.responseId !== 'string' || !event.responseId.trim()) {
                    throw new AgentError({ code: 'PROVIDER_PROTOCOL_ERROR', phase: 'provider', message: 'Responses 完成结果缺少引用。' })
                }
                this.state.responseId = event.responseId
                if (this.state.pendingInput) { this.state.pendingInput.accepted = true }
                if (calls.length) { this.state.toolExchange = { responseId: event.responseId, calls, results: [] } }
                else { delete this.state.toolExchange }
                await this.persist()
            }
            // Provider 特有 responseId 在此收住，传给 Core 的只有通用事件。
            if (event.type === 'finish') {
                yield { type: 'finish', reason: event.reason, ...(event.rawReason === undefined ? {} : { rawReason: event.rawReason }) }
            } else { yield event }
        }
    }

    /** @param context - 已提交模型意图和工具结果的 Run。 */
    private async record(context: AgentContext): Promise<void> {
        if (this.active?.context !== context || this.disposed || !this.active.sent) { return }
        let lastAssistant = -1
        for (let index = this.messages.length - 1; index >= 0; index--) { if (this.messages[index]?.role === 'assistant') { lastAssistant = index; break } }
        const assistant = this.messages[lastAssistant]
        if (assistant?.role === 'assistant' && lastAssistant >= (this.active.modelInputLength ?? 0) && this.state.responseId) {
            if (assistant.toolCalls?.length) {
                this.state.toolExchange = { responseId: this.state.responseId, calls: copySessionValue([...assistant.toolCalls]),
                    results: copySessionValue(this.messages.slice(lastAssistant + 1).filter((message): message is Extract<AgentMessage, { role: 'tool' }> => message.role === 'tool')) }
            } else { delete this.state.toolExchange }
        }
        await this.persist()
    }

    /** 未闭合的远端工具批次，需要核实而不能自动重跑。 */
    get pendingToolCalls(): readonly ToolCall[] {
        const exchange = this.state.toolExchange
        return exchange ? copySessionValue(exchange.calls.filter(call => !exchange.results.some(result => result.toolCallId === call.id))) : []
    }

    /** @param results - 宿主核实的全部缺失工具结果。 */
    async completePendingTools(results: readonly Extract<AgentMessage, { role: 'tool' }>[]): Promise<void> {
        if (this.active || this.recovering || this.disposed || !this.pendingToolCalls.length) { throw new Error('当前没有可恢复的工具批次。') }
        this.recovering = true
        try {
            const candidate = this.snapshot()
            const exchange = candidate.toolExchange!
            const completed = [...exchange.results, ...normalizeRecoveredTools(results)]
            closedMessageBoundaries([{ role: 'assistant', content: '', toolCalls: exchange.calls }, ...completed])
            exchange.results = copySessionValue(completed)
            await this.persist(candidate)
            this.state = candidate
        } finally { this.recovering = false }
    }

    /** 返回隔离的客户端恢复记录，不复制后端权威历史。 */
    snapshot(): ResponsesSessionSnapshot { return copySessionValue(this.state) }

    /** 共享不可变历史引用；下一次请求建立新分支并获得新游标。 @param id - 新插件的会话身份。 @param store - 子插件独立存储，默认仅保存在内存中。 */
    fork(id: string, store?: FormalBackendPluginOptions['store']): FormalBackendPlugin {
        if (this.active || this.pendingToolCalls.length) { throw new Error('运行或工具批次尚未结束，核实后再分叉。') }
        const { store: _store, ...options } = this.options
        return new FormalBackendPlugin({ ...options, id, snapshot: { ...this.snapshot(), id }, ...(store === undefined ? {} : { store }) })
    }

    /** 停止使用本插件；正在运行的取消由宿主 signal 控制。 */
    dispose(): void { this.disposed = true }

    /** 有序保存隔离快照。 @param snapshot - 待提交状态，默认当前快照。 */
    private async persist(snapshot = this.snapshot()): Promise<void> {
        if (this.disposed || !this.options.store) { return }
        const saved = this.saveTail.then(() => this.options.store!.save(snapshot))
        this.saveTail = saved.catch(() => {})
        await saved
    }
}

/** @param options - 与当前 Agent 配对的后端会话配置。 */
export function createFormalBackendPlugin(options: FormalBackendPluginOptions): FormalBackendPlugin {
    return new FormalBackendPlugin(options)
}
