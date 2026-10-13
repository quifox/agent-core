// Workflow adapted from OpenAI Codex memories/write, commit 806d9732, Apache-2.0.
// Host CAS storage replaces Codex's SQLite leases and local Git workspace.
import { createAgent, defineTool, toolError, toolSuccess, type AgentPlugin, type ModelTurnResult } from '@quifox/agent-core'
import { ChatModelPlugin, type ChatModelPluginOptions } from '@quifox/agent-plugin-model'
import { ChatConversationPlugin, ChatSessionPlugin, type ChatInput } from '@quifox/agent-plugin-session'
import { estimateChatInputTokens } from '@quifox/agent-plugin-compaction'
import { z } from 'zod'
import { DEFAULT_MEMORY_POLICY, type ConversationArchive, type ConversationMemory, type MemoryConversation, type MemoryNote, type MemoryPolicy, type MemoryState, type MemoryStore } from './contracts.js'
import { conversationMemoryPath, renderConversationMemory, renderGlobalMemory, validateGlobalMemory } from './documents.js'
import { redactMemorySecrets, selectMemoryEvidence, truncateMemoryText, utf8Bytes } from './evidence.js'
import { CONSOLIDATION_PROMPT, EXTRACTION_PROMPT } from './prompts.js'
import { consolidatedNoteWatermark, sourceReadPage } from './service.js'
import { maintenanceNotes, maintenanceVersion, summaryVisible, updateMemoryState } from './state.js'

const extractionSchema = z.object({ description: z.string(), summary: z.string() }).strict()
const { $schema: _schemaVersion, ...extractionJsonSchema } = z.toJSONSchema(extractionSchema)
const readSchema = z.object({ ref: z.string().min(1), startLine: z.number().int().positive().default(1), limit: z.number().int().min(1).max(200).default(40), startOffset: z.number().int().nonnegative().default(0) }).strict()
const notesReadSchema = z.object({ start: z.number().int().positive().default(1), limit: z.number().int().min(1).max(20).default(20) }).strict()
const notesSearchSchema = z.object({ query: z.string().trim().min(1).max(500), limit: z.number().int().min(1).max(20).default(20) }).strict()
const NOTE_BATCH_MAX_COUNT = 32
const NOTE_BATCH_MAX_BYTES = 20_000
class MemoryBudgetExceeded extends Error {}
class MemorySourceChanged extends Error {}

interface NoteBatchEntry extends MemoryNote {
    index: number
    contentTruncated?: true
    metadataTruncated?: true
}

interface NoteBatch {
    entries: NoteBatchEntry[]
    targetWatermark: number
    requiresRead: Set<number>
}

/** All I/O and trusted token generation are supplied by the host. */
export interface MemoryProcessorOptions {
    store: MemoryStore
    archive: ConversationArchive
    model: Omit<ChatModelPluginOptions, 'session'>
    /** Defaults to strict json-schema; choose an explicit mode for other Chat capabilities. */
    extractionFormat?: MemoryExtractionFormat
    newId(): string
    now?(): number
    policy?: Partial<MemoryPolicy>
}

/** Explicit extraction capability; the processor never silently downgrades. */
export type MemoryExtractionFormat = 'json-schema' | 'json-object' | 'text'

/** Outcomes describe processing, never claim semantic memory accuracy. */
export interface MemoryPassResult { extracted: number; consolidated: boolean; errors: string[] }

/** Independent, owner-scoped background pipeline built on ordinary Agent Core. */
export class MemoryProcessor {
    readonly policy: MemoryPolicy
    private readonly clock: () => number

