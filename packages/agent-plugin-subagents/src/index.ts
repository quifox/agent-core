import { z } from 'zod'
import { createAgent, defineTool, toolError, toolSuccess, type Agent, type AgentContext, type AgentEvent, type AgentHooks, type AgentPlugin, type AgentRunOutcome, type ModelTurnResult, type ToolResult } from '@quifox/agent-core'
import { getConversation, type ChatInput, type Conversation } from '@quifox/agent-plugin-session'

export type SubAgentResult = { status: 'idle' | 'running' | 'stopping' | 'cancelled' | 'unknown' } | { status: 'completed'; text: string } | { status: 'failed'; message: string }

export interface SubAgentConfiguration { agent?: string; model?: string; reasoningEffort?: string; name?: string }
export interface SubAgentControl { taskId: string; name?: string; signal(): AbortSignal | undefined; configuration?: SubAgentConfiguration }
export class SubAgentRequestError extends Error {
    constructor(message: string, readonly code: string) { super(message); this.name = 'SubAgentRequestError' }
}
class AdmissionError extends Error {
    constructor(readonly taskId: string, readonly childName: string) { super('Child exists but its initial message was not admitted.') }
}

export const subAgentNameSchema = z.string().trim().min(1).max(64).regex(/^[\p{L}\p{N}_-]+$/u)
const defaultNames = ['Turing', 'Curie', 'Newton', 'Einstein', 'Noether', 'Lovelace', 'Darwin', 'Tesla', 'Faraday', 'Maxwell',
    'Euler', 'Ramanujan', 'Shannon', 'Hopper', 'Boole', 'Pascal', 'Leibniz', 'Archimedes', 'Gauss', 'Kepler'] as const
const nameKey = (name: string): string => name.normalize('NFKC').toLowerCase()

/** Allocate a readable name without model calls; the Host supplies its full ownership scope. */
export function allocateSubAgentName(existing: Iterable<string>, requested?: string): string {
    const used = new Set([...existing].map(nameKey))
    if (requested !== undefined) {
        const parsed = subAgentNameSchema.safeParse(requested)
        if (!parsed.success) throw new SubAgentRequestError('子 Agent 名称须为 1–64 个字母、数字、下划线或短横线。', 'SUBAGENT_NAME_INVALID')
        if (used.has(nameKey(parsed.data))) throw new SubAgentRequestError(`子 Agent 名称已存在：${parsed.data}`, 'SUBAGENT_NAME_TAKEN')
        return parsed.data
    }
    for (let round = 0; ; round += 1) for (const base of defaultNames) {
        const candidate = `${base}${round ? round + 1 : ''}`
        if (!used.has(nameKey(candidate))) return candidate
    }
}

/** 调用方负责构造并重绑子插件；不隐式继承父工具或权限。 */
export interface SubAgentsPluginOptions {
    /** @param conversation - 独立子会话组合。 @param ctx - 父工具的协作 Context。 */
    plugins(conversation: Conversation, ctx: AgentContext, control: SubAgentControl): AgentPlugin<ChatInput>[]
    /** Host may explicitly bind child persistence and capabilities while keeping fork semantics. */
    createConversation?(parent: Conversation, mode: 'empty' | 'fork', ctx: AgentContext, control: SubAgentControl): Promise<Conversation>
    /** Observation failures cannot change execution outcomes. */
    onEvent?(taskId: string, event: AgentEvent): void | Promise<void>
    waitTimeoutMs?: number
    maxCompletedTasks?: number
    newId?(): string
    /** Host admission finishes before an async send acknowledges the child message. */
    onInput?(taskId: string, prompt: string): Promise<void>
    /** Request Host-owned execution cancellation immediately; commit cleanup after the supplied boundary. */
    onStop?(taskId: string, settled: Promise<void>): Promise<void>
    /** Observe the queue's final result without starting another model turn. */
    onResult?(taskId: string, result: SubAgentResult): void | Promise<void>
    /** Host may consume the same Agent stream through its common persistence/event executor. */
    execute?(taskId: string, agent: Agent<ChatInput>, input: ChatInput): Promise<AgentRunOutcome>
    signal?(ctx: AgentContext): AbortSignal | undefined
    /** Restore a durable identity before model tools access an evicted result; Host validates ownership. */
    onResolveTask?(taskId: string, ctx: AgentContext): void | Promise<void>
}

