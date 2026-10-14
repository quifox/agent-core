import { defineTool, toolError, toolSuccess, type AgentContext, type AgentHooks, type AgentPlugin, type AgentRunOutcome, type ToolResult } from '@quifox/agent-core'
import type { ChatInput } from '@quifox/agent-plugin-session'
import { z } from 'zod'
import { MEMORY_READ_INSTRUCTIONS } from './prompts.js'
import { MemoryInputError, MemoryService, MemoryUnavailableError, memoryToolText } from './service.js'
import { memoryNoteInputSchema, conversationSendInputSchema, conversationListInputSchema } from './tool-input.js'

/** Identity comes from a trusted host binding, never model tool arguments. */
export interface MemoryBinding {
    ownerId: string
    conversationId: string
    context: { set(key: string, content: string): void }
    /** Resolve a tool call to its durable assistant-batch identity for safe mutation recovery. */
    operationId?(callId: string): string
    useMemory?: boolean
}

/** One shared object can serve independent Agents without shared current-user slots. */
export interface MemoryPluginOptions {
    service: MemoryService
    binding(ctx: AgentContext): MemoryBinding
    schedule?(binding: MemoryBinding): void
    /** Observe failed noncritical usage feedback without receiving user data. */
    onFeedbackError?(): void
}

/** Read/search/source verification and persistent cross-conversation messages. */
export class MemoryPlugin implements AgentPlugin<ChatInput> {
    id = 'memory'
    readonly hooks: AgentHooks<ChatInput>
    private readonly active = new WeakMap<AgentContext, AgentRunOutcome>()
    private readonly runs = new Map<AgentRunOutcome, { binding: MemoryBinding; toolCallId?: string }>()

    /** @param options - Shared service plus per-Agent trusted binding. */
    constructor(private readonly options: MemoryPluginOptions) {
        this.hooks = {
            onInitialize: async ctx => { this.register(ctx, !!options.binding(ctx).operationId) },
            onRunStart: async (ctx, _input, outcome) => {
                if (this.active.has(ctx)) { throw new Error('Memory binding already has an active run.') }
                const binding = options.binding(ctx)
                this.active.set(ctx, outcome); this.runs.set(outcome, { binding })
                options.schedule?.(binding)
                return { action: 'continue' }
            },
            beforeModel: async ctx => {
                const run = this.run(ctx)
                if (run.binding.useMemory === false) { run.binding.context.set('memory', ''); return { action: 'continue' } }
                const current = await options.service.global(run.binding.ownerId)
                run.binding.context.set('memory', `${MEMORY_READ_INSTRUCTIONS}\n\n${current.content}`)
                return { action: 'continue' }
            },
            beforeTool: async (ctx, call) => {
                const owned = ['memory_list', 'memory_read', 'memory_search', 'memory_note', 'conversation_list', 'conversation_read', 'conversation_search', 'conversation_send']
                if (owned.includes(call.name) && ctx.tools.get(call.name)?.inputSchema.safeParse(call.input).success === false) {
                    return { action: 'result', result: toolError('Memory request is invalid.', { code: 'MEMORY_INPUT_INVALID' }) }
                }
                this.run(ctx).toolCallId = call.id
                return { action: 'continue' }
            },
            afterTool: async (ctx, result) => {
                const run = this.run(ctx)
                if (run.toolCallId === result.call.id) { delete run.toolCallId }
                return { action: 'continue' }
            },
            afterModel: async (ctx, result) => {
                if (!result.toolCalls.length && this.run(ctx).binding.useMemory !== false) {
                    try {
                        await options.service.recordUsage(this.run(ctx).binding.ownerId, [...result.text.matchAll(/\[memory:([A-Za-z0-9_-]+)\]/g)].map(match => match[1]!))
                    } catch {
                        // Usage telemetry must not turn a persisted answer into pending retry input.
                        try { options.onFeedbackError?.() } catch { /* Observers cannot change the answer outcome. */ }
                    }
                }
                return { action: 'continue' }
            },
            onRunEnd: async (ctx, outcome) => {
                if (this.active.get(ctx) === outcome) { this.active.delete(ctx); this.runs.delete(outcome) }
            }
        }
    }

    /** @param ctx - Long-lived Agent context; Outcome is the run identity. */
    private run(ctx: AgentContext): { binding: MemoryBinding; toolCallId?: string } {
        const outcome = this.active.get(ctx); const run = outcome ? this.runs.get(outcome) : undefined
        if (!run) { throw new Error('No active memory binding.') }
        return run
    }

