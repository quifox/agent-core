import { createAgent, type AgentContext, type AgentPlugin, type AgentHooks } from '../src/index.js'

declare const ctx: AgentContext
// @ts-expect-error Core 不拥有会话消息。
void ctx.messages
// @ts-expect-error 网络取消属于 I/O 插件。
void ctx.signal
// @ts-expect-error Core 不提供运行 ID。
void ctx.runId
// @ts-expect-error Core 不提供请求工厂。
void ctx.createModelRequest

const plugin: AgentPlugin<{ image: string }> = { id: 'input', hooks: { onRunStart: async (_ctx, input) => {
    input.image.toUpperCase()
    return { action: 'continue' }
} } }
const agent = createAgent({ plugins: [plugin] })
void agent.stream({ image: 'base64' })
// @ts-expect-error 泛型入口不是任意字符串。
void agent.run('prompt')
// @ts-expect-error 无 Core model 选项。
createAgent({ model: {}, plugins: [] })
// @ts-expect-error 无 onEvent 回调入口。
void agent.run({ image: 'x', onEvent() {} })

const hooks: AgentHooks = {
    // @ts-expect-error 参数准备在工具内部，beforeModel 没有 request 参数。
    beforeModel: async (_ctx, request) => ({ action: 'continue', request })
}
void hooks

// 动态读取保留完整工具方法，不要求使用者执行某个固定调用顺序。
const tool = ctx.tools.get('save')
if (tool) { void tool.execute({ callerOwned: true }, ctx) }
const toolSnapshot = ctx.tools.values()
toolSnapshot.splice(0, 1)
