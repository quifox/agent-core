import { createAgent, type AgentPlugin } from '@quifox/agent-core'
import { PluginCompositionPlugin } from '../src/index.js'

/** Host 只持有引用；Code Mode 可以直接绑定 composition.setNextPlugins。
 * @param initialPlugins - 使用者已有的插件对象。
 */
export function createExampleHost<Input>(initialPlugins: AgentPlugin<Input>[]) {
    const composition = new PluginCompositionPlugin<Input>({
        replaceAgent: nextAgent => { runtime.agent = nextAgent },
    })
    const runtime = { agent: createAgent({ plugins: [...initialPlugins, composition] }) }
    return { runtime, setNextPlugins: (plugins: AgentPlugin<Input>[]) => composition.setNextPlugins(plugins) }
}