    /** Register only explicit, bounded, owner-scoped service tools. @param ctx - Initializing Agent. */
    private register(ctx: AgentContext, noteRetrySafe: boolean): void {
        const read = z.object({ ref: z.string().min(1).max(300), startLine: z.number().int().positive().default(1), limit: z.number().int().min(1).max(200).default(40) }).strict()
        const query = z.object({ query: z.string().min(1).max(500), limit: z.number().int().min(1).max(100).default(20) }).strict()
        ctx.tools.register(defineTool({ name: 'conversation_list', description: 'List owned conversations, including empty or unsummarized ones. Filter by title with query; follow nextCursor for more pages.', inputSchema: conversationListInputSchema, policy: { sideEffect: 'none', approval: 'none' },
            execute: async (input, context) => executeMemoryTool(() => this.options.service.listConversations(this.run(context).binding.ownerId, input)) }))
        ctx.tools.register(defineTool({ name: 'memory_list', description: 'List memory titles, descriptions and exact summary/source references.', inputSchema: z.object({ limit: z.number().int().min(1).max(200).default(30) }).strict(), policy: { sideEffect: 'none', approval: 'none' },
            execute: async (input, context) => executeMemoryTool(() => this.options.service.list(this.run(context).binding.ownerId, input.limit)) }))
        ctx.tools.register(defineTool({ name: 'memory_read', description: 'Read a supplied memory path or memory-notes reference in bounded line ranges. Follow truncated pages using startLine plus returned line count.', inputSchema: read, policy: { sideEffect: 'none', approval: 'none' },
            execute: async (input, context) => executeMemoryTool(() => this.options.service.read(this.run(context).binding.ownerId, input.ref, input.startLine, input.limit)) }))
        ctx.tools.register(defineTool({ name: 'memory_search', description: 'Locate relevant memory summaries using keywords; misses do not prove no prior discussion.', inputSchema: query, policy: { sideEffect: 'none', approval: 'none' },
            execute: async (input, context) => executeMemoryTool(() => this.options.service.search(this.run(context).binding.ownerId, input.query, input.limit)) }))
        ctx.tools.register(defineTool({ name: 'conversation_read', description: 'Verify original Chat JSONL. Follow truncated pages with returned nextLine and nextOffset as startLine and startOffset; lineFragment marks part of a redacted physical line.', inputSchema: read.extend({ startOffset: z.number().int().nonnegative().default(0) }), policy: { sideEffect: 'none', approval: 'none' },
            execute: async (input, context) => executeMemoryTool(() => this.options.service.readSource(this.run(context).binding.ownerId, input.ref, input.startLine, input.limit, input.startOffset)) }))
        ctx.tools.register(defineTool({ name: 'conversation_search', description: 'Keyword search original Chat conversations, including those not yet summarized.', inputSchema: query, policy: { sideEffect: 'none', approval: 'none' },
            execute: async (input, context) => executeMemoryTool(() => this.options.service.searchSource(this.run(context).binding.ownerId, input.query, input.limit)) }))
        ctx.tools.register(defineTool({ name: 'memory_note', description: 'Append an explicit user request to remember/correct/forget; use only when the user asked.', inputSchema: memoryNoteInputSchema, policy: { sideEffect: 'external', approval: 'none', retrySafe: noteRetrySafe },
            execute: async (input, context) => {
                const run = this.run(context)
                const callId = run.toolCallId
                if (!callId) { throw new Error('Memory note execution has no active tool call identity.') }
                return executeMemoryTool(() => this.options.service.note(run.binding.ownerId,
                    { kind: input.kind, content: input.content, ...(input.conversationId === undefined ? {} : { conversationId: input.conversationId }) },
                    run.binding.operationId?.(callId)))
            } }))
        ctx.tools.register(defineTool({ name: 'conversation_send', description: 'Send a message to another owned conversation. The server assigns its message ID and handles retry deduplication. Queued delivery does not mean the target finished.', inputSchema: conversationSendInputSchema, policy: { sideEffect: 'external', approval: 'none', retrySafe: noteRetrySafe },
            execute: async (input, context) => {
                const run = this.run(context)
                if (!run.toolCallId) { throw new Error('Message dispatch has no active tool call identity.') }
                const operationId = run.binding.operationId?.(run.toolCallId)
                return executeMemoryTool(() => this.options.service.send(run.binding.ownerId, run.binding.conversationId, input.conversationId, input.content, operationId))
            } }))
    }
}

/** Convert only explicit service-level business failures; infrastructure errors remain recoverable failures. @param operation - Service call. */
async function executeMemoryTool<T>(operation: () => Promise<T>): Promise<ToolResult> {
    try { return toolSuccess(memoryToolText(await operation())) }
    catch (error) {
        if (error instanceof MemoryUnavailableError || error instanceof MemoryInputError) { return toolError(error.message, { code: error.code }) }
        throw error
    }
}
