import type { AgentEvent, AgentPlugin, ModelTurnResult, ToolCall } from '../src/index.js'

type TestTurn = ModelTurnResult

/** @param calls - 完整工具计划。 @param text - 测试自定义产物。 */
export function turn(calls: ToolCall[] = [], text = 'done'): TestTurn {
    return { text, reasoning: '', usage: {}, toolCalls: calls, finishReason: calls.length ? 'tool-calls' : 'stop' }
}

/** @param turns - 测试插件的执行脚本，Core 不解释其自定义产物。 */
export function scripted(turns: TestTurn[] = [turn()]): AgentPlugin {
    let index = 0
    return { id: 'generation', hooks: { async *model() {
        const result = turns[index++]
        if (!result) { throw new Error('模型调用超过脚本范围。') }
        yield { type: 'text-delta', delta: result.text }
        return result
    } } }
}

/** @param stream - 实际公开事件流。 */
export async function collectEvents(stream: AsyncIterable<AgentEvent>): Promise<AgentEvent[]> {
    const events: AgentEvent[] = []
    for await (const event of stream) { events.push(event) }
    return events
}
