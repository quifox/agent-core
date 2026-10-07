import { expect, it } from 'vitest'
import { z } from 'zod'
import { createAgent, defineTool, hooksFrom, toolsFrom, Tool, Hook, toolSuccess, type AgentContext, type ContinueOrStop, type ModelTurnResult } from '../src/index.js'
import { turn } from './fixtures.js'

it('装饰器绑定实例 this，生成普通注册与运行钩子', async () => {
    class Plugin {
        id = 'decorated'
        executions = 0
        hooks = hooksFrom(this)
        @Tool(defineTool({ name: 'echo', description: '', inputSchema: z.object({}), policy: { sideEffect: 'none', approval: 'none' }, execute: async () => toolSuccess('unused') }))
        async echo() { this.executions += 1; return toolSuccess('echo') }
        @Hook('onInitialize')
        async start(ctx: AgentContext) { for (const tool of toolsFrom(this)) { ctx.tools.register(tool) } }
        @Hook('model')
        async *model(): AsyncGenerator<never, ModelTurnResult> { return this.executions ? turn() : turn([{ id: 'a', name: 'echo', input: {} }]) }
        @Hook('beforeModel')
        async before(): Promise<ContinueOrStop> { return { action: 'continue' } }
    }
    const plugin = new Plugin()
    await createAgent({ plugins: [plugin] }).run(null)
    expect(plugin.executions).toBe(1)
    expect(new Plugin().executions).toBe(0)
})
