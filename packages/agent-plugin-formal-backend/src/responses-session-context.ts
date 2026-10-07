import { AgentError, type ModelRequest } from '@quifox/agent-core'
import { checkSessionAbort, copySessionValue, requestIdentity } from '@quifox/agent-plugin-session'
import { generateModelSummary, type ResponsesModelPlugin, type ResponsesModelEvent, type ResponsesModelRequest } from '@quifox/agent-plugin-model'
import type { FormalBackendApi } from './index.js'
import { z } from 'zod'
import { COMPACTION_PROMPT, type SessionFork } from '@quifox/agent-plugin-compaction'

interface ResponsesSessionFork extends SessionFork {
    stream(request: ModelRequest): AsyncIterable<ResponsesModelEvent>
}

const planSchema = z.object({
    required: z.boolean(),
    context_id: z.string().min(1).optional(),
    input_tokens: z.number().int().nonnegative(),
    context_window: z.number().int().positive(),
    summary_max_output_tokens: z.number().int().positive()
})
const checkpointSchema = z.object({
    accepted: z.boolean(),
    context_id: z.string().min(1).optional()
})

/** 每个 Run 独立的 Responses 门面；只持有服务端引用及下一次请求路由。 */
export class ResponsesSessionContext {
    private pending: { identity: string; target: ResponsesModelPlugin } | undefined

    /** @param options - 现有模型、typed API、不可变引用绑定工厂与当前运行检查。 */
    constructor(
        private readonly options: {
            model: ResponsesModelPlugin
            api: FormalBackendApi
            bind: (id: string, purpose: 'summary' | 'responses') => ResponsesModelPlugin
            isCurrent: () => boolean
            summaryInstruction?: string
        }
    ) {
    }

    /** 后端预检与摘要属于本插件，不借 Core 请求参数传递。 @param request - 全部公开 beforeModel 处理后的请求。 */
    async prepareRequest(request: ResponsesModelRequest): Promise<ResponsesModelRequest> {
        const fork = await this.prepare(request)
        if (!fork) { return request }
        for (let candidate = 0; candidate < 3; candidate += 1) {
            checkSessionAbort(request.signal)
            const { signal: _signal, ...plain } = fork.request
            const input: ModelRequest = {
                ...copySessionValue(plain),
                messages: [...copySessionValue(fork.request.messages), { role: 'user', content: this.options.summaryInstruction ?? COMPACTION_PROMPT }],
                ...(candidate === 2 ? { tools: [], toolChoice: 'none' as const } : {}),
                ...(request.signal ? { signal: request.signal } : {})
            }
            let result
            try { result = await generateModelSummary(fork.stream(input), input.signal) } catch (error) {
                checkSessionAbort(request.signal)
                if (candidate === 2 || (error instanceof AgentError && error.code !== 'PROVIDER_PROTOCOL_ERROR' && !error.retryable)) { throw error }
                continue
            }
            if (result.finishReason !== 'stop' || result.toolCalls.length || !result.text.trim()) { continue }
            const accepted = await fork.accept(result)
            if (accepted) { return accepted }
        }
        throw new Error('后端摘要未通过检查点验收。')
    }

    /** @param request - Final plugin request, matching the prepared request identity. */
    async *stream(request: ModelRequest): AsyncIterable<ResponsesModelEvent> {
        checkSessionAbort(request.signal)
        const pending = this.pending
        this.pending = undefined
        if (!this.options.isCurrent()) {
            throw new Error('当前运行已过期。')
        }
        if (pending && pending.identity !== requestIdentity(request)) {
            throw new Error('压缩后的请求又发生了变化。')
        }
        yield* (pending?.target ?? this.options.model).stream(request)
    }

    /** @param request - 当前原始增量请求。 @returns 后端选定范围的隔离摘要模型。 */
    async prepare(request: ResponsesModelRequest): Promise<ResponsesSessionFork | undefined> {
        checkSessionAbort(request.signal)
        this.pending = undefined
        const { signal: _signal, ...payload } = request
        const frozen = copySessionValue(payload)
        const identity = requestIdentity(request)
        const plan = planSchema.parse(
            await this.options.api.prepareAgentContext(
                {
                    request: {
                        ...this.options.model.requestBody(request),
                        stream: false
                    },
                    summary_instruction: this.options.summaryInstruction ?? COMPACTION_PROMPT,
                    summary_max_output_tokens: Math.min(
                        4096,
                        request.maxOutputTokens ?? 4096
                    )
                },
                { signal: request.signal }
            )
        )
        checkSessionAbort(request.signal)
        if (!this.options.isCurrent() || requestIdentity(request) !== identity) {
            throw new Error('当前会话快照已过期。')
        }
        if (!plan.required) {
            if (plan.context_id) {
                this.pending = {
                    identity,
                    target: this.options.bind(plan.context_id, 'responses')
                }
            }
            return undefined
        }
        const id = plan.context_id
        if (!id) {
            throw new Error('服务端缺少分叉引用。')
        }
        const summary = this.options.bind(id, 'summary')
        let candidateId: string | undefined
        return {
            stream: async function* (input) {
                    candidateId = undefined
                    for await (const event of summary.stream(input)) {
                        if (event.type === 'finish' && 'responseId' in event) { candidateId = event.responseId }
                        yield event
                    }
                },
            request: {
                ...frozen,
                messages: [],
                maxOutputTokens: plan.summary_max_output_tokens
            },
            accept: async (_result) => {
                checkSessionAbort(request.signal)
                if (
                    !this.options.isCurrent() ||
                    requestIdentity(request) !== identity
                ) {
                    throw new Error('当前会话快照已过期。')
                }
                if (!candidateId) {
                    throw new Error('服务端摘要缺少 Response ID。')
                }
                const checkpoint = checkpointSchema.parse(
                    await this.options.api.commitAgentCheckpoint(
                        {
                            contextId: id,
                            agentCheckpointRequest: {
                                candidate_response_id: candidateId
                            }
                        },
                        { signal: request.signal }
                    )
                )
                checkSessionAbort(request.signal)
                if (
                    !this.options.isCurrent() ||
                    requestIdentity(request) !== identity
                ) {
                    throw new Error('当前会话快照已过期。')
                }
                if (!checkpoint.accepted) {
                    return undefined
                }
                if (!checkpoint.context_id) {
                    throw new Error('服务端缺少检查点引用。')
                }
                const prepared = { ...frozen, ...(request.signal === undefined ? {} : { signal: request.signal }) }
                this.pending = {
                    identity,
                    target: this.options.bind(checkpoint.context_id, 'responses')
                }
                return prepared
            }
        }
    }
}
