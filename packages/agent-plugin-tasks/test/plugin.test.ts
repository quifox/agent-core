import { expect, it, vi } from 'vitest'
import { createAgent, defineTool, ToolRegistry, toolSuccess, type AgentContext, type AgentEvent, type ToolResult } from '@quifox/agent-core'
import { z } from 'zod'
import { BackgroundTasksPlugin } from '../src/index.js'

/** Construct an independent long-lived owner at the plugin boundary. */
function owner(): AgentContext { return { tools: new ToolRegistry(), plugins: [] } }

it('joins real cleanup after cancellation and preserves a successful receipt from a cancellation-ignoring operation', async () => {
    const tasks = new BackgroundTasksPlugin(), context = owner()
    let finish!: () => void, began!: () => void
    const blocked = new Promise<void>(resolve => { finish = resolve })
    const ready = new Promise<void>(resolve => { began = resolve })
    const id = tasks.submit(context, async () => { began(); await blocked; return toolSuccess('committed') })
    await ready
    const joined = tasks.join(context, id)
    tasks.cancel(context, id)
    expect(tasks.get(context, id)).toMatchObject({ status: 'running', cancelRequested: true })
    expect(await tasks.join(owner(), id)).toBeUndefined()
    finish(); expect(await joined).toMatchObject({ status: 'completed', cancelRequested: true, result: { status: 'success', content: 'committed' } })
})

it('returns a running identity immediately and preserves one real final result', async () => {
    const tasks = new BackgroundTasksPlugin()
    const ctx = owner()
    let finish!: (result: ToolResult) => void
    const result = new Promise<ToolResult>(resolve => { finish = resolve })
    let executions = 0
    const id = tasks.submit(ctx, async () => { executions += 1; return result })
    expect(tasks.get(ctx, id)).toMatchObject({ id, status: 'running' })
    finish(toolSuccess('finished', { saved: true }))
    expect(await tasks.wait(ctx, id)).toMatchObject({ id, status: 'completed', result: { content: 'finished' } })
    expect(await tasks.wait(ctx, id)).toMatchObject({ status: 'completed' })
    expect(executions).toBe(1)
})

it('restores unknown receipts within the owner and allocates a fresh default identity afterward', async () => {
    const tasks = new BackgroundTasksPlugin(), ctx = owner(), other = owner()
    tasks.restore(ctx, [{ id: 'background-1', status: 'running', cancelRequested: false }])
    expect(tasks.get(other, 'background-1')).toBeUndefined()
    expect(await tasks.wait(ctx, 'background-1')).toMatchObject({ status: 'unknown' })
    const id = tasks.submit(ctx, async () => toolSuccess('new operation'))
    expect(id).toBe('background-2')
    expect(await tasks.wait(ctx, id)).toMatchObject({ status: 'completed', result: { content: 'new operation' } })
    expect(() => tasks.restore(ctx, [{ id: 'background-1', status: 'completed', cancelRequested: false }])).toThrow('reused')
})

it('a bounded wait expires without cancelling or re-executing the operation', async () => {
    vi.useFakeTimers()
    let finish!: (result: ToolResult) => void
    const result = new Promise<ToolResult>(resolve => { finish = resolve })
    const tasks = new BackgroundTasksPlugin()
    const ctx = owner()
    const id = tasks.submit(ctx, async () => result)
    let settled = false
    const waiting = tasks.wait(ctx, id, 5).then(snapshot => { settled = true; return snapshot })
    try {
        await vi.advanceTimersByTimeAsync(5)
        expect(settled).toBe(true)
        expect(await waiting).toMatchObject({ status: 'running', cancelRequested: false })
        expect(vi.getTimerCount()).toBe(0)
    } finally {
        finish(toolSuccess('finished'))
        await waiting
        vi.useRealTimers()
    }
})

it('records cancellation only after the operation acknowledges its signal', async () => {
    const tasks = new BackgroundTasksPlugin()
    const ctx = owner()
    const id = tasks.submit(ctx, signal => new Promise((_resolve, reject) => {
        signal.addEventListener('abort', () => reject(signal.reason), { once: true })
    }))
    await Promise.resolve()
    expect(tasks.cancel(ctx, id)).toMatchObject({ status: 'running', cancelRequested: true })
    expect(await tasks.wait(ctx, id)).toMatchObject({ status: 'cancelled', cancelRequested: true })
})

it('keeps a real completion when the operation finishes after cancellation', async () => {
    const tasks = new BackgroundTasksPlugin()
    const ctx = owner()
    let finish!: (result: ToolResult) => void
    const id = tasks.submit(ctx, () => new Promise(resolve => { finish = resolve }))
    await Promise.resolve()
    tasks.cancel(ctx, id)
    finish(toolSuccess('already saved'))
    expect(await tasks.wait(ctx, id)).toMatchObject({ status: 'completed', cancelRequested: true, result: { content: 'already saved' } })
})

it('does not expose or cancel another owner task', async () => {
    const tasks = new BackgroundTasksPlugin()
    const ctx = owner()
    const other = owner()
    const id = tasks.submit(ctx, async () => toolSuccess('private'))
    expect(tasks.get(other, id)).toBeUndefined()
    expect(tasks.cancel(other, id)).toBeUndefined()
    expect(await tasks.wait(other, id)).toBeUndefined()
    expect(await tasks.wait(ctx, id)).toMatchObject({ status: 'completed', cancelRequested: false })
})