    /** @param options - Explicit source/storage/model capabilities. */
    constructor(private readonly options: MemoryProcessorOptions) {
        this.policy = { ...DEFAULT_MEMORY_POLICY, ...options.policy }
        this.clock = options.now ?? Date.now
        if (options.extractionFormat !== undefined && !['json-schema', 'json-object', 'text'].includes(options.extractionFormat)) {
            throw new Error('Invalid memory extraction format.')
        }
        for (const [name, value] of Object.entries(this.policy)) {
            if (!Number.isSafeInteger(value) || value < 0 || (['maxConcurrentExtractions', 'inputTokens', 'leaseMs', 'maxConsolidationSteps'].includes(name) && value === 0)) {
                throw new Error(`Invalid memory policy: ${name}.`)
            }
        }
        this.inputBudget()
    }

    /** Run eligible extraction followed by one global consolidation. @param ownerId - Authenticated owner. @param currentConversationId - Active root source to exclude. */
    async run(ownerId: string, currentConversationId?: string): Promise<MemoryPassResult> {
        const result: MemoryPassResult = { extracted: 0, consolidated: false, errors: [] }
        const conversations = (await this.options.archive.list(ownerId)).filter(conversation => conversation.ownerId === ownerId)
        const state = await this.options.store.load(ownerId)
        const now = this.clock()
        const eligible = conversations.filter(conversation => {
            const updated = Date.parse(conversation.updatedAt)
            const job = state.jobs[conversation.id]
            return conversation.id !== currentConversationId && !conversation.active && conversation.generateMemory && !state.revoked.includes(conversation.id) &&
                Number.isFinite(updated) && now - updated >= this.policy.minIdleMs && now - updated <= this.policy.maxAgeMs &&
                (conversation.revision > (job?.watermark ?? 0) || maintenanceVersion(state, conversation.id) > (job?.noteWatermark ?? 0)) &&
                (!job || (job.expiresAt <= now && job.retryAt <= now))
        }).sort((a, b) => b.updatedAt.localeCompare(a.updatedAt) || a.id.localeCompare(b.id)).slice(0, this.policy.maxConversations)
        for (let offset = 0; offset < eligible.length; offset += this.policy.maxConcurrentExtractions) {
            const outcomes = await Promise.allSettled(eligible.slice(offset, offset + this.policy.maxConcurrentExtractions).map(conversation => this.extract(ownerId, conversation)))
            for (const outcome of outcomes) {
                if (outcome.status === 'fulfilled') { if (outcome.value) { result.extracted += 1 } }
                else { result.errors.push(outcome.reason instanceof MemoryBudgetExceeded ? 'extraction_input_budget_exceeded' : 'extraction_failed') }
            }
        }
        try { result.consolidated = await this.consolidate(ownerId, conversations) }
        catch (error) { result.errors.push(error instanceof MemoryBudgetExceeded ? 'consolidation_input_budget_exceeded' : 'consolidation_failed') }
        return result
    }

