import type { AgentHooks, AgentPlugin, AgentRunOutcome, ModelTurnResult, ToolResult } from '@quifox/agent-core'
import { copySessionValue, type ChatInput, type ConversationContext, type ExecutionContinuation } from '@quifox/agent-plugin-session'

/** 当前轮的派生执行记录，不是跨轮 Message[] 的第二个 owner。 */
export interface ExecutionCheckpoint {
    turn: ModelTurnResult
    calls: { id: string; status: 'not-started' | 'started' | 'completed'; result?: ToolResult }[]
}

/** 在完整步骤后清空，提前退出时保留；恢复决策由协作插件解释。 */
export class ExecutionCheckpointPlugin implements AgentPlugin<ChatInput>, ExecutionContinuation {
    id = 'execution-checkpoint'
    readonly hooks: AgentHooks<ChatInput>
    replaying = false
    private state: ExecutionCheckpoint | undefined
    private outcome: AgentRunOutcome | undefined
    /** 本次前置链的暂记；保留首次状态，以支持同一插件对象重复插入。 */
    private entering: { call: ExecutionCheckpoint['calls'][number]; previous: ExecutionCheckpoint['calls'][number]['status'] } | undefined

    /** @param snapshot - 与对应 Session 快照配套的完整本轮记录。 */
    constructor(snapshot?: ExecutionCheckpoint, options: { canResumeModel?(): boolean } = {}) {
        this.state = snapshot === undefined ? undefined : copySessionValue(snapshot)
        this.hooks = {
            onInitialize: async ctx => { (ctx as ConversationContext).execution = this },
            onRunStart: async (ctx, input, outcome) => {
                (ctx as ConversationContext).execution = this
                if ('resume' in input) {
                    if (!this.state && !options.canResumeModel?.()) throw new Error('没有可恢复的本轮执行记录。')
                    this.replaying = this.state?.calls.some(call => call.status !== 'completed') ?? false
                } else if (this.state?.calls.some(call => call.status !== 'completed')) { throw new Error('未完成的本轮记录不能被新输入覆盖。') }
                this.outcome = outcome
                return { action: 'continue' }
            },
            afterModel: async (_ctx, turn) => {
                if (!this.replaying) {
                    this.state = turn.toolCalls.length ? { turn: copySessionValue(turn), calls: turn.toolCalls.map(call => ({ id: call.id, status: 'not-started' })) } : undefined
                }
                return { action: 'continue' }
            },
            beforeTool: async (_ctx, call) => {
                const current = this.state?.calls.find(item => item.id === call.id)
                if (current) {
                    if (this.entering?.call !== current) { this.entering = { call: current, previous: current.status } }
                    current.status = 'started'
                }
                return { action: 'continue' }
            },
            afterTool: async (_ctx, run) => {
                const current = this.state?.calls.find(item => item.id === run.call.id)
                if (current) { current.status = 'completed'; current.result = copySessionValue(run.result) }
                this.entering = undefined
                return { action: 'continue' }
            },
            afterStep: async () => { this.state = undefined; this.replaying = false; return { action: 'continue' } },
            onRunEnd: async (_ctx, outcome) => {
                if (this.outcome !== outcome) { return }
                const entering = this.entering
                // 有效结果都会经过 afterTool；正常 stop 留下的暂记说明入口尚未执行。
                if (outcome.ok && entering?.call.status === 'started') { entering.call.status = entering.previous }
                if (this.state?.calls.every(call => call.status === 'completed')) { this.state = undefined }
                this.entering = undefined
                this.replaying = false
                this.outcome = undefined
            }
        }
    }

    /** 为组合 model 提供临时工具轮，仍由 Core 调用原工具入口。 */
    next(): ModelTurnResult | undefined {
        if (!this.replaying || !this.state) { return undefined }
        const ids = new Set(this.state.calls.filter(call => call.status !== 'completed').map(call => call.id))
        return { ...copySessionValue(this.state.turn), toolCalls: copySessionValue(this.state.turn.toolCalls.filter(call => ids.has(call.id))), finishReason: 'tool-calls' }
    }

    /** 查询进入本次恢复前的未知状态，不把本轮前置暂记误当成重试。 @param callId - 原逻辑调用身份。 */
    requiresRetry(callId: string): boolean {
        if (!this.replaying) { return false }
        const call = this.state?.calls.find(item => item.id === callId)
        return (this.entering?.call === call ? this.entering?.previous : call?.status) === 'started'
    }

    /** 显式复制，不共享可变调用状态或业务资源。 */
    fork(): ExecutionCheckpointPlugin { return new ExecutionCheckpointPlugin(this.snapshot()) }
    /** 当前轮结束后为空；宿主需要跨进程恢复时自行存储。 */
    snapshot(): ExecutionCheckpoint | undefined { return this.state === undefined ? undefined : copySessionValue(this.state) }

    /** Host may roll back a failed paired Session write only while no run owns this checkpoint. */
    restore(snapshot?: ExecutionCheckpoint): void {
        if (this.outcome) throw new Error('活动执行记录不能被恢复快照替换。')
        this.state = snapshot === undefined ? undefined : copySessionValue(snapshot)
        this.replaying = false; this.entering = undefined
    }

    /** @param callId - 已核实的原调用。 @param result - 真实或明确未执行的回执；同时交给 Session 接纳。 */
    confirm(callId: string, result: ToolResult): void {
        const call = this.state?.calls.find(item => item.id === callId)
        if (!call) { throw new Error('本轮记录中没有该调用。') }
        call.status = 'completed'; call.result = copySessionValue(result)
    }
}
