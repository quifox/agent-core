import type { AgentMessage, AgentRunOutcome } from '@quifox/agent-core'
import { z } from 'zod'
import type { AgentHooks, AgentPlugin, ToolCall, ToolResult } from '@quifox/agent-core'
import type { ConversationContext } from './conversation.js'
import { ChatSessionHistory, copySessionValue, closedMessageBoundaries, pendingSessionToolCalls, normalizeRecoveredTools, type SessionEntry } from './history.js'
export { ChatConversationPlugin, getConversation } from './conversation.js'
export type { Conversation, ConversationContext, CompactionSource, CompactionBranch, ConversationBranchOptions, ChatConversationPluginOptions, ExecutionContinuation } from './conversation.js'

export { checkSessionAbort, copySessionValue, requestIdentity, closedMessageBoundaries, pendingSessionToolCalls, normalizeRecoveredTools, ChatSessionHistory } from './history.js'
export type { SessionContext, SessionEntry } from './history.js'

/** 会话插件自己的输入合同；其他插件组合可定义完全不同的 Core 输入。 */
export type ChatInput = { prompt: string } | { resume: true }

/** 验证恢复与存储边界的数据；普通钩子不因此复制消息。 */
export const sessionMessageSchema = z.discriminatedUnion('role', [
    z.object({ role: z.literal('system'), content: z.string() }),
    z.object({ role: z.literal('user'), content: z.string() }),
    z.object({ role: z.literal('assistant'), content: z.string(), reasoning: z.string().optional(),
        toolCalls: z.array(z.object({ id: z.string().min(1), name: z.string().min(1), input: z.unknown() })).optional() }),
    z.object({ role: z.literal('tool'), content: z.string(), toolCallId: z.string().min(1), toolName: z.string().min(1), isError: z.boolean().optional() })
]).transform(value => copySessionValue(value) as AgentMessage)

export const pendingInputSchema = z.object({
    original: z.array(sessionMessageSchema), prepared: z.array(sessionMessageSchema)
}).strict()

export const chatSessionSnapshotSchema = z.object({
    version: z.literal(1), id: z.string().min(1), ownerId: z.string().min(1),
    history: z.array(z.object({ id: z.string().min(1), message: sessionMessageSchema, compaction: z.object({
        sourcePoint: z.number().int().nonnegative(), coveredStart: z.string().min(1), coveredEnd: z.string().min(1), retainedFrom: z.string().optional()
    }).optional() }).transform(value => copySessionValue(value) as SessionEntry)),
    pendingInput: pendingInputSchema.optional()
}).strict()
export type ChatSessionSnapshot = z.infer<typeof chatSessionSnapshotSchema>

/** 存储和会话身份只属于这个插件。 */
export interface ChatSessionPluginOptions {
    id: string
    ownerId: string
    snapshot?: unknown
    history?: ChatSessionHistory
    store?: { save(snapshot: ChatSessionSnapshot): void | Promise<void> }
}

/** 由会话 owner 决定分叉位置和子存储，不属于 Core 参数。 */
export interface SessionForkOptions {
    id?: string
    boundary?: 'complete' | 'before-tools' | 'resume'
    store?: ChatSessionPluginOptions['store']
}

/** 跨轮消息的唯一 owner；生成、压缩和提示词插件显式引用此对象。 */
export class ChatSessionPlugin implements AgentPlugin<ChatInput> {
    id = 'session-memory'
    messages: AgentMessage[]
    readonly hooks: AgentHooks<ChatInput>
    private archive: ChatSessionHistory
    private pending: ChatSessionSnapshot['pendingInput']
    private active: { outcome: AgentRunOutcome; context: object; original: AgentMessage[]; sent: boolean; retry: boolean } | undefined
    private saving = Promise.resolve()
    private branchSequence = 0

