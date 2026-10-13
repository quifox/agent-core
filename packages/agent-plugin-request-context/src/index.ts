import type { AgentHooks, AgentPlugin, AgentRunOutcome, AgentMessage, ToolResult } from '@quifox/agent-core'
import type { ChatModelPlugin, ChatSessionSource, ModelInfo } from '@quifox/agent-plugin-model'
import type { ChatInput, ChatSessionPlugin, CompactionBranch, CompactionSource,
    Conversation, ConversationBranchOptions, ConversationContext } from '@quifox/agent-plugin-session'

/** A request-only context contribution. It is excluded from Session history and snapshots. */
export class RequestContextPlugin implements AgentPlugin<ChatInput> {
    id = 'request-context'
    readonly hooks: AgentHooks<ChatInput>
    readonly source: ChatSessionSource
    private readonly contributions = new Map<string, string>()
    private activeOutcome: AgentRunOutcome | undefined

    /** @param session - The only owner of canonical Chat messages and persistence. */
    constructor(private readonly session: ChatSessionPlugin) {
        const plugin = this
        this.source = {
            get messages() { return session.messages },
            get pendingToolCalls() { return session.pendingToolCalls },
            async acceptRequest(messages) {
                const accepted = await session.acceptRequest(messages)
                return plugin.project(accepted)
            }
        }
        this.hooks = {
            onRunStart: async (_ctx, _input, outcome) => {
                if (this.activeOutcome) { throw new Error('Request context is already active for this conversation.') }
                this.activeOutcome = outcome
                this.contributions.clear()
                return { action: 'continue' }
            },
            beforeModel: async () => {
                this.requireActiveOutcome()
                this.contributions.clear()
                return { action: 'continue' }
            },
            onRunEnd: async (_ctx, outcome) => {
                if (this.activeOutcome !== outcome) { return }
                this.contributions.clear()
                this.activeOutcome = undefined
            }
        }
    }

    /** @param session - Candidate Session identity for a Conversation composition. */
    isBoundTo(session: ChatSessionPlugin): boolean { return this.session === session }

    /** @param key - Stable plugin-owned contribution key. @param content - Current model-only content; empty content removes it. */
    set(key: string, content: string): void {
        this.requireActiveOutcome()
        if (!/^[A-Za-z0-9._:-]{1,128}$/.test(key)) { throw new Error('Request context keys must use 1-128 safe identifier characters.') }
        if (typeof content !== 'string') { throw new TypeError('Request context content must be a string.') }
        if (content.trim()) { this.contributions.set(key, content) }
        else { this.contributions.delete(key) }
    }

    /** Return the current run's ordered contribution projection for diagnostics. */
    snapshot(): { key: string; content: string }[] {
        this.requireActiveOutcome()
        return [...this.contributions].map(([key, content]) => ({ key, content }))
    }

    /** @param messages - Canonical messages; returns a fresh model-only projection without mutating them. */
    project(messages: readonly AgentMessage[]): AgentMessage[] {
        this.requireActiveOutcome()
        const canonical = [...messages]
        if (!this.contributions.size) { return canonical }
        const body = [...this.contributions].map(([key, content]) => `## ${key}\n${content}`).join('\n\n')
        const context: AgentMessage = {
            role: 'system',
            content: `Temporary context supplied by plugins. It is not part of the conversation history.\n\n${body}`
        }
        const firstNonSystem = canonical.findIndex(message => message.role !== 'system')
        const insertionIndex = firstNonSystem < 0 ? canonical.length : firstNonSystem
        canonical.splice(insertionIndex, 0, context)
        return canonical
    }

    /** @param outcome - The run identity expected to own current contributions. */
    private requireActiveOutcome(outcome?: AgentRunOutcome): AgentRunOutcome {
        const active = this.activeOutcome
        if (!active || (outcome && active !== outcome)) { throw new Error('Request context is available only during its active run.') }
        return active
    }
}

/** A Chat Conversation that composes canonical Session storage with a request-only projection. */
export class ContextualChatConversationPlugin implements Conversation {
    id = 'contextual-chat-conversation'
    readonly hooks: AgentHooks<ChatInput>
    private readonly compactionSource: CompactionSource | undefined