interface ChildState { controller?: AbortController; stopVersion: number }
interface Task { name: string; owner: AgentContext | undefined; parent?: Conversation; agent: Agent<ChatInput>; state: ChildState; result: SubAgentResult; completion: Promise<SubAgentResult>; stopCompletion?: Promise<SubAgentResult>; admissions: Set<Promise<void>> }

/** 启动和等待是两个普通工具；后台任务的所有状态留在本插件。 */
export class SubAgentsPlugin implements AgentPlugin<ChatInput> {
    id = 'subagents'
    readonly hooks: AgentHooks<ChatInput>
    private readonly tasks = new Map<string, Task>()
    private readonly pendingNames = new Set<string>()
    private readonly completed: string[] = []
    private sequence = 0
    private readonly timeout: number
    private readonly maxCompletedTasks: number

    /** @param options - 子插件编排与有界等待配置。 */
    constructor(private readonly options: SubAgentsPluginOptions) {
        this.timeout = options.waitTimeoutMs ?? 10_000
        if (!Number.isSafeInteger(this.timeout) || this.timeout < 0 || this.timeout > 300_000) { throw new Error('子任务等待必须在零到五分钟之间。') }
        this.maxCompletedTasks = options.maxCompletedTasks ?? 100
        if (!Number.isSafeInteger(this.maxCompletedTasks) || this.maxCompletedTasks < 1 || this.maxCompletedTasks > 10_000) {
            throw new Error('已完成子任务保留数量必须在一到一万之间。')
        }
        const start = defineTool({ name: 'subagent_start', description: '创建独立子 Agent。可指定 name，未指定则自动命名；名称不可重复。无 prompt 时保存前缀并待机；有 prompt 时异步启动。可指定 Agent 定义、模型配置和思考强度，缺省继承父选择。',
            inputSchema: z.object({ prompt: z.string().trim().min(1).optional(), mode: z.enum(['empty', 'fork']).default('fork'),
                agent: z.string().min(1).optional(), model: z.string().min(1).optional(), reasoningEffort: z.string().min(1).optional(), name: subAgentNameSchema.optional() }).strict(),
            policy: { sideEffect: 'external', approval: 'none' }, execute: async (input, ctx) => {
                try {
                    const configuration = { ...(input.agent ? { agent: input.agent } : {}), ...(input.model ? { model: input.model } : {}), ...(input.reasoningEffort ? { reasoningEffort: input.reasoningEffort } : {}), ...(input.name ? { name: input.name } : {}) }
                    const data = { ...await this.create(ctx, input.prompt, input.mode, configuration), status: input.prompt ? 'running' : 'idle' }
                    return toolSuccess(JSON.stringify(data), data)
                }
                catch (error) {
                    if (error instanceof SubAgentRequestError) return toolError(error.message, { code: error.code })
                    if (error instanceof AdmissionError) return toolError(`Agent ${error.childName} 已创建，但首条消息未接纳；可检查该任务或重发。`, { code: 'SUBAGENT_ADMISSION_FAILED', data: { taskId: error.taskId, name: error.childName, status: 'idle' } })
                    return toolError('子任务未能创建，请检查会话边界和子插件组合。', { code: 'SUBAGENT_START_FAILED' })
                }
            } })
        const wait = defineTool({ name: 'subagent_wait', description: '等待指定子任务的最终回复。超时返回 running，任务继续执行，之后可再次等待。',
            inputSchema: z.object({ taskId: z.string().min(1), timeoutMs: z.number().int().min(0).max(300_000).optional() }).strict(), policy: { sideEffect: 'none', approval: 'none' },
            execute: async (input, ctx) => this.wait(input.taskId, ctx, input.timeoutMs, this.options.signal?.(ctx)) })
        const send = defineTool({ name: 'subagent_send', description: '向子 Agent 发送后续消息；立即接纳，按到达顺序运行。',
            inputSchema: z.object({ taskId: z.string().min(1), prompt: z.string().trim().min(1) }).strict(), policy: { sideEffect: 'external', approval: 'none' },
            execute: async (input, ctx) => this.sendAsync(input.taskId, input.prompt, ctx) })
        const stop = defineTool({ name: 'subagent_stop', description: '请求停止子 Agent。waitForExit 可优雅等待工具与队列真实收尾；超时返回 stopping。终止不保证副作用回滚，之后可恢复或发送新任务。',
            inputSchema: z.object({ taskId: z.string().min(1), waitForExit: z.boolean().default(false), timeoutMs: z.number().int().min(0).max(300_000).optional() }).strict(), policy: { sideEffect: 'external', approval: 'none' },
            execute: async (input, ctx) => { await this.resolveTask(input.taskId, ctx); return input.waitForExit ? this.stopAndWait(input.taskId, ctx, input.timeoutMs, this.options.signal?.(ctx)) : this.stop(input.taskId, ctx) } })
        this.hooks = { onInitialize: async ctx => { ctx.tools.register(start); ctx.tools.register(wait); ctx.tools.register(send); ctx.tools.register(stop) } }
    }

