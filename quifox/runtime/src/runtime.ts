import { createHash, randomUUID } from 'node:crypto'
import { mkdir, readFile, stat } from 'node:fs/promises'
import { dirname, join, resolve } from 'node:path'
import { z } from 'zod'
import { createAgent, StreamClosedError, toolError, type Agent, type AgentContext, type AgentPlugin, type AgentRunOutcome } from '@quifox/agent-core'
import { BackgroundTasksPlugin, type BackgroundTaskSnapshot } from '@quifox/agent-plugin-tasks'
import { McpPlugin } from '@quifox/agent-plugin-mcp'
import { PluginActivationPlugin } from '@quifox/agent-plugin-composition'
import { builtinPlugins, installedPlugins, pluginEnabled, pluginMarketplace } from './plugin-catalog.js'
import { SubAgentsPlugin, SubAgentRequestError, allocateSubAgentName, subAgentNameSchema, type SubAgentConfiguration, type SubAgentControl, type SubAgentResult } from '@quifox/agent-plugin-subagents'
import { EventPublisherPlugin } from '@quifox/agent-plugin-events'
import { ObservabilityPlugin, compareObservabilityRuns, foldObservability, type ObservabilityComposition, type ObservabilityEvent } from '@quifox/agent-plugin-observability'
import { ChatModelPlugin } from '@quifox/agent-plugin-model'
import { ChatSessionPlugin, chatSessionSnapshotSchema, pendingInputSchema, sessionMessageSchema, getConversation, type ChatInput, type ChatSessionSnapshot } from '@quifox/agent-plugin-session'
import { ExecutionCheckpointPlugin, type ExecutionCheckpoint } from '@quifox/agent-plugin-checkpoint'
import { InterruptPlugin } from '@quifox/agent-plugin-interrupt'
import { MessageInboxPlugin, type MessageInboxSnapshot } from '@quifox/agent-plugin-steering'
import { ContextualChatConversationPlugin, RequestContextPlugin } from '@quifox/agent-plugin-request-context'
import { ChatCompactionSource, CompactionPlugin, estimateChatInputTokens } from '@quifox/agent-plugin-compaction'
import { MemoryPlugin, MemoryProcessor, MemoryService, type MemoryOrigin } from '@quifox/agent-plugin-memory'
import { ProjectGuidancePlugin, SkillsPlugin } from '@quifox/agent-plugin-project-context'
import { ancestorDirectories, mergeConfig, workspaceConfig, reasoningEffortSchema, selectModel, isMissing, loadConfig, readConfig, modelBudget, publicConfig, runtimePaths, saveConfig, writeAtomic, type RuntimeConfig, type WorkspaceConfigLayer } from './config.js'
import { SessionJournal } from './journal.js'
import { FileMemoryStore } from './memory-store.js'
import { HostArchive } from './archive.js'
import { createProjectFiles } from './project-files.js'
import { PermissionGate } from './permissions.js'
import { nativeTools, inspectTool, canonicalPath } from './native-tools.js'
import { toolInterruption } from './tool-interruption.js'
import { DiagnosticLog } from './diagnostics.js'
import type { FileChange } from './tool-presentation.js'
import { HostMcpClient, interruptMcp } from './mcp.js'
import { displayEvent, displaySession, displayValue, displayWindow } from './display-projection.js'
import { SessionLeases, leaseBusy, withFileLease } from './leases.js'
import { agentCatalog, toolAllowed, type AgentCatalog } from './agent-config.js'
import type { AgentRecipient, InputRoutingReceipt, RuntimeCommand, RuntimeEvent, SessionMetadata, SessionSummary, SessionView, TranscriptMessage } from './protocol.js'
import { agentRecipients, parseSpawnInput, parseAgentInput } from './input-routing.js'
import { modelCatalog } from './model-catalog.js'
import { PresentationPlugin } from '@quifox/agent-plugin-presentation'
import { projectList, projectRead, projectSearch, projectTarget } from './project-browser.js'
import type { PresentationHost } from './presentation-host.js'

const metadataSchema = z.object({ id: z.string().min(1), ownerId: z.string().min(1), title: z.string(), workspace: z.string(),
    createdAt: z.string(), updatedAt: z.string(), revision: z.number().int().nonnegative(), parentId: z.string().optional(), taskId: z.string().optional(), generateMemory: z.boolean(),
    modelId: z.string().optional(), reasoningEffort: reasoningEffortSchema.optional(), agentName: z.string().optional(), creationIdentity: z.string().optional(),
    name: subAgentNameSchema.optional(), initialInstructions: z.string().optional(),
    toolScopes: z.array(z.array(z.string())).optional(), toolDenylist: z.array(z.string()).optional(), approvalMode: z.enum(['ask', 'allow', 'deny']).optional() }).strict()
const checkpointSchema = z.object({ turn: z.object({ text: z.string(), reasoning: z.string(), finishReason: z.string(),
    toolCalls: z.array(z.object({ id: z.string(), name: z.string(), input: z.unknown() })), usage: z.record(z.string(), z.unknown()) }).passthrough(),
    calls: z.array(z.object({ id: z.string(), status: z.enum(['not-started', 'started', 'completed']), result: z.object({ status: z.enum(['success', 'error', 'denied']), content: z.string() }).passthrough().optional() })) })
const savedSchema = z.object({ metadata: metadataSchema, session: chatSessionSnapshotSchema, checkpoint: checkpointSchema.optional(),
    inbox: z.unknown(), origins: z.record(z.string(), z.enum(['human', 'assistant', 'other-agent', 'commentary', 'context', 'tool', 'memory', 'system'])),
    inputOrigins: z.record(z.string(), z.enum(['human', 'other-agent', 'context'])), admissions: z.record(z.string(), z.string()).default({}), pendingInputId: z.string().optional(), status: z.enum(['idle', 'running', 'stopped', 'error']) })
const routingSourceSchema = z.object({ session: chatSessionSnapshotSchema, origins: savedSchema.shape.origins }).strict()
const routingAdmissionSchema = z.object({ id: z.uuid(), signature: z.string().regex(/^[a-f0-9]{64}$/), source: routingSourceSchema.optional() }).strict()
const eventSchema = z.object({ version: z.literal(1), sessionId: z.string().min(1), runId: z.string().min(1).optional(),
    operationId: z.string().min(1).optional(),
    sequence: z.number().int().positive().max(Number.MAX_SAFE_INTEGER), timestamp: z.iso.datetime(), type: z.string().min(1), data: z.unknown() }).strict()
    .refine(event => event.type !== 'input-routing-admission' || routingAdmissionSchema.safeParse(event.data).success, 'Invalid routing admission.')

/** Replay shares immutable JSON prefixes; validate each shared object once, then copy only the final live state. */
function archiveStateSchema() {
    const memo = <Schema extends z.ZodType>(schema: Schema): z.ZodType<z.output<Schema>> => {
        const checked = new WeakSet<object>()
        return z.custom<z.output<Schema>>(value => {
            if (value && typeof value === 'object' && checked.has(value)) return true
            if (!schema.safeParse(value).success) return false
            if (value && typeof value === 'object') checked.add(value)
            return true
        }, 'Invalid archived state field.')
    }
    const message = memo(sessionMessageSchema)
    return savedSchema.extend({ session: memo(chatSessionSnapshotSchema.extend({
        history: memo(z.array(memo(chatSessionSnapshotSchema.shape.history.element))),
        pendingInput: memo(pendingInputSchema.extend({ original: memo(z.array(message)), prepared: memo(z.array(message)) })).optional()
    })), checkpoint: memo(checkpointSchema).optional(), origins: memo(savedSchema.shape.origins),
        inputOrigins: memo(savedSchema.shape.inputOrigins), admissions: memo(savedSchema.shape.admissions),
        inbox: memo(z.custom<MessageInboxSnapshot>(value => { if (!value || typeof value !== 'object') return false; try { new MessageInboxPlugin(value as MessageInboxSnapshot); return true } catch { return false } })) })
}

/** Streaming deltas stay in the durable journal; UI windows count structural observations instead. */
function isObservation(event: RuntimeEvent): boolean {
    if (event.type === 'input-routing-admission') return false
    if (event.type === 'agent') return !['text-delta', 'reasoning-delta', 'usage'].includes((event.data as { type?: string }).type ?? '')
    if (event.type === 'subagent-event') { const nested = (event.data as { event?: RuntimeEvent }).event; return !nested || isObservation(nested) }
    return true
}
interface SavedState { metadata: SessionMetadata; session: ChatSessionSnapshot; checkpoint?: ExecutionCheckpoint; inbox: MessageInboxSnapshot;
    origins: Record<string, MemoryOrigin>; inputOrigins: Record<string, 'human' | 'other-agent' | 'context'>; admissions: Record<string, string>; pendingInputId?: string; status: SessionSummary['status'] }
interface Entry {
    history: ChatSessionSnapshot['history']; fileStamp?: string; liveText: string; observations: RuntimeEvent[]
    config: RuntimeConfig; baseConfig: RuntimeConfig; configSources: string[]; projectMcp: string[]; untrustedMcp: string[]
    agents: AgentCatalog
    metadata: SessionMetadata; session: ChatSessionPlugin; context: RequestContextPlugin; conversation: ContextualChatConversationPlugin; model: ChatModelPlugin
    checkpoint: ExecutionCheckpointPlugin; inbox: MessageInboxPlugin; interrupt: InterruptPlugin; permissions: PermissionGate
    skills: SkillsPlugin; guidance: ProjectGuidancePlugin; observability: ObservabilityPlugin<ChatInput>; agent: Agent<ChatInput>; status: SessionSummary['status']; origins: SavedState['origins']; inputOrigins: SavedState['inputOrigins']
    events: RuntimeEvent[]; sequence: number; runId: string | undefined; controller: AbortController | undefined; draining: Promise<unknown> | undefined
    tasks: BackgroundTasksPlugin; taskFacts: Map<string, BackgroundTaskSnapshot>; taskRuns: Map<string, string | undefined>; owner: AgentContext | undefined
    admissions: Record<string, string>; resuming: boolean; stopEpoch: number
    plugins: AgentPlugin<ChatInput>[]; subagents: SubAgentsPlugin; child: { parent: Entry; owner: AgentContext | undefined; control: SubAgentControl } | undefined
    managedRun: boolean; initialInputId: string | undefined
    pendingInputId: string | undefined; compactions: Set<string>; recoveryUnknown: boolean
    persistence: Promise<void>
    prepareInput: ChatInput; preparing: Promise<AgentContext> | undefined
}
interface Admission { id: string; prompt: string; mode: 'queue' | 'steer'; origin: 'human' | 'other-agent'; created: boolean }
interface UnavailableArchive { state: SavedState; events: RuntimeEvent[]; checkedAt: number }
export interface RuntimeOptions { root?: string; workspace?: string; environment?: Record<string, string | undefined>; globalSkillsRoot?: string; presentation?: PresentationHost }

/** A single Host owns execution and persistence for both terminal and desktop adapters. */
export class QuiFoxRuntime {
    readonly paths: ReturnType<typeof runtimePaths>
    private config: RuntimeConfig
    private configuring = false
    private configurationPending = false
    private readonly entries = new Map<string, Entry>()
    private readonly unavailable = new Map<string, UnavailableArchive>()
    private readonly listeners = new Set<(event: RuntimeEvent) => void>()
    private readonly journal: SessionJournal
    private readonly diagnostics: DiagnosticLog
    private readonly store: FileMemoryStore
    private readonly archive: HostArchive
    private readonly memory: MemoryService
    private readonly mcp = new Map<string, HostMcpClient>()
    private catalog: unknown = {}
    private catalogUpdatedAt = 0
    private catalogRetryAt = 0
    private catalogTimer: ReturnType<typeof setInterval> | undefined
    private catalogCompositionPending = false
    private catalogWork: Promise<void> | undefined
    private catalogController: AbortController | undefined
    private memoryWork: Promise<void> | undefined
    private memoryError: string | undefined
    private memoryController: AbortController | undefined
    private readonly memoryJobs = new Set<Promise<void>>()
    private readonly eventJobs = new Set<Promise<void>>()
    private closed = false
    private closeWork: Promise<void> | undefined
    private readonly commands = new Set<Promise<unknown>>()
    private readonly leases = new SessionLeases()
    private ownershipWork: Promise<unknown> = Promise.resolve()
    private configStamp: string | undefined
    private configRefresh: Promise<void> | undefined
    private readonly creations = new Map<string, { identity: string; work: Promise<SessionView> }>()
    private readonly spawnOperations = new Map<string, { identity: string; work: Promise<InputRoutingReceipt> }>()
    private readonly routingAdmissions = new Map<string, { signature: string; work: Promise<unknown> }>()

    private constructor(private readonly options: RuntimeOptions & { workspace: string }, config: RuntimeConfig) {
        this.paths = runtimePaths(options.root); this.config = config
        this.journal = new SessionJournal(this.paths.sessions)
        this.diagnostics = new DiagnosticLog(this.paths.root)
        this.store = new FileMemoryStore(this.paths.memory, () => { this.memoryError = 'Memory projection failed.' })
        this.archive = new HostArchive(this.journal, () => [...this.entries.values()].map(entry => ({ ...entry.metadata,
            shortId: entry.metadata.id.slice(0, 8), sourceRef: `conversation:${entry.metadata.id}`, active: entry.status === 'running' })).concat([...this.unavailable.values()].map(({ state }) => ({ ...state.metadata,
                shortId: state.metadata.id.slice(0, 8), sourceRef: `conversation:${state.metadata.id}`, active: false }))),
        async (owner, _from, to, content, id) => {
            const entry = this.entry(to)
            if (entry.metadata.ownerId !== owner) throw new Error('Conversation is unavailable.')
            await this.submit(entry, content, 'queue', 'other-agent', id)
            return { id, status: 'queued' }
        })
        this.memory = new MemoryService(this.store, this.archive, randomUUID)
    }

