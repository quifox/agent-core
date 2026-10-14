import { open, readdir, stat } from 'node:fs/promises'
import { basename, dirname, extname, isAbsolute, relative, resolve, sep } from 'node:path'
import { canonicalPath } from './native-tools.js'
import type { ProjectFile, ProjectListing } from './protocol.js'

export async function projectTarget(workspace: string, path: string): Promise<{ workspace: string; path: string; relativePath: string }> {
    const root = await canonicalPath(workspace), target = await canonicalPath(resolve(root, path))
    const distance = relative(root, target)
    const outside = isAbsolute(distance) || distance === '..' || distance.startsWith(`..${sep}`)
    return { workspace: outside ? dirname(target) : root, path: target, relativePath: outside ? basename(target) : distance.split(sep).join('/') || '.' }
}

export async function projectList(workspace: string, path = '.'): Promise<ProjectListing> {
    const target = await projectTarget(workspace, path)
    const entries = (await readdir(target.path, { withFileTypes: true })).filter(item => !['.git', 'node_modules', 'target', '.quifox'].includes(item.name))
    entries.sort((a, b) => Number(b.isDirectory()) - Number(a.isDirectory()) || a.name.localeCompare(b.name))
    return { path: target.relativePath, entries: entries.slice(0, 1000).map(item => ({ name: item.name, kind: item.isDirectory() ? 'directory' : item.isSymbolicLink() ? 'symlink' : 'file' })), truncated: entries.length > 1000 }
}

export async function projectRead(workspace: string, path: string): Promise<ProjectFile> {
    const target = await projectTarget(workspace, path), info = await stat(target.path)
    if (!info.isFile()) throw new Error('请选择文件。')
    const extension = extname(target.path).toLowerCase()
    const kind = ['.png', '.jpg', '.jpeg', '.gif', '.webp', '.avif', '.bmp', '.svg'].includes(extension) ? 'image' :
        ['.mp4', '.webm', '.mov', '.m4v', '.ogv'].includes(extension) ? 'video' : 'text'
    const base = { ...target, bytes: info.size, kind, truncated: false } as ProjectFile
    if (kind !== 'text') return base
    const handle = await open(target.path, 'r')
    try {
        const buffer = Buffer.alloc(1_000_001), { bytesRead } = await handle.read(buffer)
        const content = buffer.subarray(0, Math.min(bytesRead, 1_000_000))
        return { ...base, kind: content.includes(0) ? 'binary' : 'text', content: content.includes(0) ? undefined : content.toString('utf8'), truncated: bytesRead > 1_000_000 }
    } finally { await handle.close() }
}

export async function projectSearch(workspace: string, query: string): Promise<{ paths: string[]; truncated: boolean }> {
    const root = (await projectTarget(workspace, '.')).workspace, needle = query.toLowerCase().trim()
    if (!needle) return { paths: [], truncated: false }
    const paths: string[] = [], pending = ['.']
    let visited = 0, truncated = false
    while (pending.length && visited < 10_000 && paths.length < 500) {
        const directory = pending.pop()!
        const listing = await projectList(root, directory)
        truncated ||= listing.truncated
        for (const item of listing.entries) {
            visited += 1
            if (visited > 10_000 || paths.length >= 500) { truncated = true; break }
            const path = directory === '.' ? item.name : `${directory}/${item.name}`
            if (item.kind === 'directory') {
                if (path.split('/').length < 32) pending.push(path); else truncated = true
            } else if (item.kind === 'file' && path.toLowerCase().includes(needle)) paths.push(path)
        }
    }
    return { paths: paths.sort(), truncated: truncated || pending.length > 0 }
}
