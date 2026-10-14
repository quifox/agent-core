import { createReadStream } from 'node:fs'
import { readFile, readdir, realpath, stat } from 'node:fs/promises'
import { createInterface } from 'node:readline'
import { isAbsolute, join, relative, resolve, sep } from 'node:path'
import { homedir } from 'node:os'
import { isResourcePath, type ProjectFiles } from '@quifox/agent-plugin-project-context'
import { isMissing } from './config.js'
import { ancestorDirectories } from './config.js'

interface FileRoot { path: string; kind: 'skills' | 'scope' }

function displayDirectory(directory: string): string {
    const distance = relative(homedir(), directory)
    return (!distance ? '~' : !isAbsolute(distance) && distance !== '..' && !distance.startsWith(`..${sep}`) ? `~/${distance}` : directory).replace(/\\/g, '/')
}

/** Uses declared sources and real skill roots; symlink resources cannot escape their skill. */
export class HostProjectFiles implements ProjectFiles {
    constructor(private readonly roots: ReadonlyMap<string, FileRoot>) {}

    private root(id: string): FileRoot {
        const root = this.roots.get(id)
        if (!root) throw new Error('Unknown project file root.')
        return root
    }

    sourcePath(id: string, path: string): string { return resolve(this.root(id).path, path) }

    private async path(id: string, path: string): Promise<string> {
        if (!isResourcePath(path)) throw new Error('Invalid project resource path.')
        const root = this.root(id)
        const segments = path.split('/')
        const boundary = await realpath(root.kind === 'skills' ? join(root.path, segments[0]!) : root.path)
        const candidate = await realpath(join(root.path, ...segments))
        const distance = relative(boundary, candidate)
        if (isAbsolute(distance) || distance === '..' || distance.startsWith(`..${sep}`)) throw new Error('Resource is outside its declared root.')
        return candidate
    }

    async list(root: string, path: string): Promise<string[]> {
        const source = this.root(root)
        let directory = source.path
        if (path) directory = await this.path(root, path)
        let entries
        try { entries = await readdir(directory, { withFileTypes: true }) } catch (error) { if (isMissing(error)) return []; throw error }
        const directories: string[] = []
        for (const entry of entries) {
            if (entry.isDirectory()) directories.push(entry.name)
            else if (entry.isSymbolicLink()) {
                try { if ((await stat(join(directory, entry.name))).isDirectory()) directories.push(entry.name) }
                catch (error) { if (!isMissing(error)) throw error }
            }
        }
        return directories.sort()
    }

    async read(root: string, path: string): Promise<string | undefined> {
        try { return await readFile(await this.path(root, path), 'utf8') } catch (error) { if (isMissing(error)) return undefined; throw error }
    }

    async metadata(root: string, path: string): Promise<string | undefined> {
        let file: string
        try { file = await this.path(root, path) } catch (error) { if (isMissing(error)) return undefined; throw error }
        const stream = createReadStream(file, { encoding: 'utf8', highWaterMark: 256 })
        const reader = createInterface({ input: stream, crlfDelay: Infinity })
        let readError: Error | undefined
        stream.on('error', error => { readError = error; reader.close() })
        let started = false
        const lines: string[] = []
        let bytes = 0
        try {
            for await (const raw of reader) {
                const line = raw.replace(/^\uFEFF/, '')
                if (!started) { if (line.trim() !== '---') return ''; started = true; continue }
                if (line.trim() === '---') return lines.join('\n')
                bytes += Buffer.byteLength(line)
                if (bytes > 8192) return ''
                lines.push(line)
            }
            if (readError) throw readError
            return ''
        } finally { reader.close(); stream.destroy() }
    }
}

/** Resolve the full root-to-cwd ancestor chain, without loading sibling instructions. */
export async function createProjectFiles(workspace: string, applicationRoot: string, globalSkillsRoot = join(homedir(), '.agents', 'skills')) {
    const cwd = await realpath(resolve(workspace))
    if (!(await stat(cwd)).isDirectory()) throw new Error('Workspace must be a directory.')
    const ancestors = ancestorDirectories(cwd)
    const mapping = new Map<string, FileRoot>()
    const globalScope = displayDirectory(resolve(applicationRoot))
    mapping.set(globalScope, { path: applicationRoot, kind: 'scope' })
    mapping.set('global-skills', { path: join(applicationRoot, 'skills'), kind: 'skills' })
    mapping.set('standard-global-skills', { path: globalSkillsRoot, kind: 'skills' })
    const scopes = [globalScope]
    const roots = ['global-skills', 'standard-global-skills']
    for (const [index, directory] of ancestors.entries()) {
        const scope = displayDirectory(directory)
        const skills = `project-skills-${index}`
        mapping.set(scope, { path: directory, kind: 'scope' })
        mapping.set(skills, { path: join(directory, '.agents', 'skills'), kind: 'skills' })
        if (directory !== resolve(applicationRoot)) scopes.push(scope)
        for (const format of ['.claude', '.quifox']) {
            const id = `project-${format.slice(1)}-skills-${index}`
            mapping.set(id, { path: join(directory, format, 'skills'), kind: 'skills' }); roots.push(id)
        }
        roots.push(skills)
    }
    const seen = new Set<string>()
    const uniqueRoots = roots.filter(root => {
        const directory = resolve(mapping.get(root)!.path)
        if (seen.has(directory)) return false
        seen.add(directory); return true
    })
    return { files: new HostProjectFiles(mapping), scopes, roots: uniqueRoots, workspace: cwd }
}