    static async open(options: RuntimeOptions = {}): Promise<QuiFoxRuntime> {
        const paths = runtimePaths(options.root)
        const workspace = resolve(options.workspace ?? process.cwd())
        const config = await loadConfig(paths.root, workspace, options.environment)
        const runtime = new QuiFoxRuntime({ ...options, root: paths.root, workspace }, config)
        try {
            try { runtime.catalog = JSON.parse(await readFile(paths.models, 'utf8')); runtime.catalogUpdatedAt = (await stat(paths.models)).mtimeMs } catch (error) { if (!isMissing(error)) throw new Error('模型资料缓存损坏。', { cause: error }) }
            await runtime.refreshSessions()
            for (const entry of [...runtime.entries.values()]) {
                if (!entry.session.snapshot().history.some(item => item.compaction && !entry.compactions.has(item.id))) continue
                try { await runtime.own(entry.metadata.id) }
                catch (error) { if (!(error instanceof Error) || !error.message.includes('另一个宿主')) throw error }
                finally { await runtime.leases.close() }
            }
            runtime.configStamp = await runtime.configurationStamp()
            runtime.catalogTimer = setInterval(() => { if (!runtime.closed && runtime.catalogExpired()) void runtime.loadModelCatalog().catch(() => {}) }, 3_600_000)
            runtime.catalogTimer.unref()
            return runtime
        } catch (error) { await runtime.leases.close(); throw error }
    }

    private async refreshSessions(forceId?: string): Promise<void> {
            for (const id of await this.journal.list()) {
                if (this.leases.has(this.journal.path(id))) continue
                if (id !== forceId && this.unavailable.has(id) && Date.now() - this.unavailable.get(id)!.checkedAt < 5000) continue
                const info = await stat(this.journal.path(id)), stamp = `${info.size}:${info.mtimeMs}`
                if (this.entries.get(id)?.fileStamp === stamp) continue
                const archive = archiveStateSchema()
                const records = (await this.journal.read(id, { latestStateOnly: true, onState: input => {
                    const state = archive.parse(input)
                    if (state.metadata.id !== id || state.session.id !== id || state.metadata.ownerId !== state.session.ownerId) throw new Error('会话归档身份不一致。')
                } })).records
                if (!records.length) continue
                let sequence = 0
                for (const record of records) {
                    if (record.kind === 'state') continue
                    else if (record.kind === 'event') { const event = eventSchema.parse(record.event); if (event.sessionId !== id || event.sequence <= sequence) throw new Error('会话事件身份或序列损坏。'); sequence = event.sequence }
                    else throw new Error('会话归档包含未知记录。')
                }
                const latest = [...records].reverse().find(record => record.kind === 'state')
                if (!latest) throw new Error('会话归档没有有效状态。')
                const state = savedSchema.parse(latest.state) as SavedState
                if (state.metadata.id !== id) throw new Error('会话归档身份不一致。')
                const events = records.filter(record => record.kind === 'event').map(record => record.event as RuntimeEvent)
                // Validate durable input state independently of the workspace's current availability.
                new MessageInboxPlugin(state.inbox)
                try {
                    const entry = await this.compose(state, events)
                    entry.fileStamp = stamp
                    if (entry.status === 'running' && !await leaseBusy(this.journal.path(id))) entry.status = 'stopped'
                    if (!this.leases.has(this.journal.path(id))) { this.entries.set(id, entry); this.unavailable.delete(id) }
                } catch {
                    this.entries.delete(id); this.unavailable.set(id, { state, events, checkedAt: Date.now() })
                }
            }
    }

    private own(id: string): Promise<Entry> {
        const work = this.ownershipWork.catch(() => {}).then(() => this.claimTree(id))
        this.ownershipWork = work
        return work
    }

    private async claimTree(id: string): Promise<Entry> {
        if (this.leases.has(this.journal.path(id))) { this.leases.assert(this.journal.path(id)); return this.entry(id) }
        await this.refreshSessions(id)
        let root = this.entry(id)
        const visited = new Set<string>()
        while (root.metadata.parentId) {
            if (visited.has(root.metadata.id)) throw new Error('子会话归属出现循环。')
            visited.add(root.metadata.id); root = this.entry(root.metadata.parentId)
        }
        const ids = new Set([root.metadata.id])
        let changed = true
        while (changed) { changed = false; for (const entry of this.entries.values()) if (entry.metadata.parentId && ids.has(entry.metadata.parentId) && !ids.has(entry.metadata.id)) { ids.add(entry.metadata.id); changed = true } }
        const acquired: string[] = []
        try {
            for (const candidate of [...ids].sort()) {
                const path = this.journal.path(candidate)
                if (!this.leases.has(path)) { await this.leases.claim(path); this.journal.invalidateWriter(candidate); acquired.push(path) }
            }
            // Reload under the leases: a different Host may have committed since the read-only snapshot.
            for (const candidate of ids) {
                const records = (await this.journal.read(candidate, { latestStateOnly: true })).records
                const state = savedSchema.parse([...records].reverse().find(record => record.kind === 'state')?.state) as SavedState
                const entry = await this.compose(state, records.filter(record => record.kind === 'event').map(record => eventSchema.parse(record.event) as RuntimeEvent))
                if (entry.status === 'running') entry.status = 'stopped'
                this.entries.set(candidate, entry)
            }
            this.restoreChildren()
            for (const candidate of ids) { const entry = this.entry(candidate); await this.observeCompactions(entry, entry.session.snapshot().history, true) }
            return this.entry(id)
        } catch (error) { await Promise.all(acquired.map(path => this.leases.release(path))); throw error }
    }

    subscribe(listener: (event: RuntimeEvent) => void): () => void { this.listeners.add(listener); return () => this.listeners.delete(listener) }

    command(command: RuntimeCommand): Promise<unknown> {
        const reject = async (cause: unknown): Promise<never> => {
            const error = cause instanceof z.ZodError ? { message: '配置或参数校验失败。', issues: cause.issues.map(issue => ({ path: issue.path, code: issue.code })) } : this.redact(cause instanceof Error ? { message: cause.message, stack: cause.stack } : { message: '操作失败。' })
            await this.diagnostics.write(command.type, error).catch(() => {})
            throw cause
        }
        if (command.type === 'close') return this.close().then(() => ({ closed: true })).catch(reject)
        if (this.closed) return reject(new Error('quifox 已关闭。'))
        const configures = ['config', 'session-config', 'refresh-models', 'mcp-set-enabled', 'plugin-set-enabled', 'plugin-install'].includes(command.type) || (command.type === 'mcp' && command.action === 'connect')
        if ((this.configuring || this.configurationPending) && (configures || ['create', 'submit', 'resume', 'memory'].includes(command.type))) return reject(new Error('配置正在更新，请稍后重试。'))
        // Reserve admission before any await; a refresh may release its own busy flag only.
        if (configures) this.configurationPending = true
        const operation = this.executeCommand(command, [...this.commands]).catch(reject).finally(() => {
            this.commands.delete(operation); if (configures) this.configurationPending = false
        })
        this.commands.add(operation)
        void operation.catch(() => {})
        return operation
    }