    /** @param options - 会话身份与可选恢复、存储。 */
    constructor(private readonly options: ChatSessionPluginOptions) {
        const snapshot = options.snapshot === undefined ? undefined : chatSessionSnapshotSchema.parse(options.snapshot)
        if (snapshot && (snapshot.id !== options.id || snapshot.ownerId !== options.ownerId)) { throw new Error('恢复记录与当前会话或用户不一致。') }
        this.archive = options.history ?? new ChatSessionHistory(snapshot ? { history: snapshot.history } : {})
        if (snapshot && options.history && JSON.stringify(snapshot.history) !== JSON.stringify(options.history.history)) { throw new Error('恢复历史与注入的记录不一致。') }
        this.messages = [...this.archive.messages]
        this.pending = snapshot?.pendingInput
        this.hooks = {
            onRunStart: async (ctx, input, outcome) => {
                if (this.active) { throw new Error('会话插件正在运行。') }
                if ('resume' in input) {
                    this.active = { outcome, context: ctx, original: copySessionValue(this.pending?.original ?? []), sent: true, retry: false }
                    return { action: 'continue' }
                }
                if (this.pendingToolCalls.length) { throw new Error('请先核实未闭合的工具批次。') }
                const original: AgentMessage[] = [{ role: 'user', content: input.prompt }]
                const retry = isPendingInput(this.pending, original)
                this.active = { outcome, context: ctx, original: copySessionValue(original), sent: false, retry }
                if (retry) { this.messages = copySessionValue(this.pending!.prepared) }
                else {
                    this.messages.push(...copySessionValue(original))
                    this.pending = { original: copySessionValue(original), prepared: copySessionValue(this.messages) }
                }
                return { action: 'continue' }
            },
            afterModel: async (ctx, result) => {
                if ((ctx as ConversationContext).execution?.replaying) { return { action: 'continue' } }
                this.messages.push({ role: 'assistant', content: result.text, ...(result.reasoning ? { reasoning: result.reasoning } : {}),
                    ...(result.toolCalls.length ? { toolCalls: copySessionValue(result.toolCalls) } : {}) })
                this.archive.record(this.messages)
                await this.persist()
                return { action: 'continue' }
            },
            afterTool: async (_ctx, run) => {
                const call = this.pendingToolCalls.find(item => item.id === run.call.id)
                if (call) {
                    this.messages.push({ role: 'tool', toolCallId: call.id, toolName: call.name,
                        content: run.result.content, ...(run.result.status === 'success' ? {} : { isError: true }) })
                    this.archive.record(this.messages)
                    await this.persist()
                }
                return { action: 'continue' }
            },
            onRunEnd: async (_ctx, outcome) => {
                if (this.active?.outcome !== outcome) { return }
                try {
                    if (this.pendingToolCalls.length === 0 && outcome.ok) { this.pending = undefined }
                    else if (this.pending) { this.pending.prepared = copySessionValue(this.messages) }
                    this.prepareUnsentInput(this.messages)
                    await this.persist()
                } finally { this.active = undefined }
            }
        }
    }

    /** 新的外部输入可注入环境；模型循环、维护和冻结重试不重复注入。 */
    shouldPrepareInput(): boolean { return !!this.active && !this.active.sent && !this.active.retry }

    /** 生成插件在真正请求前调用；保存失败不允许开始网络 I/O。 @param messages - 所有 beforeModel 处理后的消息。 */
    async acceptRequest(messages: readonly AgentMessage[]): Promise<AgentMessage[]> {
        if (!this.active) { throw new Error('生成插件必须与活动会话插件一起使用。') }
        if (this.active.retry && !this.active.sent && this.pending) { messages = copySessionValue(this.pending.prepared) }
        closedMessageBoundaries(messages)
        if (messages !== this.messages) { this.messages = [...messages] }
        this.prepareUnsentInput(this.messages)
        this.pending = {
            original: copySessionValue(this.active.original),
            prepared: copySessionValue(this.messages)
        }
        this.archive.record(this.messages)
        await this.persist()
        this.active.sent = true
        return this.messages
    }

    /** 未知工具结果派生自消息，不另存一份运行计数。 */
    get pendingToolCalls(): readonly ToolCall[] { return pendingSessionToolCalls(this.messages) }

