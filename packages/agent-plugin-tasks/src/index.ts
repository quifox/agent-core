import { z } from 'zod'
import { defineTool, toolError, toolSuccess, type AgentContext, type AgentHooks, type AgentPlugin, type ToolResult } from '@quifox/agent-core'

export type BackgroundTaskStatus = 'running' | 'completed' | 'failed' | 'cancelled' | 'unknown'

/** Latest task facts; cancellation requests are separate from final status. */
export interface BackgroundTaskSnapshot {
    id: string
    status: BackgroundTaskStatus
    cancelRequested: boolean
    result?: ToolResult
    resultDataUnavailable?: boolean
    error?: string
}

interface Task {
    owner: AgentContext
    snapshot: BackgroundTaskSnapshot
    controller: AbortController
    completion: Promise<BackgroundTaskSnapshot>
}

/** Owns background operations while ordinary Core tools return their identities. */
export class BackgroundTasksPlugin implements AgentPlugin {
    id = 'background-tasks'
    readonly hooks: AgentHooks
    private readonly tasks = new Map<string, Task>()
    private sequence = 0

    /** Register ordinary observation tools; actual operations are injected by the Host. */
    constructor(private readonly options: { newId?(): string; onTask?(snapshot: BackgroundTaskSnapshot): void; signal?(owner: AgentContext): AbortSignal | undefined } = {}) {
        const inputSchema = z.object({ taskId: z.string().min(1) }).strict()
        const policy = { sideEffect: 'none', approval: 'none' } as const
        const get = defineTool({ name: 'task_get', description: 'Read the latest facts of a background task.', inputSchema, policy,
            execute: async (input, ctx) => this.receipt(this.get(ctx, input.taskId)) })
        const wait = defineTool({ name: 'task_wait', description: 'Wait for a background task; timeout returns its current facts.',
            inputSchema: inputSchema.extend({ timeoutMs: z.number().int().min(0).max(300_000).optional() }), policy,
            execute: async (input, ctx) => {
                const signal = this.options.signal?.(ctx), snapshot = await this.wait(ctx, input.taskId, input.timeoutMs, signal)
                return signal?.aborted && snapshot?.status === 'running' ? toolError('等待工具已被打断；任务结果以实际收尾记录为准。', { code: 'USER_INTERRUPTED', data: snapshot }) : this.receipt(snapshot)
            } })
        const cancel = defineTool({ name: 'task_cancel', description: 'Request cancellation; completion does not imply rollback.', inputSchema,
            policy: { sideEffect: 'external', approval: 'none', retrySafe: true },
            execute: async (input, ctx) => this.receipt(this.cancel(ctx, input.taskId)) })
        this.hooks = { onInitialize: async ctx => { ctx.tools.register(get); ctx.tools.register(wait); ctx.tools.register(cancel) } }
    }

    /**
     * Submit one operation and handle both its success and failure immediately.
     * @param owner - Long-lived Agent identity owning the operation.
     * @param operation - Host operation receiving its own cancellation signal.
     * @returns Task identity before the operation has a final result.
     */
    submit(owner: AgentContext, operation: (signal: AbortSignal) => Promise<ToolResult>): string {
        let id = this.options.newId?.() ?? `background-${++this.sequence}`
        if (!this.options.newId) while (this.tasks.has(id)) id = `background-${++this.sequence}`
        if (!id || this.tasks.has(id)) throw new Error('Background task identity is invalid or reused.')
        const snapshot: BackgroundTaskSnapshot = { id, status: 'running', cancelRequested: false }
        const controller = new AbortController()
        const task: Task = { owner, snapshot, controller, completion: Promise.resolve(snapshot) }
        this.tasks.set(id, task)
        this.observe(snapshot)
        task.completion = Promise.resolve().then(() => {
            controller.signal.throwIfAborted()
            return operation(controller.signal)
        }).then(result => {
            const { data, ...fields } = result
            const receipt: ToolResult = fields
            if (data !== undefined) {
                try {
                    if (JSON.stringify(data) === undefined) throw new Error('Data has no JSON representation.')
                    receipt.data = structuredClone(data)
                } catch { snapshot.resultDataUnavailable = true }
            }
            snapshot.status = 'completed'
            snapshot.result = receipt
            this.observe(snapshot)
            return snapshot
        }).catch(error => {
            snapshot.status = controller.signal.aborted && error === controller.signal.reason ? 'cancelled' : 'failed'
            if (snapshot.status === 'failed') snapshot.error = 'Background operation failed.'
            this.observe(snapshot)
            return snapshot
        })
        return id
    }