    private async executeCommand(command: RuntimeCommand, previousCommands: readonly Promise<unknown>[]): Promise<unknown> {
        if (this.closed && command.type !== 'close') throw new Error('quifox 已关闭。')
        const inspection = ['snapshot', 'resources', 'plugins', 'memory-file', 'agents', 'project', 'model-catalog'].includes(command.type)
            || (command.type === 'observability' && command.action === 'summary') || (command.type === 'instructions' && command.action === 'read')
        if (!inspection && !['close', 'stop', 'approve', 'config', 'refresh-models', 'presentation-reply'].includes(command.type)) await this.refreshConfiguration()
        const inspectedConfig = inspection ? await readConfig(this.paths.root, this.options.workspace, this.options.environment) : this.config
        switch (command.type) {
            case 'snapshot': {
                await this.refreshSessions(command.sessionId)
                return command.sessionId ? this.redact(await (this.unavailable.has(command.sessionId) ? this.archiveView(this.unavailable.get(command.sessionId)!, command) : this.view(this.entry(command.sessionId), command.messageLimit, command.eventLimit, command.traceOnly, command.runId)), inspectedConfig) : this.redact(
                    { configurationRevision: createHash('sha256').update(await this.configurationStamp()).digest('hex'), config: publicConfig({ ...inspectedConfig, workspace: this.options.workspace }, this.catalog), sessions: [...this.entries.values()].map(entry => this.summary(entry)).concat([...this.unavailable.values()].map(archive => this.archiveSummary(archive))) }, inspectedConfig)
            }
            case 'create': {
                let workspace = command.workspace === null ? undefined : resolve(command.workspace ?? this.options.workspace)
                const id = command.sessionId ? z.uuid().parse(command.sessionId) : randomUUID()
                const identity = JSON.stringify({ workspace: workspace ?? null, title: command.title?.trim() || 'New session', modelId: command.modelId ?? 'default',
                    reasoningEffort: command.reasoningEffort ?? null, agent: command.agent ?? null, approvalMode: command.approvalMode ?? null })
                const pending = this.creations.get(id)
                if (pending) { if (pending.identity !== identity) throw new Error('创建会话的身份与参数不一致。'); return pending.work }
                const work = (async (): Promise<SessionView> => {
                if (command.sessionId) {
                    await this.refreshSessions(id)
                    const previous = this.entries.get(id), unavailable = this.unavailable.get(id)
                    const metadata = previous?.metadata ?? unavailable?.state.metadata
                    if (metadata) {
                        if (metadata.creationIdentity !== identity) throw new Error('创建会话的身份与参数不一致。')
                        return previous ? this.view(previous) : this.archiveView(unavailable!, { type: 'snapshot', sessionId: id })
                    }
                }
                workspace ??= await this.allocateWorkspace()
                const definitions = await agentCatalog(workspace, this.paths.root)
                const definition = command.agent ? definitions.agents.find(agent => agent.name === command.agent) : undefined
                if (command.agent && !definition) throw new SubAgentRequestError('Agent 定义不存在或无效。', 'AGENT_CONFIG_INVALID')
                const now = new Date().toISOString()
                const effort = command.reasoningEffort ?? definition?.effort
                const metadata: SessionMetadata = { id, ownerId: 'local', title: command.title?.trim() || 'New session', workspace,
                    createdAt: now, updatedAt: now, revision: 0, generateMemory: true, creationIdentity: identity, modelId: command.modelId ?? (definition?.model && definition.model !== 'inherit' ? definition.model : 'default'),
                    ...(effort ? { reasoningEffort: effort } : {}), ...(command.approvalMode ? { approvalMode: command.approvalMode } : {}), ...(definition ? { agentName: definition.name,
                        toolScopes: definition.tools ? [definition.tools] : [], toolDenylist: definition.disallowedTools ?? [],
                        ...(definition.permissionMode === 'dontAsk' || definition.permissionMode === 'plan' ? { approvalMode: 'deny' as const } : {}) } : {}) }
                const entry = await this.compose({ metadata, session: { version: 1, id, ownerId: metadata.ownerId, history: [] },
                    inbox: { version: 1, messages: [] }, origins: {}, inputOrigins: {}, admissions: {}, status: 'idle' })
                this.entries.set(id, entry)
                try { await this.leases.claim(this.journal.path(id)); await this.persist(entry) }
                catch (error) { this.entries.delete(id); await this.leases.release(this.journal.path(id)); throw error }
                await this.publish(entry, 'session', this.summary(entry)).catch(() => {})
                return this.view(entry)
                })()
                this.creations.set(id, { identity, work })
                try { return await work } finally { if (this.creations.get(id)?.work === work) this.creations.delete(id) }
            }
            case 'submit': return this.humanInput(await this.own(command.sessionId), command.prompt, command.mode ?? 'queue', command.messageId ?? randomUUID())
            case 'inbox': {
                const entry = await this.own(command.sessionId)
                await this.persist(entry, undefined, false, undefined, undefined, { action: command.action, messageId: command.messageId })
                await this.publish(entry, 'inbox-updated', { action: command.action, messageId: command.messageId })
                return { accepted: true }
            }
            case 'stop': {
                const entry = this.leases.has(this.journal.path(command.sessionId)) ? this.entry(command.sessionId) : await this.own(command.sessionId)
                this.stopTree(entry)
                if (entry.child) return command.waitForExit ? entry.child.parent.subagents.stopAndWait(entry.child.control.taskId, entry.child.owner, command.timeoutMs) : entry.child.parent.subagents.stop(entry.child.control.taskId, entry.child.owner)
                return { requested: entry.status === 'running' }
            }
            case 'resume': {
                const entry = await this.own(command.sessionId)
                if (entry.draining || entry.resuming || !this.summary(entry).resumeAvailable) throw new Error('当前会话不能续跑。')
                entry.resuming = true
                try {
                if (pluginEnabled(entry.config, 'observability')) entry.observability.recordRecovery(command.mode)
                if (command.mode === 'replan') {
                    for (const call of entry.checkpoint.snapshot()?.calls ?? []) {
                        if (call.status === 'completed') continue
                        const result = toolError(call.status === 'not-started' ? 'Tool was not executed before interruption.' : 'Tool result is unknown; do not assume the operation was rolled back.',
                            { code: call.status === 'not-started' ? 'USER_INTERRUPTED' : 'TOOL_RESULT_UNKNOWN' })
                        const previous = entry.checkpoint.snapshot()
                        entry.checkpoint.confirm(call.id, result)
                        try { await entry.conversation.confirmTool(call.id, result) } catch (error) { entry.checkpoint.restore(previous); throw error }
                        await this.publish(entry, 'tool-recovery', { call: entry.checkpoint.snapshot()?.turn.toolCalls.find(item => item.id === call.id), previousStatus: call.status, result,
                            operationId: this.operationId(entry, call.id) }).catch(() => {})
                    }
                }
                const input = entry.pendingInputId && !entry.admissions[entry.pendingInputId] ? undefined : this.hasModelContinuation(entry) ? { resume: true } as const : undefined
                this.launch(entry, entry.checkpoint.snapshot() ? { resume: true } : input)
                return { accepted: true }
                } finally { entry.resuming = false }
            }
            case 'approve': return { accepted: this.entry(command.sessionId).permissions.reply(command.approvalId, command.approved) }
            case 'resources': {
                const workspace = command.workspace === null ? this.workspaceParent() : resolve(command.workspace ?? this.options.workspace)
                let directory = workspace
                if (command.workspace === null) for (;;) {
                    try { if (!(await stat(directory)).isDirectory()) throw new Error('Workspace must be a directory.'); break }
                    catch (cause) { if (!isMissing(cause) || dirname(directory) === directory) throw cause; directory = dirname(directory) }
                }
                const project = await createProjectFiles(directory, this.paths.root, this.options.globalSkillsRoot)
                const layered = await workspaceConfig(inspectedConfig, directory, this.paths.root)
                const context = (): never => { throw new Error('Resource queries cannot initialize an Agent context.') }
                const skills = new SkillsPlugin({ files: project.files, roots: project.roots, context })
                const guidance = new ProjectGuidancePlugin({ files: project.files, scopes: project.scopes, context })
                const agents = await agentCatalog(directory, this.paths.root)
                const resources = displayValue({ workspace: directory, skills: await skills.catalog(), skillsEnabled: pluginEnabled(layered.config, 'skills'), guidance: (await guidance.load()).map(({ root, path }) => ({ root, path })),
                    agents: { ...agents, agents: agents.agents.map(({ instructions: _instructions, ...agent }) => agent) },
                    memory: await this.memoryView(undefined, layered.config), configSources: layered.sources, disabledSkills: layered.config.skills.disabled })
                return this.redact({ ...resources.value, config: publicConfig({ ...layered.config, workspace: directory }, this.catalog), ...(resources.truncated ? { displayTruncated: true } : {}) }, inspectedConfig, layered.config)
            }
            case 'instructions': {
                const workspace = resolve(command.workspace ?? this.options.workspace)
                const globalPath = resolve(this.paths.root, 'AGENTS.md')
                if (command.action === 'save-global') {
                    if (command.content === undefined) throw new Error('保存全局 AGENTS.md 需要内容。')
                    await writeAtomic(globalPath, command.content)
                }
                const project = await createProjectFiles(workspace, this.paths.root, this.options.globalSkillsRoot)
                const context = (): never => { throw new Error('Instruction queries cannot initialize an Agent context.') }
                const guidance = new ProjectGuidancePlugin({ files: project.files, scopes: project.scopes, context })
                const sources = (await guidance.load()).map(source => ({ scope: source.root, path: source.path, displayPath: project.files.sourcePath(source.root, source.path), content: source.content }))
                const globalContent = await readFile(globalPath, 'utf8').catch(error => { if (isMissing(error)) return ''; throw error })
                const layered = await workspaceConfig(inspectedConfig, workspace, this.paths.root)
                return this.redact({ globalPath, globalContent, sources }, inspectedConfig, layered.config)
            }
            case 'plugins': {
                if (!command.sessionId) {
                    const layered = await workspaceConfig(inspectedConfig, resolve(command.workspace ?? this.options.workspace), this.paths.root)
                    return { scope: 'configuration', plugins: [], installed: installedPlugins(layered.config, inspectedConfig), marketplace: pluginMarketplace(layered.config) }
                }
                await this.refreshSessions(command.sessionId)
                const unavailable = this.unavailable.get(command.sessionId)
                if (unavailable) return { scope: 'session', marketplace: pluginMarketplace(inspectedConfig), installed: installedPlugins(inspectedConfig, inspectedConfig), plugins: foldObservability(unavailable.events.filter(isObservation).map(event => event.data as ObservabilityEvent)).runs.at(-1)?.composition?.plugins ?? [] }
                const entry = this.entry(command.sessionId)
                return { scope: 'session', plugins: entry.plugins.map(plugin => {
                    const value = plugin as AgentPlugin<ChatInput> & { name?: string; description?: string; ui?: { kind: string; title: string } }
                    return { id: plugin.id, ...(value.name ? { name: value.name } : {}), ...(value.description ? { description: value.description } : {}),
                        ...(value.ui ? { surface: value.ui } : {}),
                        ...(plugin === entry.conversation ? { components: [entry.session.id, entry.context.id, entry.model.id] } : {}) }
                }), installed: installedPlugins(entry.config, inspectedConfig), marketplace: pluginMarketplace(entry.config) }
            }
            case 'memory-file': {
                const ownerId = command.sessionId ? this.entries.get(command.sessionId)?.metadata.ownerId ?? this.unavailable.get(command.sessionId)?.state.metadata.ownerId : 'local'
                if (!ownerId) throw new Error('会话不存在。')
                const path = resolve(this.store.directory(ownerId), 'memory.md')
                let exists = true
                const content = await readFile(path, 'utf8').catch(error => { if (isMissing(error)) { exists = false; return '' }; throw error })
                const workspace = command.sessionId ? this.entries.get(command.sessionId)?.metadata.workspace ?? this.unavailable.get(command.sessionId)?.state.metadata.workspace ?? this.options.workspace : this.options.workspace
                const layered = await workspaceConfig(inspectedConfig, workspace, this.paths.root)
                return this.redact(displayValue({ path, content, exists }, 200_000).value, inspectedConfig, layered.config)
            }
            case 'observability': {
                await Promise.all([...this.eventJobs])
                if (command.action === 'summary') await this.refreshSessions(command.sessionId)
                const archive = command.action === 'summary' ? this.unavailable.get(command.sessionId) : undefined
                if (archive) return this.redact(await this.observabilityView({ events: archive.events, metadata: archive.state.metadata, status: archive.state.status, runId: undefined }), inspectedConfig)
                const entry = command.action === 'evaluate' ? await this.own(command.sessionId) : this.entry(command.sessionId)
                if (command.action === 'evaluate') {
                    if (!command.evaluator) throw new Error('评测需要 evaluator。')
                    const existing = foldObservability(entry.observations.map(event => event.data as ObservabilityEvent))
                    if (command.runId && !existing.runs.some(run => run.runId === command.runId)) throw new Error('评测目标 run 不存在。')
                    entry.observability.recordEvaluation({ evaluator: command.evaluator, ...(command.runId ? { runId: command.runId } : {}),
                        ...(command.score === undefined ? {} : { score: command.score }), ...(command.passed === undefined ? {} : { passed: command.passed }),
                        ...(command.note === undefined ? {} : { note: command.note }) })
                    await Promise.all([...this.eventJobs])
                }
                return this.redact(await this.observabilityView(entry), inspectedConfig)
            }
            case 'memory': { this.scheduleMemory(command.sessionId); return this.memoryView(this.entry(command.sessionId)) }
            case 'agents': {
                const catalog = await agentCatalog(command.workspace ?? this.options.workspace, this.paths.root)
                return { ...catalog, agents: catalog.agents.map(({ instructions: _instructions, ...agent }) => agent) }
            }
            case 'model-catalog': {
                if (command.refresh) await this.loadModelCatalog()
                else if (this.catalogExpired()) { try { await this.loadModelCatalog() } catch (error) { if (!modelCatalog(this.catalog).cached) throw error } }
                return modelCatalog(this.catalog, command.provider)
            }
            case 'project': {
                const workspace = command.sessionId ? this.entry(command.sessionId).metadata.workspace : command.workspace ?? this.options.workspace ?? this.config.workspace
                if (command.action === 'search') return projectSearch(workspace, command.query ?? '')
                return command.action === 'list' ? projectList(workspace, command.path) : projectRead(workspace, command.path ?? '.')
            }
            case 'presentation-reply': { this.options.presentation?.confirm(command.requestId, command.reply); return null }
            case 'mcp': {
                const entry = command.sessionId ? this.entry(command.sessionId) : undefined
                const workspace = entry?.metadata.workspace ?? command.workspace ?? this.options.workspace
                const layered = await workspaceConfig(this.config, workspace, this.paths.root)
                const config = entry?.status === 'running' ? entry.config : layered.config
                if (command.action === 'connect') {
                    await Promise.allSettled(previousCommands)
                    if (this.configuring || [...this.entries.values()].some(entry => entry.draining || [...entry.taskFacts.values()].some(task => task.status === 'running'))) throw new Error('请在运行和后台任务结束后连接或重试 MCP。')
                    const server = config.mcp.find(server => server.id === command.serverId)
                    if (!server) throw new Error('MCP server 不存在。')
                    if (!server.enabled) throw new Error('MCP server 已禁用。')
                    this.configuring = true
                    try {
                        await this.mcpClient(server, workspace, this.mcp, !layered.untrustedMcp.includes(server.id)).listTools()
                        const entries = await this.rebuild(this.config, this.catalog, this.mcp)
                        this.entries.clear(); for (const [id, candidate] of entries) this.entries.set(id, candidate)
                        this.restoreChildren()
                    }
                    catch { throw new Error(layered.untrustedMcp.includes(server.id) ? '项目 MCP 尚未授权，请在设置中允许此目录。' : 'MCP 连接失败，请检查服务配置与连接状态后重试。') }
                    finally { this.configuring = false }
                }
                return config.mcp.map(server => ({ id: server.id, transport: server.transport, enabled: server.enabled,
                    globalEnabled: this.config.mcp.find(item => item.id === server.id)?.enabled,
                    source: layered.projectMcp.includes(server.id) ? 'project' : 'global',
                    ...(!server.enabled ? { status: 'disabled', toolCount: 0 } :
                        layered.untrustedMcp.includes(server.id) ? { status: 'untrusted', toolCount: 0 } : this.mcpClient(server, workspace).status) }))
            }
            case 'mcp-set-enabled':
            case 'plugin-set-enabled':
            case 'plugin-install': {
                this.configuring = true
                try {
                    await Promise.allSettled(previousCommands)
                    if ([...this.entries.values()].some(entry => entry.draining || [...entry.taskFacts.values()].some(task => task.status === 'running'))) throw new Error('请在运行和后台任务结束后修改插件配置。')
                    const workspace = await canonicalPath(command.workspace ?? this.options.workspace)
                    const global = command.scope === 'global', path = global ? this.paths.config : resolve(workspace, '.quifox', 'config.json')
                    return await withFileLease(path, async () => {
                        const base = await loadConfig(this.paths.root, this.options.workspace, this.options.environment)
                        const effective = global ? base : (await workspaceConfig(base, workspace, this.paths.root)).config
                        const pluginId = command.type === 'mcp-set-enabled' ? `mcp:${command.serverId}` : command.pluginId
                        if (command.type === 'plugin-install' ? !builtinPlugins.some(plugin => plugin.id === pluginId) : !installedPlugins(effective, base).some(plugin => plugin.id === pluginId)) throw new Error('插件不存在或不是可停用扩展。')
                        const existing = global ? await loadConfig(this.paths.root, this.options.workspace, {}) : await readFile(path, 'utf8').then(text => z.record(z.string(), z.unknown()).parse(JSON.parse(text)), error => { if (isMissing(error)) return {}; throw error })
                        let patch: Record<string, unknown>
                        if (command.type === 'plugin-install') {
                            patch = { installedPlugins: command.action === 'install' ? [...new Set([...effective.installedPlugins, pluginId])] : effective.installedPlugins.filter(id => id !== pluginId) }
                        } else if (pluginId.startsWith('mcp:')) {
                            const serverId = pluginId.slice(4), items = z.array(z.record(z.string(), z.unknown())).parse('mcp' in existing ? existing.mcp : [])
                            patch = { mcp: [...items.filter(item => item.id !== serverId), { ...items.find(item => item.id === serverId), id: serverId, enabled: command.enabled }] }
                        } else patch = { plugins: { ...z.record(z.string(), z.unknown()).parse('plugins' in existing ? existing.plugins : {}), [pluginId]: command.enabled } }
                        const value = { ...existing, ...patch }
                        const next = global ? mergeConfig(base, patch) : base
                        const candidate = global ? undefined : { path, value }
                        const preview = global ? next : (await workspaceConfig(next, workspace, this.paths.root, candidate)).config
                        modelBudget(preview, this.catalog)
                        this.memoryController?.abort(); await this.memoryWork; await this.journal.flush()
                        const clients = new Map<string, HostMcpClient>()
                        let entries: Map<string, Entry>
                        try { entries = await this.rebuild(next, this.catalog, clients, candidate); await writeAtomic(path, `${JSON.stringify(value, null, 2)}\n`) }
                        catch (error) { await Promise.allSettled([...clients.values()].map(client => client.close())); throw error }
                        const previous = [...this.mcp.values()]
                        this.config = next; this.configStamp = undefined
                        this.entries.clear(); for (const [id, entry] of entries) this.entries.set(id, entry)
                        this.mcp.clear(); for (const [id, client] of clients) this.mcp.set(id, client)
                        this.restoreChildren(); await Promise.allSettled(previous.map(client => client.close()))
                        return command.type === 'plugin-install' ? { scope: command.scope, pluginId, installed: command.action === 'install' } : { scope: command.scope, ...(command.type === 'mcp-set-enabled' ? { serverId: command.serverId } : { pluginId }), enabled: command.enabled }
                    })
                } finally { this.configuring = false }
            }
            case 'session-config': {
                this.configuring = true
                try {
                    await Promise.allSettled(previousCommands)
                    if ([...this.entries.values()].some(entry => entry.draining || [...entry.taskFacts.values()].some(task => task.status === 'running'))) throw new Error('请在运行和后台任务结束后修改会话配置。')
                    const entry = await this.own(command.sessionId), saved = this.saved(entry)
                    if (command.approvalMode) {
                        if (entry.permissions.mode === 'deny') throw new Error('当前 Agent 的权限限制不允许修改审批模式。')
                        saved.metadata.approvalMode = command.approvalMode
                    }
                    if (command.modelId) saved.metadata.modelId = command.modelId
                    if (command.reasoningEffort === null) delete saved.metadata.reasoningEffort
                    else if (command.reasoningEffort) saved.metadata.reasoningEffort = command.reasoningEffort
                    const candidate = await this.compose(saved, entry.events)
                    const candidates = new Map(this.entries); candidates.set(command.sessionId, candidate)
                    // Rebind the whole idle composition so parent/child capabilities refer to the selected model.
                    const entries = new Map<string, Entry>()
                    for (const [id, value] of candidates) entries.set(id, await this.compose(this.saved(value), value.events))
                    await this.persist(entries.get(command.sessionId)!)
                    this.entries.clear(); for (const [id, value] of entries) this.entries.set(id, value)
                    this.restoreChildren(); return this.view(this.entry(command.sessionId))
                } finally { this.configuring = false }
            }
            case 'refresh-models': {
                this.configuring = true
                try {
                await Promise.allSettled(previousCommands)
                if ([...this.entries.values()].some(entry => entry.draining || [...entry.taskFacts.values()].some(task => task.status === 'running'))) throw new Error('请在运行结束后刷新模型资料。')
                const response = await fetch('https://models.dev/api.json', { signal: AbortSignal.timeout(20_000) })
                if (!response.ok) throw new Error('模型资料刷新失败。')
                const catalog: unknown = await response.json()
                if (!catalog || typeof catalog !== 'object' || Array.isArray(catalog)) throw new Error('模型资料格式无效。')
                modelBudget(this.config, catalog)
                this.memoryController?.abort(); await this.memoryWork
                await this.journal.flush()
                const entries = await this.rebuild(this.config, catalog, this.mcp)
                await writeAtomic(this.paths.models, `${JSON.stringify(catalog)}\n`); this.catalog = catalog; this.catalogUpdatedAt = Date.now(); this.catalogCompositionPending = false
                this.entries.clear(); for (const [id, entry] of entries) this.entries.set(id, entry)
                this.restoreChildren()
                return { refreshed: true }
                } finally { this.configuring = false }
            }
            case 'config': {
                this.configuring = true
                try {
                await Promise.allSettled(previousCommands)
                const patch = z.record(z.string(), z.unknown()).parse(command.patch)
                if (Object.keys(patch).length === 1 && Object.hasOwn(patch, 'preferences')) return await withFileLease(this.paths.config, async () => {
                    const next = mergeConfig(await loadConfig(this.paths.root, this.options.workspace, this.options.environment), patch)
                    const stored = mergeConfig(await loadConfig(this.paths.root, this.options.workspace, {}), patch)
                    const preferences = await Promise.all([...this.entries.values()].map(async entry => ({ entry,
                        value: (await workspaceConfig(next, entry.metadata.workspace, this.paths.root)).config.preferences })))
                    await saveConfig(this.paths.root, stored)
                    this.config.preferences = next.preferences; this.configStamp = undefined
                    for (const { entry, value } of preferences) {
                        entry.config.preferences = value
                        entry.baseConfig.preferences = value
                    }
                    return publicConfig(next, this.catalog)
                })
                if ([...this.entries.values()].some(entry => entry.draining || [...entry.taskFacts.values()].some(task => task.status === 'running'))) throw new Error('请在运行和后台任务结束后修改配置。')
                return await withFileLease(this.paths.config, async () => {
                const next = mergeConfig(await loadConfig(this.paths.root, this.options.workspace, this.options.environment), command.patch),
                    stored = mergeConfig(await loadConfig(this.paths.root, this.options.workspace, {}), command.patch)
                modelBudget(next, this.catalog)
                this.memoryController?.abort(); await this.memoryWork
                await this.journal.flush()
                const clients = new Map<string, HostMcpClient>()
                let entries: Map<string, Entry>
                try { entries = await this.rebuild(next, this.catalog, clients); await saveConfig(this.paths.root, stored) }
                catch (error) { await Promise.allSettled([...clients.values()].map(client => client.close())); throw error }
                const previous = [...this.mcp.values()]
                this.config = next
                this.mcp.clear(); for (const [id, client] of clients) this.mcp.set(id, client)
                this.entries.clear(); for (const [id, entry] of entries) this.entries.set(id, entry)
                this.restoreChildren()
                await Promise.allSettled(previous.map(client => client.close()))
                return publicConfig(next, this.catalog)
                })
                } finally { this.configuring = false }
            }
            case 'close': await this.close(); return { closed: true }
        }
    }

