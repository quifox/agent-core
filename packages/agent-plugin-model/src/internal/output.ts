import type { ModelEvent, ModelRequest, ModelTurnResult } from '@quifox/agent-core'
import { AgentError, createAgent } from '@quifox/agent-core'
import type { LanguageModel } from './model.js'

/** 摘要分支使用同一 Core，并在模型后停止，工具定义可保留但不执行。 @param model - 快照绑定的模型。 @param request - 隔离的完整摘要输入。 */
export async function generateSummary(model: LanguageModel, request: ModelRequest): Promise<ModelTurnResult> {
    return generateModelSummary(model.stream(request), request.signal)
}

/** Consume plugin-produced events in an isolated summary run. */
export async function generateModelSummary(events: AsyncIterable<ModelEvent>, signal?: AbortSignal): Promise<ModelTurnResult> {
    const branch = createAgent({ plugins: [{ id: 'summary-generation', hooks: {
        async *model() { return yield* collectModelOutput(events, signal) },
        afterModel: async () => ({ action: 'stop', reason: 'summary-captured' })
    } }] })
    const outcome = await branch.run(undefined)
    if (!outcome.ok) { throw outcome.error }
    if (!outcome.value) { throw protocolError('摘要分支没有取得完整模型结果。') }
    return outcome.value as ModelTurnResult
}

/** 供应商流聚合属于生成插件，Core 只消费其生成器。 @param model - 注入的模型连接。 @param request - 完整 Chat 请求。 */
export async function* collectChatOutput(model: LanguageModel, request: ModelRequest): AsyncGenerator<ModelEvent, ModelTurnResult, void> {
    return yield* collectModelOutput(model.stream(request), request.signal)
}

/** Aggregate model-plugin events without accepting a protocol client. */
export async function* collectModelOutput(events: AsyncIterable<ModelEvent>, signal?: AbortSignal): AsyncGenerator<ModelEvent, ModelTurnResult, void> {
    if (signal?.aborted) { throw new AgentError({ code: 'ABORTED', phase: 'provider', message: '模型请求已取消。' }) }
    const result: ModelTurnResult = { text: '', reasoning: '', toolCalls: [], usage: {}, finishReason: 'unknown' }
    let finished = false
    for await (const event of events) {
        if (signal?.aborted) { throw new AgentError({ code: 'ABORTED', phase: 'provider', message: '模型请求已取消。' }) }
        if (!event || finished) { throw protocolError('模型在结束后继续输出或返回了无效事件。') }
        switch (event.type) {
            case 'text-delta':
            case 'reasoning-delta':
                if (typeof event.delta !== 'string') { throw protocolError('模型增量不是文本。') }
                if (event.type === 'text-delta') { result.text += event.delta }
                else { result.reasoning += event.delta }
                break
            case 'tool-call':
                if (!event.call || typeof event.call.id !== 'string' || typeof event.call.name !== 'string') { throw protocolError('工具调用无效。') }
                result.toolCalls.push(event.call)
                break
            case 'usage':
                if (!event.usage || typeof event.usage !== 'object' || Array.isArray(event.usage)) { throw protocolError('模型用量无效。') }
                for (const key of ['inputTokens', 'outputTokens', 'totalTokens', 'cachedInputTokens', 'reasoningTokens'] as const) {
                    const value = event.usage?.[key]
                    if (value !== undefined) {
                        if (!Number.isFinite(value) || value < 0) { throw protocolError('模型用量无效。') }
                        result.usage[key] = (result.usage[key] ?? 0) + value
                    }
                }
                break
            case 'finish':
                finished = true
                result.finishReason = event.reason
                if (event.rawReason !== undefined) { result.rawFinishReason = event.rawReason }
                break
            default: throw protocolError('模型输出了未知事件。')
        }
        yield event
    }
    if (signal?.aborted) { throw new AgentError({ code: 'ABORTED', phase: 'provider', message: '模型请求已取消。' }) }
    if (!finished) { throw protocolError('模型流没有完整结束标记。') }
    return result
}

/** @param message - 不含请求内容的协议说明。 */
function protocolError(message: string): AgentError { return new AgentError({ code: 'PROVIDER_PROTOCOL_ERROR', phase: 'provider', message }) }
