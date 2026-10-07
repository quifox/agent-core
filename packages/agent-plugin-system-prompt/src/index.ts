import type { AgentPlugin } from '@quifox/agent-core'
import type { AgentMessage } from '@quifox/agent-core'

/**
 * 明确引用消息 owner；Core 不提供默认提示词或请求参数。
 * @param messages - 本次会话的可变消息能力。
 * @param content - 调用方显式提供的可信系统内容。
 */
export function createSystemPromptPlugin(messages: (() => AgentMessage[]) | { addSystemPrompt(content: string): void }, content: string): AgentPlugin {
    return { id: 'system-prompt', hooks: {
        beforeModel: async () => {
            if (typeof messages !== 'function') { messages.addSystemPrompt(content); return { action: 'continue' } }
            const current = messages()
            if (content.trim() && !current.some(message => message.role === 'system' && message.content === content)) {
                const index = current.findIndex(message => message.role !== 'system')
                current.splice(index < 0 ? current.length : index, 0, { role: 'system', content })
            }
            return { action: 'continue' }
        }
    } }
}
