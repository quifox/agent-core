import { expect, it } from 'vitest'
import { readFile } from 'node:fs/promises'
import { join } from 'node:path'
import type { SessionView } from '../src/protocol.js'
import { synthetic } from './synthetic.js'

it('returns a model-visible background identity and waits for the actual native command receipt', async () => {
    const command = `"${process.execPath}" -e "setTimeout(()=>console.log('real background stdout'),30)"`
    const fixture = await synthetic((input, index) => {
        if (index === 1) return { calls: [{ id: 'background-start', name: 'run_command', input: { command, background: true } }] }
        if (index === 2) {
            const receipt = JSON.parse(input.messages.at(-1)!.content) as { taskId: string }
            return { calls: [{ id: 'background-wait', name: 'task_wait', input: { taskId: receipt.taskId, timeoutMs: 2000 } }] }
        }
        return { text: 'background observed' }
    }, config => { config.approval = 'allow' })
    try {
        const session = await fixture.runtime.command({ type: 'create' }) as SessionView
        await fixture.runtime.command({ type: 'submit', sessionId: session.id, prompt: 'run native background work' }); await fixture.runtime.waitForIdle(session.id)
        const view = await fixture.runtime.command({ type: 'snapshot', sessionId: session.id }) as SessionView
        expect(view.status).toBe('idle'); expect(fixture.requests).toHaveLength(3)
        const actual = JSON.parse(fixture.requests[2]!.messages.at(-1)!.content) as { id: string; status: string; result: { status: string; content: string } }
        expect(actual).toMatchObject({ status: 'completed', result: { status: 'success' } }); expect(actual.result.content).toContain('real background stdout')
        expect(view.backgroundTasks[0]?.id).toBe(actual.id)
    } finally { await fixture.close() }
})

it('closing the real Host waits for native background cancellation and leaves no child process', async () => {
    const command = `"${process.execPath}" -e "require('node:fs').writeFileSync('child.pid',String(process.pid));setInterval(()=>{},1000)"`
    const fixture = await synthetic((_input, index) => index === 1 ? { calls: [{ id: 'background-long', name: 'run_command', input: { command, background: true } }] } : { text: 'submitted' }, config => { config.approval = 'allow' })
    try {
        const session = await fixture.runtime.command({ type: 'create' }) as SessionView
        await fixture.runtime.command({ type: 'submit', sessionId: session.id, prompt: 'start cancellable operation' }); await fixture.runtime.waitForIdle(session.id)
        await expect.poll(async () => Number(await readFile(join(fixture.root, 'child.pid'), 'utf8'))).toBeGreaterThan(0)
        const pid = Number(await readFile(join(fixture.root, 'child.pid'), 'utf8'))
        await fixture.runtime.close()
        expect(() => process.kill(pid, 0)).toThrow()
        await fixture.restart()
        const restored = await fixture.runtime.command({ type: 'snapshot', sessionId: session.id }) as SessionView
        expect(restored.backgroundTasks[0]).toMatchObject({ cancelRequested: true, result: { code: 'COMMAND_INTERRUPTED' } })
    } finally { await fixture.close() }
})
