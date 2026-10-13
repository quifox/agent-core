import { randomUUID } from 'node:crypto'
import { toolDenied, toolError, type AgentContext, type AgentHooks, type AgentPlugin, type AgentRunOutcome, type BeforeToolDecision, type ToolCall } from '@quifox/agent-core'
import type { ChatInput } from '@quifox/agent-plugin-session'
import type { ToolInspection } from './tool-presentation.js'
import { FileAccessError } from './tool-presentation.js'

export interface ApprovalRequest { id: string; sessionId: string; operationId: string; call: ToolCall; inspection?: ToolInspection }
export interface PermissionGateOptions {
    sessionId: string
    mode(): 'ask' | 'allow' | 'deny'
    allowed?(name: string): boolean
    inspect?(call: ToolCall, ctx: AgentContext): Promise<ToolInspection>
    signal(): AbortSignal | undefined
    operationId(call: ToolCall): string
    onRequest(request: ApprovalRequest): void
}
interface Pending { request: ApprovalRequest; resolve(approved: boolean): void }

/** Approval is bound to the final operation identity and parameters, with an explicit tail guard. */
export class PermissionGate implements AgentPlugin<ChatInput> {
    id = 'host-permissions'
    readonly hooks: AgentHooks<ChatInput>
    readonly guard: AgentPlugin<ChatInput>
    private readonly requests = new Map<string, Pending>()
    private readonly grants = new Map<string, string>()
    private active: AgentRunOutcome | undefined

    constructor(private readonly options: PermissionGateOptions) {
        this.hooks = {
            onRunStart: async (_ctx, _input, outcome) => {
                if (this.active) throw new Error('Permission gate already has an active run.')
                this.active = outcome
                return { action: 'continue' }
            },
            beforeTool: async (ctx, call) => this.authorize(ctx, call),
            onRunEnd: async (_ctx, outcome) => { if (this.active === outcome) { this.close(); this.active = undefined } }
        }
        this.guard = { id: 'host-permissions-guard', hooks: { beforeTool: async (ctx, call) => {
            if (this.options.allowed && !this.options.allowed(call.name)) return { action: 'result', result: toolDenied('当前 Agent 权限不允许该工具。', { code: 'TOOL_PERMISSION_DENIED' }) }
            const tool = ctx.tools.get(call.name)
            if (tool && !tool.inputSchema.safeParse(call.input).success) return { action: 'result', result: toolError('工具参数不符合声明。', { code: 'TOOL_INPUT_INVALID' }) }
            let inspection: ToolInspection | undefined
            try { inspection = await this.options.inspect?.(call, ctx) } catch (cause) { if (cause instanceof FileAccessError) return { action: 'result', result: cause.result }; throw cause }
            if (!this.requiresApproval(ctx, call, inspection)) return { action: 'continue' }
            const operation = this.options.operationId(call)
            const granted = this.grants.get(operation)
            this.grants.delete(operation)
            return granted === fingerprint(call) + (inspection?.authorizationIdentity ?? '') ? { action: 'continue' } : { action: 'result', result: toolDenied(
                '工具身份或参数已变化，需要重新批准。', { code: 'AUTHORIZATION_CHANGED' }) }
        } } }
    }

    get pending(): ApprovalRequest[] { return [...this.requests.values()].map(item => structuredClone(item.request)) }
    get mode(): 'ask' | 'allow' | 'deny' { return this.options.mode() }

    reply(id: string, approved: boolean): boolean {
        const pending = this.requests.get(id)
        if (!pending) return false
        this.requests.delete(id)
        pending.resolve(approved)
        return true
    }

    close(): void {
        for (const request of this.requests.values()) request.resolve(false)
        this.requests.clear(); this.grants.clear()
    }

    private requiresApproval(ctx: AgentContext, call: ToolCall, inspection?: ToolInspection): boolean {
        return (ctx.tools.policy(call.name)?.approval === 'host' || !!inspection?.requiresApproval) && this.options.mode() !== 'allow'
    }

    private async authorize(ctx: AgentContext, call: ToolCall): Promise<BeforeToolDecision> {
        if (this.options.allowed && !this.options.allowed(call.name)) return { action: 'result', result: toolDenied('当前 Agent 权限不允许该工具。', { code: 'TOOL_PERMISSION_DENIED' }) }
        const tool = ctx.tools.get(call.name)
        if (tool && !tool.inputSchema.safeParse(call.input).success) {
            return { action: 'result', result: toolError('工具参数不符合声明。', { code: 'TOOL_INPUT_INVALID' }) }
        }
        let inspection: ToolInspection | undefined
        try { inspection = await this.options.inspect?.(call, ctx) } catch (cause) { if (cause instanceof FileAccessError) return { action: 'result', result: cause.result }; throw cause }
        if (!this.requiresApproval(ctx, call, inspection)) return { action: 'continue' }
        if (this.options.mode() === 'deny') return { action: 'result', result: toolDenied('当前 Agent 不允许需要审批的操作。', { code: 'TOOL_PERMISSION_DENIED' }) }
        const signal = this.options.signal()
        if (signal?.aborted) return { action: 'result', result: toolDenied('已停止待授权操作。', { code: 'USER_INTERRUPTED' }) }
        const request: ApprovalRequest = { id: randomUUID(), sessionId: this.options.sessionId,
            operationId: this.options.operationId(call), call: structuredClone(call), ...(inspection ? { inspection } : {}) }
        const original = fingerprint(call) + (inspection?.authorizationIdentity ?? '')
        let resolve!: (approved: boolean) => void
        const answer = new Promise<boolean>(accept => { resolve = accept })
        this.requests.set(request.id, { request, resolve })
        const aborted = (): void => { this.reply(request.id, false) }
        signal?.addEventListener('abort', aborted, { once: true })
        try {
            this.options.onRequest(structuredClone(request))
            const approved = await answer
            if (!approved) return { action: 'result', result: toolDenied(signal?.aborted ? '已停止待授权操作。' : '用户拒绝了工具操作。',
                { code: signal?.aborted ? 'USER_INTERRUPTED' : 'USER_DENIED' }) }
            this.grants.set(request.operationId, original)
            return { action: 'continue' }
        } finally { signal?.removeEventListener('abort', aborted); this.requests.delete(request.id) }
    }
}

function fingerprint(call: ToolCall): string {
    return JSON.stringify({ name: call.name, input: call.input }, (_key, value: unknown) => {
        if (!value || typeof value !== 'object' || Array.isArray(value)) return value
        return Object.fromEntries(Object.entries(value).sort(([left], [right]) => left.localeCompare(right)))
    })
}