    /** Claim, regenerate and publish one source; stale workers keep no write authority. @param ownerId - Trusted owner. @param conversation - Source snapshot. */
    private async extract(ownerId: string, conversation: MemoryConversation): Promise<boolean> {
        const token = this.options.newId()
        const claimed = await updateMemoryState(this.options.store, ownerId, state => {
            const prior = state.jobs[conversation.id]; const now = this.clock()
            if (state.revoked.includes(conversation.id) || (prior && ((prior.watermark >= conversation.revision &&
                (prior.noteWatermark ?? 0) >= maintenanceVersion(state, conversation.id)) || prior.expiresAt > now || prior.retryAt > now))) { return false }
            state.jobs[conversation.id] = { token, expiresAt: now + this.policy.leaseMs, retryAt: 0, watermark: prior?.watermark ?? 0, noteWatermark: prior?.noteWatermark ?? 0 }
            return true
        })
        if (!claimed) { return false }
        const stopHeartbeat = this.heartbeat(ownerId, conversation.id, token)
        try {
            const records = await this.options.archive.records(ownerId, conversation.sourceRef)
            const noteWatermark = claimed.notes.length
            const metadata = redactMemorySecrets(JSON.stringify({ title: conversation.title,
                createdAt: conversation.createdAt, updatedAt: conversation.updatedAt, maintenance: maintenanceNotes(claimed, conversation.id) }))
            const modelWindow = this.options.model.maxInputTokens ?? this.options.model.contextWindow
            const tokens = modelWindow ? Math.min(this.policy.inputTokens,
                Math.max(1, Math.floor((this.inputBudget() - utf8Bytes(EXTRACTION_PROMPT) - utf8Bytes(metadata) - 2_000) / 8))) : this.policy.inputTokens
            const evidence = selectMemoryEvidence(records, tokens)
            const output = await this.generate(ownerId, EXTRACTION_PROMPT,
                `Conversation metadata and maintenance: ${metadata}\n${evidence.text}`)
            const candidate = extractionSchema.parse(JSON.parse(output.text))
            if ((candidate.description.trim().length === 0) !== (candidate.summary.trim().length === 0)) { throw new Error('Partial empty extraction is invalid.') }
            const current = (await this.options.archive.list(ownerId)).find(item => item.id === conversation.id)
            if (!current || current.revision !== conversation.revision || !current.generateMemory) { throw new MemorySourceChanged('Source changed during extraction.') }
            const published = await updateMemoryState(this.options.store, ownerId, state => {
                const job = state.jobs[conversation.id]
                if (!job || job.token !== token || job.expiresAt <= this.clock() || state.revoked.includes(conversation.id) ||
                    maintenanceVersion(state, conversation.id) > noteWatermark) { return false }
                if (candidate.summary.trim()) {
                    const previous = state.summaries[conversation.id]
                    state.summaries[conversation.id] = {
                        conversationId: conversation.id, path: conversationMemoryPath(conversation), title: conversation.title,
                        description: truncateMemoryText(redactMemorySecrets(candidate.description), 1_024),
                        summary: truncateMemoryText(redactMemorySecrets(candidate.summary), 9_000), sourceRef: conversation.sourceRef,
                        sourceUpdatedAt: conversation.updatedAt, sourceRevision: conversation.revision, generatedAt: new Date(this.clock()).toISOString(), noteWatermark,
                        usageCount: previous?.usageCount ?? 0, ...(previous?.lastUsedAt ? { lastUsedAt: previous.lastUsedAt } : {})
                    }
                } else { delete state.summaries[conversation.id] }
                job.watermark = conversation.revision; job.noteWatermark = noteWatermark; job.expiresAt = 0; job.retryAt = 0; delete job.error
                return true
            })
            if (!published) { await this.fail(ownerId, conversation.id, token, 'stale_extraction', 0) }
            return published !== undefined
        } catch (error) {
            await this.fail(ownerId, conversation.id, token, error instanceof MemorySourceChanged ? 'stale_extraction' : 'extraction_failed',
                error instanceof MemorySourceChanged ? 0 : this.policy.retryMs)
            throw error
        } finally { await stopHeartbeat() }
    }

    /** Select useful supported summaries in stable order. @param state - Owner state. @param conversations - Existing sources. */
    private select(state: MemoryState, conversations: readonly MemoryConversation[]): ConversationMemory[] {
        const allowed = new Set(conversations.filter(item => item.generateMemory).map(item => item.id))
        return Object.values(state.summaries).filter(memory => allowed.has(memory.conversationId) && summaryVisible(state, memory) &&
            this.clock() - Date.parse(memory.lastUsedAt ?? memory.sourceUpdatedAt) <= this.policy.maxUnusedMs)
            .sort((a, b) => b.usageCount - a.usageCount || (b.lastUsedAt ?? b.sourceUpdatedAt).localeCompare(a.lastUsedAt ?? a.sourceUpdatedAt) || a.conversationId.localeCompare(b.conversationId))
            .slice(0, this.policy.maxSummaries).sort((a, b) => a.conversationId.localeCompare(b.conversationId))
    }

