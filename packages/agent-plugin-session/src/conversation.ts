import type { AgentContext, AgentHooks, AgentPlugin, ToolResult } from '@quifox/agent-core'
import type { ModelTurnResult } from '@quifox/agent-core'
import type { ChatInput, ChatSessionPlugin } from './index.js'
import type { ChatModelPlugin, ModelInfo } from '@quifox/agent-plugin-model'

/** 摘要分支隐藏具体协议的请求和历史，失败候选不写回父会话。 */
export interface CompactionBranch {
    /** @param withoutTools - 最后一次候选禁止工具。 */
    generate(withoutTools: boolean): Promise<ModelTurnResult>
    /** @param result - 候选完整结果。 @returns 是否已验证并提交。 */
    accept(result: ModelTurnResult): Promise<boolean>
}

/** 组合内部的协议适配器；预算检查、切分和提交只委托一个会话 owner。 */
export interface CompactionSource {
    /** @param info - 本轮实际模型预算。 @param instruction - 摘要策略的固定指令。 */
    prepare(info: ModelInfo, instruction: string): Promise<CompactionBranch | undefined>
}

/** 会话分支参数不包含消息列表或供应商游标。 */
export interface ConversationBranchOptions { id?: string; boundary?: 'complete' | 'before-tools' | 'resume' }

/** 独立本轮记录插件贡献的恢复能力，不包含会话历史。 */
export interface ExecutionContinuation {
    replaying: boolean
    next(): ModelTurnResult | undefined
    /** 供恢复策略查询原调用是否结果未知；本接口不决定是否重试。 @param callId - 原调用身份。 */
    requiresRetry?(callId: string): boolean
}

/** 其他插件依赖的会话能力；Chat 和远端引用使用各自实现。 */
export interface Conversation extends AgentPlugin<ChatInput> {
    fork(options?: ConversationBranchOptions): Promise<Conversation>
    empty(options?: Pick<ConversationBranchOptions, 'id'>): Promise<Conversation>
    addSystemPrompt(content: string): void
    appendUserContext(content: string): void
    appendUserMessages(contents: readonly string[]): void
    readOutput(): string
    confirmTool(callId: string, result: ToolResult): Promise<void>
    prepareCompaction(info: ModelInfo, instruction: string): Promise<CompactionBranch | undefined>
}

/** 此 Context 扩展属于会话插件族，不改变 Core 公共接口。 */
export interface ConversationContext extends AgentContext { conversation: Conversation; modelInfo: ModelInfo; execution?: ExecutionContinuation }

/** Chat 的明确组合参数；衍生组合用新组件重新创建适配器。 */
export interface ChatConversationPluginOptions {
    session: ChatSessionPlugin
    generation: ChatModelPlugin
    compaction?: (session: ChatSessionPlugin, generation: ChatModelPlugin) => CompactionSource
}

/** 保留两个组件职责和全部生命周期，只向 Agent 注册一个组合插件。 */
export class ChatConversationPlugin implements Conversation {
    id = 'chat-conversation'
    readonly hooks: AgentHooks<ChatInput>
    private readonly source: CompactionSource | undefined

    /** @param options - 已配对的组件及可选压缩适配器构造。 */
    constructor(private readonly options: ChatConversationPluginOptions) {
        if (!options.generation.isBoundTo(options.session)) { throw new Error('会话组合的 Model 必须绑定同一个 Session。') }
        this.source = options.compaction?.(options.session, options.generation)
        const hooks = mergeHooks(options.session.hooks, options.generation.hooks)
        const initialize = asHandlers(hooks.onInitialize)
        const start = asHandlers(hooks.onRunStart)
        hooks.onInitialize = [async ctx => { (ctx as ConversationContext).conversation = this }, ...initialize]
        hooks.onRunStart = [async ctx => { (ctx as ConversationContext).conversation = this; return { action: 'continue' } }, ...start]
        this.hooks = hooks
    }

    /** @param options - 完整边界或工具批次之前的子会话。 */
    async fork(options: ConversationBranchOptions = {}): Promise<ChatConversationPlugin> {
        return this.compose(this.options.session.fork(options))
    }

    /** @param options - 独立的新会话身份。 */
    async empty(options: Pick<ConversationBranchOptions, 'id'> = {}): Promise<ChatConversationPlugin> {
        return this.compose(this.options.session.empty(options))
    }

    /** @param content - 可信提示词贡献。 */
    addSystemPrompt(content: string): void { this.options.session.addSystemPrompt(content) }
    /** @param content - 尚未发送的 user 附加内容。 */
    appendUserContext(content: string): void { this.options.session.appendUserContext(content) }
    /** @param contents - 本轮首次请求前按顺序追加的独立 user 消息。 */
    appendUserMessages(contents: readonly string[]): void { this.options.session.appendUserMessages(contents) }
    /** 读取 Session 所记录的最终回复。 */
    readOutput(): string { return this.options.session.readOutput() }
    /** @param callId - 待核实原调用。 @param result - 真实核实回执。 */
    async confirmTool(callId: string, result: ToolResult): Promise<void> { await this.options.session.confirmTool(callId, result) }

    /** @param info - 当前模型预算。 @param instruction - 固定摘要指令。 */
    async prepareCompaction(info: ModelInfo, instruction: string): Promise<CompactionBranch | undefined> {
        if (!this.source) { throw new Error('当前会话组合没有配置压缩适配器。') }
        return this.source.prepare(info, instruction)
    }

    /** @param session - 新的会话 owner；不共享父请求或存储回调。 */
    private compose(session: ChatSessionPlugin): ChatConversationPlugin {
        return new ChatConversationPlugin({ session, generation: this.options.generation.fork(session),
            ...(this.options.compaction ? { compaction: this.options.compaction } : {}) })
    }
}

/** @param ctx - 插件已经发布本轮组合能力的共享 Context。 */
export function getConversation(ctx: AgentContext): ConversationContext {
    const extension = ctx as Partial<ConversationContext>
    if (!extension.conversation || !extension.modelInfo) { throw new Error('当前 Agent 没有可用的会话组合能力。') }
    return extension as ConversationContext
}

/** @param value - 原始处理器或有序数组。 */
function asHandlers<Handler>(value: Handler | Handler[] | undefined): Handler[] {
    return value === undefined ? [] : Array.isArray(value) ? value : [value]
}

/** @param first - Session 钩子。 @param second - Model 钩子；生成器由其直接提供。 */
function mergeHooks(first: AgentHooks<ChatInput>, second: AgentHooks<ChatInput>): AgentHooks<ChatInput> {
    const output: Record<string, unknown> = {}
    for (const name of new Set([...Object.keys(first), ...Object.keys(second)])) {
        const key = name as keyof AgentHooks<ChatInput>
        output[name] = name === 'model' ? second.model ?? first.model : [...asHandlers<unknown>(first[key]), ...asHandlers<unknown>(second[key])]
    }
    return output as AgentHooks<ChatInput>
}
