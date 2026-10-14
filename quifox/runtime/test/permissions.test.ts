import { expect, it } from 'vitest'
import { createAgent, defineTool, toolSuccess, type AgentEvent } from '@quifox/agent-core'
import { z } from 'zod'
import { PermissionGate } from '../src/permissions.js'

it.each([{ label: 'oversized feedback', approved: false, feedback: 'x'.repeat(8001) }, { label: 'blank feedback', approved: false, feedback: ' ' }, { label: 'feedback on approval', approved: true, feedback: '拒绝说明' }])('rejects $label without consuming the pending operation', async ({ approved, feedback }) => {
    let rejected = false, pending = 0, turn = 0
    const gate = new PermissionGate({ sessionId: 'session', mode: () => 'ask', signal: () => undefined, operationId: call => call.id,
        onRequest: request => {
            try { gate.reply(request.id, approved, feedback) } catch { rejected = true }
            pending = gate.pending.length
            gate.reply(request.id, false, 'valid reply')
        } })
    const agent = createAgent({ plugins: [gate, gate.guard, { id: 'host', hooks: {
        onInitialize: async ctx => { ctx.tools.register(defineTool({ name: 'save', description: 'Save a synthetic value.', inputSchema: z.object({}).strict(),
            policy: { sideEffect: 'external', approval: 'host' }, execute: async () => toolSuccess('saved') })) },
        model: async function* () { return { text: 'done', reasoning: '', usage: {}, finishReason: 'stop', toolCalls: ++turn === 1 ? [{ id: 'call', name: 'save', input: {} }] : [] } }
    } }] })
    const events: AgentEvent[] = []
    for await (const event of agent.stream({ prompt: 'save' })) events.push(event)
    expect(rejected).toBe(true); expect(pending).toBe(1)
    expect(events.find(event => event.type === 'tool-result')).toMatchObject({ run: { result: { code: 'USER_DENIED', content: '用户拒绝了工具操作。\n用户说明：valid reply' } } })
})

it('returns a rejection explanation in the same denied tool result without executing the tool', async () => {
    let executions = 0, turn = 0
    const gate = new PermissionGate({ sessionId: 'session', mode: () => 'ask', signal: () => undefined, operationId: call => call.id,
        onRequest: request => { queueMicrotask(() => gate.reply(request.id, false, '请先检查文件内容。')) } })
    const agent = createAgent({ plugins: [gate, gate.guard, { id: 'host', hooks: {
        onInitialize: async ctx => { ctx.tools.register(defineTool({ name: 'save', description: 'Save a synthetic value.', inputSchema: z.object({}).strict(),
            policy: { sideEffect: 'external', approval: 'host' }, execute: async () => { executions += 1; return toolSuccess('saved') } })) },
        model: async function* () { return { text: 'done', reasoning: '', usage: {}, finishReason: 'stop', toolCalls: ++turn === 1 ? [{ id: 'call', name: 'save', input: {} }] : [] } }
    } }] })
    const events: AgentEvent[] = []
    for await (const event of agent.stream({ prompt: 'save' })) events.push(event)
    expect(executions).toBe(0)
    expect(events.find(event => event.type === 'tool-result')).toMatchObject({ run: { result: { status: 'denied', code: 'USER_DENIED', content: '用户拒绝了工具操作。\n用户说明：请先检查文件内容。' } } })
    expect(gate.pending).toHaveLength(0)
})

it('keeps interruption factual and ignores a rejection explanation sent after cancellation', async () => {
    const controller = new AbortController()
    let accepted = true, turn = 0, executions = 0
    const gate = new PermissionGate({ sessionId: 'session', mode: () => 'ask', signal: () => controller.signal, operationId: call => call.id,
        onRequest: request => { controller.abort(); accepted = gate.reply(request.id, false, 'late explanation') } })
    const agent = createAgent({ plugins: [gate, gate.guard, { id: 'host', hooks: {
        onInitialize: async ctx => { ctx.tools.register(defineTool({ name: 'save', description: 'Save a synthetic value.', inputSchema: z.object({}).strict(),
            policy: { sideEffect: 'external', approval: 'host' }, execute: async () => { executions += 1; return toolSuccess('saved') } })) },
        model: async function* () { return { text: 'done', reasoning: '', usage: {}, finishReason: 'stop', toolCalls: ++turn === 1 ? [{ id: 'call', name: 'save', input: {} }] : [] } }
    } }] })
    const events: AgentEvent[] = []
    for await (const event of agent.stream({ prompt: 'save' })) events.push(event)
    expect(accepted).toBe(false); expect(executions).toBe(0)
    expect(events.find(event => event.type === 'tool-result')).toMatchObject({ run: { result: { code: 'USER_INTERRUPTED', content: '已停止待授权操作。' } } })
})

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
