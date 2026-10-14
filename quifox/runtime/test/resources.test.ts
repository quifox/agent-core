import { expect, it } from 'vitest'
import { mkdir, readFile, unlink, writeFile } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import { loadConfig, saveConfig } from '../src/config.js'
import type { PluginView, ResourceView, RuntimeSnapshot } from '../src/protocol.js'
import { synthetic } from './synthetic.js'
import { createProjectFiles } from '../src/project-files.js'
import { SkillsPlugin } from '@quifox/agent-plugin-project-context'

it('discovers resources and the actual plugin composition without creating or running a session', async () => {
    const fixture = await synthetic(() => ({ text: 'unused' }))
    try {
        await mkdir(join(fixture.root, 'skills', 'review'), { recursive: true })
        await writeFile(join(fixture.root, 'skills', 'review', 'SKILL.md'), '---\nname: review\ndescription: Review a change.\n---\nPrivate skill body')
        await writeFile(join(fixture.root, 'AGENTS.md'), 'Synthetic project instructions')
        const resources = await fixture.runtime.command({ type: 'resources' }) as ResourceView
        expect(resources.skills.skills.map(skill => skill.name)).toContain('review')
        const project = await createProjectFiles(fixture.root, fixture.root, join(fixture.root, 'skills'))
        const catalog = await new SkillsPlugin({ files: project.files, roots: project.roots, context: () => ({ set() {} }) }).catalog()
        expect(catalog.skills.filter(skill => skill.name === 'review')).toHaveLength(1)
        expect(resources.guidance.some(source => source.path === 'AGENTS.md')).toBe(true)
        expect(resources.memory.summaries).toBe(0)
        const plugins = await fixture.runtime.command({ type: 'plugins' }) as PluginView
        expect(plugins.scope).toBe('configuration')
        expect(plugins.plugins).toEqual([])
        expect(plugins.installed.map(plugin => plugin.id)).toEqual(expect.arrayContaining(['skills', 'project-guidance', 'observability']))
        expect(plugins.installed.find(plugin => plugin.id === 'observability')?.surface?.kind).toBe('observability')
        expect((await fixture.runtime.command({ type: 'snapshot' }) as RuntimeSnapshot).sessions).toHaveLength(0)
        expect(fixture.requests).toHaveLength(0)
        expect(JSON.stringify(resources)).not.toContain('Private skill body')
    } finally { await fixture.close() }
})

it('projects plugin activation for a selected directory without changing the launch project or creating a session', async () => {
    const fixture = await synthetic(() => ({ text: 'unused' }))
    try {
        const project = join(fixture.root, 'other project')
        await mkdir(join(project, '.quifox'), { recursive: true })
        await writeFile(join(project, '.quifox', 'config.json'), JSON.stringify({ plugins: { skills: false } }))
        const selected = await fixture.runtime.command({ type: 'plugins', workspace: project }) as PluginView
        expect(selected.installed.find(plugin => plugin.id === 'skills')?.enabled).toBe(false)
        const launch = await fixture.runtime.command({ type: 'plugins' }) as PluginView
        expect(launch.installed.find(plugin => plugin.id === 'skills')?.enabled).toBe(true)
        expect((await fixture.runtime.command({ type: 'snapshot' }) as RuntimeSnapshot).sessions).toEqual([])
        expect(fixture.requests).toEqual([])
    } finally { await fixture.close() }
})

it('shows installed plugins even when a project model has no known context capacity', async () => {
    const fixture = await synthetic(() => ({ text: 'unused' }))
    try {
        const project = join(fixture.root, 'unknown model project')
        await mkdir(join(project, '.quifox'), { recursive: true })
        await writeFile(join(project, '.quifox', 'config.json'), JSON.stringify({ model: { model: 'unknown-project-model' } }))
        const plugins = await fixture.runtime.command({ type: 'plugins', workspace: project }) as PluginView
        expect(plugins.scope).toBe('configuration')
        expect(plugins.installed.find(plugin => plugin.id === 'observability')?.surface?.kind).toBe('observability')
        expect(plugins.plugins).toEqual([])
        expect((await fixture.runtime.command({ type: 'snapshot' }) as RuntimeSnapshot).sessions).toEqual([])
        expect(fixture.requests).toEqual([])
    } finally { await fixture.close() }
})

it('keeps configuration and historical observation readable when an already loaded project becomes non-executable', async () => {
    const fixture = await synthetic(() => ({ text: 'original response' }))
    try {
        const project = join(fixture.root, 'changed model project')
        await mkdir(join(project, '.quifox'), { recursive: true })
        const session = await fixture.runtime.command({ type: 'create', workspace: project }) as import('../src/protocol.js').SessionView
        await fixture.runtime.command({ type: 'submit', sessionId: session.id, prompt: 'original task' }); await fixture.runtime.waitForIdle(session.id)
        await writeFile(join(project, '.quifox', 'config.json'), JSON.stringify({ model: { model: 'unknown-project-model' } }))
        const plugins = await fixture.runtime.command({ type: 'plugins', workspace: project }) as PluginView
        expect(plugins.installed.some(plugin => plugin.id === 'observability')).toBe(true)
        const listing = await fixture.runtime.command({ type: 'snapshot' }) as RuntimeSnapshot
        expect(listing.sessions.map(item => item.id)).toContain(session.id)
        const observation = await fixture.runtime.command({ type: 'observability', action: 'summary', sessionId: session.id }) as import('../src/protocol.js').ObservabilityView
        expect(observation.totalRuns).toBe(1)
        expect(observation.runs[0]?.status).toBe('success')
        const resource = await fixture.runtime.command({ type: 'resources', workspace: project }) as ResourceView
        expect(resource.config.model.model).toBe('unknown-project-model')
        await expect(fixture.runtime.command({ type: 'submit', sessionId: session.id, prompt: 'must not run with invalid capacity' })).rejects.toThrow('模型容量未知')
        expect(fixture.requests).toHaveLength(1)
    } finally { await fixture.close() }
})

