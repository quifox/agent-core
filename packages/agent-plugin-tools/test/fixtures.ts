import type { AgentEvent } from '@quifox/agent-core'
import type { ModelEvent, ModelRequest } from '@quifox/agent-core'
import type { ScriptedModel as LanguageModel } from '../../../test/support/chat-model.mjs'

export type ModelTurnScript =
    | readonly ModelEvent[]
    | ((request: ModelRequest, call: number) => AsyncIterable<ModelEvent>)

export interface ScriptedModel extends LanguageModel {
    readonly requests: ModelRequest[]
    readonly calls: number
}

/** 创建无 Provider 依赖的可重复模型脚本。 */
export function createScriptedModel(
    scripts: readonly ModelTurnScript[]
): ScriptedModel {
    const requests: ModelRequest[] = []
    let calls = 0

    return {
        provider: 'fake',
        modelId: 'fake-1',
        requests,
        get calls() {
            return calls
        },
        async *stream(request) {
            const call = calls
            calls += 1
            requests.push(request)
            const script = scripts[call] ?? scripts[scripts.length - 1]
            if (!script) {
                throw new Error(`Missing model script for call ${call}`)
            }

            if (typeof script === 'function') {
                yield* script(request, call)
                return
            }

            for (const event of script) {
                yield event
            }
        }
    }
}

/** 完整消费事件流，供测试断言终端顺序。 */
export async function collectEvents(stream: AsyncIterable<AgentEvent>): Promise<AgentEvent[]> {
    const events: AgentEvent[] = []
    for await (const event of stream) {
        events.push(event)
    }
    return events
}

/** @param agent - 被测 Agent。 @param input - 原样传递的输入。 */
export async function* observeRun<T>(agent: import('@quifox/agent-core').Agent<T>, input: T): AsyncGenerator<AgentEvent> {
    for await (const event of agent.stream(input)) { yield event }
}