    async waitForIdle(id: string): Promise<void> { const entry = this.entry(id); if (entry.child) await entry.child.parent.subagents.join(entry.child.control.taskId, entry.child.owner); await entry.draining }
    private entry(id: string): Entry { const entry = this.entries.get(id); if (!entry) throw new Error(this.unavailable.has(id) ? '此会话的工作目录或配置不可用，请修复后重试或新建会话。' : '会话不存在。'); return entry }

    private async configurationStamp(): Promise<string> {
        const workspaces = [this.options.workspace, ...[...this.entries.values()].map(entry => entry.metadata.workspace)]
        const paths = [...new Set([this.paths.config, ...workspaces.flatMap(workspace => ancestorDirectories(workspace).map(directory => resolve(directory, '.quifox', 'config.json')))])].sort()
        return JSON.stringify(await Promise.all(paths.map(async path => {
            try { const file = await stat(path); return [path, file.ino, file.size, file.mtimeMs, file.ctimeMs] }
            catch (error) { if (isMissing(error)) return [path, null]; throw error }
        })))
    }

    private refreshConfiguration(): Promise<void> {
        if (this.configRefresh) return this.configRefresh
        if (this.closed || this.configuring) return Promise.resolve()
        // Capture only already-admitted commands: callers joining this refresh must not wait on one another.
        const previous = [...this.commands]
        const work = (async () => {
            const stamp = await this.configurationStamp()
            if (stamp === this.configStamp && !this.catalogCompositionPending) return
            await Promise.allSettled(previous)
            if (this.closed || this.configuring) return
            const next = await loadConfig(this.paths.root, this.options.workspace, this.options.environment)
            const sameGlobal = JSON.stringify(next) === JSON.stringify(this.config)
            const sameScopes = !this.catalogCompositionPending && sameGlobal && (await Promise.all([...this.entries.values()].map(async entry => {
                const layered = await workspaceConfig(next, entry.metadata.workspace, this.paths.root)
                return JSON.stringify(selectModel(layered.config, entry.metadata.modelId, entry.metadata.reasoningEffort, this.catalog)) === JSON.stringify(entry.config)
            }))).every(Boolean)
            if (sameScopes) { this.configStamp = stamp; return }
            if ([...this.entries.values()].some(entry => entry.draining || [...entry.taskFacts.values()].some(task => task.status === 'running'))) return
            this.configuring = true
            const clients = new Map<string, HostMcpClient>()
            try {
                modelBudget(next, this.catalog)
                this.memoryController?.abort(); await this.memoryWork
                const entries = await this.rebuild(next, this.catalog, clients)
                const old = [...this.mcp.values()]
                this.config = next; this.configStamp = stamp; this.catalogCompositionPending = false
                this.entries.clear(); for (const [id, entry] of entries) this.entries.set(id, entry)
                this.mcp.clear(); for (const [id, client] of clients) this.mcp.set(id, client)
                this.restoreChildren()
                await Promise.allSettled(old.map(client => client.close()))
            } catch (error) { await Promise.allSettled([...clients.values()].map(client => client.close())); throw error }
            finally { this.configuring = false }
        })()
        this.configRefresh = work
        void work.catch(() => {}).finally(() => { if (this.configRefresh === work) this.configRefresh = undefined })
        return work
    }

    private archiveSummary(archive: UnavailableArchive): SessionSummary {
        const { metadata, status } = archive.state
        return { id: metadata.id, title: metadata.title, workspace: metadata.workspace, updatedAt: metadata.updatedAt,
            ...(metadata.parentId ? { parentId: metadata.parentId } : {}), ...(metadata.taskId ? { taskId: metadata.taskId } : {}),
            ...(metadata.taskId ? { name: metadata.name ?? `Agent-${metadata.taskId.slice(0, 8)}` } : {}),
            status: status === 'running' ? 'stopped' : status, resumeAvailable: false, unavailable: '工作目录或配置不可用，原始会话仍可查看。修复后重新选择此会话，或新建会话。' }
    }

    private async archiveView(archive: UnavailableArchive, command: Extract<RuntimeCommand, { type: 'snapshot' }>): Promise<SessionView> {
        const { state } = archive, messages = state.session.history.filter(item => !item.compaction && item.message.role !== 'system')
        const events = archive.events.filter(event => (!command.runId || event.runId === command.runId) && (command.traceOnly ? isObservation(event) : event.type !== 'input-routing-admission'))
        const view: SessionView = { ...this.archiveSummary(archive), modelId: state.metadata.modelId ?? 'default',
            messages: (command.messageLimit ? messages.slice(-command.messageLimit) : messages).map(item => this.transcript(state.metadata.id, item, state.origins[item.id] ?? 'context')),
            events: command.eventLimit ? events.slice(-command.eventLimit) : events, totalMessages: messages.length, totalEvents: archive.events.length, eventSequence: archive.events.at(-1)?.sequence ?? 0,
            approvals: [], pendingMessages: state.inbox.messages.filter(item => item.status === 'pending' || item.status === 'staged').map(({ id, prompt, mode }) => ({ id, prompt, mode })),
            toolStates: state.checkpoint?.calls.map(({ id, status }) => ({ id, status })) ?? [], backgroundTasks: [], skills: { skills: [], issues: [] }, guidance: [],
            memory: { enabled: this.config.memory.enabled, processing: false, content: '', summaries: 0 } }
        return this.redact(command.traceOnly ? displaySession(view) : view)
    }

    private async rebuild(config: RuntimeConfig, catalog: unknown, clients: Map<string, HostMcpClient>, candidate?: WorkspaceConfigLayer): Promise<Map<string, Entry>> {
        const entries = new Map<string, Entry>()
        for (const [id, entry] of this.entries) entries.set(id, await this.compose(this.saved(entry), entry.events, undefined, config, catalog, clients, candidate))
        return entries
    }

