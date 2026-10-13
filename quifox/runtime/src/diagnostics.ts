import { appendFile, mkdir, rename, stat } from 'node:fs/promises'
import { join } from 'node:path'
import { isMissing } from './config.js'

/** Local diagnostics contain no prompts or command arguments and never enter public snapshots. */
export class DiagnosticLog {
    private queue = Promise.resolve()
    constructor(private readonly root: string) {}
    write(action: string, error: unknown): Promise<void> {
        const work = this.queue.catch(() => {}).then(async () => {
            const directory = join(this.root, 'logs'), path = join(directory, `runtime-${process.pid}.log`)
            await mkdir(directory, { recursive: true, mode: 0o700 })
            try { if ((await stat(path)).size > 10_000_000) await rename(path, `${path}.previous`) } catch (cause) { if (!isMissing(cause)) throw cause }
            await appendFile(path, `${JSON.stringify({ time: new Date().toISOString(), action, error })}\n`, { mode: 0o600 })
        })
        this.queue = work
        return work
    }
}