it('exposes inherited project model choices before creating a conversation', async () => {
    const fixture = await synthetic(() => ({ text: 'unused' }))
    try {
        const project = join(fixture.root, 'nested project')
        await mkdir(join(project, '.quifox'), { recursive: true })
        await writeFile(join(project, '.quifox', 'config.json'), JSON.stringify({ model: { model: 'project-model' }, preferences: { reasoningEffort: 'max' } }))
        const selected = await fixture.runtime.command({ type: 'resources', workspace: project }) as ResourceView
        expect(selected.config.model.model).toBe('project-model')
        expect(selected.config.preferences.reasoningEffort).toBe('max')
        expect(JSON.stringify(selected.config)).not.toContain('synthetic-key')
        expect(fixture.requests).toEqual([])
    } finally { await fixture.close() }
})

it('does not recreate a removed global configuration while inspecting resources or historical observations', async () => {
    const fixture = await synthetic(() => ({ text: 'saved response' }))
    try {
        const session = await fixture.runtime.command({ type: 'create' }) as import('../src/protocol.js').SessionView
        await fixture.runtime.command({ type: 'submit', sessionId: session.id, prompt: 'saved task' }); await fixture.runtime.waitForIdle(session.id)
        const path = join(fixture.root, 'config.json')
        await unlink(path)
        const snapshot = await fixture.runtime.command({ type: 'snapshot' }) as RuntimeSnapshot
        expect(snapshot.sessions.map(item => item.id)).toContain(session.id)
        await fixture.runtime.command({ type: 'resources' })
        await fixture.runtime.command({ type: 'plugins' })
        await fixture.runtime.command({ type: 'instructions', action: 'read' })
        await fixture.runtime.command({ type: 'memory-file' })
        const observation = await fixture.runtime.command({ type: 'observability', action: 'summary', sessionId: session.id }) as import('../src/protocol.js').ObservabilityView
        expect(observation.totalRuns).toBe(1)
        await expect(readFile(path, 'utf8')).rejects.toMatchObject({ code: 'ENOENT' })
        expect(fixture.requests).toHaveLength(1)
    } finally { await fixture.close() }
})

it.each(['global', 'workspace'])('redacts newly configured %s credentials in memory and instruction projections without composing an Agent', async scope => {
    const fixture = await synthetic(() => ({ text: 'unused' }))
    try {
        const preview = await fixture.runtime.command({ type: 'memory-file' }) as { path: string }
        await mkdir(dirname(preview.path), { recursive: true })
        const body = 'synthetic-key / synthetic-new-secret'
        await writeFile(preview.path, body); await writeFile(join(fixture.root, 'AGENTS.md'), body)
        const config = await loadConfig(fixture.root, fixture.root, {})
        config.model.apiKey = 'synthetic-new-secret'; await saveConfig(fixture.root, config)
        const project = join(fixture.root, 'project secret')
        if (scope === 'workspace') {
            await mkdir(join(project, '.quifox'), { recursive: true })
            await writeFile(join(project, '.quifox', 'config.json'), JSON.stringify({ model: { apiKey: 'synthetic-project-secret' } }))
            await writeFile(join(project, 'AGENTS.md'), `${body} / synthetic-project-secret`)
        }
        const memory = await fixture.runtime.command({ type: 'memory-file' })
        const instructions = await fixture.runtime.command({ type: 'instructions', action: 'read', ...(scope === 'workspace' ? { workspace: project } : {}) })
        expect(JSON.stringify([memory, instructions])).not.toContain('synthetic-new-secret')
        expect(JSON.stringify([memory, instructions])).not.toContain('synthetic-key')
        expect(JSON.stringify([memory, instructions])).not.toContain('synthetic-project-secret')
        expect(fixture.requests).toEqual([])
    } finally { await fixture.close() }
})

it('reads scoped instructions and edits the global AGENTS.md without creating a session', async () => {
    const fixture = await synthetic(() => ({ text: 'unused' }))
    try {
        const first = await fixture.runtime.command({ type: 'instructions', action: 'read', workspace: fixture.root }) as {
            globalPath: string; globalContent: string; sources: { scope: string; path: string; content: string }[]
        }
        expect(first.globalPath).toBe(join(fixture.root, 'AGENTS.md'))
        expect(first.globalContent).toBe('')
        await fixture.runtime.command({ type: 'instructions', action: 'save-global', workspace: fixture.root, content: '# Global\nUse tests.' })
        const second = await fixture.runtime.command({ type: 'instructions', action: 'read', workspace: fixture.root }) as typeof first
        expect(second.globalContent).toContain('Use tests.')
        expect(second.sources.some(source => source.scope === fixture.root.replace(/\\/g, '/') && source.content.includes('Use tests.'))).toBe(true)
        expect((await fixture.runtime.command({ type: 'snapshot' }) as RuntimeSnapshot).sessions).toHaveLength(0)
    } finally { await fixture.close() }
})
