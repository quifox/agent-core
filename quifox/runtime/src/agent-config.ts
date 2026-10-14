import { readFile, readdir, realpath, stat } from 'node:fs/promises'
import { isAbsolute, join, relative, sep } from 'node:path'
import { parseDocument } from 'yaml'
import { z } from 'zod'
import { ancestorDirectories, isMissing, reasoningEffortSchema } from './config.js'

const names = z.union([z.array(z.string().min(1)), z.string().transform(value => value.split(',').map(name => name.trim()).filter(Boolean))])
const definition = z.object({ name: z.string().regex(/^[a-z0-9]+(?:-[a-z0-9]+)*$/), description: z.string().min(1), model: z.string().min(1).optional(),
    tools: names.optional(), disallowedTools: names.optional(), effort: reasoningEffortSchema.optional(),
    permissionMode: z.enum(['default', 'plan', 'dontAsk']).optional() }).strict()
export interface AgentDefinition extends z.infer<typeof definition> { source: string; instructions: string }
export interface AgentCatalog { agents: AgentDefinition[]; issues: { source: string; message: string }[] }

/** Closest named definition wins; CC frontmatter compatibility is intentionally limited to these fields. */
export async function agentCatalog(workspace: string, applicationRoot: string): Promise<AgentCatalog> {
    const directories = [join(applicationRoot, 'agents'), ...ancestorDirectories(await realpath(workspace)).flatMap(root => [join(root, '.claude', 'agents'), join(root, '.quifox', 'agents')])]
    const agents = new Map<string, AgentDefinition>(), issues: AgentCatalog['issues'] = []
    for (const directory of [...new Set(directories)]) {
        let entries: string[]
        try { entries = await readdir(directory) } catch (error) { if (isMissing(error)) continue; throw error }
        for (const file of entries.filter(name => /^[A-Za-z0-9_-]+\.md$/.test(name)).sort()) {
            const source = join(directory, file)
            try {
                const distance = relative(await realpath(directory), await realpath(source))
                if (isAbsolute(distance) || distance === '..' || distance.startsWith(`..${sep}`)) throw new Error('Agent file escapes its source directory.')
                if ((await stat(source)).size > 128_000) throw new Error('Agent definition exceeds the file limit.')
                const text = await readFile(source, 'utf8'), match = /^\uFEFF?---\s*\r?\n([\s\S]*?)\r?\n---\s*(?:\r?\n|$)([\s\S]*)$/.exec(text)
                if (!match) throw new Error('Agent requires YAML frontmatter.')
                const yaml = parseDocument(match[1]!, { uniqueKeys: true })
                if (yaml.errors.length || yaml.warnings.length) throw new Error('Invalid Agent YAML.')
                const parsed = definition.parse(yaml.toJS({ maxAliasCount: 10 }))
                agents.set(parsed.name, { ...parsed, source, instructions: match[2]! })
            } catch { issues.push({ source, message: 'Agent 定义无效、越界或包含未支持字段。' }) }
        }
    }
    return { agents: [...agents.values()], issues }
}

const aliases: Record<string, string> = { Read: 'read_file', Write: 'write_file', Edit: 'apply_patch', Bash: 'run_command', Glob: 'list_files', Agent: 'subagent_start' }
export function matchesTool(pattern: string, name: string): boolean {
    const value = aliases[pattern] ?? pattern
    return value === '*' || value === name || (value.endsWith('*') && name.startsWith(value.slice(0, -1)))
}

export function toolAllowed(name: string, scopes: readonly string[][] = [], denied: readonly string[] = []): boolean {
    return scopes.every(scope => scope.some(pattern => matchesTool(pattern, name))) && !denied.some(pattern => matchesTool(pattern, name))
}