    /** @param options - A Session, its request adapter, generation bound to that adapter, and optional compaction factory. */
    constructor(private readonly options: ContextualChatConversationPluginOptions) {
        if (!options.context.isBoundTo(options.session)) { throw new Error('Request context must wrap the Conversation Session.') }
        if (!options.generation.isBoundTo(options.context.source)) { throw new Error('Chat Model must be bound to the request context source.') }
        this.compactionSource = options.compaction?.(options.session, options.generation, options.context)
        const hooks = mergeHooks(options.session.hooks, options.generation.hooks, options.context.hooks)
        const initialize = asHandlers(hooks.onInitialize)
        const start = asHandlers(hooks.onRunStart)
        hooks.onInitialize = [async ctx => { (ctx as ConversationContext).conversation = this }, ...initialize]
        hooks.onRunStart = [async ctx => { (ctx as ConversationContext).conversation = this; return { action: 'continue' } }, ...start]
        this.hooks = hooks
    }

    /** @param options - A complete-history or before-tools child boundary. */
    async fork(options: ConversationBranchOptions = {}): Promise<ContextualChatConversationPlugin> {
        return this.compose(this.options.session.fork(options), options.signal)
    }

    /** @param options - A new independent conversation identity. */
    async empty(options: Pick<ConversationBranchOptions, 'id' | 'signal'> = {}): Promise<ContextualChatConversationPlugin> {
        return this.compose(this.options.session.empty(options), options.signal)
    }

    /** @param content - Trusted prompt content owned by Session. */
    addSystemPrompt(content: string): void { this.options.session.addSystemPrompt(content) }
    /** @param content - Additional content for an unsent user input. */
    appendUserContext(content: string): void { this.options.session.appendUserContext(content) }
    /** @param contents - Ordered standalone user messages for the first request. */
    appendUserMessages(contents: readonly string[]): void { this.options.session.appendUserMessages(contents) }
    /** @param contents - Steering messages for a complete model request boundary. */
    appendSteeringMessages(contents: readonly string[]): boolean { return this.options.session.appendSteeringMessages(contents) }
    /** The final assistant response recorded by Session. */
    readOutput(): string { return this.options.session.readOutput() }
    /** @param callId - The original pending call. @param result - Its verified receipt. */
    async confirmTool(callId: string, result: ToolResult): Promise<void> { await this.options.session.confirmTool(callId, result) }

    /** @param info - Current model budget. @param instruction - Fixed compaction instruction. */
    async prepareCompaction(info: ModelInfo, instruction: string): Promise<CompactionBranch | undefined> {
        if (!this.compactionSource) { throw new Error('This Conversation has no compaction adapter.') }
        return this.compactionSource.prepare(info, instruction)
    }

    /** @param session - Child Session; request contributions do not carry across branches. */
    private compose(session: ChatSessionPlugin, signal?: () => AbortSignal | undefined): ContextualChatConversationPlugin {
        const context = new RequestContextPlugin(session)
        return new ContextualChatConversationPlugin({
            session,
            context,
            generation: this.options.generation.fork(context.source, signal),
            ...(this.options.compaction ? { compaction: this.options.compaction } : {})
        })
    }
}

/** Request context is recalculated on each attempt and is not frozen with Session pending input. */
export interface ContextualChatConversationPluginOptions {
    session: ChatSessionPlugin
    generation: ChatModelPlugin
    context: RequestContextPlugin
    compaction?: (session: ChatSessionPlugin, generation: ChatModelPlugin, context: RequestContextPlugin) => CompactionSource
}

/** @param values - Original handlers or their ordered list. */
function asHandlers<Handler>(values: Handler | Handler[] | undefined): Handler[] {
    return values === undefined ? [] : Array.isArray(values) ? values : [values]
}

/** @param first - Canonical Session hooks. @param second - Model hooks. @param third - Request context hooks. */
function mergeHooks(first: AgentHooks<ChatInput>, second: AgentHooks<ChatInput>, third: AgentHooks<ChatInput>): AgentHooks<ChatInput> {
    const output: Record<string, unknown> = {}
    for (const name of new Set([...Object.keys(first), ...Object.keys(second), ...Object.keys(third)])) {
        const key = name as keyof AgentHooks<ChatInput>
        if (name === 'model') { output[name] = third.model ?? second.model ?? first.model }
        else { output[name] = [...asHandlers<unknown>(first[key]), ...asHandlers<unknown>(second[key]), ...asHandlers<unknown>(third[key])] }
    }
    return output as AgentHooks<ChatInput>
}
