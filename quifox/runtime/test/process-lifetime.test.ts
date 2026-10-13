import { expect, it } from 'vitest'
import { execFileSync, spawn, type ChildProcess } from 'node:child_process'
import { readFile, stat } from 'node:fs/promises'
import { once } from 'node:events'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { synthetic } from './synthetic.js'

async function stopSupervisor(worker: ChildProcess): Promise<void> {
    if (worker.exitCode !== null || worker.signalCode !== null) return
    const exited = once(worker, 'exit')
    worker.stdin?.end()
    if (process.platform !== 'win32') worker.kill('SIGTERM')
    const force = setTimeout(() => { worker.kill('SIGKILL') }, 2000)
    try { await exited } finally { clearTimeout(force) }
}

it('ends a command process when its supervising Host is killed, without letting the delayed write run', async () => {
    const fixture = await synthetic(() => ({ text: 'unused' }))
    const command = `"${process.execPath}" -e "require('node:fs').writeFileSync('owned.pid',String(process.pid));setTimeout(()=>require('node:fs').writeFileSync('late.txt','unexpected'),1800)"`
    const worker = spawn('bun', ['-e', 'const {runCommand}=await import(process.env.QUIFOX_TEST_SOURCE);await runCommand(process.env.QUIFOX_TEST_COMMAND,process.env.QUIFOX_TEST_ROOT)'],
        { env: { ...process.env, QUIFOX_TEST_SOURCE: new URL('../src/native-tools.ts', import.meta.url).href, QUIFOX_TEST_COMMAND: command, QUIFOX_TEST_ROOT: fixture.root }, stdio: 'ignore' })
    let commandPid: number | undefined
    try {
        await expect.poll(async () => Number(await readFile(join(fixture.root, 'owned.pid'), 'utf8'))).toBeGreaterThan(0)
        commandPid = Number(await readFile(join(fixture.root, 'owned.pid'), 'utf8'))
        const exited = once(worker, 'exit'); worker.kill('SIGKILL'); await exited
        await expect.poll(() => { try { process.kill(commandPid!, 0); return true } catch { return false } }, { timeout: 1600 }).toBe(false)
        await new Promise(resolve => setTimeout(resolve, 1900))
        await expect(stat(join(fixture.root, 'late.txt'))).rejects.toMatchObject({ code: 'ENOENT' })
    } finally {
        if (worker.exitCode === null && worker.signalCode === null) worker.kill('SIGKILL')
        if (commandPid) { try { process.kill(commandPid, 'SIGKILL') } catch { /* Only this test's process was eligible for cleanup. */ } }
        await fixture.close()
    }
})

