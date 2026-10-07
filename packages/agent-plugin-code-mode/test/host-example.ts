import { createAgent, type AgentPlugin } from '@quifox/agent-core'
import { PluginCompositionPlugin } from '@quifox/agent-plugin-composition'
import { CodeModePlugin, type CodeModeOptions } from '../src/index.js'

/** 宿主接线；执行器与当前 Agent 引用都归使用者。
 * @param initialPlugins - 已有 Model/Session 等插件。
 * @param execute - 宿主选择的代码执行器。
 */
export function createExampleHost<Input>(initialPlugins: AgentPlugin<Input>[], execute: CodeModeOptions['execute']) {
    const composition = new PluginCompositionPlugin<Input>({
        replaceAgent: nextAgent => { runtime.agent = nextAgent },
    })
    const codeMode = new CodeModePlugin<Input>({
        execute,
        bindings: () => ({
            setNextPlugins: (plugins: AgentPlugin<Input>[]) => composition.setNextPlugins(plugins),
        }),
    })
    const runtime = { agent: createAgent({ plugins: [...initialPlugins, codeMode, composition] }) }
    return runtime
}
