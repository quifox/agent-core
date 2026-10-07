import type { AgentContext, AgentPluginRef } from './context.js'
import { handlers, type AgentHooks } from './hooks.js'

/** 调用方构造的插件对象；同一 Agent 的后续运行复用该对象。 */
export interface AgentPlugin<Input = unknown, Ctx extends AgentContext = AgentContext> extends AgentPluginRef {
    id: string
    name?: string
    description?: string
    /** 仅声明关系；数组顺序始终是唯一执行顺序。 */
    after?: string
    hooks?: AgentHooks<Input, Ctx>
}

/** 遍历实时草稿；新增对象参与注册，已移除对象不再加载。 @param candidates - 保留对象引用的完整候选列表。 @internal */
export async function preparePlugins<Input, Ctx extends AgentContext>(candidates: AgentPlugin<Input, Ctx>[]): Promise<AgentPlugin<Input, Ctx>[]> {
    const visited = new Set<AgentPlugin<Input, Ctx>>()
    while (true) {
        const plugin = candidates.find(item => !visited.has(item))
        if (!plugin) { break }
        visited.add(plugin)
        for (const callback of handlers(plugin.hooks?.onRegister)) {
            if (!candidates.includes(plugin)) { break }
            await callback(candidates)
        }
    }
    return [...candidates]
}
