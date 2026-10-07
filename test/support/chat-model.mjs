// Scripted responses enter through the public transport boundary, never a model-client option.
const encoder = new TextEncoder()
const finishReasons = { 'tool-calls': 'tool_calls', 'content-filter': 'content_filter' }

export function chatModelOptions(source) {
    return {
        model: source.modelId,
        baseUrl: 'https://model.test',
        transport: {
            async stream(request) {
                const wire = JSON.parse(request.body)
                const calls = new Map()
                const messages = wire.messages.map(message => {
                    if (message.role === 'tool') {
                        return { role: 'tool', content: message.content, toolCallId: message.tool_call_id,
                            toolName: message.name ?? calls.get(message.tool_call_id) ?? '' }
                    }
                    if (message.role !== 'assistant') { return { role: message.role, content: message.content } }
                    const toolCalls = message.tool_calls?.map(call => {
                        calls.set(call.id, call.function.name)
                        return { id: call.id, name: call.function.name, input: JSON.parse(call.function.arguments) }
                    })
                    return { role: 'assistant', content: message.content ?? '',
                        ...(message.reasoning_content ? { reasoning: message.reasoning_content } : {}),
                        ...(toolCalls ? { toolCalls } : {}) }
                })
                const input = {
                    messages,
                    tools: (wire.tools ?? []).map(tool => ({
                        name: tool.function.name, description: tool.function.description, inputSchema: tool.function.parameters
                    })),
                    ...(wire.max_tokens === undefined ? {} : { maxOutputTokens: wire.max_tokens }),
                    ...(wire.temperature === undefined ? {} : { temperature: wire.temperature }),
                    ...(wire.tool_choice === undefined ? {} : { toolChoice: wire.tool_choice }),
                    ...(request.signal ? { signal: request.signal } : {})
                }
                return { status: 200, headers: {}, body: (async function* () {
                    let index = 0
                    for await (const event of source.stream(input)) {
                        let value
                        if (event.type === 'text-delta') { value = { choices: [{ delta: { content: event.delta } }] } }
                        else if (event.type === 'reasoning-delta') { value = { choices: [{ delta: { reasoning_content: event.delta } }] } }
                        else if (event.type === 'tool-call') {
                            value = { choices: [{ delta: { tool_calls: [{ index: index++, id: event.call.id,
                                function: { name: event.call.name, arguments: JSON.stringify(event.call.input) } }] } }] }
                        } else if (event.type === 'usage') {
                            value = { choices: [], usage: { prompt_tokens: event.usage.inputTokens,
                                completion_tokens: event.usage.outputTokens, total_tokens: event.usage.totalTokens } }
                        } else if (event.type === 'finish') {
                            value = { choices: [{ delta: {}, finish_reason: finishReasons[event.reason] ?? event.reason }] }
                        } else { throw new Error('Unknown scripted event') }
                        yield encoder.encode(`data: ${JSON.stringify(value)}\n\n`)
                    }
                    yield encoder.encode('data: [DONE]\n\n')
                })() }
            }
        }
    }
}