    /** Exact input identity excludes lease heartbeats and usage-counter churn. @param state - Owner state. @param selected - Stable selected sources. @param noteWatermark - Batch covered by this candidate. */
    private fingerprint(state: MemoryState, selected: readonly ConversationMemory[], noteWatermark: number): string {
        return JSON.stringify({ summaries: selected.map(({ usageCount: _count, lastUsedAt: _used, ...memory }) => memory),
            noteWatermark, notesTotal: state.notes.length, revoked: state.revoked })
    }

    /** New independent Agent verifies sources and proposes one bounded document. @param ownerId - Trusted owner. @param conversations - Source catalogue. */
    private async consolidate(ownerId: string, conversations: readonly MemoryConversation[]): Promise<boolean> {
        const initial = await this.options.store.load(ownerId)
        const selected = this.select(initial, conversations)
        const observedSources = new Map(conversations.map(source => [source.id, {
            revision: source.revision, sourceRef: source.sourceRef, updatedAt: source.updatedAt, title: source.title
        }]))
        const noteWatermark = consolidatedNoteWatermark(initial)
        const noteBatch = selectNoteBatch(initial.notes, noteWatermark)
        const fingerprint = this.fingerprint(initial, selected, noteBatch.targetWatermark)
        if (fingerprint === normalizedFingerprint(initial.consolidatedFingerprint)) {
            try { validateGlobalMemory(initial.global, selected); return false } catch { /* Repair a missing/invalid artifact. */ }
        }
        const token = this.options.newId()
        const claimed = await updateMemoryState(this.options.store, ownerId, state => {
            const now = this.clock(); const job = state.consolidation
            if (job && (job.expiresAt > now || job.retryAt > now)) { return false }
            state.consolidation = { token, expiresAt: now + this.policy.leaseMs, retryAt: 0, watermark: job?.watermark ?? 0 }
            return true
        })
        if (!claimed) { return false }
        const stopHeartbeat = this.heartbeat(ownerId, undefined, token)
        let candidate: string | undefined
        const requiredNoteReads = noteBatch.requiresRead
        const readNoteIndexes = new Set<number>()
        const sourceRefs = new Set(selected.map(memory => memory.sourceRef))
        const tools = [
            defineTool({ name: 'memory_read', description: 'Read an exact selected conversation summary.', inputSchema: z.object({ path: z.string() }).strict(), policy: { sideEffect: 'none', approval: 'none' },
                execute: async input => {
                    const memory = selected.find(item => item.path === input.path)
                    if (!memory) { throw new Error('Memory source is not available.') }
                    const current = await this.options.store.load(ownerId)
                    if (current.revoked.includes(memory.conversationId)) { throw new Error('Memory source was revoked.') }
                    return toolSuccess(redactMemorySecrets(renderConversationMemory(memory)))
                } }),
            defineTool({ name: 'conversation_read', description: 'Verify original JSONL. Follow truncated pages using nextLine/nextOffset as startLine/startOffset; lineFragment marks a redacted line fragment.', inputSchema: readSchema, policy: { sideEffect: 'none', approval: 'none' },
                execute: async input => {
                    await this.assertSource(ownerId, input.ref, selected, sourceRefs)
                    const result = await this.options.archive.read(ownerId, input.ref, input.startLine, input.limit)
                    return toolSuccess(JSON.stringify(sourceReadPage(result, input.startOffset)))
                } }),
            defineTool({ name: 'conversation_search', description: 'Find original evidence in selected conversation archives.', inputSchema: z.object({ query: z.string().min(1).max(500) }).strict(), policy: { sideEffect: 'none', approval: 'none' },
                execute: async input => {
                    const current = await this.options.store.load(ownerId)
                    const allowed = selected.filter(item => !current.revoked.includes(item.conversationId)).map(item => item.conversationId)
                    const matches = (await this.options.archive.search(ownerId, input.query, 30, allowed)).filter(item => sourceRefs.has(item.ref) && !current.revoked.includes(item.conversationId))
                    return toolSuccess(truncateMemoryText(redactMemorySecrets(JSON.stringify(matches)), 12_000))
                } }),
            defineTool({ name: 'notes_read', description: 'Read up to 20 append-only memory notes by one-based archive range.', inputSchema: notesReadSchema, policy: { sideEffect: 'none', approval: 'none' },
                execute: async input => {
                    const end = Math.min(initial.notes.length, input.start - 1 + input.limit)
                    const notes = initial.notes.slice(input.start - 1, end).map((note, offset) => {
                        const index = input.start + offset
                        readNoteIndexes.add(index)
                        return { index, ...note }
                    })
                    return toolSuccess(redactMemorySecrets(JSON.stringify({ start: input.start, notes })))
                } }),
            defineTool({ name: 'notes_search', description: 'Search append-only memory notes by keyword; use notes_read to verify a full match.', inputSchema: notesSearchSchema, policy: { sideEffect: 'none', approval: 'none' },
                execute: async input => {
                    const words = [...new Set(input.query.normalize('NFKC').toLocaleLowerCase().split(/\s+/).filter(Boolean))]
                    const matches = initial.notes.map((note, offset) => {
                        const content = note.content.normalize('NFKC').toLocaleLowerCase()
                        const score = words.filter(word => content.includes(word)).length
                        return score ? { index: offset + 1, id: note.id, kind: note.kind, createdAt: note.createdAt,
                            ...(note.conversationId ? { conversationId: note.conversationId } : {}),
                            content: truncateMemoryText(redactMemorySecrets(note.content), 512), score } : undefined
                    }).filter((match): match is NonNullable<typeof match> => match !== undefined)
                    matches.sort((a, b) => b.score - a.score || b.index - a.index)
                    return toolSuccess(JSON.stringify(matches.slice(0, input.limit)))
                } }),
            defineTool({ name: 'memory_publish', description: 'Submit the complete candidate memory.md; server publication follows successful completion.', inputSchema: z.object({ content: z.string().max(20_000) }).strict(), policy: { sideEffect: 'none', approval: 'none' },
                execute: async input => {
                    if ([...requiredNoteReads].some(index => !readNoteIndexes.has(index))) {
                        return toolError('Read every truncated note in the current batch before publishing memory.', { code: 'MEMORY_NOTE_READ_REQUIRED' })
                    }
                    try { candidate = renderGlobalMemory(input.content, selected) }
                    catch { return toolError('Provide User Profile, User preferences and General Tips within 8000 UTF-8 bytes. The server renders relative navigation; do not invent pointers.', { code: 'MEMORY_INPUT_INVALID' }) }
                    return toolSuccess('Candidate validated; publication awaits successful completion.')
                } })
        ] as const
        const workerToolNames = new Set(tools.map(tool => tool.name))
        try {
            const catalogue = selected.map(memory => ({ path: memory.path, conversationId: memory.conversationId, title: memory.title, description: memory.description, sourceRef: memory.sourceRef }))
            const previous = initial.consolidatedFingerprint ? JSON.parse(initial.consolidatedFingerprint) as { summaries: ConversationMemory[] } : { summaries: [] }
            const changedSources = selected.filter(memory => {
                const prior = previous.summaries.find(item => item.conversationId === memory.conversationId)
                return !prior || prior.sourceRevision !== memory.sourceRevision || prior.summary !== memory.summary || prior.title !== memory.title || prior.description !== memory.description
            }).map(memory => memory.path)
            const deletedSources = previous.summaries.filter(memory => !selected.some(item => item.conversationId === memory.conversationId)).map(memory => memory.path)
            const input = redactMemorySecrets(JSON.stringify({ existingMemory: initial.global, sources: catalogue,
                changedSources, deletedSources, deletedOrRevoked: initial.revoked, noteWatermark,
                targetNoteWatermark: noteBatch.targetWatermark, notesTotal: initial.notes.length, notes: noteBatch.entries }))
            await this.generate(ownerId, CONSOLIDATION_PROMPT, input, { id: 'memory-worker-tools', hooks: {
                onInitialize: async ctx => {
                    ctx.tools.register(tools[0]); ctx.tools.register(tools[1]); ctx.tools.register(tools[2]);
                    ctx.tools.register(tools[3]); ctx.tools.register(tools[4]); ctx.tools.register(tools[5])
                },
                beforeTool: async (ctx, call) => {
                    if (!workerToolNames.has(call.name)) { return { action: 'continue' } }
                    const workerTool = ctx.tools.get(call.name)
                    if (!workerTool) { throw new Error('Consolidation tool registration is unavailable.') }
                    if (!workerTool.inputSchema.safeParse(call.input).success) {
                        return { action: 'result', result: toolError('Consolidation tool arguments are invalid.', { code: 'MEMORY_INPUT_INVALID' }) }
                    }
                    return { action: 'continue' }
                }
            } })
            if (candidate === undefined) { throw new Error('Consolidation ended without publishing a candidate.') }
            const latestConversations = (await this.options.archive.list(ownerId)).filter(item => item.ownerId === ownerId)
            const published = await updateMemoryState(this.options.store, ownerId, state => {
                const job = state.consolidation
                const currentSelected = this.select(state, latestConversations)
                const currentById = new Map(latestConversations.map(item => [item.id, item]))
                const sourcesAreCurrent = selected.every(memory => {
                    const source = currentById.get(memory.conversationId)
                    const observed = observedSources.get(memory.conversationId)
                    return source?.generateMemory === true && observed && source.sourceRef === observed.sourceRef && source.revision === observed.revision &&
                        source.updatedAt === observed.updatedAt && source.title === observed.title
                })
                if (!job || job.token !== token || job.expiresAt <= this.clock() || !sourcesAreCurrent || this.fingerprint(state, currentSelected, noteBatch.targetWatermark) !== fingerprint) { return false }
                state.global = candidate!
                state.consolidatedFingerprint = fingerprint
                state.summaries = Object.fromEntries(Object.entries(state.summaries).filter(([id, memory]) => {
                    const source = currentById.get(id)
                    return source?.generateMemory === true && !state.revoked.includes(id) &&
                        this.clock() - Date.parse(memory.lastUsedAt ?? memory.sourceUpdatedAt) <= this.policy.maxUnusedMs
                }))
                job.watermark = state.revision; job.expiresAt = 0; job.retryAt = 0; delete job.error
                return true
            })
            if (!published) { await this.fail(ownerId, undefined, token, 'stale_consolidation', 0) }
            return published !== undefined
        } catch (error) {
            await this.fail(ownerId, undefined, token, 'consolidation_failed')
            throw error
        } finally { await stopHeartbeat() }
    }

