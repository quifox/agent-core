import { isResourcePath, type ProjectFiles } from '@quifox/agent-plugin-project-context'
import { mkdir, lstat, readFile } from 'node:fs/promises'
import { join, dirname, resolve } from 'node:path'
import { writeAtomic, isMissing } from './config.js'
import { workflowResources, langchainResources } from './workflow-skill.generated.js'
import { HostProjectFiles } from './project-files.js'
export { workflowResources } from './workflow-skill.generated.js'

export const workflowSkillRoot = 'quifox-plugin-skills'
/** @param files - Project file sources. @param plugins - Enabled business plugin documentation. @param enabled - Selected bundles. @param applicationRoot - Host-owned data directory. */
export async function workflowSkillFiles(files: ProjectFiles, plugins: unknown, enabled: { workflows: boolean; langchain: boolean }, applicationRoot: string): Promise<ProjectFiles> {
    applicationRoot = resolve(applicationRoot)
    const resources = { ...enabled.langchain ? langchainResources : {}, ...enabled.workflows ? Object.fromEntries(Object.entries(workflowResources).map(([path, content]) => ['typescript-workflows/' + path, content])) : {} }
    if (enabled.workflows) resources['typescript-workflows/plugins.md'] = '# Enabled business plugins\n\n' + JSON.stringify(plugins, null, 2)
    const directory = join(applicationRoot, 'plugin-skills')
    const directories = new Set<string>()
    const ensure = async (path: string): Promise<void> => {
        if (directories.has(path)) return
        if (path !== applicationRoot) await ensure(dirname(path))
        await mkdir(path, { recursive: true, mode: 0o700 })
        if ((await lstat(path)).isSymbolicLink()) throw new Error('Plugin skill directories cannot be symbolic links.')
        directories.add(path)
    }
    await ensure(directory)
    for (const [path, content] of Object.entries(resources)) {
        if (!isResourcePath(path)) throw new Error('Invalid bundled skill resource path.')
        const target = join(directory, path)
        await ensure(dirname(target))
        try { if ((await lstat(target)).isSymbolicLink()) throw new Error('Plugin skill files cannot be symbolic links.') } catch (cause) { if (!isMissing(cause)) throw cause }
        let previous: string | undefined
        try { previous = await readFile(target, 'utf8') } catch (cause) { if (!isMissing(cause)) throw cause }
        if (previous !== content) await writeAtomic(target, content)
    }
    const materialized = new HostProjectFiles(new Map([[workflowSkillRoot, { path: directory, kind: 'skills' }]]))
    return {
        sourcePath: (root, path) => root === workflowSkillRoot ? join(directory, path) : files.sourcePath(root, path),
        list: (root, path) => root === workflowSkillRoot ? Promise.resolve(path ? [] : Object.keys(resources).filter(path => path.endsWith('/SKILL.md')).map(path => path.slice(0, -9))) : files.list(root, path),
        metadata: (root, path) => root === workflowSkillRoot ? materialized.metadata(root, path) : files.metadata(root, path),
        read: (root, path) => root === workflowSkillRoot ? resources[path] === undefined ? Promise.resolve(undefined) : materialized.read(root, path) : files.read(root, path)
    }
}