    /** 核实后恢复消息；不重新执行工具。 @param results - 全部待恢复调用的明确回执。 */
    async completePendingTools(results: readonly Extract<AgentMessage, { role: 'tool' }>[]): Promise<void> {
        if (this.active || !this.pendingToolCalls.length) { throw new Error('当前没有可恢复的工具批次。') }
        const messages = [...this.messages, ...normalizeRecoveredTools(results)]
        closedMessageBoundaries(messages)
        const archive = new ChatSessionHistory({ history: this.archive.history })
        archive.record(messages)
        const snapshot = { ...this.snapshot(), history: [...archive.history] }
        if (snapshot.pendingInput) { snapshot.pendingInput.prepared = copySessionValue(messages) }
        await this.persist(snapshot)
        this.messages = messages
        this.archive = archive
        this.pending = snapshot.pendingInput
    }

    /** @param callId - 未确认的原调用。 @param result - 核实后的回执，允许其余调用仍未开始。 */
    async confirmTool(callId: string, result: ToolResult): Promise<void> {
        if (this.active) { throw new Error('运行期间不能恢复工具回执。') }
        const call = this.pendingToolCalls.find(item => item.id === callId)
        if (!call) { throw new Error('没有该待核实工具调用。') }
        const message = normalizeRecoveredTools([{ role: 'tool', toolCallId: call.id, toolName: call.name,
            content: result.content, ...(result.status === 'success' ? {} : { isError: true }) }])[0]!
        const archive = new ChatSessionHistory({ history: this.archive.history })
        const messages = [...this.messages, message]
        archive.record(messages)
        const snapshot = { ...this.snapshot(), history: [...archive.history] }
        if (snapshot.pendingInput) { snapshot.pendingInput.prepared = copySessionValue(messages) }
        await this.persist(snapshot)
        this.messages = messages; this.archive = archive; this.pending = snapshot.pendingInput
    }

    /** 只有明确的持久化与 Fork 边界复制状态。 */
    snapshot(): ChatSessionSnapshot {
        return chatSessionSnapshotSchema.parse({ version: 1, id: this.options.id, ownerId: this.options.ownerId, history: this.archive.history,
            ...(this.pending === undefined ? {} : { pendingInput: this.pending }) })
    }

    /** 压缩提交保留完整原记录，只改变可发送投影。 @param history - 追加了有效检查点的记录。 */
    async acceptCompaction(history: readonly SessionEntry[]): Promise<void> {
        const archive = new ChatSessionHistory({ history })
        const snapshot = { ...this.snapshot(), history: [...archive.history] }
        if (snapshot.pendingInput) snapshot.pendingInput.prepared = copySessionValue([...archive.messages])
        await this.persist(snapshot)
        this.messages.splice(0, this.messages.length, ...archive.messages)
        this.archive = archive
        this.pending = snapshot.pendingInput
    }

    /** @param options - Child identity or branch boundary. @param store - Child storage for the string-identity form. */
    fork(options: string | SessionForkOptions = {}, store?: ChatSessionPluginOptions['store']): ChatSessionPlugin {
        const branch = typeof options === 'string' ? { id: options, ...(store ? { store } : {}) } : options
        if (branch.boundary === 'resume' && this.active) { throw new Error('恢复分叉必须先结束父运行。') }
        if (branch.boundary === undefined || branch.boundary === 'complete') {
            if (this.active || this.pendingToolCalls.length) {
                throw new Error('运行或工具批次尚未结束，不能 Fork。')
            }
        }
        const id = branch.id ?? `${this.options.id}/fork-${++this.branchSequence}`
        let history = this.archive.history
        if (this.pendingToolCalls.length && branch.boundary !== 'resume') {
            let cut = -1
            for (let index = this.messages.length - 1; index >= 0; index -= 1) {
                const message = this.messages[index]
                if (message?.role === 'assistant' && message.toolCalls?.length) { cut = index; break }
            }
            const prefix = this.messages.slice(0, cut)
            closedMessageBoundaries(prefix)
            history = this.archive.forkAt(cut).history
        } else if (branch.boundary !== 'resume') { closedMessageBoundaries(this.messages) }
        return new ChatSessionPlugin({ id, ownerId: this.options.ownerId,
            snapshot: { version: 1, id, ownerId: this.options.ownerId, history }, ...(branch.store ? { store: branch.store } : {}) })
    }

