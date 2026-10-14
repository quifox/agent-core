import { expect, it, vi } from 'vitest'
import { createAgent, ToolRegistry, type AgentEvent, type ModelRequest } from '@quifox/agent-core'
import { McpPlugin } from '../src/index.js'

it('maps a standard MCP tool through Core while preserving schema, arguments and its real result', async () => {
    const call = vi.fn(async () => ({ content: [{ type: 'text', text: 'real value' }], structuredContent: { value: 7 }, isError: false }))
    const inputSchema = { type: 'object', properties: { value: { type: 'integer', minimum: 1 } }, required: ['value'], additionalProperties: false }
    const mcp = new McpPlugin({ namespace: 'synthetic', client: { listTools: async () => ({ tools: [{ name: 'read.value', description: 'Read a value.', inputSchema }] }), callTool: call, close: async () => {} } })
    const requests: ModelRequest['tools'][] = []
    let turn = 0
    const agent = createAgent({ plugins: [mcp, { id: 'scripted-model', hooks: { model: async function* (ctx) {
        requests.push(ctx.tools.definitions())
        return { text: 'done', reasoning: '', usage: {}, finishReason: 'stop', toolCalls: ++turn === 1
            ? [{ id: 'call', name: ctx.tools.definitions()[0]!.name, input: { value: 7 } }] : [] }
    } } }] })
    const events: AgentEvent[] = []
    const stream = agent.stream({})
    while (true) { const next = await stream.next(); if (next.done) { expect(next.value.ok).toBe(true); break } events.push(next.value) }
    expect(requests[0]![0]!.inputSchema).toMatchObject(inputSchema)
    expect(call.mock.calls[0]).toEqual([{ name: 'read.value', arguments: { value: 7 } }, undefined])
    expect(events.find(event => event.type === 'tool-result')).toMatchObject({ run: { result: { status: 'success', data: { structuredContent: { value: 7 } } } } })
})

it('reads every directory page and validates arguments without coercion before any remote call', async () => {
    const listTools = vi.fn(async (input?: { cursor: string }) => input?.cursor === 'next'
        ? { tools: [{ name: 'second', inputSchema: { type: 'object', properties: {} } }] }
        : { tools: [{ name: 'first', inputSchema: { type: 'object', properties: { value: { type: 'integer' } }, required: ['value'] } }], nextCursor: 'next' })
    const callTool = vi.fn(async () => ({ content: [], isError: true }))
    const close = vi.fn(async () => {})
    const plugin = new McpPlugin({ namespace: 'source', client: { listTools, callTool, close } })
    const ctx = { tools: new ToolRegistry(), plugins: [] }
    const initialize = plugin.hooks.onInitialize!
    if (Array.isArray(initialize)) throw new Error('Expected one initialization hook.')
    await initialize(ctx)
    expect(listTools.mock.calls).toEqual([[undefined], [{ cursor: 'next' }]])
    expect(ctx.tools.definitions()).toHaveLength(2)
    const tool = ctx.tools.get(ctx.tools.definitions()[0]!.name)!
    expect(ctx.tools.policy(tool.name)).toEqual({ sideEffect: 'external', approval: 'host' })
    await expect(tool.prepare(ctx, { value: '7' })).rejects.toThrow()
    expect(callTool).not.toHaveBeenCalled()
    const prepared = await tool.prepare(ctx, { value: 7 })
    expect((await tool.execute(prepared, ctx)).code).toBe('MCP_TOOL_ERROR')
    await plugin.close(); await plugin.close()
    expect(close).toHaveBeenCalledTimes(1)
})

it('rejects a repeated cursor instead of silently truncating or looping the directory', async () => {
    const plugin = new McpPlugin({ namespace: 'source', client: { listTools: async () => ({ tools: [], nextCursor: 'same' }),
        callTool: async () => ({ content: [] }), close: async () => {} } })
    const agent = createAgent({ plugins: [plugin] })
    expect((await agent.run({})).ok).toBe(false)
})
