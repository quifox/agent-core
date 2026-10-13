import type { AgentContext, AgentHooks, AgentMessage, AgentPlugin, ModelRequest, ModelSettings, ToolCall, ModelTurnResult } from '@quifox/agent-core'
import { createOpenAICompatibleProvider, type HeaderSource, type AssistantReasoningField } from './internal/openai-compatible.js'
import type { HttpTransport } from './internal/http.js'
import type { LanguageModel } from './internal/model.js'
import { collectChatOutput, generateSummary } from './internal/output.js'
import { copyModelValue, modelValueIdentity } from './internal/value.js'

/** History admission supplied by a cooperating Chat Session plugin. */
export interface ChatSessionSource {
    readonly messages: readonly AgentMessage[]
    readonly pendingToolCalls: readonly ToolCall[]
    acceptRequest(messages: readonly AgentMessage[]): Promise<AgentMessage[]>
}

/** Public model configuration; protocol clients are created inside the plugin. */
export interface ChatModelPluginOptions {
    session: ChatSessionSource
    model: string
    /** Known Chat protocol dialect; omitted for a custom compatible endpoint. */
    provider?: string
    baseUrl: string
    apiKey?: string
    headers?: HeaderSource
    transport?: HttpTransport
    path?: string
    includeUsage?: boolean
    assistantReasoningField?: AssistantReasoningField
    settings?: ModelSettings
    signal?: () => AbortSignal | undefined
    contextWindow?: number
    maxInputTokens?: number
}

/** Model metadata published by the plugin for cooperating capabilities. */
export interface ModelInfo {
    modelId: string
    contextWindow?: number
    maxInputTokens?: number
    maxOutputTokens?: number
}

interface ModelContext extends AgentContext {
    modelInfo: ModelInfo
    execution?: { next(): ModelTurnResult | undefined }
}

/** Chat generation through ordinary Hooks, with a private protocol client. */
export class ChatModelPlugin implements AgentPlugin {
    id = 'chat-model'
    readonly hooks: AgentHooks
    private readonly client: LanguageModel
    private currentRequest: ModelRequest | undefined

    /** @param options - Session and model connection/settings configuration. */
    constructor(private readonly options: ChatModelPluginOptions) {
        this.client = createOpenAICompatibleProvider({
            ...options,
            id: options.provider ?? 'chat',
            ...(options.provider === 'deepseek' && options.assistantReasoningField === undefined ? { assistantReasoningField: 'reasoning_content' as const } : {})
        }).languageModel(options.model)
        const plugin = this
        this.hooks = {
            onInitialize: async ctx => { (ctx as ModelContext).modelInfo = this.info },
            onRunStart: async ctx => { (ctx as ModelContext).modelInfo = this.info; return { action: 'continue' } },
            beforeStep: async ctx => {
                const signal = options.signal?.()
                this.currentRequest = {
                    ...options.settings, messages: options.session.messages, tools: ctx.tools.definitions(),
                    ...(signal === undefined ? {} : { signal })
                }
                return { action: 'continue' }
            },
            async *model(ctx) {
                const resumed = (ctx as ModelContext).execution?.next()
                if (resumed) {
                    if (modelValueIdentity(resumed.toolCalls) !== modelValueIdentity(options.session.pendingToolCalls)) {
                        throw new Error('本轮执行记录与会话待恢复调用不一致。')
                    }
                    return resumed
                }
                const request = { ...plugin.request }
                const messages = await options.session.acceptRequest(request.messages)
                request.messages = copyModelValue(messages)
                request.tools = copyModelValue(request.tools)
                return yield* collectChatOutput(plugin.client, request)
            }
        }
    }

    /** Mutable request shared with ordered beforeModel handlers. */
    get request(): ModelRequest {
        if (!this.currentRequest) { throw new Error('Chat 请求尚未准备；请检查插件顺序。') }
        return this.currentRequest
    }

    /** @param session - Session identity checked by Conversation composition. */
    isBoundTo(session: ChatSessionSource): boolean { return session === this.options.session }

    /** Metadata has no protocol client or connection factory. */
    get info(): ModelInfo {
        return { modelId: this.options.model,
            ...(this.options.contextWindow === undefined ? {} : { contextWindow: this.options.contextWindow }),
            ...(this.options.maxInputTokens === undefined ? {} : { maxInputTokens: this.options.maxInputTokens }),
            ...(this.options.settings?.maxOutputTokens === undefined ? {} : { maxOutputTokens: this.options.settings.maxOutputTokens }) }
    }

    /** @param session - Child Session; parent cancellation is not inherited. */
    fork(session: ChatSessionSource, signal?: () => AbortSignal | undefined): ChatModelPlugin {
        const { signal: _signal, ...options } = this.options
        return new ChatModelPlugin({ ...options, session, ...(signal ? { signal } : {}) })
    }

    /** Generate an isolated summary without exposing the protocol client. */
    async summarize(request: ModelRequest): Promise<ModelTurnResult> {
        return generateSummary(this.client, request)
    }
}