    private async compose(saved: SavedState, events: RuntimeEvent[] = [], child?: Entry['child'], config = this.config, catalog = this.catalog, clients = this.mcp, candidate?: WorkspaceConfigLayer): Promise<Entry> {
        const layered = await workspaceConfig(config, saved.metadata.workspace, this.paths.root, candidate)
        config = selectModel(layered.config, saved.metadata.modelId, saved.metadata.reasoningEffort, catalog)
        if (layered.unregisteredModelOrigins.includes(new URL(config.model.baseUrl).origin)) throw new SubAgentRequestError('项目模型地址尚未在全局连接中配置，请先在设置中添加该连接。', 'MODEL_CONNECTION_UNREGISTERED')
        saved.metadata.generateMemory = !saved.metadata.parentId && pluginEnabled(config, 'memory') && config.memory.enabled && config.memory.generate
        const agents = await agentCatalog(saved.metadata.workspace, this.paths.root)
        const definition = saved.metadata.agentName ? agents.agents.find(agent => agent.name === saved.metadata.agentName) : undefined
        if (saved.metadata.agentName && !definition) throw new SubAgentRequestError('Agent 定义不存在或无效。', 'SUBAGENT_AGENT_INVALID')
        const project = await createProjectFiles(saved.metadata.workspace, this.paths.root, this.options.globalSkillsRoot)
        const entry = { history: saved.session.history, liveText: '', config, baseConfig: layered.config, projectMcp: layered.projectMcp, untrustedMcp: layered.untrustedMcp, agents, configSources: layered.sources, metadata: saved.metadata, status: saved.status, origins: saved.origins, inputOrigins: saved.inputOrigins,
            events, observations: events.filter(isObservation), sequence: events.at(-1)?.sequence ?? 0, runId: undefined, controller: undefined, draining: undefined, taskFacts: new Map(), taskRuns: new Map(), owner: undefined,
            admissions: saved.admissions, resuming: false, child, managedRun: false, initialInputId: undefined, pendingInputId: saved.pendingInputId, persistence: Promise.resolve(),
            compactions: new Set(events.filter(event => event.type === 'compaction' && (event.data as { status?: string }).status === 'committed').map(event => (event.data as { id: string }).id)), recoveryUnknown: saved.status === 'running' || saved.inbox.messages.some(item => item.status === 'pending' || item.status === 'staged'),
            prepareInput: { prompt: '' }, preparing: undefined, stopEpoch: 0 } as Entry
        entry.inbox = new MessageInboxPlugin(saved.inbox, { beforeAdmission: () => entry.persistence.catch(() => {}) }); entry.inbox.restoreStaged()
        entry.session = new ChatSessionPlugin({ id: saved.metadata.id, ownerId: saved.metadata.ownerId, snapshot: saved.session,
            store: { save: snapshot => this.persist(entry, snapshot, true) } })
        entry.context = new RequestContextPlugin(entry.session)
        const budget = modelBudget(config, catalog)
        const generation = new ChatModelPlugin({ session: entry.context.source, ...this.modelOptions(config, catalog), signal: () => this.signal(entry),
            contextWindow: budget.contextWindow, maxInputTokens: budget.maxInputTokens })
        entry.model = generation
        entry.conversation = new ContextualChatConversationPlugin({ session: entry.session, generation, context: entry.context,
            compaction: (session, model, context) => new ChatCompactionSource(session, model, candidate => estimateChatInputTokens({ ...candidate, messages: context.project(candidate.messages) })) })
        entry.checkpoint = new ExecutionCheckpointPlugin(saved.checkpoint, { canResumeModel: () => this.hasModelContinuation(entry) })
        entry.interrupt = new InterruptPlugin({ mode: 'terminate' })
        entry.tasks = new BackgroundTasksPlugin({ newId: randomUUID, signal: () => this.signal(entry), onTask: task => {
            if (!entry.taskRuns.has(task.id)) entry.taskRuns.set(task.id, entry.runId)
            entry.taskFacts.set(task.id, task); void this.publish(entry, 'background-task', task, { runId: entry.taskRuns.get(task.id) }).catch(() => {})
        } })
        for (const event of events.filter(event => event.type === 'background-task')) {
            const task = structuredClone(event.data) as BackgroundTaskSnapshot
            if (task.status === 'running') task.status = 'unknown'
            entry.taskFacts.set(task.id, task)
            entry.taskRuns.set(task.id, event.runId)
        }
        const planTools = new Set<string>()
        const allowed = (name: string): boolean => (entry.config.memory.enabled || !name.startsWith('memory_')) && toolAllowed(name, entry.metadata.toolScopes, entry.metadata.toolDenylist) &&
            toolAllowed(name, definition?.tools ? [definition.tools] : [], definition?.disallowedTools) && (definition?.permissionMode !== 'plan' || planTools.has(name))
        const approvalMode = (): 'ask' | 'allow' | 'deny' => entry.metadata.approvalMode === 'deny' || definition?.permissionMode === 'dontAsk' || definition?.permissionMode === 'plan' ? 'deny' : entry.metadata.approvalMode ?? entry.config.approval
        entry.permissions = new PermissionGate({ sessionId: saved.metadata.id, mode: approvalMode, allowed, signal: () => this.signal(entry),
            inspect: (call, ctx) => inspectTool(entry.metadata.workspace, call, ctx.tools.policy(call.name)?.sideEffect === 'none' || call.name === 'open_view'),
            operationId: call => this.operationId(entry, call.id), onRequest: request => { void this.publish(entry, 'approval', request).catch(() => {}) } })
        entry.skills = new SkillsPlugin({ files: project.files, roots: project.roots, context: () => entry.context, disabled: config.skills.disabled,
            selected: input => { const prompt = (input as { prompt?: string } | undefined)?.prompt; const match = prompt && /^(?:\$([^\s]+)|\/([a-z0-9-]+))(?:\s|$)/.exec(prompt); return match ? [match[1] ?? match[2]!] : [] } })
        entry.guidance = new ProjectGuidancePlugin({ files: project.files, scopes: project.scopes, context: () => entry.context })
        const memory = new MemoryPlugin({ service: this.memory, binding: () => ({ ownerId: entry.metadata.ownerId, conversationId: entry.metadata.id,
            context: entry.context, operationId: call => this.operationId(entry, call), useMemory: entry.config.memory.enabled }), schedule: () => this.scheduleMemory(entry.metadata.id) })
        const durability: AgentPlugin<ChatInput> = { id: 'host-durability', hooks: {
            onInitialize: async ctx => {
                entry.owner = ctx; entry.tasks.restore(ctx, [...entry.taskFacts.values()])
                for (const child of this.entries.values()) if (child.child?.parent === entry) child.child.owner = ctx
            },
            async *beforeModel() {
                yield { type: 'model-info', requestKind: entry.checkpoint.replaying ? 'replay' : 'request', model: generation.info,
                    inputEstimate: estimateChatInputTokens({ ...generation.request, messages: entry.context.project(generation.request.messages) }) }
                return { action: 'continue' }
            },
            beforeTool: async () => { await this.persist(entry); return { action: 'continue' } }, onRunEnd: async () => { await this.persist(entry) }
        } }
        const childCreationEpochs = new WeakMap<object, number>()
        entry.subagents = new SubAgentsPlugin({ newId: randomUUID, signal: () => this.signal(entry),
            onResolveTask: (taskId, owner) => {
                if (getConversation(owner).conversation !== entry.conversation) return
                const child = [...this.entries.values()].find(candidate => candidate.metadata.taskId === taskId && candidate.metadata.parentId === entry.metadata.id)
                if (!child || child.draining || !this.leases.has(this.journal.path(child.metadata.id)) || entry.subagents.has(taskId)) return
                const control = entry.subagents.restore(entry.conversation, taskId, child.conversation, child.plugins, this.subagentResult(child), this.childName(child))
                child.child = { parent: entry, owner, control }
            },
            createConversation: async (parent, mode, owner, control) => {
                if (parent !== entry.conversation) throw new Error('子 Agent 父会话身份不一致。')
                const stopEpoch = entry.stopEpoch, child = await this.createChild(entry, owner, control, mode, catalog)
                childCreationEpochs.set(child.conversation, stopEpoch)
                return child.conversation
            },
            plugins: conversation => {
                if (childCreationEpochs.get(conversation) !== entry.stopEpoch) throw new SubAgentRequestError('子 Agent 创建已被停止。', 'USER_INTERRUPTED')
                const childEntry = [...this.entries.values()].find(candidate => candidate.conversation === conversation)
                if (!childEntry) throw new Error('子会话未注册。')
                return childEntry.plugins
            },
            onInput: async (taskId, prompt) => {
                const childEntry = this.childEntry(taskId)
                if (this.needsRecovery(childEntry) || this.signal(childEntry)?.aborted) throw new Error('子会话需要先恢复：请 continue 或 replan 后重发消息。')
                const id = randomUUID()
                await this.persist(childEntry, undefined, false, { id, prompt, mode: 'queue', origin: 'other-agent', created: false })
                await this.publish(childEntry, 'inbox', { id, prompt, mode: 'queue' }).catch(() => {})
            },
            onStop: async (taskId, settled) => {
                const childEntry = this.childEntry(taskId)
                childEntry.interrupt.requestStop(); childEntry.controller?.abort(new Error('Subagent stopped.')); childEntry.permissions.close()
                const background = [...childEntry.taskFacts.values()].filter(task => task.status === 'running')
                if (childEntry.owner) for (const task of background) childEntry.tasks.cancel(childEntry.owner, task.id)
                await settled; await childEntry.persistence
                for (const task of childEntry.taskFacts.values()) if (task.status === 'running' && !background.some(item => item.id === task.id)) { background.push(task); if (childEntry.owner) childEntry.tasks.cancel(childEntry.owner, task.id) }
                if (childEntry.owner) await Promise.all(background.map(task => childEntry.tasks.join(childEntry.owner!, task.id)))
                const requestBoundary = childEntry.session.snapshot().pendingInput || childEntry.checkpoint.snapshot() || (childEntry.pendingInputId && childEntry.admissions[childEntry.pendingInputId])
                const activeInputId = requestBoundary ? childEntry.pendingInputId : undefined
                const cancelled = childEntry.inbox.snapshot().messages.filter(message => message.status === 'pending' && message.id !== activeInputId).map(message => message.id)
                if (cancelled.length) { await this.persist(childEntry, undefined, false, undefined, cancelled); await this.publish(childEntry, 'input-cancelled', { ids: cancelled, reason: 'subagent-stopped' }) }
            },
            onResult: async (taskId, result) => {
                const childEntry = this.childEntry(taskId)
                await this.publish(entry, 'subagent-result', { taskId, childId: childEntry.metadata.id, name: this.childName(childEntry), result,
                    resumeAvailable: this.summary(childEntry).resumeAvailable,
                    toolStates: childEntry.checkpoint.snapshot()?.calls.map(({ id, status }) => ({ id, status })) ?? [] })
            },
            execute: async (taskId, agent, _input) => {
                const childEntry = this.childEntry(taskId)
                if (childEntry.draining) await childEntry.draining
                if (this.closed) throw new Error('Host is closed.')
                if (this.needsRecovery(childEntry)) throw new Error('子会话需要先恢复；已接纳消息保留在队列中。')
                const hostAgent = childEntry.agent
                childEntry.agent = agent; childEntry.managedRun = true
                const work = this.drain(childEntry, undefined, true); childEntry.draining = work
                try { return await work ?? { ok: false, error: new StreamClosedError(), errors: [] } }
                finally {
                    childEntry.managedRun = false; childEntry.agent = hostAgent
                    if (childEntry.draining === work) childEntry.draining = undefined
                    const pending = childEntry.inbox.snapshot().messages.find(item => item.status === 'pending' && item.mode === 'steer')
                    if (pending && !this.closed) entry.subagents.send(taskId, pending.prompt)
                }
            } })
        const agentConfiguration: AgentPlugin<ChatInput> = { id: 'host-agent-configuration', hooks: {
            onInitialize: async ctx => {
                for (const tool of ctx.tools.values()) if (tool.policy.sideEffect === 'none') planTools.add(tool.name)
                if (definition?.permissionMode === 'plan') entry.metadata.toolScopes = [...entry.metadata.toolScopes ?? [], [...planTools]]
                for (const tool of ctx.tools.values()) if (!allowed(tool.name)) ctx.tools.remove(tool.name)
            },
            beforeModel: async ctx => {
                entry.context.set('agent-role', [definition?.instructions, entry.metadata.initialInstructions].filter(Boolean).join('\n\n'))
                entry.context.set('agent-definitions', ctx.tools.get('subagent_start') && agents.agents.length ? `Available Agent definitions for subagent_start. Their tool access cannot exceed yours.\n${JSON.stringify(agents.agents.map(({ name, description, model }) => ({ name, description, model })))}` : '')
                const results = entry.events.filter(event => event.type === 'subagent-result').slice(-20).map(event => event.data)
                entry.context.set('subagent-results', results.length ? `Verified child task results. Notifications do not imply a new user request.\n${JSON.stringify(displayValue(results, 20_000).value)}` : '')
                return { action: 'continue' }
            } } }
        const privateResults: AgentPlugin<ChatInput> = { id: 'host-private-tool-results', hooks: { afterTool: async (_ctx, run) => {
            // Preserve the shared result object while removing known credentials before checkpoint/session commits.
            Object.assign(run.result, this.redact(run.result)); return { action: 'continue' }
        } } }
        const preparation: AgentPlugin<ChatInput> = { id: 'host-input-preparation', hooks: { onRunStart: async (_ctx, input) => input === entry.prepareInput
            ? { action: 'stop', value: { kind: 'host-prepared' } } : { action: 'continue' } } }
        entry.observability = new ObservabilityPlugin<ChatInput>({
            sourceId: entry.metadata.id,
            runId: () => entry.runId,
            variant: () => [entry.metadata.modelId ?? 'default', entry.config.model.model, entry.config.model.reasoningEffort ?? 'default'].join(':'),
            composition: ctx => {
                const request = generation.request
                const composition: ObservabilityComposition = {
                    plugins: entry.plugins.map(plugin => {
                        const named = plugin as AgentPlugin<ChatInput> & { name?: string }
                        return { id: plugin.id, ...(named.name ? { name: named.name } : {}) }
                    }),
                    tools: ctx.tools.definitions().map(tool => ({ name: tool.name, description: tool.description })),
                    systemMessages: request.messages.filter(message => message.role === 'system').map(message => ({ content: message.content })),
                    context: entry.context.snapshot()
                }
                return this.observedComposition(composition)
            },
            publish: event => this.publish(entry, 'observability', event)
        })
        const presentation = this.options.presentation ? new PresentationPlugin({
            context: () => entry.context,
            open: async target => {
                this.signal(entry)?.throwIfAborted()
                if (/^https?:\/\//i.test(target)) {
                    const url = new URL(target)
                    target = url.href
                } else {
                    if (/^[a-z][a-z0-9+.-]*:/i.test(target) && !/^[a-z]:[\\/]/i.test(target)) throw new Error('只支持本地文件和 HTTP(S) URL。')
                    const file = await projectTarget(entry.metadata.workspace, target)
                    if (!(await stat(file.path)).isFile()) throw new Error('请选择文件。')
                    target = file.path
                }
                const call = entry.checkpoint.snapshot()?.calls.find(call => call.status === 'started')
                if (!call) throw new Error('展示调用缺少执行身份。')
                return this.options.presentation!.open({ id: randomUUID(), sessionId: entry.metadata.id, operationId: this.operationId(entry, call.id), workspace: entry.metadata.workspace, target }, this.signal(entry))
            }
        }) as AgentPlugin<ChatInput> : undefined
        const candidates = [preparation, entry.interrupt as AgentPlugin<ChatInput>, privateResults, entry.permissions, entry.checkpoint,
            entry.conversation, entry.inbox, entry.skills, entry.guidance, memory, new CompactionPlugin(), entry.tasks as AgentPlugin<ChatInput>,
            nativeTools({ workspace: entry.metadata.workspace, signal: () => this.signal(entry), tasks: entry.tasks, backgroundEnabled: pluginEnabled(config, 'background-tasks') }) as AgentPlugin<ChatInput>, entry.subagents, ...this.mcpPlugins(entry, config, clients),
            ...presentation ? [presentation] : [], agentConfiguration, toolInterruption(() => this.signal(entry)), durability, entry.permissions.guard, new EventPublisherPlugin<ChatInput>({ sourceId: entry.metadata.id }), entry.observability]
        entry.plugins = new PluginActivationPlugin<ChatInput>().select(candidates.map(plugin => Object.assign(plugin, { enabled: pluginEnabled(config, plugin.id) })))
        entry.agent = createAgent<ChatInput>({ plugins: entry.plugins })
        return entry
    }

    private workspaceParent(): string {
        const date = new Date()
        const day = `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, '0')}-${String(date.getDate()).padStart(2, '0')}`
        return join(this.paths.root, 'workspaces', day)
    }

    private async allocateWorkspace(): Promise<string> {
        const parent = this.workspaceParent()
        await mkdir(parent, { recursive: true, mode: 0o700 })
        for (let index = 1; ; index += 1) {
            const directory = join(parent, index === 1 ? 'new-chat' : `new-chat-${index}`)
            try { await mkdir(directory, { mode: 0o700 }); return directory }
            catch (cause) { if ((cause as NodeJS.ErrnoException).code !== 'EEXIST') throw cause }
        }
    }

    private childName(entry: Entry): string { return entry.metadata.name ?? `Agent-${entry.metadata.taskId!.slice(0, 8)}` }

    private recipients(entry: Entry): AgentRecipient[] {
        return agentRecipients([...this.entries.values()].map(item => this.summary(item)).concat([...this.unavailable.values()].map(item => this.archiveSummary(item))), entry.metadata.id)
    }

    /** Initialize the real plugin/tool composition without admitting an input or calling a model. */
    private async prepareContext(entry: Entry): Promise<AgentContext> {
        if (entry.preparing) return entry.preparing
        if (entry.owner) return entry.owner
        if (entry.draining || entry.resuming) throw new Error('父 Agent 正在初始化，请稍后重试。')
        const work = entry.agent.run(entry.prepareInput).then(outcome => {
            if (!outcome.ok || !entry.owner) throw new Error('父 Agent 能力初始化失败。')
            return entry.owner
        })
        entry.preparing = work
        try { return await work } finally { if (entry.preparing === work) entry.preparing = undefined }
    }

