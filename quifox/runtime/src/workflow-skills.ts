import type { ProjectFiles } from '@quifox/agent-plugin-project-context'
import { workflowResources, langchainResources } from './workflow-skill.generated.js'
export { workflowResources } from './workflow-skill.generated.js'

export const workflowSkillRoot = 'quifox-plugin-skills'
export function workflowSkillFiles(files: ProjectFiles, plugins: unknown, enabled = { workflows: true, langchain: false }): ProjectFiles {
    const resources = { ...enabled.langchain ? langchainResources : {}, ...enabled.workflows ? Object.fromEntries(Object.entries(workflowResources).map(([path, content]) => ['typescript-workflows/' + path, content])) : {} }
    return {
        list: (root, path) => root === workflowSkillRoot ? Promise.resolve(path ? [] : Object.keys(resources).filter(path => path.endsWith('/SKILL.md')).map(path => path.slice(0, -9))) : files.list(root, path),
        metadata: (root, path) => root === workflowSkillRoot ? Promise.resolve(resources[path]?.split('---')[1]) : files.metadata(root, path),
        read: (root, path) => root === workflowSkillRoot ? Promise.resolve(enabled.workflows && path === 'typescript-workflows/plugins.md' ? '# Enabled business plugins\n\n' + JSON.stringify(plugins, null, 2) : resources[path]) : files.read(root, path)
    }
}
