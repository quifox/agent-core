import { toolError, type AgentPlugin } from '@quifox/agent-core'
import type { ChatInput } from '@quifox/agent-plugin-session'

/** Host tools cooperate with cancellation; their actual cleanup/result closes the call. */
export function toolInterruption(signal: () => AbortSignal | undefined): AgentPlugin<ChatInput> {
    return { id: 'host-tool-interruption', hooks: { onInitialize: async ctx => {
        for (const tool of ctx.tools.values()) {
            ctx.tools.remove(tool.name)
            const execute = tool.execute.bind(tool)
            tool.execute = async (input, context) => {
                const current = signal()
                if (!current) return execute(input, context)
                if (current.aborted) return toolError('工具未执行：本轮已停止。', { code: 'USER_INTERRUPTED' })
                try {
                    return await execute(input, context)
                } catch (cause) {
                    if (current.aborted) return toolError('工具调用已被打断；未确认完成，不能假定副作用已回滚。', { code: 'USER_INTERRUPTED' })
                    throw cause
                }
            }
            // Registration binds execute; rebind the same objects in their original final order.
            ctx.tools.register(tool)
        }
    } } }
}
