import { expect, it } from 'vitest'
import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import { readFile, writeFile, realpath } from 'node:fs/promises'
import { join } from 'node:path'
import type { SessionView } from '../src/protocol.js'
import { synthetic } from './synthetic.js'

it('shows command file differences, subtracts preexisting edits and retains edits from a failed command', async () => {
    const execute = promisify(execFile)
    const script = "const fs=require('fs');fs.writeFileSync('tracked.txt','changed by command\\n');process.exitCode=3"
    const command = `${JSON.stringify(process.execPath)} -e ${JSON.stringify(script)}`
    const fixture = await synthetic((_input, index) => index === 1 ? { calls: [{ id: 'command', name: 'run_command', input: { command } }] } : { text: 'actual result observed' }, config => { config.approval = 'allow' })
    try {
        await execute('git', ['init', '-q'], { cwd: fixture.root })
        await writeFile(join(fixture.root, '.gitignore'), 'config.json\nsessions/\nmemory/\n')
        await writeFile(join(fixture.root, 'tracked.txt'), 'original\n'); await writeFile(join(fixture.root, 'preexisting.txt'), 'base\n')
        await execute('git', ['add', '.'], { cwd: fixture.root })
        await execute('git', ['-c', 'user.name=Synthetic', '-c', 'user.email=synthetic@example.test', 'commit', '-qm', 'synthetic baseline'], { cwd: fixture.root })
        await writeFile(join(fixture.root, 'preexisting.txt'), 'user existing edit\n')
        const session = await fixture.runtime.command({ type: 'create' }) as SessionView
        await fixture.runtime.command({ type: 'submit', sessionId: session.id, prompt: 'execute command and observe changes' }); await fixture.runtime.waitForIdle(session.id)
        const view = await fixture.runtime.command({ type: 'snapshot', sessionId: session.id, traceOnly: true }) as SessionView
        expect(await readFile(join(fixture.root, 'tracked.txt'), 'utf8')).toBe('changed by command\n')
        expect(view.changes).toEqual([{ path: join(await realpath(fixture.root), 'tracked.txt'), before: 'original\n', after: 'changed by command\n' }])
        expect(view.messages.find(item => item.message.role === 'tool')?.message.content).toContain('"exitCode":3')
    } finally { await fixture.close() }
})

it('keeps late background changes attached to their originating run while a newer turn is active', async () => {
    const execute = promisify(execFile)
    let release!: () => void
    const gate = new Promise<void>(resolve => { release = resolve })
    const script = "const fs=require('fs');const timer=setInterval(()=>{if(fs.existsSync('release-task')){clearInterval(timer);fs.writeFileSync('late.txt','late background edit\\n')}},10)"
    const command = `${JSON.stringify(process.execPath)} -e ${JSON.stringify(script)}`
    const fixture = await synthetic(async (_input, index) => {
        if (index === 1) return { calls: [{ id: 'background', name: 'run_command', input: { command, timeoutMs: 0 } }] }
        if (index === 3) await gate
        return { text: 'completed turn' }
    }, config => { config.approval = 'allow' })
    try {
        await execute('git', ['init', '-q'], { cwd: fixture.root })
        await writeFile(join(fixture.root, '.gitignore'), 'config.json\nsessions/\nmemory/\nrelease-task\n')
        const session = await fixture.runtime.command({ type: 'create' }) as SessionView
        await fixture.runtime.command({ type: 'submit', sessionId: session.id, prompt: 'first turn starts background work' }); await fixture.runtime.waitForIdle(session.id)
        const first = await fixture.runtime.command({ type: 'snapshot', sessionId: session.id }) as SessionView
        const started = first.events.find(event => event.type === 'background-task')!
        await fixture.runtime.command({ type: 'submit', sessionId: session.id, prompt: 'new turn while background is still pending' })
        await expect.poll(() => fixture.requests.length).toBe(3)
        await writeFile(join(fixture.root, 'release-task'), 'go')
        await expect.poll(async () => (await fixture.runtime.command({ type: 'snapshot', sessionId: session.id }) as SessionView).events.some(event =>
            event.type === 'background-task' && (event.data as { status: string }).status === 'completed')).toBe(true)
        const active = await fixture.runtime.command({ type: 'snapshot', sessionId: session.id }) as SessionView
        const completed = active.events.filter(event => event.type === 'background-task').at(-1)!
        expect(completed.runId).toBe(started.runId)
        expect(active.changes).toEqual([])
        expect((completed.data as { result: { data: { changes: unknown[] } } }).result.data.changes).toHaveLength(1)
        release(); await fixture.runtime.waitForIdle(session.id)
    } finally { release(); await fixture.close() }
})
