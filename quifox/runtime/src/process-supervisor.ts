/** A small independent process owns the command group and treats Host pipe EOF as cancellation. */
export async function commandSupervisor(command: string, cwd: string): Promise<void> {
    const { spawn } = await import('node:child_process')
    await new Promise<void>((resolve, reject) => {
        const child = spawn(command, [], { cwd, shell: true, windowsHide: true, detached: process.platform !== 'win32', stdio: ['ignore', 'pipe', 'pipe'] })
        let timer: ReturnType<typeof setTimeout> | undefined
        let stopping = false
        const kill = (force: boolean): void => {
            if (!child.pid) return
            if (process.platform === 'win32') {
                const killer = spawn('taskkill', ['/pid', String(child.pid), '/T', ...(force ? ['/F'] : [])], { windowsHide: true, stdio: 'ignore' })
                killer.on('error', () => { child.kill(force ? 'SIGKILL' : 'SIGTERM') })
            } else {
                try { process.kill(-child.pid, force ? 'SIGKILL' : 'SIGTERM') }
                catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ESRCH') child.kill(force ? 'SIGKILL' : 'SIGTERM') }
            }
        }
        const stop = (): void => { if (!stopping) { stopping = true; kill(false); timer = setTimeout(() => kill(true), 1000) } }
        const output = (source: typeof child.stdout, target: NodeJS.WriteStream): void => {
            source.on('data', (chunk: Buffer) => { if (!target.write(chunk)) source.pause() })
            target.on('drain', () => source.resume())
            target.on('error', stop)
        }
        output(child.stdout, process.stdout); output(child.stderr, process.stderr)
        process.stdin.on('end', stop); process.stdin.on('error', stop); process.stdin.resume()
        process.on('SIGTERM', stop); process.on('SIGINT', stop)
        const cleanup = (): void => {
            if (timer) clearTimeout(timer)
            process.stdin.off('end', stop); process.stdin.off('error', stop); process.stdin.destroy()
            process.off('SIGTERM', stop); process.off('SIGINT', stop)
        }
        child.once('error', error => { cleanup(); reject(error) })
        child.once('close', code => { cleanup(); process.exitCode = code ?? 128; resolve() })
    })
}
