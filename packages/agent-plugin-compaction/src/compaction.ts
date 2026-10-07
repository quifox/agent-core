import { AgentError, type AgentHooks, type AgentPlugin, type AgentContext } from '@quifox/agent-core'
import { type ModelTurnResult } from '@quifox/agent-core'
import { getConversation, type ChatInput } from '@quifox/agent-plugin-session'
import { COMPACTION_PROMPT } from './context.js'

/** 压缩策略配置；协议、消息和模型连接由组合适配器提供。 */
export interface CompactionPluginOptions {
    instruction?: string
}

/** 复用既有安全切分与检查点算法，钩子只协调插件对象。 */
export class CompactionPlugin implements AgentPlugin<ChatInput> {
    id = 'chat-compaction'
    after = 'chat-conversation'
    readonly hooks: AgentHooks<ChatInput>

    /** @param options - 固定摘要指令；预算来自本轮插件元数据。 */
    constructor(private readonly options: CompactionPluginOptions = {}) {
        this.hooks = { beforeModel: async ctx => { await this.compact(ctx); return { action: 'continue' } } }
    }

    /** 不覆盖原始记录；仅接受有效检查点后更新主投影。 */
    private async compact(ctx: AgentContext): Promise<void> {
        const { conversation, modelInfo, execution } = getConversation(ctx)
        if (execution?.replaying) { return }
        const instruction = this.options.instruction ?? COMPACTION_PROMPT
        const fork = await conversation.prepareCompaction(modelInfo, instruction)
        if (!fork) { return }
        for (let candidate = 0; candidate < 3; candidate += 1) {
            let result: ModelTurnResult
            try { result = await fork.generate(candidate === 2) } catch (error) {
                if (candidate === 2 || (error instanceof AgentError && error.code !== 'PROVIDER_PROTOCOL_ERROR' && !error.retryable)) { throw error }
                continue
            }
            if (await fork.accept(result)) { return }
        }
        throw new Error('摘要生成失败，原始会话已保留。')
    }
}