    private async createChild(entry: Entry, owner: AgentContext, control: SubAgentControl, mode: 'empty' | 'fork', catalog: unknown,
        prepared?: { id: string; creationIdentity: string; stopEpoch: number; instructions?: string; source: ChatSessionSnapshot; origins: SavedState['origins'] }): Promise<Entry> {
        if (this.closed) throw new Error('quifox 已关闭。')
        const stopEpoch = prepared?.stopEpoch ?? entry.stopEpoch, creationSignal = this.signal(entry)
        const checkCreation = (): void => { if (entry.stopEpoch !== stopEpoch || creationSignal?.aborted) throw new SubAgentRequestError('子 Agent 创建已被停止。', 'USER_INTERRUPTED') }
        checkCreation()
        const configuration: SubAgentConfiguration = control.configuration ?? {}
        const agent = configuration.agent ? entry.agents.agents.find(item => item.name === configuration.agent) : undefined
        if (configuration.agent && !agent) throw new SubAgentRequestError('Agent 定义不存在或无效。', 'SUBAGENT_AGENT_INVALID')
        const choice = configuration.model ?? agent?.model
        const modelId = !choice || choice === 'inherit' ? entry.metadata.modelId ?? 'default' : choice
        const profile = modelId === 'default' ? entry.baseConfig.model : entry.baseConfig.models.find(model => model.id === modelId)
        const requestedEffort = configuration.reasoningEffort ?? agent?.effort ?? profile?.reasoningEffort ??
            (!choice || choice === 'inherit' ? entry.config.model.reasoningEffort : entry.metadata.reasoningEffort)
        const effort = requestedEffort ? reasoningEffortSchema.safeParse(requestedEffort) : { success: true as const, data: undefined }
        if (!effort.success) throw new SubAgentRequestError('思考强度无效。', 'SUBAGENT_CONFIG_INVALID')
        try { modelBudget(selectModel(entry.baseConfig, modelId, effort.data, catalog), catalog) }
        catch { throw new SubAgentRequestError('子 Agent 模型配置不存在或容量/思考强度无效。', 'SUBAGENT_MODEL_INVALID') }
        const id = prepared?.id ?? randomUUID(), now = new Date().toISOString()
        const session = prepared ? new ChatSessionPlugin({ id, ownerId: entry.metadata.ownerId, snapshot: { ...prepared.source, id } }) :
            mode === 'empty' ? entry.session.empty({ id }) : entry.session.fork({ id, boundary: 'before-tools' })
        const parentRole = entry.agents.agents.find(item => item.name === entry.metadata.agentName)
        const deny = entry.metadata.approvalMode === 'deny' || parentRole?.permissionMode === 'plan' || parentRole?.permissionMode === 'dontAsk' ||
            agent?.permissionMode === 'plan' || agent?.permissionMode === 'dontAsk'
        const child = await this.compose({ metadata: { id, ownerId: entry.metadata.ownerId, title: 'Agent', workspace: entry.metadata.workspace,
            parentId: entry.metadata.id, taskId: control.taskId, createdAt: now, updatedAt: now, revision: 0, generateMemory: false, modelId,
            ...(effort.data ? { reasoningEffort: effort.data } : {}), ...(agent ? { agentName: agent.name } : {}),
            ...(prepared ? { creationIdentity: prepared.creationIdentity, ...(prepared.instructions ? { initialInstructions: prepared.instructions } : {}) } : {}),
            toolScopes: [...entry.metadata.toolScopes ?? [], owner.tools.values().map(tool => tool.name), ...(agent?.tools ? [agent.tools] : []),
                ...(agent?.permissionMode === 'plan' ? [owner.tools.values().filter(tool => tool.policy.sideEffect === 'none').map(tool => tool.name)] : [])],
            toolDenylist: [...entry.metadata.toolDenylist ?? [], ...agent?.disallowedTools ?? []], ...(deny ? { approvalMode: 'deny' as const } : entry.metadata.approvalMode ? { approvalMode: entry.metadata.approvalMode } : {}) },
            session: session.snapshot(), inbox: { version: 1, messages: [] }, origins: Object.fromEntries(session.snapshot().history.map(item => [item.id, prepared?.origins[item.id] ?? entry.origins[item.id] ?? 'context'])),
            inputOrigins: {}, admissions: {}, status: 'idle' }, [], { parent: entry, owner, control })
        // Assign and reserve synchronously in the shared tree before the first persistence await.
        if (this.closed) throw new Error('quifox 已关闭。')
        checkCreation()
        const name = allocateSubAgentName(this.recipients(entry).map(item => item.name), configuration.name)
        child.metadata.name = name; child.metadata.title = `Agent ${name}`; control.name = name
        this.entries.set(id, child)
        try { await this.leases.claim(this.journal.path(id)); await this.persist(child) }
        catch (error) { this.entries.delete(id); await this.leases.release(this.journal.path(id)); throw error }
        if (entry.stopEpoch !== stopEpoch || creationSignal?.aborted) { child.status = 'stopped'; child.interrupt.requestStop(); await this.persist(child); checkCreation() }
        await this.publish(entry, 'subagent', this.summary(child)).catch(() => {})
        if (entry.stopEpoch !== stopEpoch || creationSignal?.aborted) { child.status = 'stopped'; child.interrupt.requestStop(); await this.persist(child); checkCreation() }
        return child
    }

    private async humanInput(entry: Entry, prompt: string, mode: 'steer' | 'queue', messageId: string): Promise<unknown> {
        const spawn = parseSpawnInput(prompt)
        if (spawn) {
            const stopEpoch = entry.stopEpoch
            if (!pluginEnabled(entry.config, 'subagents')) throw new Error('子智能体插件已停用。')
            await this.admitRouting(entry, prompt, messageId, [], true)
            const identity = JSON.stringify({ parentId: entry.metadata.id, prompt }), key = `${entry.metadata.id}:${messageId}`
            const previous = this.spawnOperations.get(key)
            if (previous) { if (previous.identity !== identity) throw new Error('子 Agent 创建身份与参数不一致。'); return previous.work }
            const work = this.spawnChildren(entry, spawn, messageId, identity, stopEpoch)
            this.spawnOperations.set(key, { identity, work })
            try { return await work } finally { if (this.spawnOperations.get(key)?.work === work) this.spawnOperations.delete(key) }
        }
        const groups = parseAgentInput(prompt, this.recipients(entry))
        if (groups && !pluginEnabled(entry.config, 'subagents')) throw new Error('子智能体插件已停用。')
        if (!groups) {
            const id = this.inputId(entry.metadata.id, messageId, 'routing-admission')
            const signature = `ordinary:${createHash('sha256').update(JSON.stringify({ prompt, mode })).digest('hex')}`
            const pending = this.routingAdmissions.get(id)
            if (this.routingAdmission(entry, messageId) || (pending && pending.signature !== signature)) throw new Error('此输入身份已用于其他输入。')
            if (pending) return pending.work
            const work = this.submit(entry, prompt, mode, 'human', messageId)
            this.routingAdmissions.set(id, { signature, work })
            try { return await work } finally { if (this.routingAdmissions.get(id)?.work === work) this.routingAdmissions.delete(id) }
        }
        await this.admitRouting(entry, prompt, messageId, groups.map(group => group.agents.map(agent => agent.sessionId)))
        const receipt: Extract<InputRoutingReceipt, { kind: 'dispatch' }> = { kind: 'dispatch', accepted: true, deliveries: [] }
        for (const [index, group] of groups.entries()) for (const agent of group.agents) {
            try {
                const target = await this.own(agent.sessionId)
                const id = this.inputId(entry.metadata.id, messageId, `group-${index}-${agent.sessionId}`)
                if (!target.inputOrigins[id] && (this.needsRecovery(target) || this.signal(target)?.aborted)) throw new Error('子 Agent 需要先 continue 或 replan，再接收新消息。')
                await this.submit(target, group.prompt, 'queue', 'human', id)
                receipt.deliveries.push({ agent, status: 'queued' })
            } catch { receipt.accepted = false; receipt.deliveries.push({ agent, status: 'error', error: '消息未接纳，请检查子 Agent 的恢复状态、执行宿主与持久化。' }) }
        }
        await this.publish(entry, 'input-routing', { messageId, input: prompt, receipt }).catch(() => {})
        return receipt
    }

    private routingAdmission(entry: Entry, messageId: string): string | undefined {
        const id = this.inputId(entry.metadata.id, messageId, 'routing-admission')
        return (entry.events.find(event => event.type === 'input-routing-admission' && (event.data as { id: string }).id === id)?.data as { signature: string } | undefined)?.signature
    }

    private async admitRouting(entry: Entry, prompt: string, messageId: string, recipients: string[][], freeze = false): Promise<void> {
        const id = this.inputId(entry.metadata.id, messageId, 'routing-admission')
        const signature = createHash('sha256').update(JSON.stringify({ prompt, recipients })).digest('hex')
        const previous = this.routingAdmission(entry, messageId), pending = this.routingAdmissions.get(id)
        if (previous || pending) {
            if ((previous ?? pending!.signature) !== signature) throw new Error('子 Agent 输入身份与参数不一致。')
            if (pending) await pending.work
            return
        }
        if (entry.inputOrigins[messageId]) throw new Error('此输入身份已用于普通消息。')
        const snapshot = freeze ? entry.session.fork({ id: randomUUID(), boundary: 'before-tools' }).snapshot() : undefined
        const source = snapshot ? { session: snapshot, origins: Object.fromEntries(snapshot.history.map(item => [item.id, entry.origins[item.id] ?? 'context'])) } : undefined
        const work = this.publish(entry, 'input-routing-admission', { id, signature, ...(source ? { source } : {}) })
        this.routingAdmissions.set(id, { signature, work })
        try { await work } finally { if (this.routingAdmissions.get(id)?.work === work) this.routingAdmissions.delete(id) }
    }

