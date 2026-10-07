import type { AgentRunOutcome, ModelTurnResult } from '@quifox/agent-core'
import { expect, it } from 'vitest'
import { createAgent } from '@quifox/agent-core'

it('Core 没有默认入口、协议配置或消息容器', async () => {
    const agent = createAgent({ plugins: [{ id: 'model', hooks: {
        async *model(ctx) {
            expect(Object.keys(ctx)).toEqual(['tools', 'plugins'])
            expect(ctx.tools.definitions()).toEqual([])
            return ({ text: '', reasoning: '', usage: {}, toolCalls: [], finishReason: 'stop' })
        }
    } }] })
    expect((await agent.run({ arbitrary: true }).then(expectModelResult)).finishReason).toBe('stop')
})

/** 仅供测试消费标准 Outcome；不包装模型结果。 */
function expectModelResult(outcome: AgentRunOutcome): ModelTurnResult {
    if (!outcome.ok) { throw outcome.error }
    return outcome.value as ModelTurnResult
}
