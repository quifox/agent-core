import { parseDocument } from 'yaml'
import { z } from 'zod'
import { defineTool, toolError, toolSuccess, type AgentContext, type AgentHooks, type AgentPlugin, type ToolResult } from '@quifox/agent-core'

/** Host reads are confined to declared roots, including real-path/symlink validation. */
export interface ProjectFiles {
    sourcePath(root: string, path: string): string
    list(root: string, path: string): Promise<string[]>
    /** Read only the YAML frontmatter, excluding delimiter lines and the Markdown body. */
    metadata(root: string, path: string): Promise<string | undefined>
    read(root: string, path: string): Promise<string | undefined>
}

export interface ContextWriter { set(key: string, content: string): void }
export interface SkillEntry { id: string; root: string; directory: string; name: string; description: string; path: string }
export interface SkillCatalog { skills: SkillEntry[]; issues: { root: string; directory: string; message: string }[] }
export interface SkillsPluginOptions {
    files: ProjectFiles
    roots: readonly string[]
    context(ctx: AgentContext): ContextWriter
    /** Explicit user selections resolved by the Host for this input. */
    selected?(input: unknown, ctx: AgentContext): readonly string[]
    disabled?: readonly string[]
}

const metadataSchema = z.object({
    name: z.string().min(1).max(64).regex(/^[a-z0-9]+(?:-[a-z0-9]+)*$/),
    description: z.string().min(1).max(1024).refine(value => !!value.trim()),
    license: z.string().optional(), compatibility: z.string().min(1).max(500).optional(),
    metadata: z.record(z.string(), z.string()).optional(), 'allowed-tools': z.string().optional()
})

/** Reject portable path escapes before any Host file access. */
export function isResourcePath(path: string): boolean {
    return !!path && !/[\\:%]/.test(path) && ![...path].some(character => character.charCodeAt(0) < 32) && !path.startsWith('/') &&
        path.split('/').every(part => !!part && part !== '.' && part !== '..')
}

/** Metadata is visible initially; full instructions and resources are explicitly loaded. */
export class SkillsPlugin implements AgentPlugin {
    id = 'skills'
    readonly hooks: AgentHooks
    private discovered: Promise<SkillCatalog> | undefined
    private readonly loaded = new WeakMap<AgentContext, Set<string>>()
    private readonly selected = new WeakMap<AgentContext, readonly string[]>()

    constructor(private readonly options: SkillsPluginOptions) {
        const policy = { sideEffect: 'none', approval: 'none', retrySafe: true } as const
        const list = defineTool({ name: 'skill_list', description: 'Rescan available skills and return metadata, readable SKILL.md paths and discovery issues.', inputSchema: z.object({}).strict(), policy,
            execute: async () => { const catalog = await this.catalog(true); return toolSuccess(JSON.stringify(catalog), catalog) } })
        this.hooks = {
            onInitialize: async ctx => { ctx.tools.register(list) },
            onRunStart: async (ctx, input) => {
                this.selected.set(ctx, this.options.selected?.(input, ctx) ?? [])
                return { action: 'continue' }
            },
            beforeModel: async ctx => {
                const catalog = await this.catalog()
                this.options.context(ctx).set('skills', `Available skills with SKILL.md paths. ${ctx.tools.get('run_command') ? 'Read the relevant file before applying a skill; resolve references relative to its directory. Use run_command for file reads and scripts, under its normal permissions. ' : ''}${ctx.tools.get('skill_list') ? 'Use skill_list to rescan changed skills. ' : ''}\n${JSON.stringify(catalog)}`)
                for (const [index, name] of (this.selected.get(ctx) ?? []).entries()) {
                    const result = await this.load(ctx, name)
                    if (result.status !== 'success') throw new Error('Explicitly selected skill is unavailable or ambiguous.')
                    this.options.context(ctx).set(`selected-skill:${index}`, result.content)
                }
                return { action: 'continue' }
            }
        }
    }

    /** Discover only metadata; infrastructure failures remain visible and can be retried. */
    catalog(refresh = false): Promise<SkillCatalog> {
        if (refresh) this.discovered = undefined
        if (!this.discovered) {
            const pending: Promise<SkillCatalog> = this.discover().catch(error => { if (this.discovered === pending) this.discovered = undefined; throw error })
            this.discovered = pending
        }
        return this.discovered
    }