    /** @param ctx - 父工具 Context。 @param prompt - 子任务的新输入。 @param mode - 空历史或安全分叉。 */
    async start(ctx: AgentContext, prompt?: string, mode: 'empty' | 'fork' = 'fork', configuration: SubAgentConfiguration = {}): Promise<string> {
        return (await this.create(ctx, prompt, mode, configuration)).taskId
    }

    private async create(ctx: AgentContext, prompt: string | undefined, mode: 'empty' | 'fork', configuration: SubAgentConfiguration): Promise<{ taskId: string; name: string }> {
        const taskId = await this.fork(ctx, mode, configuration)
        const created = { taskId, name: this.tasks.get(taskId)!.name }
        if (prompt === undefined) return created
        const receipt = await this.sendAsync(taskId, prompt, ctx)
        if (receipt.status !== 'success') throw new AdmissionError(taskId, created.name)
        return created
    }

    /** Create a child context without starting a model call. */
    async fork(ctx: AgentContext, mode: 'empty' | 'fork' = 'fork', configuration: SubAgentConfiguration = {}): Promise<string> {
        const { conversation } = getConversation(ctx)
        const name = allocateSubAgentName([...this.tasks.values()].map(task => task.name).concat([...this.pendingNames]), configuration.name)
        this.pendingNames.add(name)
        try {
            const parentSignal = this.options.signal?.(ctx)
            parentSignal?.throwIfAborted()
            let taskId = this.options.newId?.() ?? `task-${++this.sequence}`
            if (!this.options.newId) while (this.tasks.has(taskId)) taskId = `task-${++this.sequence}`
            if (!taskId || this.tasks.has(taskId)) throw new Error('子任务身份无效或重复。')
            const state: ChildState = { stopVersion: 0 }
            const signal = (): AbortSignal | undefined => state.controller?.signal
            const control: SubAgentControl = { taskId, name, signal, configuration }
            const child = this.options.createConversation ? await this.options.createConversation(conversation, mode, ctx, control) :
                mode === 'empty' ? await conversation.empty({ signal }) : await conversation.fork({ boundary: 'before-tools', signal })
            parentSignal?.throwIfAborted()
            const plugins = this.options.plugins(child, ctx, control)
            if (!plugins.includes(child)) { throw new Error('子插件列表必须包含所创建的子会话。') }
            const stop = this.stopBoundary(state)
            const agent = createAgent({ plugins: [...plugins, stop] })
            const task: Task = { name: control.name ?? name, owner: ctx, agent, state, result: { status: 'idle' }, completion: Promise.resolve({ status: 'idle' }), admissions: new Set() }
            this.tasks.set(taskId, task)
            return taskId
        } finally { this.pendingNames.delete(name) }
    }

