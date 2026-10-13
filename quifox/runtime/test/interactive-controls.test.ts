import { expect, it, vi } from 'vitest'
import { BackgroundTasksPlugin } from '@quifox/agent-plugin-tasks'
import { readFile } from 'node:fs/promises'
import { join } from 'node:path'
import type { RuntimeSnapshot, SessionView } from '../src/protocol.js'
import { synthetic } from './synthetic.js'
import type { ToolResult } from '@quifox/agent-core'

it('retains the actual foreground cancellation receipt and waits for the process to exit before recovery', async () => {
    const fixture = await synthetic((_request, index) => index === 1 ? { calls: [{ id: 'foreground', name: 'run_command', input: {
        command: "node -e \"require('node:fs').writeFileSync('foreground.pid',String(process.pid)); console.log('started'); setInterval(()=>{},1000)\""
    } }] } : { text: 'Recovered.' }, config => { config.approval = 'allow' })
    try {
        const session = await fixture.runtime.command({ type: 'create' }) as SessionView
        await fixture.runtime.command({ type: 'submit', sessionId: session.id, prompt: 'Run one foreground command.' })
        await expect.poll(() => readFile(join(fixture.root, 'foreground.pid'), 'utf8').catch(() => ''), { timeout: 2500 }).not.toBe('')
        const pid = Number(await readFile(join(fixture.root, 'foreground.pid'), 'utf8'))
        await fixture.runtime.command({ type: 'stop', sessionId: session.id }); await fixture.runtime.waitForIdle(session.id)
        const view = await fixture.runtime.command({ type: 'snapshot', sessionId: session.id }) as SessionView
        const result = (view.events.find(event => event.type === 'agent' && (event.data as { type?: string }).type === 'tool-result')?.data as { run: { result: ToolResult } }).run.result
        expect(result.status).toBe('error'); expect(result.data).toMatchObject({ cancelRequested: true })
        expect(result.data).toHaveProperty('exitCode')
        expect(result.code).toBe('COMMAND_INTERRUPTED')
        expect(() => process.kill(pid, 0)).toThrow()
        expect(view.resumeAvailable).toBe(true)
    } finally { await fixture.close() }
})

it('does not commit or start a child whose asynchronous creation was overtaken by stopping its parent', async () => {
    let release!: () => void, entered!: () => void
    const blocked = new Promise<void>(resolve => { release = resolve }), creating = new Promise<void>(resolve => { entered = resolve })
    const fixture = await synthetic(() => ({ calls: [{ id: 'child', name: 'subagent_start', input: { prompt: 'Child task.' } }] }))
    const host = fixture.runtime as unknown as { compose(state: { metadata: { parentId?: string } }, ...arguments_: unknown[]): Promise<unknown> }
    const original = host.compose
    const spy = vi.spyOn(host, 'compose').mockImplementation(async function (this: typeof host, state, ...arguments_) {
        if (state.metadata.parentId) { entered(); await blocked }
        return original.call(this, state, ...arguments_)
    })
    try {
        const session = await fixture.runtime.command({ type: 'create' }) as SessionView
        await fixture.runtime.command({ type: 'submit', sessionId: session.id, prompt: 'Create a child.' }); await creating
        await fixture.runtime.command({ type: 'stop', sessionId: session.id }); release(); await fixture.runtime.waitForIdle(session.id)
        expect((await fixture.runtime.command({ type: 'snapshot' }) as RuntimeSnapshot).sessions).toHaveLength(1)
        expect(fixture.requests).toHaveLength(1)
    } finally { release(); spy.mockRestore(); await fixture.close() }
})

