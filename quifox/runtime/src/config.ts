import { mkdir, open, readFile, rename, unlink, realpath } from 'node:fs/promises'
import { homedir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { randomUUID } from 'node:crypto'
import { z } from 'zod'
import { resolveModelLimits, resolveModelCapabilities, type ModelLimits } from '@quifox/agent-plugin-model'
import { resolveCompactionBudget } from '@quifox/agent-plugin-compaction'
import { defaultShortcuts } from './preferences.js'
import { builtinPlugins } from './plugin-catalog.js'

const positive = z.number().int().positive().max(Number.MAX_SAFE_INTEGER)
const url = z.string().url().refine(value => { const parsed = new URL(value); return ['https:', 'http:'].includes(parsed.protocol) && !parsed.username && !parsed.password }, 'Expected an HTTP URL without embedded credentials.')
export const reasoningEffortSchema = z.enum(['none', 'low', 'medium', 'high', 'xhigh', 'max'])
const shortcut = z.string().regex(/^mod\+([a-z0-9]|=|-)$/)
const shortcuts = z.object({ zoomIn: shortcut, zoomOut: shortcut, zoomReset: shortcut, newSession: shortcut }).strict()
    .refine(value => new Set(Object.values(value)).size === 4, 'Keyboard shortcuts must be unique.')
const model = z.object({ provider: z.string().min(1), model: z.string().min(1), baseUrl: url, apiKey: z.string().min(1).optional(),
    contextWindow: positive.optional(), maxInputTokens: positive.optional(), maxOutputTokens: positive,
    temperature: z.number().min(0).max(2).optional(), providerOptions: z.record(z.string(), z.unknown()).optional(),
    reasoningEffort: reasoningEffortSchema.optional(), reasoningEfforts: z.array(reasoningEffortSchema).optional() }).strict()
const mcp = z.object({ id: z.string().regex(/^[A-Za-z0-9_-]{1,20}$/), enabled: z.boolean().default(true), transport: z.enum(['stdio', 'http']),
    command: z.string().min(1).optional(), args: z.array(z.string()).default([]), url: url.optional(),
    env: z.record(z.string(), z.string()).optional(), headers: z.record(z.string(), z.string()).optional() }).strict().refine(value =>
    value.transport === 'stdio' ? !!value.command : !!value.url, 'MCP transport requires a command or URL.')

const configurationShape = z.object({
    version: z.literal(1), workspace: z.string().min(1), model,
    models: z.array(model.extend({ id: z.string().regex(/^[A-Za-z0-9_-]{1,64}$/).refine(value => value !== 'default'), label: z.string().min(1).optional() })).default([]),
    preferences: z.object({ inputMode: z.enum(['queue', 'steer']).default('queue'), theme: z.enum(['system', 'light', 'dark']).default('system'),
        fontSize: z.number().int().min(14).max(22).default(18), shortcuts: shortcuts.default(defaultShortcuts),
        uiScale: z.number().min(.8).max(1.4).default(1), reasoningEffort: reasoningEffortSchema.optional() }).default({ inputMode: 'queue', theme: 'system', uiScale: 1, fontSize: 18, shortcuts: defaultShortcuts }),
    installedPlugins: z.array(z.string().refine(value => builtinPlugins.some(plugin => plugin.id === value), 'Unknown bundled plugin.')).refine(value => new Set(value).size === value.length, 'Installed plugins must be unique.').default(builtinPlugins.map(plugin => plugin.id)),
    plugins: z.object({ skills: z.boolean().optional(), memory: z.boolean().optional(), 'project-guidance': z.boolean().optional(), 'chat-compaction': z.boolean().optional(),
        'background-tasks': z.boolean().optional(), 'host-native-tools': z.boolean().optional(), subagents: z.boolean().optional(), presentation: z.boolean().optional(), observability: z.boolean().optional() }).strict().default({}),
    trustedProjects: z.array(z.string().min(1)).default([]),
    compaction: z.object({ context: positive.optional(), compactTokens: positive.optional(), safetyTokens: z.number().int().nonnegative().default(10_240) }).strict(),
    memory: z.object({ enabled: z.boolean(), generate: z.boolean(), extractionFormat: z.enum(['json-schema', 'json-object', 'text']),
        minIdleMs: z.number().int().nonnegative().optional() }).strict(),
    skills: z.object({ disabled: z.array(z.string().min(1)).default([]) }).strict().default({ disabled: [] }),
    approval: z.enum(['ask', 'allow']), mcp: z.array(mcp)
}).strict().refine(value => new Set(value.mcp.map(server => server.id)).size === value.mcp.length, 'MCP server identities must be unique.')
    .refine(value => new Set(value.models.map(item => item.id)).size === value.models.length, 'Model profile identities must be unique.')

export type RuntimeConfig = z.infer<typeof configurationShape>
export const configSchema = configurationShape.refine(value => Buffer.byteLength(JSON.stringify(publicConfig(value))) <= 8_000_000, 'Public configuration exceeds the display budget.')
export interface RuntimePaths { root: string; config: string; sessions: string; memory: string; models: string; lock: string }

export function runtimePaths(root = join(homedir(), '.quifox')): RuntimePaths {
    root = resolve(root)
    return { root, config: join(root, 'config.json'), sessions: join(root, 'sessions'), memory: join(root, 'memory'),
        models: join(root, 'models.json'), lock: join(root, 'runtime.lock') }
}

/** Official default uses a conservative decimal 1M capacity; other model identities need their own metadata/config. */
export function defaultConfig(workspace: string): RuntimeConfig {
    return configSchema.parse({ version: 1, workspace: resolve(workspace), model: { provider: 'deepseek', model: 'deepseek-flash', baseUrl: 'https://api.deepseek.com',
        contextWindow: 1_000_000, maxOutputTokens: 16_384 }, compaction: { safetyTokens: 10_240 },
        memory: { enabled: true, generate: true, extractionFormat: 'json-object' }, skills: { disabled: [] }, approval: 'ask', mcp: [] })
}

/** Environment overrides stay in memory and are never automatically written into config.json. */
export async function loadConfig(root: string, workspace: string, environment: Record<string, string | undefined> = process.env): Promise<RuntimeConfig> {
    return configuration(root, workspace, environment, true)
}

/** Inspection may use defaults but never restores a removed configuration file. */
export async function readConfig(root: string, workspace: string, environment: Record<string, string | undefined> = process.env): Promise<RuntimeConfig> {
    return configuration(root, workspace, environment, false)
}

async function configuration(root: string, workspace: string, environment: Record<string, string | undefined>, initialize: boolean): Promise<RuntimeConfig> {
    const paths = runtimePaths(root)
    if (initialize) await mkdir(paths.root, { recursive: true, mode: 0o700 })
    let config: RuntimeConfig
    try { config = configSchema.parse(JSON.parse(await readFile(paths.config, 'utf8'))) }
    catch (error) {
        if (!isMissing(error)) throw new Error('无法读取有效的 quifox 配置。', { cause: error })
        config = defaultConfig(workspace)
        if (initialize) try {
            const handle = await open(paths.config, 'wx', 0o600)
            try { await handle.writeFile(`${JSON.stringify(config, null, 2)}\n`); await handle.sync() } finally { await handle.close() }
        } catch (createError) {
            if ((createError as NodeJS.ErrnoException).code !== 'EEXIST') throw createError
            config = configSchema.parse(JSON.parse(await readFile(paths.config, 'utf8')))
        }
    }
    if (environment.MODEL_ID && environment.MODEL_ID !== config.model.model) {
        config.model.model = environment.MODEL_ID
        delete config.model.contextWindow; delete config.model.maxInputTokens
        delete config.model.reasoningEffort; delete config.model.reasoningEfforts
    }
    if (environment.MODEL_BASE_URL) config.model.baseUrl = environment.MODEL_BASE_URL
    if (environment.MODEL_API_KEY) config.model.apiKey = environment.MODEL_API_KEY
    return configSchema.parse(config)
}

export async function saveConfig(root: string, config: RuntimeConfig): Promise<void> {
    const next = configSchema.parse(config)
    await writeAtomic(runtimePaths(root).config, `${JSON.stringify(next, null, 2)}\n`)
}

export function publicConfig(config: RuntimeConfig, catalog: unknown = {}) {
    const capabilities = (model: RuntimeConfig['model']) => {
        const metadata = resolveModelCapabilities(catalog, model.provider, model.model, model)
        const efforts = metadata.reasoningEfforts?.filter((effort): effort is z.infer<typeof reasoningEffortSchema> => reasoningEffortSchema.safeParse(effort).success)
        return { ...(efforts === undefined ? {} : { reasoningEfforts: efforts }), ...(metadata.reasoning === undefined ? {} : { reasoning: metadata.reasoning }),
            ...(metadata.source ? { reasoningSource: metadata.source } : {}) }
    }
    const { apiKey: _apiKey, ...model } = config.model
    return { ...config, model: { ...model, ...capabilities(model), baseUrl: publicUrl(model.baseUrl), providerOptions: undefined, hasApiKey: !!config.model.apiKey },
        models: config.models.map(({ apiKey, providerOptions: _options, ...profile }) => ({ ...profile, ...capabilities(profile), baseUrl: publicUrl(profile.baseUrl), hasApiKey: !!apiKey })),
        mcp: config.mcp.map(({ env, headers, args, url, ...server }) => ({ ...server, ...(url ? { url: publicUrl(url) } : {}), argCount: args.length,
            envKeys: Object.keys(env ?? {}), headerNames: Object.keys(headers ?? {}) })) }
}

export function selectModel(config: RuntimeConfig, id = 'default', reasoningEffort?: z.infer<typeof reasoningEffortSchema>, catalog: unknown = {}): RuntimeConfig {
    const selected = id === 'default' ? config.model : config.models.find(profile => profile.id === id)
    if (!selected) throw new Error(`模型配置不存在：${id}`)
    const { id: _id, label: _label, ...definition } = selected as RuntimeConfig['model'] & { id?: string; label?: string }
    const capabilities = resolveModelCapabilities(catalog, definition.provider, definition.model, definition)
    const explicit = reasoningEffort ?? definition.reasoningEffort
    if (explicit && capabilities.reasoningEfforts && !capabilities.reasoningEfforts.includes(explicit)) throw new Error(`该模型不支持配置的思考强度：${explicit}`)
    const preferred = config.preferences.reasoningEffort ?? 'high'
    const effort = explicit ?? (capabilities.reasoningEfforts?.includes(preferred) ? preferred : undefined)
    return { ...config, model: { ...definition, ...(effort ? { reasoningEffort: effort } : {}) } }
}

export function ancestorDirectories(workspace: string): string[] {
    const result: string[] = []
    let directory = resolve(workspace)
    while (true) { result.unshift(directory); const parent = dirname(directory); if (parent === directory) return result; directory = parent }
}

/** Partial layers inherit individual settings; callers choose whether identity lists replace or overlay. */
export function mergeConfig(base: RuntimeConfig, input: unknown, overlay = false): RuntimeConfig {
    const patch = z.record(z.string(), z.unknown()).parse(input)
    const modelPatch = z.record(z.string(), z.unknown()).parse(patch.model ?? {})
    const model = { ...base.model, ...modelPatch }
    const clearMovedCredentials = (value: Record<string, unknown>, previous: RuntimeConfig['model'], fields: Record<string, unknown>): void => {
        if (typeof fields.baseUrl !== 'string') return
        let changed = false
        try { changed = new URL(fields.baseUrl).origin !== new URL(previous.baseUrl).origin } catch { return }
        if (changed) for (const field of ['apiKey', 'providerOptions']) if (!(field in fields)) delete value[field]
    }
    clearMovedCredentials(model, base.model, modelPatch)
    for (const field of ['contextWindow', 'maxInputTokens', 'reasoningEffort', 'reasoningEfforts', 'apiKey'] as const) if (model[field] === null) delete model[field]
    if ((modelPatch.model && modelPatch.model !== base.model.model) || (modelPatch.provider && modelPatch.provider !== base.model.provider)) {
        if (!('contextWindow' in modelPatch)) delete model.contextWindow
        if (!('maxInputTokens' in modelPatch)) delete model.maxInputTokens
        if (!('reasoningEfforts' in modelPatch)) delete model.reasoningEfforts
        if (!('reasoningEffort' in modelPatch)) delete model.reasoningEffort
    }
    const compaction = { ...base.compaction, ...z.record(z.string(), z.unknown()).parse(patch.compaction ?? {}) }
    for (const field of ['context', 'compactTokens'] as const) if (compaction[field] === null) delete compaction[field]
    const identities = (key: 'models' | 'mcp'): unknown[] => {
        if (patch[key] === undefined) return base[key]
        const items = z.array(z.record(z.string(), z.unknown())).parse(patch[key])
        const merged = items.map(item => {
            const previous = base[key].find(previous => previous.id === item.id), value: Record<string, unknown> = { ...previous, ...item }
            if (key === 'models') {
                if (previous) clearMovedCredentials(value, previous as RuntimeConfig['model'], item)
                for (const field of ['contextWindow', 'maxInputTokens', 'reasoningEffort', 'reasoningEfforts', 'apiKey']) if (value[field] === null) delete value[field]
                if (previous && ((item.model && item.model !== (previous as RuntimeConfig['model']).model) || (item.provider && item.provider !== (previous as RuntimeConfig['model']).provider))) {
                    if (!('contextWindow' in item)) delete value.contextWindow
                    if (!('maxInputTokens' in item)) delete value.maxInputTokens
                    if (!('reasoningEfforts' in item)) delete value.reasoningEfforts
                    if (!('reasoningEffort' in item)) delete value.reasoningEffort
                }
            }
            return value
        })
        return overlay ? [...base[key].filter(previous => !items.some(item => item.id === previous.id)), ...merged] : merged
    }
    const skillPatch = z.record(z.string(), z.unknown()).parse(patch.skills ?? {})
    const skills = { ...base.skills, ...skillPatch }
    if (overlay && Array.isArray(skillPatch.disabled)) {
        skills.disabled = [...new Set([...base.skills.disabled, ...z.array(z.string().min(1)).parse(skillPatch.disabled)])]
    }
    const preferences = z.record(z.string(), z.unknown()).parse(patch.preferences ?? {})
    return configSchema.parse({ ...base, ...patch, model, compaction, models: identities('models'), mcp: identities('mcp'), skills,
        plugins: { ...base.plugins, ...z.record(z.string(), z.unknown()).parse(patch.plugins ?? {}) },
        memory: { ...base.memory, ...z.record(z.string(), z.unknown()).parse(patch.memory ?? {}) },
        preferences: { ...base.preferences, ...preferences, shortcuts: { ...base.preferences.shortcuts, ...z.record(z.string(), z.unknown()).parse(preferences.shortcuts ?? {}) } } })
}

export interface WorkspaceConfigLayer { path: string; value: unknown }
export async function workspaceConfig(base: RuntimeConfig, workspace: string, applicationRoot: string, candidate?: WorkspaceConfigLayer): Promise<{ config: RuntimeConfig; sources: string[]; projectMcp: string[]; untrustedMcp: string[]; unregisteredModelOrigins: string[] }> {
    const sources = [runtimePaths(applicationRoot).config]
    const projectMcp = new Set<string>()
    let config = base
    const globalFile = runtimePaths(applicationRoot).config
    const globalPath = await realpath(globalFile).catch(error => { if (isMissing(error)) return globalFile; throw error })
    const standardGlobalFile = runtimePaths().config
    const standardGlobalPath = await realpath(standardGlobalFile).catch(() => standardGlobalFile)
    for (const directory of ancestorDirectories(await realpath(workspace))) {
        const path = join(directory, '.quifox', 'config.json')
        try {
            // An explicit root selects an independent user profile; the default user file is never a project layer.
            const proposed = candidate?.path === path
            const canonical = await realpath(path).catch(error => { if (proposed && isMissing(error)) return path; throw error })
            if (resolve(path) === standardGlobalFile || canonical === standardGlobalPath || canonical === globalPath) continue
            const patch = z.record(z.string(), z.unknown()).parse(proposed ? candidate.value : JSON.parse(await readFile(path, 'utf8')))
            if ('trustedProjects' in patch) throw new Error('Project configuration cannot grant its own trust.')
            const previous = config
            config = mergeConfig(config, patch, true)
            for (const server of patch.mcp as Record<string, unknown>[] ?? []) if (Object.keys(server).some(key => key !== 'id' && key !== 'enabled')) projectMcp.add(server.id as string)
            const protect = (before: RuntimeConfig['model'] | undefined, after: RuntimeConfig['model'], fields: Record<string, unknown>): void => {
                if (!before || new URL(before.baseUrl).origin === new URL(after.baseUrl).origin) return
                if (!Object.hasOwn(fields, 'apiKey')) delete after.apiKey
                if (!Object.hasOwn(fields, 'providerOptions')) delete after.providerOptions
            }
            protect(previous.model, config.model, patch.model as Record<string, unknown> ?? {})
            for (const fields of patch.models as Record<string, unknown>[] ?? []) {
                const after = config.models.find(model => model.id === fields.id)
                if (after) protect(previous.models.find(model => model.id === fields.id), after, fields)
            }
            sources.push(path)
        } catch (error) { if (!isMissing(error)) throw new Error(`项目配置无效：${path}`, { cause: error }) }
    }
    const trusted = base.trustedProjects.some(root => ancestorDirectories(resolve(workspace)).includes(resolve(root)))
    if (base.approval === 'ask') config.approval = 'ask'
    config.memory.enabled = base.memory.enabled && config.memory.enabled
    config.memory.generate = base.memory.generate && config.memory.generate
    const allowedOrigins = new Set([base.model, ...base.models].map(model => new URL(model.baseUrl).origin))
    const connection = (server: RuntimeConfig['mcp'][number] | undefined) => { if (!server) return undefined; const { enabled: _enabled, ...fields } = server; return JSON.stringify(fields) }
    return { config, sources, projectMcp: config.mcp.filter(server => projectMcp.has(server.id)).map(server => server.id), untrustedMcp: trusted ? [] : config.mcp.filter(server => connection(base.mcp.find(item => item.id === server.id)) !== connection(server)).map(server => server.id),
        unregisteredModelOrigins: [...new Set([config.model, ...config.models].map(model => new URL(model.baseUrl).origin))].filter(origin => !allowedOrigins.has(origin)) }
}

function publicUrl(value: string): string { const parsed = new URL(value); parsed.search = ''; parsed.hash = ''; parsed.username = ''; parsed.password = ''; return parsed.toString() }

/** Resolve actual capacities separately from requested generation/compaction settings. */
export function modelBudget(config: RuntimeConfig, catalog: unknown = {}) {
    const configured: ModelLimits = { ...(config.model.contextWindow === undefined ? {} : { contextWindow: config.model.contextWindow }),
        ...(config.model.maxInputTokens === undefined ? {} : { maxInputTokens: config.model.maxInputTokens }) }
    const limits = resolveModelLimits(catalog, config.model.provider, config.model.model, configured)
    if (limits.contextWindow === undefined) throw new Error('模型容量未知：请刷新模型资料或在配置中声明 contextWindow。')
    const maxOutputTokens = Math.min(config.model.maxOutputTokens, limits.maxOutputTokens ?? config.model.maxOutputTokens)
    return { ...resolveCompactionBudget({ modelContextWindow: limits.contextWindow, maxOutputTokens, safetyTokens: config.compaction.safetyTokens,
        ...(config.compaction.context === undefined ? {} : { context: config.compaction.context }),
        ...(config.compaction.compactTokens === undefined ? {} : { compactTokens: config.compaction.compactTokens }),
        ...(limits.maxInputTokens === undefined ? {} : { modelInputTokens: limits.maxInputTokens }) }), maxOutputTokens }
}

export async function writeAtomic(path: string, content: string, mode = 0o600): Promise<void> {
    const temporary = `${path}.${randomUUID()}.tmp`
    try {
        const handle = await open(temporary, 'wx', mode)
        try { await handle.writeFile(content); await handle.sync() } finally { await handle.close() }
        await rename(temporary, path)
    } catch (error) { await unlink(temporary).catch(() => {}); throw error }
}

export function isMissing(error: unknown): boolean { return (error as NodeJS.ErrnoException | undefined)?.code === 'ENOENT' }
