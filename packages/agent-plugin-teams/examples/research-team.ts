import { createAgent, type Agent, type AgentPlugin } from '@quifox/agent-core'
import { ChatModelPlugin, type ChatModelPluginOptions } from '@quifox/agent-plugin-model'
import { ChatConversationPlugin, ChatSessionPlugin, type ChatInput } from '@quifox/agent-plugin-session'
import { createSystemPromptPlugin } from '@quifox/agent-plugin-system-prompt'
import { TeamsPlugin } from '../src/index.js'

/** 每个成员可以选择自己的模型、身份提示词和工具插件。 */
export interface ResearchMemberOptions {
    name: string
    prompt: string
    model: Omit<ChatModelPluginOptions, 'session'>
    plugins?: AgentPlugin<ChatInput>[]
}

/**
 * 返回所有真实成员，不指定唯一入口。
 * @param options - 例如研究员、核验员、撰稿人、协调者的独立配置。
 */
export function createResearchTeam(options: ResearchMemberOptions[]): {
    teams: TeamsPlugin
    agents: Map<string, Agent<ChatInput>>
} {
    const teams = new TeamsPlugin()
    const agents = new Map<string, Agent<ChatInput>>()
    for (const option of options) {
        const session = new ChatSessionPlugin({ id: option.name, ownerId: 'research-team' })
        const conversation = new ChatConversationPlugin({ session, generation: new ChatModelPlugin({ ...option.model, session }) })
        const prompt = createSystemPromptPlugin(conversation, option.prompt)
        const agent = createAgent<ChatInput>({ plugins: [conversation, prompt, ...option.plugins ?? [], teams] })
        teams.register(option.name, agent, conversation)
        agents.set(option.name, agent)
    }
    return { teams, agents }
}