    /** @param owner - Requesting Agent. @param id - Task identity. @returns Facts only for the same owner. */
    get(owner: AgentContext, id: string): BackgroundTaskSnapshot | undefined {
        const task = this.tasks.get(id)
        return task?.owner === owner ? structuredClone(task.snapshot) : undefined
    }

    /** @param owner - Requesting Agent. @param id - Task identity. @returns Observed facts after requesting cancellation. */
    cancel(owner: AgentContext, id: string): BackgroundTaskSnapshot | undefined {
        const task = this.tasks.get(id)
        if (task?.owner !== owner) return undefined
        if (task.snapshot.status === 'running' && !task.snapshot.cancelRequested) {
            task.snapshot.cancelRequested = true
            task.controller.abort(new DOMException('Background task cancelled.', 'AbortError'))
            this.observe(task.snapshot)
        }
        return structuredClone(task.snapshot)
    }

    private observe(snapshot: BackgroundTaskSnapshot): void {
        try { this.options.onTask?.(structuredClone(snapshot)) } catch { /* Observation cannot change task facts. */ }
    }

    /** Restore receipts; an interrupted process cannot claim its operation is still running. */
    restore(owner: AgentContext, snapshots: readonly BackgroundTaskSnapshot[]): void {
        for (const saved of snapshots) {
            if (this.tasks.has(saved.id)) throw new Error('Background task identity is reused.')
            const snapshot = structuredClone(saved)
            if (snapshot.status === 'running') snapshot.status = 'unknown'
            this.tasks.set(snapshot.id, { owner, snapshot, controller: new AbortController(), completion: Promise.resolve(snapshot) })
        }
    }

    /** Request shutdown for one owner and observe acknowledgement without an unbounded wait. */
    async close(owner: AgentContext, timeoutMs = 10_000): Promise<BackgroundTaskSnapshot[]> {
        this.validateTimeout(timeoutMs)
        const owned = [...this.tasks.values()].filter(task => task.owner === owner)
        for (const task of owned) this.cancel(owner, task.snapshot.id)
        const results = await Promise.all(owned.map(task => this.wait(owner, task.snapshot.id, timeoutMs)))
        return results.filter((result): result is BackgroundTaskSnapshot => result !== undefined)
    }

    /** Join an explicitly owned operation during Host resource cleanup without manufacturing a timeout result. */
    async join(owner: AgentContext, id: string): Promise<BackgroundTaskSnapshot | undefined> {
        const task = this.tasks.get(id)
        return task?.owner === owner ? structuredClone(await task.completion) : undefined
    }

    /** @param owner - Requesting Agent. @param id - Task identity. @param timeoutMs - Maximum observation time. */
    async wait(owner: AgentContext, id: string, timeoutMs = 10_000, signal?: AbortSignal): Promise<BackgroundTaskSnapshot | undefined> {
        const task = this.tasks.get(id)
        if (task?.owner !== owner) return undefined
        this.validateTimeout(timeoutMs)
        if (timeoutMs === 0 || task.snapshot.status !== 'running' || signal?.aborted) return structuredClone(task.snapshot)
        let timer: ReturnType<typeof setTimeout> | undefined
        let aborted: (() => void) | undefined
        try {
            const result = await Promise.race([task.completion, new Promise<BackgroundTaskSnapshot>(resolve => {
                timer = setTimeout(() => resolve(task.snapshot), timeoutMs)
                aborted = () => resolve(task.snapshot)
                signal?.addEventListener('abort', aborted, { once: true })
                if (signal?.aborted) aborted()
            })])
            return structuredClone(result)
        } finally {
            if (timer !== undefined) clearTimeout(timer)
            if (aborted) signal?.removeEventListener('abort', aborted)
        }
    }

    /** @param snapshot - Task facts or an unknown identity. */
    private receipt(snapshot: BackgroundTaskSnapshot | undefined): ToolResult {
        return snapshot ? toolSuccess(JSON.stringify(snapshot), snapshot) :
            toolError('Background task does not exist for this Agent.', { code: 'TASK_NOT_FOUND' })
    }

    private validateTimeout(timeoutMs: number): void {
        if (!Number.isSafeInteger(timeoutMs) || timeoutMs < 0 || timeoutMs > 300_000) throw new Error('Invalid background task wait timeout.')
    }
}