    /** Verify that an original ref remains selected and not revoked. @param ownerId - Owner. @param ref - Opaque archive ref. @param selected - Snapshot. @param refs - Allowed refs. */
    private async assertSource(ownerId: string, ref: string, selected: readonly ConversationMemory[], refs: ReadonlySet<string>): Promise<void> {
        const state = await this.options.store.load(ownerId)
        if (!refs.has(ref) || selected.some(memory => memory.sourceRef === ref && state.revoked.includes(memory.conversationId))) { throw new Error('Original source is not available.') }
    }

    /** Generate through the existing Chat/Session/Core stack. @param ownerId - Internal task owner. @param system - Fixed instructions. @param input - Untrusted evidence. @param tools - Optional controlled capability. */
    private async generate(ownerId: string, system: string, input: string, tools?: AgentPlugin<ChatInput>): Promise<ModelTurnResult> {
        const session = new ChatSessionPlugin({ id: `memory-worker-${this.options.newId()}`, ownerId })
        const providerOptions: Record<string, unknown> = { ...this.options.model.settings?.providerOptions }
        delete providerOptions.response_format
        const format = this.options.extractionFormat ?? 'json-schema'
        if (!tools && format !== 'text') {
            providerOptions.response_format = format === 'json-object' ? { type: 'json_object' } : {
                type: 'json_schema', json_schema: { name: 'conversation_memory', strict: true, schema: extractionJsonSchema }
            }
        }
        const model = new ChatModelPlugin({ ...this.options.model, session, settings: {
            maxOutputTokens: 16_384, ...this.options.model.settings, providerOptions, toolChoice: tools ? 'auto' : 'none'
        } })
        const conversation = new ChatConversationPlugin({ session, generation: model })
        conversation.addSystemPrompt(system)
        let steps = 0
        let budgetExceeded = false
        const guard: AgentPlugin<ChatInput> = { id: 'memory-worker-budget', hooks: {
            beforeStep: async () => { if (++steps > this.policy.maxConsolidationSteps) { throw new Error('Memory worker step budget exceeded.') }; return { action: 'continue' } },
            beforeModel: async () => {
                if (estimateChatInputTokens(model.request) > this.inputBudget()) {
                    budgetExceeded = true
                    throw new MemoryBudgetExceeded('Memory worker input budget exceeded.')
                }
                return { action: 'continue' }
            }
        } }
        const outcome = await createAgent<ChatInput>({ plugins: [conversation, ...(tools ? [tools] : []), guard] }).run({ prompt: input })
        if (!outcome.ok) { throw budgetExceeded ? new MemoryBudgetExceeded('Memory worker input budget exceeded.') : outcome.error }
        const value = outcome.value as ModelTurnResult | undefined
        if (!value || value.finishReason !== 'stop' || value.toolCalls.length || outcome.errors.length) { throw new Error('Memory worker did not finish successfully.') }
        return value
    }

