import { mkdir, lstat, readdir, open } from 'node:fs/promises'
import { constants } from 'node:fs'
import { join } from 'node:path'
import { inspectWorkflow, type WorkflowInspection } from './workflow.js'
import { writeAtomic } from './config.js'
import { withFileLease } from './leases.js'

export interface WorkflowDocument { name: string; script: string; inspection: WorkflowInspection }
export class WorkflowLibrary {
    readonly directory: string
    constructor(root: string) { this.directory = join(root, 'workflows') }
    private path(name: string): string {
        if (!/^[A-Za-z0-9_-]{1,64}$/.test(name)) throw new Error('工作流名称只能包含字母、数字、短横线和下划线。')
        return join(this.directory, name + '.ts')
    }
    private async prepare(): Promise<void> {
        await mkdir(this.directory, { recursive: true, mode: 0o700 })
        const status = await lstat(this.directory)
        if (status.isSymbolicLink() || !status.isDirectory()) throw new Error('工作流目录不能是符号链接。')
    }
    async list(): Promise<{ name: string }[]> {
        await this.prepare()
        return (await readdir(this.directory, { withFileTypes: true })).filter(file => file.isFile() && /^[A-Za-z0-9_-]{1,64}\.ts$/.test(file.name)).slice(0, 200).map(file => ({ name: file.name.slice(0, -3) })).sort((a, b) => a.name.localeCompare(b.name))
    }
    async read(name: string): Promise<WorkflowDocument> {
        await this.prepare()
        const handle = await open(this.path(name), constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0))
        try {
            const status = await handle.stat()
            if (!status.isFile() || status.size > 200000) throw new Error('工作流文件无效或超过 200 KB。')
            const script = await handle.readFile('utf8')
            return { name, script, inspection: inspectWorkflow(script) }
        } finally { await handle.close() }
    }
    async save(name: string, script: string): Promise<WorkflowDocument> {
        const inspection = inspectWorkflow(script)
        if (!inspection.ok) throw new Error('请修复工作流诊断后再保存。')
        await this.prepare()
        const path = this.path(name)
        await withFileLease(path, async () => {
            try { if ((await lstat(path)).isSymbolicLink()) throw new Error('工作流文件不能是符号链接。') } catch (cause) { if ((cause as NodeJS.ErrnoException).code !== 'ENOENT') throw cause }
            await writeAtomic(path, script)
        })
        return { name, script, inspection }
    }
}
