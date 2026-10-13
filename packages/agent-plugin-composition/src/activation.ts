import type { AgentContext, AgentHooks, AgentPlugin } from '@quifox/agent-core'

export type ActivatablePlugin<Input = unknown, Ctx extends AgentContext = AgentContext> = AgentPlugin<Input, Ctx> & { enabled?: boolean }

/** Select enabled candidates before any initialization; configuration remains Host-owned. */
export class PluginActivationPlugin<Input = unknown, Ctx extends AgentContext = AgentContext> implements AgentPlugin<Input, Ctx> {
    readonly id = 'plugin-activation'
    readonly hooks: AgentHooks<Input, Ctx> = {
        onRegister: async candidates => { candidates.splice(0, candidates.length, ...this.select(candidates)); }
    }

    select(candidates: ActivatablePlugin<Input, Ctx>[]): AgentPlugin<Input, Ctx>[] {
        return candidates.filter(plugin => plugin !== this && plugin.enabled !== false)
    }
}