    /** Count the whole request conservatively and reserve the configured output capacity. */
    private inputBudget(): number {
        const model = this.options.model
        const output = model.settings?.maxOutputTokens ?? 16_384
        const limits = [this.policy.inputTokens * 4 + 24_000]
        for (const value of [model.maxInputTokens, model.contextWindow, output]) {
            if (value !== undefined && (!Number.isSafeInteger(value) || value <= 0)) { throw new Error('Invalid memory model capacity.') }
        }
        if (model.maxInputTokens !== undefined) { limits.push(model.maxInputTokens) }
        if (model.contextWindow !== undefined) { limits.push(model.contextWindow - output) }
        const limit = Math.min(...limits)
        if (limit <= 0) { throw new Error('Memory model output reservation leaves no input capacity.') }
        return limit
    }

    /** Renew only current ownership, never reclaim an expired token. @param ownerId - Owner. @param conversationId - Stage one source or global stage. @param token - Current lease. */
    private heartbeat(ownerId: string, conversationId: string | undefined, token: string): () => Promise<void> {
        let inFlight: Promise<void> | undefined
        const timer = setInterval(() => {
            if (inFlight) return
            const work = updateMemoryState(this.options.store, ownerId, state => {
                const job = conversationId === undefined ? state.consolidation : state.jobs[conversationId]
                if (!job || job.token !== token || job.expiresAt <= this.clock()) { return false }
                job.expiresAt = this.clock() + this.policy.leaseMs; return true
            }).catch(() => { /* Publication independently checks ownership after transient storage failure. */ })
            inFlight = work.then(() => {})
            void inFlight.finally(() => { inFlight = undefined })
        }, Math.max(10, Math.min(90_000, Math.floor(this.policy.leaseMs / 3))))
        return async () => { clearInterval(timer); await inFlight }
    }