it('dispatches a compiled supervisor once and never restarts its command after pipe EOF', async () => {
    const fixture = await synthetic(() => ({ text: 'unused' }))
    const binary = join(fixture.root, 'quifox-engine-test')
    const source = fileURLToPath(new URL('../src/sidecar.ts', import.meta.url))
    try {
        execFileSync('bun', ['build', source, '--compile', '--outfile', binary], { stdio: 'ignore' })
        if (process.platform === 'darwin') execFileSync('/usr/bin/codesign', ['--force', '--sign', '-', binary], { stdio: 'ignore' })
    } catch (error) { await fixture.close(); throw error }
    const environment: NodeJS.ProcessEnv = { ...process.env, QUIFOX_ROOT: fixture.root, QUIFOX_WORKSPACE: fixture.root }
    delete environment.MODEL_API_KEY; delete environment.MODEL_BASE_URL; delete environment.MODEL_ID
    // Production first starts this compiled Host, then reuses its executable for command supervision.
    const host = spawn(binary, ['--root', fixture.root, '--workspace', fixture.root], { env: environment, stdio: ['pipe', 'pipe', 'pipe'] })
    let hostOutput = '', hostError = ''
    host.stdout.on('data', chunk => { hostOutput += chunk.toString() })
    host.stderr.on('data', chunk => { hostError += chunk.toString() })
    try {
        await expect.poll(() => {
            if (host.exitCode !== null || host.signalCode !== null) throw new Error(`Compiled Host exited: ${host.exitCode}/${host.signalCode}: ${hostError}`)
            return hostOutput.includes('"kind":"ready"')
        }, { timeout: 7000 }).toBe(true)
    } catch (error) {
        if (host.exitCode === null && host.signalCode === null) { const exited = once(host, 'exit'); host.kill('SIGKILL'); await exited }
        await fixture.close(); throw error
    }
    const command = `"${process.execPath}" -e "const fs=require('node:fs');fs.appendFileSync('starts.txt',process.pid+'\\n');setTimeout(()=>fs.writeFileSync('late.txt','unexpected'),1800)"`
    const worker = spawn(binary, ['--quifox-supervisor', JSON.stringify({ command, cwd: fixture.root })], { env: environment, stdio: ['pipe', 'pipe', 'pipe'] })
    let stderr = '', stdout = ''
    worker.stderr.on('data', chunk => { stderr += chunk.toString() })
    worker.stdout.on('data', chunk => { stdout += chunk.toString() })
    let commandPid: number | undefined
    try {
        await expect.poll(async () => {
            if (worker.exitCode !== null || worker.signalCode !== null) throw new Error(`Compiled supervisor exited: ${worker.exitCode}/${worker.signalCode}: ${stderr}`)
            if (stdout.includes('"kind":"ready"')) throw new Error('Compiled supervisor incorrectly entered Host mode.')
            return Number((await readFile(join(fixture.root, 'starts.txt'), 'utf8')).trim())
        }, { timeout: 3000 }).toBeGreaterThan(0).catch(error => { throw new Error(`Compiled supervisor startup failed: ${stderr}`, { cause: error }) })
        commandPid = Number((await readFile(join(fixture.root, 'starts.txt'), 'utf8')).trim())
        const exited = once(worker, 'exit'); worker.stdin.end(); await exited
        expect((await readFile(join(fixture.root, 'starts.txt'), 'utf8')).trim().split('\n')).toHaveLength(1)
        await expect(stat(join(fixture.root, 'late.txt'))).rejects.toMatchObject({ code: 'ENOENT' })
    } finally {
        await stopSupervisor(worker)
        if (commandPid) { try { process.kill(commandPid, 'SIGKILL') } catch { /* Only this test's process was eligible for cleanup. */ } }
        if (host.exitCode === null && host.signalCode === null) { const exited = once(host, 'exit'); host.stdin.end(); await exited }
        await fixture.close()
    }
}, 10000)

it('cleans a supervisor command group without relying on a startup PID file', async () => {
    const fixture = await synthetic(() => ({ text: 'unused' }))
    const source = fileURLToPath(new URL('../src/process-supervisor-entry.ts', import.meta.url))
    const command = `"${process.execPath}" -e "process.stdout.write(String(process.pid));setInterval(()=>{},1000)"`
    const worker = spawn('bun', [source, '--quifox-supervisor', JSON.stringify({ command, cwd: fixture.root })],
        { env: { ...process.env, QUIFOX_ROOT: fixture.root, QUIFOX_WORKSPACE: fixture.root }, stdio: ['pipe', 'pipe', 'pipe'] })
    let output = '', commandPid: number | undefined
    worker.stdout.on('data', chunk => { output += chunk.toString() })
    try {
        await expect.poll(() => Number(output.trim())).toBeGreaterThan(0)
        commandPid = Number(output.trim())
        await stopSupervisor(worker)
        await expect.poll(() => { try { process.kill(commandPid!, 0); return true } catch { return false } }).toBe(false)
    } finally {
        await stopSupervisor(worker)
        if (commandPid) { try { process.kill(commandPid, 'SIGKILL') } catch { /* Only this test's process was eligible for cleanup. */ } }
        await fixture.close()
    }
})
