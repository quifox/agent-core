import { expect, it, vi } from 'vitest'
import { mkdtemp, mkdir, rm, writeFile, symlink } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { inspectTool } from '../src/native-tools.js'
import { synthetic } from './synthetic.js'
import type { SessionView } from '../src/protocol.js'

it('approves only after command preparation and returns a denial without executing', async () => {
    const fixture = await synthetic((_request, index) => index === 1 ? { calls: [
        { id: 'safe', name: 'run_command', input: { command: 'pwd' } },
        { id: 'unsafe', name: 'run_command', input: { command: 'touch must-not-exist' } }
    ] } : { text: 'done' })
    let approvals = 0
    fixture.runtime.subscribe(event => {
        if (event.type === 'approval') { approvals++; void fixture.runtime.command({ type: 'approve', sessionId: event.sessionId!, approvalId: (event.data as { id: string }).id, approved: false }) }
    })
    try {
        const session = await fixture.runtime.command({ type: 'create' }) as SessionView
        await fixture.runtime.command({ type: 'submit', sessionId: session.id, prompt: 'inspect then change' }); await fixture.runtime.waitForIdle(session.id)
        expect(approvals).toBe(1)
        expect(fixture.requests[1]?.messages.filter(message => message.role === 'tool').map(message => message.content)).toEqual([
            expect.stringContaining(fixture.root), expect.stringContaining('用户拒绝')
        ])
        expect((await fixture.runtime.command({ type: 'snapshot', sessionId: session.id }) as SessionView).status).toBe('idle')
    } finally { await fixture.close() }
})

it('only exempts fully literal, known read-only arguments and in-workspace paths', async () => {
    const root = await mkdtemp(join(tmpdir(), 'quifox-command-policy-'))
    try {
        await writeFile(join(root, 'source.txt'), 'source')
        for (const command of ['pwd', 'ls -la', 'cat source.txt', 'sed -n 1,20p source.txt', 'rg -n source source.txt']) {
            expect(await inspectTool(root, { name: 'run_command', input: { command } })).toMatchObject({ risk: 'read-only', requiresApproval: false })
        }
        for (const command of ['cat ../outside', 'ls > written', 'ls; touch written', 'rg --pre=sh source.txt', 'rg -z source',
            'sed -i s/a/b/ source.txt', 'sed -n 1wout source.txt', 'echo $(touch written)', 'echo `pwd`', 'cat $FILE', 'cat *.txt',
            'cat <(pwd)', 'cat <<EOF\n$(touch written)\nEOF', 'env ls', 'sh -c ls', './ls', 'ls && pwd', 'cat "${FILE}"', 'find . -delete', "ls 'unterminated", 'cat "unterminated']) {
            expect(await inspectTool(root, { name: 'run_command', input: { command } })).toMatchObject({ requiresApproval: true })
        }
    } finally { await rm(root, { recursive: true, force: true }) }
})

it('does not auto-approve an escaped symlink target or a workspace executable shadowing PATH', async () => {
    const root = await mkdtemp(join(tmpdir(), 'quifox-path-policy-'))
    const outside = await mkdtemp(join(tmpdir(), 'quifox-outside-policy-'))
    const initialPath = process.env.PATH ?? ''
    try {
        await writeFile(join(outside, 'secret'), 'outside')
        await symlink(join(outside, 'secret'), join(root, 'linked'))
        expect(await inspectTool(root, { name: 'run_command', input: { command: 'cat linked' } })).toMatchObject({ requiresApproval: true })
        await writeFile(join(root, 'ls'), '#!/bin/sh\nexit 0\n', { mode: 0o755 })
        vi.stubEnv('PATH', root + ':' + initialPath)
        expect(await inspectTool(root, { name: 'run_command', input: { command: 'ls' } })).toMatchObject({ requiresApproval: true })
        await mkdir(join(root, 'tools'))
        await writeFile(join(root, 'tools', 'ls'), '#!/bin/sh\nexit 0\n', { mode: 0o755 })
        vi.stubEnv('PATH', 'tools:' + initialPath)
        expect(await inspectTool(root, { name: 'run_command', input: { command: 'ls' } })).toMatchObject({ requiresApproval: true })
    } finally { vi.unstubAllEnvs(); await rm(root, { recursive: true, force: true }); await rm(outside, { recursive: true, force: true }) }
})