    /** Preserve published artifacts and defer the failed owner task. @param ownerId - Owner. @param conversationId - Source or global stage. @param token - Ownership. @param error - Safe failure code. */
    private async fail(ownerId: string, conversationId: string | undefined, token: string, error: string, retryMs = this.policy.retryMs): Promise<void> {
        await updateMemoryState(this.options.store, ownerId, state => {
            const job = conversationId === undefined ? state.consolidation : state.jobs[conversationId]
            if (!job || job.token !== token) { return false }
            job.expiresAt = 0; job.retryAt = retryMs ? this.clock() + retryMs : 0; job.error = error; return true
        })
    }
}

/** Normalize the prior full-note fingerprint without replaying already incorporated notes. @param value - Published input identity. */
function normalizedFingerprint(value: string): string {
    try {
        const parsed = JSON.parse(value) as { summaries: unknown[]; notes?: unknown[]; revoked: unknown[]; noteWatermark?: number; notesTotal?: number }
        if (Array.isArray(parsed.notes)) {
            return JSON.stringify({ summaries: parsed.summaries, noteWatermark: parsed.notes.length, notesTotal: parsed.notes.length, revoked: parsed.revoked })
        }
    } catch { /* An absent or invalid fingerprint requires reconstruction. */ }
    return value
}