it('stops a child creation delayed while publishing its durable identity before task registration', async () => {
    let release!: () => void, entered!: () => void
    const blocked = new Promise<void>(resolve => { release = resolve }), publishing = new Promise<void>(resolve => { entered = resolve })
    const fixture = await synthetic(() => ({ calls: [{ id: 'child', name: 'subagent_start', input: { prompt: 'Child task.' } }] }))
    const host = fixture.runtime as unknown as { publish(entry: unknown, type: string, ...arguments_: unknown[]): Promise<void> }
    const original = host.publish
    const spy = vi.spyOn(host, 'publish').mockImplementation(async function (this: typeof host, entry, type, ...arguments_) {
        if (type === 'subagent') { entered(); await blocked }
        return original.call(this, entry, type, ...arguments_)
    })
    try {
        const session = await fixture.runtime.command({ type: 'create' }) as SessionView
        await fixture.runtime.command({ type: 'submit', sessionId: session.id, prompt: 'Create a child.' }); await publishing
        await fixture.runtime.command({ type: 'stop', sessionId: session.id }); release(); await fixture.runtime.waitForIdle(session.id)
        const snapshot = await fixture.runtime.command({ type: 'snapshot' }) as RuntimeSnapshot
        expect(snapshot.sessions.filter(item => item.parentId === session.id).every(item => item.status === 'stopped')).toBe(true)
        expect(fixture.requests).toHaveLength(1)
    } finally { release(); spy.mockRestore(); await fixture.close() }
})

it('stops a slash-spawn batch while its parent context is still being prepared', async () => {
    let release!: () => void, entered!: () => void
    const blocked = new Promise<void>(resolve => { release = resolve }), preparing = new Promise<void>(resolve => { entered = resolve })
    const fixture = await synthetic(() => ({ text: 'Unexpected request.' }))
    const host = fixture.runtime as unknown as { prepareContext(entry: unknown): Promise<unknown> }
    const original = host.prepareContext
    const spy = vi.spyOn(host, 'prepareContext').mockImplementation(async function (this: typeof host, entry) {
        entered(); await blocked; return original.call(this, entry)
    })
    try {
        const session = await fixture.runtime.command({ type: 'create' }) as SessionView
        const spawning = fixture.runtime.command({ type: 'submit', sessionId: session.id, prompt: '/spawn 2', messageId: 'spawn-before-stop' })
        await preparing; await fixture.runtime.command({ type: 'stop', sessionId: session.id }); release()
        await expect(spawning).rejects.toThrow('创建已被停止')
        expect((await fixture.runtime.command({ type: 'snapshot' }) as RuntimeSnapshot).sessions).toHaveLength(1)
        expect(fixture.requests).toHaveLength(0)
    } finally { release(); spy.mockRestore(); await fixture.close() }
})

it('saves appearance while a model request is active without replacing its Agent', async () => {
    let release!: () => void
    const held = new Promise<void>(resolve => { release = resolve })
    const fixture = await synthetic(async () => { await held; return { text: 'Original run completed.' } })
    try {
        const session = await fixture.runtime.command({ type: 'create' }) as SessionView
        await fixture.runtime.command({ type: 'submit', sessionId: session.id, prompt: 'Keep working.' })
        await expect.poll(() => fixture.requests.length).toBe(1)
        await fixture.runtime.command({ type: 'config', patch: { preferences: { theme: 'light', uiScale: 1.2 } } })
        const view = await fixture.runtime.command({ type: 'snapshot', sessionId: session.id }) as SessionView
        expect(view.status).toBe('running'); expect(view.preferences).toMatchObject({ theme: 'light', uiScale: 1.2 })
        expect(JSON.parse(await readFile(join(fixture.root, 'config.json'), 'utf8'))).toMatchObject({ preferences: { theme: 'light', uiScale: 1.2 } })
        release(); await fixture.runtime.waitForIdle(session.id)
        expect(fixture.requests).toHaveLength(1)
        expect((await fixture.runtime.command({ type: 'snapshot', sessionId: session.id }) as SessionView).messages.at(-1)?.message.content).toBe('Original run completed.')
    } finally { release(); await fixture.close() }
})

