import type { AgentRunOutcome, ModelTurnResult } from '@quifox/agent-core'
import { expect, it } from 'vitest'
import { createAgent, type AgentPlugin } from '@quifox/agent-core'
import { type AgentMessage } from '@quifox/agent-core'
import { createSystemPromptPlugin } from '../src/index.js'

/** @param messages - 插件自己持有的消息。 @param plugins - 追加的普通插件。 */
function agentFor(_messages: AgentMessage[], plugins: AgentPlugin[] = []) {
    const generation: AgentPlugin = { id: 'model', hooks: { async *model(ctx) {
        expect(ctx).not.toHaveProperty('messages')
        return ({ text: '', reasoning: '', usage: {}, toolCalls: [], finishReason: 'stop' })
    } } }
    return createAgent({ plugins: [generation, ...plugins] })
}

it('显式消息能力保持已有 system 顺序，跨轮不重复', async () => {
    const messages: AgentMessage[] = [{ role: 'system', content: '已有' }, { role: 'user', content: '问题' }]
    const agent = agentFor(messages, [createSystemPromptPlugin(() => messages, '通用规则')])
    await agent.run(null).then(expectModelResult); await agent.run(null).then(expectModelResult)
    expect(messages.filter(message => message.role === 'system').map(message => message.content)).toEqual(['已有', '通用规则'])
})

it('空内容及被注册筛选删除的插件不追加', async () => {
    const messages: AgentMessage[] = []
    const plugin = createSystemPromptPlugin(() => messages, '不会执行')
    await agentFor(messages, [plugin, { id: 'guard', hooks: { onRegister: async plugins => { plugins.splice(plugins.indexOf(plugin), 1) } } }]).run(null).then(expectModelResult)
    await agentFor(messages, [createSystemPromptPlugin(() => messages, ' ')]).run(null).then(expectModelResult)
    expect(messages).toEqual([])
})

it('后项直接修改共享 system 和 user，不需请求替换协议', async () => {
    const messages: AgentMessage[] = [{ role: 'user', content: '问题' }]
    await agentFor(messages, [createSystemPromptPlugin(() => messages, '原规则'), { id: 'revise', hooks: {
        beforeModel: async () => { messages[0]!.content = '修订规则'; messages[1]!.content += '\n环境'; return { action: 'continue' } }
    } }]).run(null).then(expectModelResult)
    expect(messages.map(message => message.content)).toEqual(['修订规则', '问题\n环境'])
})

/** 仅供测试消费标准 Outcome；不包装模型结果。 */
function expectModelResult(outcome: AgentRunOutcome): ModelTurnResult {
    if (!outcome.ok) { throw outcome.error }
    return outcome.value as ModelTurnResult
}