    /** Queue one message on the same child Agent; receipt proves admission, not completion. */
    send(taskId: string, prompt: string, owner?: AgentContext): ToolResult {
        const task = this.tasks.get(taskId)
        if (!task || !this.authorized(task, owner)) return toolError('子任务不存在。', { code: 'SUBAGENT_NOT_FOUND' })
        if (!prompt.trim()) return toolError('子任务消息不能为空。', { code: 'SUBAGENT_INVALID_MESSAGE' })
        if (task.result.status === 'stopping') return toolError('子 Agent 正在收尾，请在结束后发送新消息。', { code: 'SUBAGENT_STOPPING' })
        const retained = this.completed.indexOf(taskId)
        if (retained >= 0) this.completed.splice(retained, 1)
        task.result = { status: 'running' }
        const previous = task.completion
        const version = task.state.stopVersion
        const work = previous.then(async () => {
            if (version !== task.state.stopVersion) return { status: 'cancelled' } as SubAgentResult
            task.state.controller = new AbortController()
            const outcome = await this.run(taskId, task.agent, prompt)
            if (task.state.controller.signal.aborted) return { status: 'cancelled' } as SubAgentResult
            if (!outcome.ok) { throw outcome.error }
            const result = outcome.value as ModelTurnResult | undefined
            return typeof result?.text === 'string' && result.text.trim() && result.toolCalls?.length === 0
                ? { status: 'completed', text: result.text } as SubAgentResult : { status: 'failed', message: '子任务未产出新的最终回复。' } as SubAgentResult
        })
        this.complete(taskId, task, work)
        return toolSuccess(`Agent ${task.name} 的消息已接纳。`, { taskId, name: task.name, status: 'queued' })
    }

    /** Finish Host admission first; direct send remains an in-process queue primitive. */
    async sendAsync(taskId: string, prompt: string, owner?: AgentContext): Promise<ToolResult> {
        await this.resolveTask(taskId, owner)
        const task = this.tasks.get(taskId)
        if (!task || !this.authorized(task, owner)) return toolError('子任务不存在。', { code: 'SUBAGENT_NOT_FOUND' })
        if (!prompt.trim()) return toolError('子任务消息不能为空。', { code: 'SUBAGENT_INVALID_MESSAGE' })
        if (task.result.status === 'stopping') return toolError('子 Agent 正在收尾。', { code: 'SUBAGENT_STOPPING' })
        const version = task.state.stopVersion, work = Promise.resolve().then(() => this.options.onInput?.(taskId, prompt))
        task.admissions.add(work)
        try { await work }
        catch { return toolError('子任务消息未接纳；请检查子会话恢复状态与 Host 持久化。', { code: 'SUBAGENT_ADMISSION_FAILED' }) }
        finally { task.admissions.delete(work) }
        if (version !== task.state.stopVersion) return toolError('消息接纳期间子 Agent 已请求停止；该消息不会执行。', { code: 'SUBAGENT_STOPPING' })
        return this.send(taskId, prompt, owner)
    }

    /** Observe actual cleanup without the ordinary tool's bounded polling timeout. */
    async join(taskId: string, owner?: AgentContext): Promise<SubAgentResult | undefined> {
        const task = this.tasks.get(taskId)
        return !task || !this.authorized(task, owner) ? undefined : task.completion
    }

    /** Stop the active turn and cancel messages already queued behind it. New messages may restart the child. */
    stop(taskId: string, owner?: AgentContext): ToolResult {
        const task = this.tasks.get(taskId)
        if (!task || !this.authorized(task, owner)) return toolError('子任务不存在。', { code: 'SUBAGENT_NOT_FOUND' })
        if (task.completion === task.stopCompletion) return toolSuccess(task.result.status === 'stopping' ? '子 Agent 正在收尾。' : '子 Agent 已完成收尾。', { taskId, name: task.name, status: task.result.status })
        const previous = task.result
        task.state.stopVersion += 1
        task.state.controller?.abort(new DOMException('Subagent stopped.', 'AbortError'))
        task.result = { status: 'stopping' }
        const settled = Promise.allSettled([task.completion, ...task.admissions]).then(() => {})
        let cleanup: Promise<void>
        try { cleanup = this.options.onStop?.(taskId, settled) ?? settled } catch (error) { cleanup = Promise.reject(error) }
        const result: SubAgentResult = previous.status === 'running' || previous.status === 'idle' ? { status: 'cancelled' } : previous
        task.stopCompletion = this.complete(taskId, task, Promise.all([settled, cleanup]).then(() => result), '子任务停止收尾失败。')
        return toolSuccess('已请求停止子 Agent。', { taskId, name: task.name, status: 'stopping' })
    }

