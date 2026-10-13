import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import { open, realpath } from 'node:fs/promises'
import { isAbsolute, relative, resolve, sep } from 'node:path'
import type { ToolResult } from '@quifox/agent-core'
import type { FileChange } from './tool-presentation.js'

const execute = promisify(execFile), limit = 100
interface Observation { root: string; workspace: string; head?: string; files: Map<string, string | null | undefined>; truncated: boolean }
async function git(cwd: string, args: string[]): Promise<string> { return (await execute('git', args, { cwd, encoding: 'utf8', maxBuffer: 1_000_000, timeout: 5000, windowsHide: true })).stdout }
function inside(workspace: string, path: string): boolean { const distance = relative(workspace, path); return !isAbsolute(distance) && distance !== '..' && !distance.startsWith(`..${sep}`) }
async function content(path: string, workspace: string): Promise<string | null | undefined> {
    try {
        if (!inside(workspace, await realpath(path))) return undefined
        const handle = await open(path, 'r')
        try { const buffer = Buffer.alloc(1_000_001), { bytesRead } = await handle.read(buffer); const file = buffer.subarray(0, bytesRead); return bytesRead > 1_000_000 || file.includes(0) ? undefined : file.toString('utf8') }
        finally { await handle.close() }
    }
    catch (cause) { if ((cause as NodeJS.ErrnoException).code === 'ENOENT') return null; throw cause }
}
async function observe(workspace: string): Promise<Observation | undefined> {
    try {
        const root = (await git(workspace, ['rev-parse', '--show-toplevel'])).trim(), realWorkspace = await realpath(workspace)
        const entries = (await git(root, ['status', '--porcelain=v1', '-z', '--untracked-files=all'])).split('\0')
        const paths: string[] = []
        for (let index = 0; index < entries.length; index += 1) {
            const entry = entries[index]!
            if (entry.length < 4) continue
            const path = entry.slice(3)
            if (inside(realWorkspace, resolve(root, path))) paths.push(path)
            if (/[RC]/.test(entry.slice(0, 2))) index += 1
        }
        const files = new Map<string, string | null | undefined>()
        for (const path of paths.slice(0, limit)) files.set(path, await content(resolve(root, path), realWorkspace))
        let head: string | undefined
        try { head = (await git(root, ['rev-parse', '--verify', 'HEAD'])).trim() } catch { /* An uncommitted repository has no clean tracked baseline. */ }
        return { root, workspace: realWorkspace, files, ...(head ? { head } : {}), truncated: paths.length > limit || [...files.values()].includes(undefined) }
    } catch { return undefined }
}

/** Observe repository content around an actual command; unrelated preexisting edits are subtracted. */
export async function withGitChanges(workspace: string, operation: () => Promise<ToolResult>): Promise<ToolResult> {
    const before = await observe(workspace), result = await operation()
    if (!before) return result
    const after = await observe(workspace)
    if (!after || before.root !== after.root) return result
    const paths = new Set([...before.files.keys(), ...after.files.keys()]), changes: FileChange[] = []
    for (const path of [...paths].slice(0, limit)) {
        let original = before.files.get(path)
        if (original === undefined && before.files.has(path)) continue
        if (original === undefined) { try { original = before.head ? await git(before.root, ['show', `${before.head}:${path}`]) : null } catch { original = null } }
        if (original?.includes('\0')) continue
        let current: string | null | undefined
        try { current = after.files.has(path) ? after.files.get(path) : await content(resolve(after.root, path), after.workspace) } catch { continue }
        if (current === undefined) continue
        if (original === current) continue
        const absolute = resolve(after.root, path)
        changes.push({ path: absolute, before: original?.slice(0, 200_000) ?? null, after: current?.slice(0, 200_000) ?? null,
            ...((original?.length ?? 0) > 200_000 || (current?.length ?? 0) > 200_000 ? { truncated: true } : {}) })
    }
    result.data = { ...(result.data && typeof result.data === 'object' ? result.data : {}), changes,
        ...((before.truncated || after.truncated || paths.size > limit) ? { changedFilesTruncated: true } : {}) }
    return result
}