    /** @param options - 子会话身份与独立存储；不复制父历史。 */
    empty(options: Pick<SessionForkOptions, 'id' | 'store'> = {}): ChatSessionPlugin {
        return new ChatSessionPlugin({ id: options.id ?? `${this.options.id}/empty-${++this.branchSequence}`,
            ownerId: this.options.ownerId, ...(options.store ? { store: options.store } : {}) })
    }

    /** @param content - 可信系统内容，只添加不存在的相同内容。 */
    addSystemPrompt(content: string): void {
        if (!content.trim() || this.messages.some(message => message.role === 'system' && message.content === content)) { return }
        const index = this.messages.findIndex(message => message.role !== 'system')
        this.messages.splice(index < 0 ? this.messages.length : index, 0, { role: 'system', content })
        this.archive.addSystemPrompt({ role: 'system', content })
    }

    /** @param content - 仅补充尚未发送的新 user，不修改已接纳历史。 */
    appendUserContext(content: string): void {
        if (!this.shouldPrepareInput()) { return }
        const last = this.messages.at(-1)
        if (last?.role === 'user') { last.content += `\n\n${content}` }
    }

    /** @param contents - 同一模型请求前接纳的额外 user 消息。 */
    appendUserMessages(contents: readonly string[]): void {
        if (!contents.length) { return }
        if (!this.active || this.active.sent || this.active.retry) {
            throw new Error('只能在本轮首次模型请求前追加用户消息。')
        }
        this.messages.push(...copySessionValue(contents.map(content => ({ role: 'user' as const, content }))))
        if (this.pending) { this.pending.prepared = copySessionValue(this.messages) }
    }

    /** Append admitted steering input at a complete model-request boundary. */
    appendSteeringMessages(contents: readonly string[]): boolean {
        if (!contents.length) return true
        if (!this.active || (this.active.retry && !this.active.sent) || this.pendingToolCalls.length) {
            return false
        }
        closedMessageBoundaries(this.messages)
        this.messages.push(...copySessionValue(contents.map(content => ({ role: 'user' as const, content }))))
        if (this.pending) this.pending.prepared = copySessionValue(this.messages)
        return true
    }

    /** 最终回复来自唯一会话记录，不另维护一份累计文本。 */
    readOutput(): string {
        const last = this.messages.at(-1)
        return last?.role === 'assistant' && !last.toolCalls?.length ? last.content : ''
    }

    /** @param messages - 全部钩子准备后的当前输入；仅修正压缩提前暂存的尾部 user。 */
    private prepareUnsentInput(messages: readonly AgentMessage[]): void {
        const last = messages.at(-1)
        if (this.active && !this.active.sent && !this.active.retry && last?.role === 'user' && this.archive.messages.length === messages.length) {
            this.archive.prepareLastInput(last)
        }
    }

    /** @param snapshot - 独立保存值；串行等待避免慢写覆盖新状态。 */
    private async persist(snapshot = this.snapshot()): Promise<void> {
        const store = this.options.store
        if (!store) { return }
        const saved = this.saving.then(() => store.save(snapshot))
        this.saving = saved.catch(() => {})
        await saved
    }
}

/** @param options - 会话插件自身配置。 */
export function createChatSessionPlugin(options: ChatSessionPluginOptions): ChatSessionPlugin { return new ChatSessionPlugin(options) }

/** @param pending - 未完成输入。 @param original - 本次原输入。 */
export function isPendingInput(pending: z.infer<typeof pendingInputSchema> | undefined, original: readonly AgentMessage[]): boolean {
    return !!pending && JSON.stringify(pending.original) === JSON.stringify(original)
}
