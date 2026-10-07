import type { AgentHooks, AgentPlugin, AgentRunOutcome } from '@quifox/agent-core'
import type { HttpTransport } from './internal/http.js'
import type { HeaderSource } from './internal/openai-compatible.js'
import { createOpenAIResponsesProvider, toResponsesRequest, selectResponsesInputMessages,
    type ResponsesLanguageModel, type ResponsesModelRequest, type ResponsesModelEvent } from './internal/openai-responses.js'
import { collectModelOutput } from './internal/output.js'

/** Connection parameters for the Responses model plugin. */
export interface ResponsesModelPluginOptions {
    model: string
    baseUrl: string
    apiKey?: string
    headers?: HeaderSource
    transport?: HttpTransport
    path?: string
}

/** Responses generation; a cooperating Session owns continuation and persistence. */
export class ResponsesModelPlugin implements AgentPlugin<ResponsesModelRequest> {
    id = 'responses-model'
    readonly hooks: AgentHooks<ResponsesModelRequest>
    request: ResponsesModelRequest = { messages: [], tools: [] }
    private readonly client: ResponsesLanguageModel
    private activeOutcome: AgentRunOutcome | undefined

    /** @param options - Model connection configuration, without an external client. */
    constructor(private readonly options: ResponsesModelPluginOptions) {
        this.client = createOpenAIResponsesProvider({ ...options, id: 'responses' }).languageModel(options.model)
        const plugin = this
        this.hooks = {
            onRunStart: async (_ctx, input, outcome) => {
                if (this.activeOutcome) { throw new Error('Responses model plugin is already handling a run.') }
                this.activeOutcome = outcome
                this.request = input
                return { action: 'continue' }
            },
            async *model() { return yield* collectModelOutput(plugin.stream(plugin.request), plugin.request.signal) },
            onRunEnd: async (_ctx, outcome) => {
                if (this.activeOutcome === outcome) { this.activeOutcome = undefined }
            }
        }
    }

    get modelId(): string { return this.options.model }

    /** Stream protocol-specific events for a composing Session plugin. */
    stream(request: ResponsesModelRequest): AsyncIterable<ResponsesModelEvent> {
        return this.client.stream(request)
    }

    /** Project a request for backend budget/checkpoint APIs. */
    requestBody(request: ResponsesModelRequest) {
        return toResponsesRequest(request, this.options.model)
    }

    /** Select the increment after the Session-owned server cursor. */
    inputMessages(request: ResponsesModelRequest) {
        return selectResponsesInputMessages(request)
    }
}
