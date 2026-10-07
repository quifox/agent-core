import { z } from 'zod'
import { createAgent, defineTool, toolError, toolSuccess, type AgentContext, type AgentHooks, type AgentPlugin, type ModelTurnResult, type ToolResult } from '@quifox/agent-core'
import { getConversation, type ChatInput, type Conversation } from '@quifox/agent-plugin-session'

export type SubAgentResult = { status: 'running' } | { status: 'completed'; text: string } | { status: 'failed'; message: string }

/** 调用方负责构造并重绑子插件；不隐式继承父工具或权限。 */
export interface SubAgentsPluginOptions {
    /** @param conversation - 独立子会话组合。 @param ctx - 父工具的协作 Context。 */
    plugins(conversation: Conversation, ctx: AgentContext): AgentPlugin<ChatInput>[]
    waitTimeoutMs?: number
    maxCompletedTasks?: number
}

interface Task { result: SubAgentResult; completion: Promise<SubAgentResult> }

/** 启动和等待是两个普通工具；后台任务的所有状态留在本插件。 */
export class SubAgentsPlugin implements AgentPlugin<ChatInput> {
    id = 'subagents'
    readonly hooks: AgentHooks<ChatInput>
    private readonly tasks = new Map<string, Task>()
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
        const start = defineTool({ name: 'subagent_start', description: '启动独立子任务。fork 继承完整历史前缀，empty 从空历史开始。立即返回 taskId，随后用 subagent_wait 获取最终结果。',
            inputSchema: z.object({ prompt: z.string().trim().min(1), mode: z.enum(['empty', 'fork']).default('fork') }).strict(),
            policy: { sideEffect: 'external', approval: 'none' }, execute: async (input, ctx) => {
                try {
                    const data = { taskId: await this.start(ctx, input.prompt, input.mode) }
                    return toolSuccess(JSON.stringify(data), data)
                }
                catch { return toolError('子任务未能创建，请检查会话边界和子插件组合。', { code: 'SUBAGENT_START_FAILED' }) }
            } })
        const wait = defineTool({ name: 'subagent_wait', description: '等待指定子任务的最终回复。超时返回 running，任务继续执行，之后可再次等待。',
            inputSchema: z.object({ taskId: z.string().min(1) }).strict(), policy: { sideEffect: 'none', approval: 'none' },
            execute: async input => this.wait(input.taskId) })
        this.hooks = { onInitialize: async ctx => { ctx.tools.register(start); ctx.tools.register(wait) } }
    }

    /** @param ctx - 父工具 Context。 @param prompt - 子任务的新输入。 @param mode - 空历史或安全分叉。 */
    async start(ctx: AgentContext, prompt: string, mode: 'empty' | 'fork' = 'fork'): Promise<string> {
        const { conversation } = getConversation(ctx)
        const child = mode === 'empty' ? await conversation.empty() : await conversation.fork({ boundary: 'before-tools' })
        const plugins = this.options.plugins(child, ctx)
        if (!plugins.includes(child)) { throw new Error('子插件列表必须包含所创建的子会话。') }
        const agent = createAgent({ plugins })
        const taskId = `task-${++this.sequence}`
        const task: Task = { result: { status: 'running' }, completion: Promise.resolve({ status: 'running' }) }
        this.tasks.set(taskId, task)
        task.completion = agent.run({ prompt }).then(outcome => {
            if (!outcome.ok) { throw outcome.error }
            const result = outcome.value as ModelTurnResult | undefined
            return typeof result?.text === 'string' && result.toolCalls?.length === 0 ? result.text : ''
        }).then(text => {
            const result: SubAgentResult = text.trim() ? { status: 'completed', text } :
                { status: 'failed', message: '子任务未产出新的最终回复。' }
            task.result = result
            this.retain(taskId)
            return result
        }, () => {
            const result: SubAgentResult = { status: 'failed', message: '子任务执行失败。' }
            task.result = result
            this.retain(taskId)
            return result
        })
        return taskId
    }

    /** @param taskId - 本插件拥有的子任务标识。 */
    async wait(taskId: string): Promise<ToolResult<SubAgentResult>> {
        const task = this.tasks.get(taskId)
        if (!task) { return toolError('子任务不存在。', { code: 'SUBAGENT_NOT_FOUND' }) }
        let timer: ReturnType<typeof setTimeout> | undefined
        let result = task.result
        if (result.status === 'running') {
            try {
                result = await Promise.race([task.completion, new Promise<SubAgentResult>(resolve => {
                    timer = setTimeout(() => resolve({ status: 'running' }), this.timeout)
                })])
            } finally { if (timer !== undefined) { clearTimeout(timer) } }
        }
        if (result.status === 'failed') { return toolError(result.message, { code: 'SUBAGENT_FAILED', data: result }) }
        return toolSuccess(result.status === 'completed' ? result.text : '子任务仍在运行，可再次等待。', { ...result })
    }

    /** @param taskId - 刚完成的任务；只淘汰已经结束的旧结果。 */
    private retain(taskId: string): void {
        this.completed.push(taskId)
        while (this.completed.length > this.maxCompletedTasks) {
            this.tasks.delete(this.completed.shift()!)
        }
    }
}