    /** Load full instructions for this Agent, without running any included script. */
    async load(ctx: AgentContext, name: string): Promise<ToolResult> {
        const skill = await this.find(name)
        if (!skill) return toolError('Skill is missing; use its catalog identity.', { code: 'SKILL_NOT_FOUND' })
        const content = await this.options.files.read(skill.root, `${skill.directory}/SKILL.md`)
        if (content === undefined) return toolError('Skill instructions are unavailable.', { code: 'SKILL_NOT_FOUND' })
        let loaded = this.loaded.get(ctx)
        if (!loaded) { loaded = new Set(); this.loaded.set(ctx, loaded) }
        loaded.add(skill.id)
        return toolSuccess(content, { skill: skill.id, root: skill.root, path: `${skill.directory}/SKILL.md` })
    }

    /** Read only within the selected skill directory, after its instructions were loaded. */
    async read(ctx: AgentContext, name: string, path: string): Promise<ToolResult> {
        if (!isResourcePath(path)) return toolError('Skill resource path is invalid.', { code: 'SKILL_PATH_INVALID' })
        const skill = await this.find(name)
        if (!skill || !this.loaded.get(ctx)?.has(skill.id)) return toolError('Load the skill before reading its resources.', { code: 'SKILL_NOT_LOADED' })
        const content = await this.options.files.read(skill.root, `${skill.directory}/${path}`)
        return content === undefined ? toolError('Skill resource does not exist.', { code: 'SKILL_NOT_FOUND' }) :
            toolSuccess(content, { skill: skill.id, root: skill.root, path: `${skill.directory}/${path}` })
    }

    private async find(name: string): Promise<SkillEntry | undefined> {
        const skills = (await this.catalog()).skills
        const exact = skills.find(skill => skill.id === name)
        if (exact) return exact
        const matches = skills.filter(skill => skill.name === name)
        return matches.at(-1)
    }

    private async discover(): Promise<SkillCatalog> {
        const catalog: SkillCatalog = { skills: [], issues: [] }
        const disabled = new Set(this.options.disabled ?? [])
        for (const root of this.options.roots) {
            for (const directory of await this.options.files.list(root, '')) {
                if (!isResourcePath(directory) || directory.includes('/')) {
                    catalog.issues.push({ root, directory, message: 'Invalid skill directory.' }); continue
                }
                if (disabled.has(`${root}/${directory}`)) continue
                const header = await this.options.files.metadata(root, `${directory}/SKILL.md`)
                if (header === undefined) continue
                try {
                    const document = parseDocument(header, { uniqueKeys: true })
                    if (document.errors.length || document.warnings.length) throw new Error('Invalid YAML metadata.')
                    const metadata = metadataSchema.parse(document.toJS({ maxAliasCount: 10 }))
                    if (metadata.name !== directory) throw new Error('Skill name must match its directory.')
                    const path = `${directory}/SKILL.md`
                    catalog.skills.push({ id: `${root}/${directory}`, root, directory, name: metadata.name, description: metadata.description,
                        path: this.options.files.sourcePath(root, path) })
                } catch { catalog.issues.push({ root, directory, message: 'Invalid SKILL.md metadata.' }) }
            }
        }
        return catalog
    }
}

export interface GuidanceEntry { root: string; path: 'AGENTS.override.md' | 'AGENTS.md'; content: string }
export interface ProjectGuidancePluginOptions {
    files: ProjectFiles
    /** Trusted Host scopes, ordered from global/root to the current directory. */
    scopes: readonly string[]
    context(ctx: AgentContext): ContextWriter
}

/** Scoped guidance contributes to requests without becoming a second transcript owner. */
export class ProjectGuidancePlugin implements AgentPlugin {
    id = 'project-guidance'
    readonly hooks: AgentHooks
    sources: readonly GuidanceEntry[] = []

    constructor(private readonly options: ProjectGuidancePluginOptions) {
        this.hooks = { beforeModel: async ctx => {
            this.sources = await this.load()
            this.options.context(ctx).set('project-guidance', this.sources.map(entry =>
                `## ${entry.root.replace(/\/$/, '')}/${entry.path}\n${entry.content}`).join('\n\n'))
            return { action: 'continue' }
        } }
    }

    /** Read only the declared ancestor scopes; a nonempty override wins at its level. */
    async load(): Promise<GuidanceEntry[]> {
        const entries: GuidanceEntry[] = []
        for (const root of this.options.scopes) {
            const override = await this.options.files.read(root, 'AGENTS.override.md')
            if (override?.trim()) { entries.push({ root, path: 'AGENTS.override.md', content: override }); continue }
            const content = await this.options.files.read(root, 'AGENTS.md')
            if (content?.trim()) entries.push({ root, path: 'AGENTS.md', content })
        }
        return entries
    }
}