/** Select one ordered, bounded append-only note batch. @param notes - Persisted note log. @param watermark - Count already incorporated. */
function selectNoteBatch(notes: readonly MemoryNote[], watermark: number): NoteBatch {
    const entries: NoteBatchEntry[] = []
    const requiresRead = new Set<number>()
    for (let offset = watermark; offset < notes.length && entries.length < NOTE_BATCH_MAX_COUNT; offset += 1) {
        const index = offset + 1
        const note = notes[offset]!
        const content = redactMemorySecrets(note.content)
        const entry = makeNoteBatchEntry(index, note, content)
        if (utf8Bytes(JSON.stringify([...entries, entry])) <= NOTE_BATCH_MAX_BYTES) {
            entries.push(entry)
            continue
        }
        if (entries.length > 0) { break }
        const bounded = fitNoteBatchEntry(index, note, content)
        entries.push(bounded)
        if (bounded.contentTruncated) { requiresRead.add(index) }
        break
    }
    return { entries, targetWatermark: watermark + entries.length, requiresRead }
}

/** @param index - One-based note index. @param note - Source note. @param content - Redacted note content. */
function makeNoteBatchEntry(index: number, note: MemoryNote, content: string): NoteBatchEntry {
    return { index, id: note.id, createdAt: note.createdAt, kind: note.kind,
        ...(note.conversationId ? { conversationId: note.conversationId } : {}), content }
}

/** Keep progress possible for an oversized historical note while requiring an exact range read. @param index - One-based note index. @param note - Source note. @param content - Redacted note content. */
function fitNoteBatchEntry(index: number, note: MemoryNote, content: string): NoteBatchEntry {
    const id = truncateMemoryText(note.id, 512)
    const createdAt = truncateMemoryText(note.createdAt, 128)
    const conversationId = note.conversationId === undefined ? undefined : truncateMemoryText(note.conversationId, 512)
    const metadataTruncated = id !== note.id || createdAt !== note.createdAt || conversationId !== note.conversationId
    const compact: NoteBatchEntry = { index, id, createdAt, kind: note.kind,
        ...(conversationId === undefined ? {} : { conversationId }), content: '', contentTruncated: true,
        ...(metadataTruncated ? { metadataTruncated: true } : {}) }
    const chars = Array.from(content)
    let low = 0
    let high = chars.length
    let best = compact
    const suffix = '\n[Content omitted; read this note by index with notes_read.]'
    while (low <= high) {
        const middle = Math.floor((low + high) / 2)
        const preview = chars.slice(0, middle).join('') + (middle < chars.length ? suffix : '')
        const candidate = { ...compact, content: preview }
        if (utf8Bytes(JSON.stringify([candidate])) <= NOTE_BATCH_MAX_BYTES) {
            best = candidate
            low = middle + 1
        } else {
            high = middle - 1
        }
    }
    return best
}