    /** Gracefully observe the same stop boundary; bounded waiting cannot manufacture a terminal result. */
    async stopAndWait(taskId: string, owner?: AgentContext, timeoutMs = this.timeout, signal?: AbortSignal): Promise<ToolResult> {
        if (!Number.isSafeInteger(timeoutMs) || timeoutMs < 0 || timeoutMs > 300_000) throw new Error('Invalid subagent wait timeout.')
        await this.resolveTask(taskId, owner)
        const task = this.tasks.get(taskId)
        if (!task || !this.authorized(task, owner)) return toolError('子任务不存在。', { code: 'SUBAGENT_NOT_FOUND' })
        this.stop(taskId, owner)
        const result = await this.waitTask(task, timeoutMs, signal)
        return { ...result, data: { ...result.data, taskId, name: task.name } }
    }

    /** Bind an explicit Host executor to this task's existing wait/stop/result lifecycle. */
    observeExecution(taskId: string, execute: () => Promise<SubAgentResult>, owner?: AgentContext): Promise<SubAgentResult> {
        const task = this.tasks.get(taskId)
        if (!task || !this.authorized(task, owner)) throw new Error('子任务不存在。')
        if (task.result.status === 'running' || task.result.status === 'stopping') throw new Error('子任务已有执行者或正在收尾。')
        const retained = this.completed.indexOf(taskId); if (retained >= 0) this.completed.splice(retained, 1)
        task.result = { status: 'running' }
        return this.complete(taskId, task, Promise.resolve().then(execute))
    }

    private complete(taskId: string, task: Task, work: Promise<SubAgentResult>, failure = '子任务执行失败。'): Promise<SubAgentResult> {
        const completion = work.catch((): SubAgentResult => ({ status: 'failed', message: failure })).then(async result => {
            if (task.completion === completion) {
                try { await this.options.onResult?.(taskId, { ...result }) } catch { /* Observation cannot alter execution. */ }
                if (task.completion === completion) { task.result = result; this.retain(taskId) }
            }
            return result
        })
        task.completion = completion
        return completion
    }

    private async run(taskId: string, agent: Agent<ChatInput>, prompt: string): Promise<AgentRunOutcome> {
        if (this.options.execute) return this.options.execute(taskId, agent, { prompt })
        const stream = agent.stream({ prompt })
        while (true) {
            const next = await stream.next()
            if (next.done) return next.value
            try { await this.options.onEvent?.(taskId, next.value) } catch { /* Observers do not own execution. */ }
        }
    }

    /** @param taskId - 本插件拥有的子任务标识。 */
    async wait(taskId: string, owner?: AgentContext, timeoutMs = this.timeout, signal?: AbortSignal): Promise<ToolResult<SubAgentResult>> {
        if (!Number.isSafeInteger(timeoutMs) || timeoutMs < 0 || timeoutMs > 300_000) throw new Error('Invalid subagent wait timeout.')
        await this.resolveTask(taskId, owner)
        const task = this.tasks.get(taskId)
        if (!task || !this.authorized(task, owner)) { return toolError('子任务不存在。', { code: 'SUBAGENT_NOT_FOUND' }) }
        return this.waitTask(task, timeoutMs, signal)
    }

