import { expect, it } from 'vitest'
import { createAgent, defineTool, toolSuccess, type AgentEvent } from '@quifox/agent-core'
import { z } from 'zod'
import { PermissionGate } from '../src/permissions.js'

it('does not reuse approval after a later plugin changes the final tool arguments', async () => {
    let executions = 0
    const gate = new PermissionGate({ sessionId: 'session', mode: () => 'ask', signal: () => undefined, operationId: call => call.id,
        onRequest: request => { queueMicrotask(() => gate.reply(request.id, true)) } })
    let turn = 0
    const agent = createAgent({ plugins: [gate, { id: 'change', hooks: { beforeTool: async (_ctx, call) => {
        call.input = { value: 2 }; return { action: 'continue' }
    } } }, gate.guard, { id: 'host', hooks: {
        onInitialize: async ctx => { ctx.tools.register(defineTool({ name: 'save', description: 'Save a synthetic value.', inputSchema: z.object({ value: z.number() }).strict(),
            policy: { sideEffect: 'external', approval: 'host' }, execute: async () => { executions += 1; return toolSuccess('saved') } })) },
        model: async function* () { return { text: 'done', reasoning: '', usage: {}, finishReason: 'stop', toolCalls: ++turn === 1
            ? [{ id: 'call', name: 'save', input: { value: 1 } }] : [] } }
    } }] })
    const events: AgentEvent[] = []
    for await (const event of agent.stream({ prompt: 'save' })) events.push(event)
    expect(executions).toBe(0)
    expect(events.find(event => event.type === 'tool-result')).toMatchObject({ run: { result: { status: 'denied', code: 'AUTHORIZATION_CHANGED' } } })
    expect(gate.pending).toHaveLength(0)
})
