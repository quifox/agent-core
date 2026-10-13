import { expect, it } from 'vitest'
import { spawn } from 'node:child_process'
import { once } from 'node:events'
import { mkdir, realpath } from 'node:fs/promises'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import type { EngineFrame, RuntimeSnapshot } from '../src/protocol.js'
import { synthetic } from './synthetic.js'

it.each(['cwd', 'environment', 'argument'] as const)('uses the %s launch directory instead of a saved workspace', async mode => {
    const fixture = await synthetic(() => ({ text: 'unused' }))
    const launch = join(fixture.root, 'launch project'), override = join(fixture.root, 'other project')
    await mkdir(launch); await mkdir(override)
    const environment: NodeJS.ProcessEnv = { ...process.env, QUIFOX_ROOT: fixture.root }; delete environment.QUIFOX_WORKSPACE
    if (mode !== 'cwd') environment.QUIFOX_WORKSPACE = mode === 'argument' ? launch : override
    const worker = spawn('bun', [fileURLToPath(new URL('../src/sidecar.ts', import.meta.url)), ...(mode === 'argument' ? ['--workspace', override] : [])], { cwd: launch, env: environment, stdio: ['pipe', 'pipe', 'pipe'] })
    const frames: EngineFrame[] = []; let pending = ''
    worker.stdout.on('data', chunk => {
        pending += chunk.toString(); let index: number
        while ((index = pending.indexOf('\n')) >= 0) { frames.push(JSON.parse(pending.slice(0, index)) as EngineFrame); pending = pending.slice(index + 1) }
    })
    try {
        await expect.poll(() => frames.some(frame => frame.kind === 'ready'), { timeout: 5000 }).toBe(true)
        worker.stdin.write(`${JSON.stringify({ id: 'startup', command: { type: 'snapshot' } })}\n`)
        await expect.poll(() => frames.some(frame => frame.kind === 'response' && frame.id === 'startup'), { timeout: 5000 }).toBe(true)
        const response = frames.find(frame => frame.kind === 'response' && frame.id === 'startup')!
        expect(response).toMatchObject({ ok: true })
        expect(await realpath((response as { value: RuntimeSnapshot }).value.config.workspace)).toBe(await realpath(mode === 'cwd' ? launch : override))
        expect((response as { value: RuntimeSnapshot }).value.sessions).toEqual([])
    } finally {
        const exited = worker.exitCode === null && worker.signalCode === null ? once(worker, 'exit') : undefined; worker.stdin.end(); await exited
        await fixture.close()
    }
}, 15000)