it('handles failures without exposing arbitrary operation exception text', async () => {
    const tasks = new BackgroundTasksPlugin()
    const ctx = owner()
    const id = tasks.submit(ctx, async () => { throw new Error('private operation detail') })
    expect(await tasks.wait(ctx, id)).toEqual({ id, status: 'failed', cancelRequested: false, error: 'Background operation failed.' })
})

it('closing an owner aborts its outstanding operations and leaves other owners running', async () => {
    const tasks = new BackgroundTasksPlugin()
    const ctx = owner()
    const other = owner()
    let executions = 0
    const id = tasks.submit(ctx, async () => { executions += 1; return toolSuccess('never started') })
    const otherId = tasks.submit(other, async () => toolSuccess('other'))
    await tasks.close(ctx)
    expect(executions).toBe(0)
    expect(await tasks.wait(ctx, id)).toMatchObject({ status: 'cancelled' })
    expect(await tasks.wait(other, otherId)).toMatchObject({ status: 'completed', cancelRequested: false })
})

it('mutating observation receipts cannot rewrite task facts or completion', async () => {
    const tasks = new BackgroundTasksPlugin()
    const ctx = owner()
    let finish!: (result: ToolResult) => void
    const id = tasks.submit(ctx, () => new Promise(resolve => { finish = resolve }))
    await Promise.resolve()
    const observed = tasks.get(ctx, id)!
    observed.status = 'completed'
    observed.cancelRequested = true
    expect(tasks.get(ctx, id)).toMatchObject({ status: 'running', cancelRequested: false })
    const result = toolSuccess('saved', { count: 1 })
    finish(result)
    const completed = (await tasks.wait(ctx, id))!
    completed.result!.content = 'forged'
    ;(completed.result!.data as { count: number }).count = 2
    result.content = 'also forged'
    expect((await tasks.wait(ctx, id))!.result).toEqual(toolSuccess('saved', { count: 1 }))
})

it('ordinary Core tools submit and observe the same background operation', async () => {
    const tasks = new BackgroundTasksPlugin()
    let finish!: (result: ToolResult) => void
    const pending = new Promise<ToolResult>(resolve => { finish = resolve })
    let turn = 0
    let executions = 0
    const agent = createAgent({ plugins: [tasks, { id: 'host-tools', hooks: {
        onInitialize: async ctx => { ctx.tools.register(defineTool({ name: 'submit', description: 'Submit a controlled operation.',
            inputSchema: z.object({}).strict(), policy: { sideEffect: 'external', approval: 'none' },
            execute: async (_input, owner) => { const id = tasks.submit(owner, async () => { executions += 1; return pending }); return toolSuccess(id, tasks.get(owner, id)) }
        })) },
        model: async function* () {
            const fields = { reasoning: '', usage: {}, finishReason: 'stop' as const }
            if (++turn === 1) return { ...fields, text: '', toolCalls: [{ id: 'submit-call', name: 'submit', input: {} }] }
            if (turn === 2) { finish(toolSuccess('real result')); return { ...fields, text: '', toolCalls: [{ id: 'wait-call', name: 'task_wait', input: { taskId: 'background-1' } }] } }
            return { ...fields, text: 'done', toolCalls: [] }
        }
    } }] })
    const events: AgentEvent[] = []
    const stream = agent.stream({})
    while (true) { const next = await stream.next(); if (next.done) { expect(next.value.ok).toBe(true); break } events.push(next.value) }
    const receipts = events.filter(event => event.type === 'tool-result')
    expect(receipts[0]).toMatchObject({ run: { call: { id: 'submit-call' }, result: { data: { status: 'running' } } } })
    expect(receipts[1]).toMatchObject({ run: { call: { id: 'wait-call' }, result: { data: { status: 'completed', result: { content: 'real result' } } } } })
    expect(executions).toBe(1)
})

it.each([
    { name: 'callback', data: { callback: () => 'host value' } },
    { name: 'bigint', data: 1n },
    { name: 'cycle', data: (() => { const value: { self?: unknown } = {}; value.self = value; return value })() }
])('nonserializable optional data cannot change a successful operation into a failure: $name', async ({ data }) => {
    const tasks = new BackgroundTasksPlugin()
    const ctx = owner()
    const id = tasks.submit(ctx, async () => toolSuccess('saved', data))
    const snapshot = await tasks.wait(ctx, id)
    expect(snapshot).toMatchObject({ status: 'completed', result: { status: 'success', content: 'saved' }, resultDataUnavailable: true })
    expect(() => JSON.stringify(snapshot)).not.toThrow()
})

it('rejects an invalid close timeout before requesting any cancellation', async () => {
    const tasks = new BackgroundTasksPlugin()
    const ctx = owner()
    const id = tasks.submit(ctx, async () => toolSuccess('done'))
    await expect(tasks.close(ctx, -1)).rejects.toThrow('timeout')
    expect(tasks.get(ctx, id)?.cancelRequested).toBe(false)
})
