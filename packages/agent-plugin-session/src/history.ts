import { z } from 'zod'
import { AgentError, type AgentHooks, type ToolCall } from '@quifox/agent-core'
import { type ModelRequest, type AgentMessage } from '@quifox/agent-core'

/** 在微信兼容信号上检查取消，不依赖原生 throwIfAborted。 @param signal - 父运行信号。 */
export function checkSessionAbort(signal?: AbortSignal): void {
    if (signal?.aborted) {
        throw new AgentError({
            code: 'ABORTED',
            phase: 'run',
            message: '会话操作已取消。'
        })
    }
}

const recoveredToolMessageSchema = z.object({
    role: z.literal('tool'),
    toolCallId: z.string().min(1),
    toolName: z.string().min(1),
    content: z.string(),
    isError: z.boolean().optional()
}).transform(({ isError, ...value }) => ({ ...value, ...(isError === undefined ? {} : { isError }) }))

/** 宿主组合的会话边界；Responses 只持有引用，具体压缩由插件贡献钩子。 */
export interface SessionContext<TContext = undefined> {
    readonly messages?: readonly AgentMessage[]
    readonly history?: readonly SessionEntry[]
    readonly hooks?: AgentHooks<TContext>
    /** @param messages - Accepted message projection supplied by the Session owner. */
    record?(messages: readonly AgentMessage[]): void
}

/** 一条原始消息或压缩消息；摘要只保存于 message.content。 */
export interface SessionEntry {
    readonly id: string
    readonly message: AgentMessage
    readonly compaction?: {
        readonly sourcePoint: number
        readonly coveredStart: string
        readonly coveredEnd: string
        readonly retainedFrom?: string
    }
}

/** JSON 模型数据的隔离快照，AbortSignal 单独保留。 @param value - JSON 数据。 */
export function copySessionValue<T>(value: T): T {
    return JSON.parse(JSON.stringify(value)) as T
}

/** JSON 对象字段顺序不构成内容变化；数组顺序仍属于合同。 @param value - 消息或配置内容。 */
export function sessionValueIdentity(value: unknown): string {
    return JSON.stringify(value, (_key, item: unknown) => {
        if (!item || typeof item !== 'object' || Array.isArray(item)) { return item }
        return Object.fromEntries(Object.entries(item).sort(([left], [right]) => left.localeCompare(right)))
    })
}

/** 比较 JSON 模型状态，不把取消信号参与内容指纹。 @param request - 待比较请求。 */
export function requestIdentity(request: ModelRequest): string {
    const { signal: _signal, ...value } = request
    return sessionValueIdentity(value)
}

/** 校验完整工具批次，并返回每个闭合边界和最近批次的起点。 @param messages - 有效消息。 */
export function closedMessageBoundaries(messages: readonly AgentMessage[]): {
    boundaries: number[]
    latestBatch: number
} {
    const pending = new Map<string, string>()
    const boundaries = [0]
    let latestBatch = -1
    for (const [index, message] of messages.entries()) {
        if (message.role === 'tool') {
            if (pending.get(message.toolCallId) !== message.toolName) {
                throw new Error('工具调用与结果未完整配对。')
            }
            pending.delete(message.toolCallId)
        } else {
            if (pending.size > 0) {
                throw new Error('工具批次未完成。')
            }
            if (message.role === 'assistant' && message.toolCalls?.length) {
                latestBatch = index
                for (const call of message.toolCalls) {
                    if (!call.id || pending.has(call.id)) {
                        throw new Error('工具调用 ID 重复或为空。')
                    }
                    pending.set(call.id, call.name)
                }
            }
        }
        if (pending.size === 0) {
            boundaries.push(index + 1)
        }
    }
    if (pending.size > 0) {
        throw new Error('工具批次缺少最终结果。')
    }
    return { boundaries, latestBatch }
}

/** 从未收口历史派生缺失调用；不创建第二份会话状态。 @param messages - 当前有效消息。 */
export function pendingSessionToolCalls(messages: readonly AgentMessage[]): readonly ToolCall[] {
    let index = messages.length - 1
    while (index >= 0 && messages[index]?.role !== 'assistant') { index -= 1 }
    const message = messages[index]
    if (message?.role !== 'assistant') { return [] }
    const pending = new Map((message.toolCalls ?? []).map(call => [call.id, call]))
    for (const result of messages.slice(index + 1)) {
        if (result.role === 'tool' && pending.get(result.toolCallId)?.name === result.toolName) { pending.delete(result.toolCallId) }
    }
    return copySessionValue([...pending.values()])
}

/** @param results - 待核实的恢复消息。 @returns 验证后的窄工具消息列表。 @internal */
export function normalizeRecoveredTools(results: readonly Extract<AgentMessage, { role: 'tool' }>[]): Extract<AgentMessage, { role: 'tool' }>[] {
    return results.map(result => recoveredToolMessageSchema.parse(result))
}