    private inputId(parentId: string, messageId: string, part: string): string {
        const hex = createHash('sha256').update(JSON.stringify([parentId, messageId, part])).digest('hex')
        return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-4${hex.slice(13, 16)}-8${hex.slice(17, 20)}-${hex.slice(20, 32)}`
    }

    private async spawnChildren(entry: Entry, input: { count: number; instructions?: string }, messageId: string, identity: string, stopEpoch: number): Promise<InputRoutingReceipt> {
        const checkCreation = (): void => { if (entry.stopEpoch !== stopEpoch) throw new SubAgentRequestError('子 Agent 创建已被停止。', 'USER_INTERRUPTED') }
        checkCreation()
        const owner = await this.prepareContext(entry)
        checkCreation()
        const ids = Array.from({ length: input.count }, (_, index) => this.inputId(entry.metadata.id, messageId, `child-${index}`))
        const existing = ids.map(id => this.entries.get(id)).find(Boolean)
        let frozen: { session: ChatSessionSnapshot; origins: SavedState['origins'] }
        const admission = entry.events.find(event => event.type === 'input-routing-admission' && (event.data as { id: string }).id === this.inputId(entry.metadata.id, messageId, 'routing-admission'))
        const source = admission ? routingAdmissionSchema.parse(admission.data).source : undefined
        if (source) {
            if (source.session.ownerId !== entry.metadata.ownerId) throw new Error('子 Agent 批次前缀归属不一致。')
            frozen = source
        } else if (existing) {
            let original: SavedState | undefined
            await this.journal.read(existing.metadata.id, { latestStateOnly: true, onState: state => { original ??= savedSchema.parse(state) as SavedState } })
            if (original?.metadata.creationIdentity !== identity) throw new Error('子 Agent 创建身份与参数不一致。')
            frozen = { session: original.session, origins: original.origins }
        } else {
            const source = entry.session.fork({ id: randomUUID(), boundary: 'before-tools' }).snapshot()
            frozen = { session: source, origins: Object.fromEntries(source.history.map(item => [item.id, entry.origins[item.id] ?? 'context'])) }
        }
        const receipt: Extract<InputRoutingReceipt, { kind: 'spawn' }> = { kind: 'spawn', accepted: true, agents: [], errors: [] }
        for (const [index, id] of ids.entries()) {
            try {
                checkCreation()
                let child = this.entries.get(id)
                if (child && (child.metadata.creationIdentity !== identity || child.metadata.parentId !== entry.metadata.id)) throw new Error('子 Agent 创建身份与参数不一致。')
                if (!child) {
                    const taskId = this.inputId(entry.metadata.id, messageId, `task-${index}`)
                    const control: SubAgentControl = { taskId, signal: () => undefined }
                    child = await this.createChild(entry, owner, control, 'fork', this.catalog, { id, creationIdentity: identity, stopEpoch,
                        ...(input.instructions ? { instructions: input.instructions } : {}), source: frozen.session, origins: frozen.origins })
                    child.child = { parent: entry, owner, control: entry.subagents.restore(entry.conversation, taskId, child.conversation, child.plugins, { status: 'idle' }, this.childName(child)) }
                }
                receipt.agents.push({ sessionId: id, taskId: child.metadata.taskId!, name: this.childName(child), status: child.status })
            } catch { receipt.accepted = false; receipt.errors.push(`第 ${index + 1} 个子 Agent 未创建，请重试同一条输入。`) }
        }
        await this.publish(entry, 'input-routing', { messageId, input: `/spawn ${input.count}${input.instructions ? ` ${input.instructions}` : ''}`, receipt }).catch(() => {})
        return receipt
    }

    private modelOptions(config = this.config, catalog = this.catalog) {
        const budget = modelBudget(config, catalog)
        return { model: config.model.model, provider: config.model.provider, baseUrl: config.model.baseUrl,
            contextWindow: budget.contextWindow, maxInputTokens: budget.maxInputTokens,
            ...(config.model.apiKey ? { apiKey: config.model.apiKey } : {}), settings: { maxOutputTokens: budget.maxOutputTokens,
                ...(config.model.reasoningEffort ? { reasoning: { type: 'effort' as const, effort: config.model.reasoningEffort } } : {}),
                ...(config.model.temperature === undefined ? {} : { temperature: config.model.temperature }),
                ...(config.model.providerOptions ? { providerOptions: config.model.providerOptions } : {}) } }
    }

    private catalogExpired(): boolean { return Date.now() >= this.catalogRetryAt && Date.now() - this.catalogUpdatedAt >= 21_600_000 }

    private async loadModelCatalog(): Promise<void> {
        if (this.catalogWork) return this.catalogWork
        const controller = new AbortController()
        this.catalogController = controller
        const work = (async () => {
            try {
                const response = await fetch('https://models.dev/api.json', { signal: AbortSignal.any([controller.signal, AbortSignal.timeout(20_000)]) })
                if (!response.ok) throw new Error('模型资料刷新失败。')
                const catalog: unknown = await response.json()
                if (!catalog || typeof catalog !== 'object' || Array.isArray(catalog)) throw new Error('模型资料格式无效。')
                modelBudget(this.config, catalog)
                if (this.closed) throw new Error('quifox 已关闭。')
                await writeAtomic(this.paths.models, `${JSON.stringify(catalog)}\n`)
                this.catalog = catalog; this.catalogUpdatedAt = Date.now(); this.catalogRetryAt = 0; this.catalogCompositionPending = true
            } catch { this.catalogRetryAt = Date.now() + 300_000; throw new Error('无法获取模型目录；已有连接与配置仍可使用。') }
        })()
        this.catalogWork = work
        try { await work } finally { if (this.catalogWork === work) { this.catalogWork = undefined; this.catalogController = undefined } }
    }

    private mcpPlugins(entry: Entry, config = this.config, clients = this.mcp): AgentPlugin<ChatInput>[] {
        return config.mcp.filter(server => server.enabled && !entry.untrustedMcp.includes(server.id)).map(server => {
            const client = this.mcpClient(server, entry.metadata.workspace, clients, !entry.untrustedMcp.includes(server.id))
            const plugin = new McpPlugin({ namespace: server.id, client: {
                listTools: input => interruptMcp(() => client.listTools(input), this.signal(entry)),
                callTool: (input, signal) => client.callTool(input, signal), close: () => client.close()
            }, signal: () => this.signal(entry) })
            const initialize = plugin.hooks.onInitialize
            plugin.hooks.onInitialize = async ctx => {
                const previous = new Set(ctx.tools.values().map(tool => tool.name))
                try { for (const hook of Array.isArray(initialize) ? initialize : initialize ? [initialize] : []) await hook(ctx) }
                catch {
                    for (const tool of ctx.tools.values()) if (!previous.has(tool.name)) ctx.tools.remove(tool.name)
                    if (this.signal(entry)?.aborted) return
                    client.discoveryFailed()
                    if (!this.closed) await this.publish(entry, 'mcp', { serverId: server.id, status: 'error', message: 'MCP 工具发现失败；其他工具仍可使用，请在设置中连接或重试。' }).catch(() => {})
                }
            }
            return plugin as AgentPlugin<ChatInput>
        })
    }

    private mcpClient(server: RuntimeConfig['mcp'][number], workspace: string, clients = this.mcp, trusted = true): HostMcpClient {
        const key = `${workspace}:${server.id}:${trusted}:${createHash('sha256').update(JSON.stringify(server)).digest('hex')}`
        let client = clients.get(key)
        if (!client) { client = new HostMcpClient(server, workspace, trusted); clients.set(key, client) }
        return client
    }

    private operationId(entry: Entry, call: string): string {
        const batch = [...entry.session.snapshot().history].reverse().find(item => item.message.role === 'assistant' && item.message.toolCalls?.some(tool => tool.id === call))
        if (!batch) throw new Error('工具操作没有持久化批次身份。')
        return `${entry.metadata.id}:${batch.id}:${call}`
    }

    private async submit(entry: Entry, prompt: string, mode: 'steer' | 'queue', origin: 'human' | 'other-agent', id: string = randomUUID()) {
        if (entry.child?.parent.subagents.isStopping(entry.child.control.taskId, entry.child.owner)) throw new Error('子 Agent 正在收尾，请在结束后发送新消息。')
        if (entry.inbox.snapshot().messages.some(message => message.id === id && message.status === 'cancelled')) throw new Error('这条消息已经取消；新任务需要新的消息身份。')
        if (!prompt.trim()) throw new Error('消息不能为空。')
        if (entry.child && !entry.child.parent.subagents.has(entry.child.control.taskId)) {
            entry.child.control = entry.child.parent.subagents.restore(entry.child.parent.conversation, entry.child.control.taskId, entry.conversation, entry.plugins, this.subagentResult(entry), this.childName(entry))
            entry.child.owner = entry.child.parent.owner
        }
        const recovering = this.needsRecovery(entry)
        const admission: Admission = { id, prompt, mode, origin, created: false }
        await this.persist(entry, undefined, false, admission)
        await this.publish(entry, 'inbox', { id, prompt, mode }).catch(() => {})
        if (admission.created && entry.child && !recovering && (mode === 'queue' || !entry.managedRun)) {
            const receipt = entry.child.parent.subagents.send(entry.child.control.taskId, prompt, entry.child.owner)
            if (receipt.status !== 'success') throw new Error('子会话消息已持久化，但调度失败；请检查任务状态后恢复。')
        }
        else if (!entry.child && !entry.draining && !entry.resuming && (entry.status === 'idle' || !this.summary(entry).resumeAvailable)) this.launch(entry)
        return { id, accepted: true, status: 'queued' }
    }

    private launch(entry: Entry, resume?: ChatInput): void {
        if (this.closed) return
        if (entry.draining) throw new Error('会话已有执行者。')
        const work = entry.child ? entry.child.parent.subagents.observeExecution(entry.child.control.taskId, async () => this.subagentResult(entry, await this.drain(entry, resume)), entry.child.owner).then(() => undefined) : this.drain(entry, resume)
        entry.draining = work
        void work.catch(() => {}).finally(() => {
            if (entry.draining === work) entry.draining = undefined
            if (!this.closed) void this.publish(entry, 'session', this.summary(entry)).catch(() => {})
            if (!this.closed && !entry.child && entry.status === 'idle' && entry.inbox.snapshot().messages.some(item => item.status === 'pending')) this.launch(entry)
        })
    }

    private async drain(entry: Entry, resume?: ChatInput, oneShot = false): Promise<AgentRunOutcome | undefined> {
        let input = resume
        let lastOutcome: AgentRunOutcome | undefined
        while (!this.closed) {
            await entry.persistence.catch(() => {})
            if (!input) { const next = entry.inbox.next(); if (!next) break; input = { prompt: next.prompt }; entry.initialInputId = next.id; entry.pendingInputId = next.id }
            else if ('prompt' in input) {
                const prompt = input.prompt
                const pending = entry.inbox.snapshot().messages.find(item => item.status === 'pending' && item.prompt === prompt)
                if (pending) { entry.inbox.claim(pending.id); entry.initialInputId = pending.id; entry.pendingInputId = pending.id }
            }
            entry.status = 'running'; entry.runId = randomUUID(); entry.controller = new AbortController()
            let outcome: AgentRunOutcome | undefined
            let stream: ReturnType<Agent<ChatInput>['stream']> | undefined
            let ended = false
            try {
                await this.persist(entry); await this.publish(entry, 'session', this.summary(entry))
                stream = entry.agent.stream(input)
                while (true) {
                    const next = await stream.next()
                    if (next.done) { outcome = next.value; ended = true; break }
                    await this.publish(entry, 'agent', this.redact(next.value))
                }
                entry.status = entry.controller.signal.aborted || (outcome.ok && (outcome.value as { kind?: string } | undefined)?.kind === 'interrupt') ? 'stopped' : outcome.ok ? 'idle' : 'error'
                if (this.signal(entry)?.aborted) entry.status = 'stopped'
                lastOutcome = outcome
                entry.recoveryUnknown = false
                if (entry.status === 'idle') entry.pendingInputId = undefined
            } catch { entry.status = entry.controller.signal.aborted ? 'stopped' : 'error' }
            finally {
                if (stream && !ended) await stream.return({ ok: false, error: new StreamClosedError(), errors: [] })
                if (this.signal(entry)?.aborted && entry.owner) {
                    const remaining = [...entry.taskFacts.values()].filter(task => task.status === 'running')
                    for (const task of remaining) entry.tasks.cancel(entry.owner, task.id)
                    await Promise.all(remaining.map(task => entry.tasks.join(entry.owner!, task.id)))
                }
                if (!entry.session.snapshot().pendingInput && !entry.checkpoint.snapshot()) entry.inbox.restoreStaged()
                entry.controller = undefined; await this.persist(entry); await this.publish(entry, 'session', this.summary(entry)); entry.runId = undefined; entry.initialInputId = undefined
            }
            input = undefined
            if (oneShot || entry.status !== 'idle') break
        }
        return lastOutcome
    }

    private saved(entry: Entry, snapshot = entry.session.snapshot(), admitted = false): SavedState {
        const origins = { ...entry.origins }, admissions = { ...entry.admissions }
        const inputs = entry.inbox.snapshot().messages.filter(item => item.status === 'staged' && !admissions[item.id])
        const initial = inputs.findIndex(item => item.id === entry.initialInputId)
        if (initial > 0) inputs.unshift(inputs.splice(initial, 1)[0]!)
        for (const item of snapshot.history) {
            if (origins[item.id]) continue
            const message = item.message
            const input = message.role === 'user' && inputs[0]?.prompt === message.content ? inputs.shift() : undefined
            if (input) admissions[input.id] = item.id
            origins[item.id] = item.compaction ? 'memory' : message.role === 'user' ? entry.inputOrigins[input?.id ?? ''] ?? 'context' : message.role
        }
        const checkpoint = entry.checkpoint.snapshot()
        return { metadata: { ...entry.metadata }, session: snapshot, ...(checkpoint ? { checkpoint } : {}),
            inbox: admitted && entry.inbox.snapshot().messages.filter(item => item.status === 'staged').every(item => admissions[item.id]) ? entry.inbox.committedSnapshot() : entry.inbox.snapshot(),
            origins, inputOrigins: { ...entry.inputOrigins }, admissions,
            ...(entry.pendingInputId ? { pendingInputId: entry.pendingInputId } : {}), status: entry.status }
    }

    private persist(entry: Entry, snapshot?: ChatSessionSnapshot, admitted = false, admission?: Admission, cancellation?: readonly string[], inboxUpdate?: { action: 'cancel' | 'steer'; messageId: string }): Promise<void> {
        const work = entry.persistence.catch(() => {}).then(async () => {
        this.leases.assert(this.journal.path(entry.metadata.id))
        const state = this.saved(entry, snapshot, admitted)
        state.metadata.updatedAt = new Date().toISOString(); state.metadata.revision += 1
        if (admission) {
            if (state.inputOrigins[admission.id] && state.inputOrigins[admission.id] !== admission.origin) throw new Error('输入身份来源冲突。')
            const candidate = new MessageInboxPlugin(state.inbox)
            const created = !state.inbox.messages.some(item => item.id === admission.id)
            candidate.post({ id: admission.id, prompt: admission.prompt, mode: admission.mode }); state.inbox = candidate.snapshot(); state.inputOrigins[admission.id] = admission.origin
            if (admission.origin === 'human' && state.metadata.title === 'New session' && !state.session.history.length) state.metadata.title = admission.prompt.trim().split('\n')[0]!.slice(0, 48)
            admission.created = created
        }
        if (cancellation) {
            const candidate = new MessageInboxPlugin(state.inbox); candidate.cancelPending(cancellation); state.inbox = candidate.snapshot()
            if (state.pendingInputId && cancellation.includes(state.pendingInputId)) delete state.pendingInputId
        }
        if (inboxUpdate) {
            const candidate = new MessageInboxPlugin(state.inbox)
            if (inboxUpdate.action === 'steer') candidate.guideThrough(inboxUpdate.messageId)
            else if (!candidate.cancelPending([inboxUpdate.messageId]).length) throw new Error('这条消息已进入请求，无法撤回。')
            state.inbox = candidate.snapshot()
        }
        await this.journal.append(entry.metadata.id, { kind: 'state', state })
        entry.history = state.session.history
        if (admitted && state.session.history.some(item => item.message.role === 'assistant' && item.message.content === entry.liveText)) entry.liveText = ''
        entry.metadata = state.metadata; entry.origins = state.origins; entry.admissions = state.admissions; entry.inputOrigins = state.inputOrigins
        if (admission) entry.inbox.post({ id: admission.id, prompt: admission.prompt, mode: admission.mode })
        if (cancellation) {
            entry.inbox.cancelPending(cancellation)
            if (entry.pendingInputId && cancellation.includes(entry.pendingInputId)) { entry.pendingInputId = undefined; entry.recoveryUnknown = false }
        }
        if (inboxUpdate) {
            if (inboxUpdate.action === 'steer') entry.inbox.guideThrough(inboxUpdate.messageId)
            else entry.inbox.cancelPending([inboxUpdate.messageId])
        }
        if (admitted && !state.inbox.messages.some(item => item.status === 'staged')) entry.inbox.commitStaged()
        await this.observeCompactions(entry, state.session.history)
        })
        entry.persistence = work
        return work
    }

    private async observeCompactions(entry: Entry, history: ChatSessionSnapshot['history'], restored = false): Promise<void> {
        for (const item of history.filter(item => item.compaction && !entry.compactions.has(item.id))) {
            try {
                await this.publish(entry, 'compaction', { status: 'committed', id: item.id, summary: item.message.content, checkpoint: item.compaction, ...(restored ? { restored: true } : {}) })
                entry.compactions.add(item.id)
            } catch { /* The state is committed; a later save can retry its observation. */ }
        }
    }

    private summary(entry: Entry): SessionSummary {
        return { id: entry.metadata.id, title: entry.metadata.title, workspace: entry.metadata.workspace,
            ...(entry.metadata.parentId ? { parentId: entry.metadata.parentId } : {}), ...(entry.metadata.taskId ? { taskId: entry.metadata.taskId } : {}),
            ...(entry.metadata.taskId ? { name: this.childName(entry) } : {}),
            status: entry.status, updatedAt: entry.metadata.updatedAt,
            resumeAvailable: !this.executionTree(entry).some(item => item.draining || item.resuming || item.status === 'running' || [...item.taskFacts.values()].some(task => task.status === 'running')) && entry.status !== 'running' && ((entry.status !== 'idle' && (this.hasModelContinuation(entry) || !!entry.checkpoint.snapshot())) ||
                (!entry.draining && entry.inbox.snapshot().messages.some(item => item.status === 'pending' || item.status === 'staged'))) }
    }

    private hasModelContinuation(entry: Entry): boolean {
        const last = entry.session.messages.at(-1)
        return last?.role === 'user' || last?.role === 'tool'
    }

    private needsRecovery(entry: Entry): boolean {
        return entry.recoveryUnknown || (['stopped', 'error'].includes(entry.status) &&
            (this.hasModelContinuation(entry) || !!entry.checkpoint.snapshot() || !!entry.session.snapshot().pendingInput ||
                !!(entry.pendingInputId && !entry.admissions[entry.pendingInputId])))
    }

    private childEntry(taskId: string): Entry {
        const entry = [...this.entries.values()].find(item => item.metadata.taskId === taskId)
        if (!entry) throw new Error('子任务不存在。')
        return entry
    }

    private restoreChildren(): void {
        for (const child of this.entries.values()) {
            const parent = child.metadata.parentId ? this.entries.get(child.metadata.parentId) : undefined
            if (!parent || !child.metadata.taskId || child.child || !this.leases.has(this.journal.path(child.metadata.id))) continue
            const control = parent.subagents.restore(parent.conversation, child.metadata.taskId, child.conversation, child.plugins, this.subagentResult(child), this.childName(child))
            child.child = { parent, owner: parent.owner, control }
        }
    }

    private subagentResult(entry: Entry, outcome?: AgentRunOutcome): SubAgentResult {
        if (!outcome && entry.inbox.snapshot().messages.some(item => item.status === 'pending' || item.status === 'staged')) return { status: 'unknown' }
        if (entry.recoveryUnknown && !outcome) return { status: 'unknown' }
        const last = [...entry.events].reverse().find(event => event.type === 'agent' && ['run-start', 'run-end'].includes((event.data as { type: string }).type))
        if (!outcome && entry.events.some(event => event.type === 'input-cancelled' && event.sequence > (last?.sequence ?? 0))) return { status: 'cancelled' }
        outcome ??= (last?.data as { type: string; outcome?: AgentRunOutcome } | undefined)?.type === 'run-end' ? (last?.data as { outcome: AgentRunOutcome }).outcome : undefined
        if (!outcome) return entry.status === 'idle' ? { status: 'idle' } : { status: 'unknown' }
        if (outcome.ok && (outcome.value as { reason?: string } | undefined)?.reason === 'tool-result-unknown') return { status: 'unknown' }
        if (entry.status === 'stopped') return { status: 'cancelled' }
        if (!outcome.ok) return { status: 'failed', message: '子任务执行失败，请检查实际运行记录。' }
        const result = outcome.value as { text?: string; toolCalls?: unknown[] } | undefined
        return result?.text?.trim() && result.toolCalls?.length === 0 ? { status: 'completed', text: result.text } : { status: 'unknown' }
    }

    private signal(entry: Entry): AbortSignal | undefined {
        const own = entry.controller?.signal, child = entry.managedRun ? entry.child?.control.signal() : undefined
        return own && child ? AbortSignal.any([own, child]) : own ?? child
    }

    private executionTree(root: Entry): Entry[] {
        const ids = new Set([root.metadata.id])
        for (let previous = -1; previous !== ids.size;) {
            previous = ids.size
            for (const entry of this.entries.values()) if (entry.metadata.parentId && ids.has(entry.metadata.parentId)) ids.add(entry.metadata.id)
        }
        return [...this.entries.values()].filter(entry => ids.has(entry.metadata.id))
    }

    private stopTree(root: Entry): void {
        for (const entry of this.executionTree(root)) {
            entry.stopEpoch++; entry.interrupt.requestStop(); entry.controller?.abort(new Error('User stopped the run.')); entry.permissions.close()
            if (entry.owner) for (const task of entry.taskFacts.values()) if (task.status === 'running') entry.tasks.cancel(entry.owner, task.id)
            if (entry.child) entry.child.parent.subagents.stop(entry.child.control.taskId, entry.child.owner)
        }
    }

    private async memoryView(entry?: Entry, config = entry?.config ?? this.config) {
        if (!pluginEnabled(config, 'memory') || !config.memory.enabled) return { enabled: false, processing: false, content: '', summaries: 0 }
        const owner = entry?.metadata.ownerId ?? 'local', state = await this.store.load(owner)
        return { enabled: config.memory.enabled, processing: !!this.memoryWork, content: (await this.memory.global(owner)).content,
            summaries: Object.keys(state.summaries).length, ...(this.memoryError ? { error: this.memoryError } : {}) }
    }

    private async view(entry: Entry, messageLimit?: number, eventLimit?: number, traceOnly = false, runId?: string): Promise<SessionView> {
        const messages = entry.history.filter(item => !item.compaction && item.message.role !== 'system')
        const events = (traceOnly ? entry.observations : entry.events.filter(event => event.type !== 'input-routing-admission')).filter(event => !runId || event.runId === runId)
        const run = entry.runId ?? [...entry.observations].reverse().find(event => event.type === 'agent' && (event.data as { type?: string }).type === 'run-start')?.runId
        const changes = new Map<string, FileChange>()
        for (let index = entry.observations.length - 1; index >= 0; index -= 1) {
            const event = entry.observations[index]!
            if (run && event.runId !== run) continue
            const data = event.data as { type?: string; result?: { data?: { changes?: FileChange[] } }; run?: { result?: { status?: string; data?: { change?: FileChange; changes?: FileChange[] } } } }
            const result = event.type === 'background-task' ? data.result : event.type === 'agent' && data.type === 'tool-result' ? data.run?.result : undefined
            const files = [...result?.data?.changes ?? [], ...('change' in (result?.data ?? {}) && data.run?.result?.data?.change ? [data.run.result.data.change] : [])]
            for (const change of files) { const latest = changes.get(change.path); changes.set(change.path, latest ? { ...latest, before: change.before, ...(change.truncated ? { truncated: true } : {}) } : change) }
        }
        const messageWindow = messageLimit ? messages.slice(-messageLimit) : messages
        const eventWindow = eventLimit ? events.slice(-eventLimit) : events
        const pendingMessages = entry.inbox.snapshot().messages.filter(item => (item.status === 'pending' || item.status === 'staged') && !entry.admissions[item.id]).map(({ id, prompt, mode, status }) => ({ id, prompt, mode, status: status as 'pending' | 'staged' }))
        const view: SessionView = { ...this.summary(entry), modelId: entry.metadata.modelId ?? 'default', ...(entry.config.model.reasoningEffort ? { reasoningEffort: entry.config.model.reasoningEffort } : {}),
            ...(entry.metadata.reasoningEffort ? { reasoningEffortOverride: entry.metadata.reasoningEffort } : {}),
            models: publicConfig(entry.config, this.catalog).models, configSources: entry.configSources, preferences: entry.config.preferences, approvalMode: entry.permissions.mode,
            defaultModel: publicConfig(entry.baseConfig, this.catalog).model, untrustedMcp: entry.untrustedMcp,
            agents: { ...entry.agents, agents: entry.agents.agents.map(({ instructions: _instructions, ...agent }) => agent) },
            messages: messageWindow.map(item => this.transcript(entry.metadata.id, item, entry.origins[item.id] ?? 'context')), events: eventWindow,
            totalMessages: messages.length, totalEvents: entry.events.length, liveText: entry.liveText,
            changes: [...changes.values()], approvals: entry.permissions.pending,
            eventSequence: entry.sequence,
            pendingMessages,
            skills: pluginEnabled(entry.config, 'skills') ? await entry.skills.catalog() : { skills: [], issues: [] }, guidance: (await entry.guidance.load()).map(({ root, path }) => ({ root, path })), memory: await this.memoryView(entry), backgroundTasks: [...entry.taskFacts.values()],
            toolStates: entry.checkpoint.snapshot()?.calls.map(({ id, status }) => ({ id, status })) ?? [] }
        return this.redact(traceOnly ? displaySession(view) : view)
    }

    private publish(entry: Entry, type: string, data: unknown, origin?: { runId: string | undefined }): Promise<void> {
        const work = (async () => {
        this.leases.assert(this.journal.path(entry.metadata.id))
        const agentEvent = type === 'agent' ? data as { type: string; call?: { id: string }; run?: { call: { id: string } } } : undefined
        if (agentEvent?.type === 'model-start') entry.liveText = ''
        else if (agentEvent?.type === 'text-delta') entry.liveText += (data as { delta?: string }).delta ?? ''
        const callId = agentEvent?.type === 'tool-start' ? agentEvent.call?.id : agentEvent?.type === 'tool-result' ? agentEvent.run?.call.id : undefined
        const operationId = callId ? this.operationId(entry, callId) : type === 'tool-recovery' ? (data as { operationId: string }).operationId : undefined
        const runId = origin ? origin.runId : entry.runId
        const event: RuntimeEvent = { version: 1, sessionId: entry.metadata.id, ...(runId ? { runId } : {}),
            ...(operationId ? { operationId } : {}),
            sequence: ++entry.sequence, timestamp: new Date().toISOString(), type, data: type === 'input-routing-admission' ? data : this.redact(data) }
        await this.journal.append(entry.metadata.id, { kind: 'event', event }); entry.events.push(event)
        if (isObservation(event)) entry.observations.push(event)
        if (type !== 'input-routing-admission') for (const listener of this.listeners) try { listener(structuredClone(displayEvent(event).value)) } catch { /* Observation does not alter execution. */ }
        const parent = entry.metadata.parentId ? this.entries.get(entry.metadata.parentId) : undefined
        if (parent && ['agent', 'session', 'approval', 'background-task', 'compaction', 'subagent-event', 'tool-recovery'].includes(type)) {
            await this.publish(parent, 'subagent-event', { childId: entry.metadata.id, taskId: entry.metadata.taskId, title: entry.metadata.title,
                status: entry.status, event, approvals: entry.permissions.pending,
                toolStates: entry.checkpoint.snapshot()?.calls.map(({ id, status }) => ({ id, status })) ?? [] }).catch(() => {})
        }
        })()
        this.eventJobs.add(work)
        void work.catch(() => {}).finally(() => this.eventJobs.delete(work))
        return work
    }

    private observedComposition(value: ObservabilityComposition): ObservabilityComposition {
        // Redact full values before slicing so a cut cannot expose a prefix of a known credential.
        const source = this.redact(value)
        let remaining = 65_536, truncated = [source.plugins, source.tools, source.systemMessages, source.context].some(items => items.length > 100)
        const metadata = (text: string): string => { if (text.length <= 128) return text; truncated = true; return text.slice(0, 128) + '…' }
        const content = (text: string, limit = 40_000): { content: string; truncated?: boolean } => {
            const length = Math.min(limit, remaining); remaining -= Math.min(text.length, length)
            if (text.length <= length) return { content: text }
            truncated = true; return { content: text.slice(0, length) + '\n…[truncated]', truncated: true }
        }
        const plugins = source.plugins.slice(0, 100).map(item => ({ id: metadata(item.id), ...(item.name ? { name: metadata(item.name) } : {}) }))
        const tools = source.tools.slice(0, 100).map(item => ({ name: metadata(item.name), description: content(item.description, 512).content }))
        const systemMessages = source.systemMessages.slice(0, 100).map(item => content(item.content))
        const context = source.context.slice(0, 100).map(item => ({ key: metadata(item.key), ...content(item.content) }))
        return { plugins, tools, systemMessages, context, totalTools: source.tools.length, ...(truncated ? { truncated: true } : {}) }
    }

    private async observabilityView(entry: Pick<Entry, 'events' | 'metadata' | 'status' | 'runId'>) {
        const events = entry.events.filter(event => event.type === 'observability').map(event => event.data as ObservabilityEvent)
        const summary = foldObservability(events)
        const remoteRun = !entry.runId && entry.status === 'running' && await leaseBusy(this.journal.path(entry.metadata.id)) ? summary.runs.filter(run => run.status === 'running').at(-1)?.runId : undefined
        for (const run of summary.runs) if (run.status === 'running' && run.runId !== (entry.runId ?? remoteRun)) run.status = 'unknown'
        const runs = displayWindow(summary.runs.slice(-50).map(run => ({ ...run, models: run.models.slice(-100), tools: run.tools.slice(-100), evaluations: run.evaluations.slice(-25), errors: run.errors.slice(-100) })), 2_000_000)
        const recoveries = displayWindow(summary.recoveries, 100_000), evaluations = displayWindow(summary.evaluations, 100_000)
        const comparison = displayWindow(compareObservabilityRuns(summary.runs), 200_000)
        const clipped = summary.runs.some(run => run.models.length > 100 || run.tools.length > 100 || run.evaluations.length > 25 || run.errors.length > 100)
        return this.redact({ runs: runs.values, recoveries: recoveries.values, evaluations: evaluations.values, comparison: comparison.values, totalRuns: summary.runs.length,
            ...(clipped || runs.values.length < summary.runs.length || [runs, recoveries, evaluations, comparison].some(item => item.truncated) ? { displayTruncated: true } : {}) })
    }

    private transcript(sessionId: string, item: { id: string; message: TranscriptMessage['message'] }, origin: MemoryOrigin): TranscriptMessage {
        return { id: item.id, message: item.message, origin, ...(item.message.role === 'assistant' && item.message.toolCalls?.length ? {
            operations: item.message.toolCalls.map(call => ({ callId: call.id, operationId: `${sessionId}:${item.id}:${call.id}` }))
        } : {}) }
    }

    private redact<T>(value: T, ...configurations: RuntimeConfig[]): T {
        const secrets = [this.config, ...configurations, ...[...this.entries.values()].map(entry => entry.config)].flatMap(config => [config.model.apiKey, ...config.models.map(model => model.apiKey),
            ...config.mcp.flatMap(server => [...Object.values(server.env ?? {}), ...Object.values(server.headers ?? {})]),
            ...[config.model.baseUrl, ...config.models.map(model => model.baseUrl), ...config.mcp.map(server => server.url)].filter((url): url is string => !!url && !!(new URL(url).search || new URL(url).password))])
            .filter((item): item is string => !!item)
        return JSON.parse(JSON.stringify(value, (_key, item: unknown) => {
            if (item instanceof Error) return { message: item.message, ...('code' in item ? { code: item.code } : {}), ...('phase' in item ? { phase: item.phase } : {}) }
            return typeof item === 'string' ? secrets.reduce((text, secret) => text.split(secret).join('[redacted]'), item) : item
        })) as T
    }

    private scheduleMemory(current: string): void {
        const config = this.entries.get(current)?.config
        if (this.closed || this.configuring || this.memoryJobs.size || !config || !pluginEnabled(config, 'memory') || !config.memory.enabled || !config.memory.generate || !config.model.apiKey) return
        this.memoryController = new AbortController(); this.memoryError = undefined
        const processor = new MemoryProcessor({ store: this.store, archive: this.archive, model: { ...this.modelOptions(config), signal: () => this.memoryController?.signal },
            extractionFormat: config.memory.extractionFormat, newId: randomUUID,
            ...(config.memory.minIdleMs === undefined ? {} : { policy: { minIdleMs: config.memory.minIdleMs } }) })
        const work = processor.run('local', current).then(result => { if (result.errors.length) this.memoryError = result.errors.join(', ') }, () => { this.memoryError = 'Memory processing failed.' }).then(async () => {
            this.memoryWork = undefined; this.memoryController = undefined
            await Promise.all([...this.entries.values()].map(async entry => { await this.publish(entry, 'memory', await this.memoryView(entry)).catch(() => {}) }))
        })
        this.memoryWork = work
        this.memoryJobs.add(work)
        void work.catch(() => {}).finally(() => this.memoryJobs.delete(work))
    }

    close(): Promise<void> {
        return this.closeWork ??= this.finishClose()
    }

    private async finishClose(): Promise<void> {
        this.closed = true; this.memoryController?.abort(); this.catalogController?.abort(); clearInterval(this.catalogTimer)
        const stop = () => { for (const entry of this.entries.values()) {
            if (entry.child) entry.child.parent.subagents.stop(entry.child.control.taskId, entry.child.owner)
            this.stopTree(entry)
        } }
        stop()
        // Initialization belongs to the transport: aborting the Agent alone cannot cancel a pending MCP handshake.
        await Promise.allSettled([...this.mcp.values()].map(client => client.close()))
        await Promise.allSettled([...this.commands])
        stop()
        try { await Promise.allSettled([...this.entries.values()].map(async entry => { await entry.draining?.catch(() => {}); if (entry.child) await entry.child.parent.subagents.join(entry.child.control.taskId, entry.child.owner); if (entry.owner) await entry.tasks.close(entry.owner) })); await Promise.allSettled([...this.memoryJobs]); await Promise.allSettled([...this.eventJobs]); await this.store.flush(); await this.journal.flush() }
        finally { await Promise.allSettled([...this.mcp.values()].map(client => client.close())); await this.leases.close(); this.listeners.clear() }
    }
}