    private async waitTask(task: Task, timeoutMs: number, signal?: AbortSignal): Promise<ToolResult<SubAgentResult>> {
        let timer: ReturnType<typeof setTimeout> | undefined
        let aborted: (() => void) | undefined
        let result = task.result
        if ((result.status === 'running' || result.status === 'stopping') && timeoutMs > 0) {
            try {
                result = await Promise.race([task.completion, new Promise<SubAgentResult>(resolve => {
                    aborted = () => resolve({ status: task.result.status === 'stopping' ? 'stopping' : 'running' })
                    signal?.addEventListener('abort', aborted, { once: true })
                    if (signal?.aborted) aborted()
                    timer = setTimeout(() => resolve({ status: task.result.status === 'stopping' ? 'stopping' : 'running' }), timeoutMs)
                })])
            } finally { if (timer !== undefined) { clearTimeout(timer) }; if (aborted) signal?.removeEventListener('abort', aborted) }
        }
        if (signal?.aborted && (result.status === 'running' || result.status === 'stopping')) return toolError('等待工具已被打断；子任务结果以实际收尾记录为准。', { code: 'USER_INTERRUPTED', data: result })
        if (result.status === 'failed') { return toolError(result.message, { code: 'SUBAGENT_FAILED', data: result }) }
        const content = result.status === 'completed' ? result.text : result.status === 'idle' ? '子 Agent 待机中。' :
            result.status === 'cancelled' ? '子 Agent 本轮已停止。' : result.status === 'stopping' ? '子 Agent 正在收尾，实际操作可能尚未结束。' : result.status === 'unknown' ? '子任务原运行状态未知，请检查子会话记录。' : '子任务仍在运行，可再次等待。'
        return toolSuccess(content, { ...result })
    }

    /** Host may restore a durable child after an old completed result was evicted. */
    has(taskId: string): boolean { return this.tasks.has(taskId) }

    /** Check the existing stop boundary before a Host starts durable admission. */
    isStopping(taskId: string, owner?: AgentContext): boolean {
        const task = this.tasks.get(taskId)
        return !!task && this.authorized(task, owner) && task.result.status === 'stopping'
    }

    private async resolveTask(taskId: string, owner?: AgentContext): Promise<void> {
        if (!this.tasks.has(taskId) && owner) await this.options.onResolveTask?.(taskId, owner)
    }

    /** Restore a Host-owned child identity without executing a model or inferring completion from history. */
    restore(parent: Conversation, taskId: string, child: Conversation, plugins: AgentPlugin<ChatInput>[], result: SubAgentResult, name?: string): SubAgentControl {
        if (!taskId || this.tasks.has(taskId) || !plugins.includes(child) || result.status === 'running' || result.status === 'stopping') throw new Error('无效的子任务恢复记录。')
        const state: ChildState = { stopVersion: 0 }
        const agent = createAgent({ plugins: [...plugins, this.stopBoundary(state)] })
        const snapshot = { ...result }
        const actualName = allocateSubAgentName([...this.tasks.values()].map(task => task.name).concat([...this.pendingNames]), name)
        this.tasks.set(taskId, { name: actualName, owner: undefined, parent, agent, state, result: snapshot, completion: Promise.resolve(snapshot), admissions: new Set() })
        return { taskId, name: actualName, signal: () => state.controller?.signal }
    }

    /** Publish a verified Host-run result only when this plugin has no active child executor. */
    recordResult(taskId: string, result: SubAgentResult): void {
        const task = this.tasks.get(taskId)
        if (!task || task.result.status === 'running' || task.result.status === 'stopping') return
        task.result = { ...result }; task.completion = Promise.resolve(task.result)
    }

    private authorized(task: Task, owner?: AgentContext): boolean {
        if (!owner || task.owner === owner) return true
        if (task.owner || !task.parent) return false
        try { if (getConversation(owner).conversation !== task.parent) return false } catch { return false }
        task.owner = owner; return true
    }

    private stopBoundary(state: ChildState): AgentPlugin<ChatInput> {
        const boundary = async () => state.controller?.signal.aborted
            ? { action: 'stop' as const, value: { kind: 'subagent-cancelled' } } : { action: 'continue' as const }
        return { id: 'subagent-stop-boundary', hooks: { beforeStep: boundary, afterStep: boundary,
            beforeTool: async () => state.controller?.signal.aborted
                ? { action: 'result', result: toolError('工具未执行：子 Agent 已请求停止。', { code: 'USER_INTERRUPTED' }) }
                : { action: 'continue' } } }
    }

    /** @param taskId - 刚完成的任务；只淘汰已经结束的旧结果。 */
    private retain(taskId: string): void {
        const previous = this.completed.indexOf(taskId); if (previous >= 0) this.completed.splice(previous, 1)
        this.completed.push(taskId)
        while (this.completed.length > this.maxCompletedTasks) {
            this.tasks.delete(this.completed.shift()!)
        }
    }
}