/** Chat 权威追加记录；有效上下文由记录中的最新检查点派生。 */
export class ChatSessionHistory implements SessionContext {
    protected readonly entries: SessionEntry[]
    protected revision = 0

    /** @param options - Recoverable message history owned by this Session. */
    constructor(options: { history?: readonly SessionEntry[] }) {
        this.entries = copySessionValue([...(options.history ?? [])])
        if (
            new Set(this.entries.map((entry) => entry.id)).size !==
            this.entries.length
        ) {
            throw new Error('会话记录 ID 重复。')
        }
        this.revision = this.entries.length
    }

    /** 完整历史快照，调用方修改它不能影响权威记录。 */
    get history(): readonly SessionEntry[] {
        return copySessionValue(this.entries)
    }

    /** 从权威记录派生本次可发送的消息；恢复时不会展开已覆盖原文。 */
    get messages(): readonly AgentMessage[] {
        return copySessionValue(this.project().map((entry) => entry.message))
    }

    /** 从最近的 assistant 批次派生待恢复调用；不是第二份运行状态。 */
    get pendingToolCalls(): readonly ToolCall[] {
        return pendingSessionToolCalls(this.messages)
    }

    /**
      * 由宿主核实执行状态后闭合中断批次；不执行业务、不产生 Attempt。
      * @param results - 对全部缺失调用的已确认结果、取消说明或明确未确认状态。
      */
    completePendingTools(
        results: readonly Extract<AgentMessage, { role: 'tool' }>[]
    ): void {
        if (this.pendingToolCalls.length === 0) {
            throw new Error('没有待恢复的工具批次。')
        }
        const normalized = normalizeRecoveredTools(results)
        const candidate = [...this.messages, ...normalized]
        closedMessageBoundaries(candidate)
        this.record(candidate)
    }

    /** @param message - 在安全输入接纳边界追加的消息。 */
    append(message: AgentMessage): void {
        do { this.revision += 1 } while (this.entries.some(entry => entry.id === `message_${this.revision}`))
        this.entries.push({
            id: `message_${this.revision}`,
            message: copySessionValue(message)
        })
    }

    /** 按最近的完整检查点恢复有效消息及其记录 ID。 */
    protected project(): SessionEntry[] {
        const checkpoint = [...this.entries]
            .reverse()
            .find((entry) => entry.compaction !== undefined)
        if (!checkpoint?.compaction) {
            const entries = this.entries.filter((entry) => entry.compaction === undefined)
            return [...entries.filter(entry => entry.message.role === 'system'), ...entries.filter(entry => entry.message.role !== 'system')]
        }
        const retained = checkpoint.compaction.retainedFrom
        const start =
            retained === undefined
                ? this.entries.indexOf(checkpoint) + 1
                : this.entries.findIndex((entry) => entry.id === retained)
        if (start < 0) {
            throw new Error('检查点保留范围不完整。')
        }
        return [
            ...this.entries.filter((entry) => entry.message.role === 'system'),
            checkpoint,
            ...this.entries
                .slice(start)
                .filter(
                    (entry) =>
                        entry.compaction === undefined && entry.message.role !== 'system'
                )
        ]
    }

    /** @param count - 有效视图中的完整前缀长度；覆盖的原文与检查点保留。 @internal */
    forkAt(count: number): ChatSessionHistory {
        const projection = this.project()
        if (!Number.isInteger(count) || count < 0 || count > projection.length) { throw new Error('会话分叉位置无效。') }
        closedMessageBoundaries(projection.slice(0, count).map(entry => entry.message))
        const omitted = new Set(projection.slice(count).map(entry => entry.id))
        return new ChatSessionHistory({ history: this.entries.filter(entry => !omitted.has(entry.id)) })
    }

    /** @param message - 压缩中暂存、尚未实际发送的当前 user；保持同一记录 ID。 @internal */
    prepareLastInput(message: Extract<AgentMessage, { role: 'user' }>): void {
        const entry = this.project().at(-1)
        if (entry?.message.role !== 'user') { throw new Error('当前暂存输入不是 user。') }
        this.entries[this.entries.indexOf(entry)] = { ...entry, message: copySessionValue(message) }
    }

    /** @param message - 本轮提示词插件新增的 system；原始记录保留，投影置于前缀。 @internal */
    addSystemPrompt(message: Extract<AgentMessage, { role: 'system' }>): void {
        if (!this.entries.some(entry => entry.message.role === 'system' && entry.message.content === message.content)) { this.append(message) }
    }

    /** Append Session-accepted messages. @param messages - Effective projection and new messages. */
    record(messages: readonly AgentMessage[]): void {
        const projected = this.project().map((entry) => entry.message)
        if (
            sessionValueIdentity(messages.slice(0, projected.length)) !==
            sessionValueIdentity(projected)
        ) {
            throw new Error('会话输入与当前有效上下文不一致。')
        }
        for (const message of messages.slice(projected.length)) {
            this.append(message)
        }
    }

}
