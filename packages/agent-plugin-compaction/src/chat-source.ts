import type { ModelRequest, ModelTurnResult } from '@quifox/agent-core'
import { copySessionValue, requestIdentity, checkSessionAbort,
    type ChatSessionPlugin, type CompactionSource, type CompactionBranch } from '@quifox/agent-plugin-session'
import type { ChatModelPlugin, ModelInfo } from '@quifox/agent-plugin-model'
import { ChatSessionContext } from './context.js'

/** @param request - 完整 Chat 输入；按 UTF-8 字节及协议开销保守估算，非精确 tokenizer。 */
export function estimateChatInputTokens(request: ModelRequest): number {
    const { signal: _signal, ...input } = request
    let bytes = 0
    for (const char of JSON.stringify(input)) {
        const point = char.codePointAt(0)!
        bytes += point <= 0x7f ? 1 : point <= 0x7ff ? 2 : point <= 0xffff ? 3 : 4
    }
    return bytes + 64 + 16 * (request.messages.length + request.tools.length)
}

/** Chat 的请求和历史只在这个适配器内部访问；公开分支不包含 messages。 */
export class ChatCompactionSource implements CompactionSource {
    /** @param session - 唯一消息 owner。 @param generation - 配对生成实现。 @param estimate - 完整投影估算器。 */
    constructor(private readonly session: ChatSessionPlugin, private readonly generation: ChatModelPlugin,
        private readonly estimate: (request: ModelRequest) => number = estimateChatInputTokens) {}

    /** @param info - 实际模型预算。 @param instruction - 固定压缩指令。 */
    async prepare(info: ModelInfo, instruction: string): Promise<CompactionBranch | undefined> {
        const request = this.generation.request
        if (!info.contextWindow || !request.maxOutputTokens) {
            throw new Error('压缩需要实际模型容量和本轮输出预算。')
        }
        if (info.maxInputTokens !== undefined && (!Number.isSafeInteger(info.maxInputTokens) || info.maxInputTokens <= 0)) {
            throw new Error('模型输入上限无效。')
        }
        const capacity = Math.min(info.contextWindow, info.maxInputTokens === undefined ? info.contextWindow : info.maxInputTokens + request.maxOutputTokens)
        const context = new ChatSessionContext({ contextWindow: capacity,
            summaryInstruction: instruction, history: this.session.snapshot().history, estimate: candidate => {
                const value = this.estimate(candidate)
                if (!Number.isFinite(value) || value < 0) { throw new Error('上下文估算器返回无效值。') }
                return value
            } })
        const identity = requestIdentity(request)
        const sessionIdentity = JSON.stringify(this.session.messages)
        const fork = await context.prepare(request)
        if (!fork) { return undefined }
        const { signal: _signal, ...plain } = fork.request
        return {
            generate: async withoutTools => {
                checkSessionAbort(request.signal)
                const input: ModelRequest = { ...copySessionValue(plain),
                    messages: [...copySessionValue(fork.request.messages), { role: 'user', content: instruction }],
                    ...(withoutTools ? { tools: [], toolChoice: 'none' as const } : {}),
                    ...(request.signal ? { signal: request.signal } : {}) }
                try { return await this.generation.summarize(input) }
                catch (error) { checkSessionAbort(request.signal); throw error }
            },
            accept: async (result: ModelTurnResult) => {
                checkSessionAbort(request.signal)
                if (identity !== requestIdentity(request) || sessionIdentity !== JSON.stringify(this.session.messages)) {
                    throw new Error('会话已变化，不能提交过期摘要。')
                }
                const prepared = await fork.accept(result)
                if (!prepared) { return false }
                checkSessionAbort(request.signal)
                await this.session.acceptCompaction(context.history)
                request.messages = this.session.messages
                return true
            }
        }
    }

}