it('withdraws pending messages and guides the remaining prefix with unchanged identities', async () => {
    let release!: () => void
    const held = new Promise<void>(resolve => { release = resolve })
    const fixture = await synthetic(async (_request, index) => { if (index === 1) await held; return { text: 'Done.' } })
    try {
        const session = await fixture.runtime.command({ type: 'create' }) as SessionView
        await fixture.runtime.command({ type: 'submit', sessionId: session.id, prompt: 'Original task.' })
        await expect.poll(() => fixture.requests.length).toBe(1)
        for (const id of ['one', 'two', 'three']) await fixture.runtime.command({ type: 'submit', sessionId: session.id, prompt: id, messageId: id })
        await fixture.runtime.command({ type: 'inbox', sessionId: session.id, action: 'cancel', messageId: 'two' })
        await fixture.runtime.command({ type: 'inbox', sessionId: session.id, action: 'steer', messageId: 'three' })
        const view = await fixture.runtime.command({ type: 'snapshot', sessionId: session.id }) as SessionView
        expect(view.pendingMessages.filter(item => item.status === 'pending')).toEqual([
            { id: 'one', prompt: 'one', mode: 'steer', status: 'pending' }, { id: 'three', prompt: 'three', mode: 'steer', status: 'pending' }
        ])
        release(); await fixture.runtime.waitForIdle(session.id)
        const completed = await fixture.runtime.command({ type: 'snapshot', sessionId: session.id }) as SessionView
        expect(completed.messages.filter(item => item.message.role === 'user').map(item => item.message.content)).toEqual(['Original task.', 'one', 'three'])
        await expect(fixture.runtime.command({ type: 'inbox', sessionId: session.id, action: 'cancel', messageId: 'one' })).rejects.toThrow('无法撤回')
        const before = (await fixture.runtime.command({ type: 'snapshot' }) as RuntimeSnapshot).sessions.length
        expect(before).toBe(1)
    } finally { release(); await fixture.close() }
})

it('stops background waits promptly, cancels their operation and preserves paired interruption receipts', async () => {
    let entered!: () => void
    const waiting = new Promise<void>(resolve => { entered = resolve })
    const originalWait = BackgroundTasksPlugin.prototype.wait
    const spy = vi.spyOn(BackgroundTasksPlugin.prototype, 'wait').mockImplementation(function (this: BackgroundTasksPlugin, ...args) {
        if (args[2] === 30000) entered()
        return originalWait.apply(this, args)
    })
    const fixture = await synthetic((request, index) => {
        if (index === 1) return { calls: [{ id: 'background', name: 'run_command', input: { command: 'node -e "setTimeout(() => {}, 30000)"', background: true } }] }
        if (index === 2) {
            const result = [...request.messages].reverse().find(message => message.role === 'tool')!
            return { calls: [{ id: 'wait', name: 'task_wait', input: { taskId: JSON.parse(result.content).taskId, timeoutMs: 30000 } }] }
        }
        return { text: 'Recovered.' }
    }, config => { config.approval = 'allow' })
    try {
        const session = await fixture.runtime.command({ type: 'create' }) as SessionView
        await fixture.runtime.command({ type: 'submit', sessionId: session.id, prompt: 'Run a background task.' }); await waiting
        await fixture.runtime.command({ type: 'stop', sessionId: session.id })
        await expect.poll(async () => (await fixture.runtime.command({ type: 'snapshot', sessionId: session.id }) as SessionView).status, { timeout: 2500 }).toBe('stopped')
        await expect.poll(async () => (await fixture.runtime.command({ type: 'snapshot', sessionId: session.id }) as SessionView).resumeAvailable).toBe(true)
        const view = await fixture.runtime.command({ type: 'snapshot', sessionId: session.id }) as SessionView
        expect(view.backgroundTasks.every(task => task.cancelRequested)).toBe(true)
        const receipt = view.messages.find(item => item.message.role === 'tool' && item.message.toolName === 'task_wait')?.message
        expect(receipt).toBeDefined()
        expect(view.backgroundTasks.every(task => task.status !== 'running')).toBe(true)
        await fixture.runtime.command({ type: 'resume', sessionId: session.id, mode: 'replan' }); await fixture.runtime.waitForIdle(session.id)
        expect((await fixture.runtime.command({ type: 'snapshot', sessionId: session.id }) as SessionView).messages.at(-1)?.message.content).toBe('Recovered.')
    } finally { await fixture.close(); spy.mockRestore() }
})
