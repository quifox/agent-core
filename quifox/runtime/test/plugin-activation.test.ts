import { expect, it } from 'vitest'
import { mkdir, readFile, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import type { ObservabilityView, PluginView, SessionView } from '../src/protocol.js'
import { synthetic } from './synthetic.js'

it('keeps disabled plugins installed while removing their runtime tools and hooks, and retains observer history', async () => {
    const fixture = await synthetic(() => ({ text: 'valid response' }))
    try {
        const session = await fixture.runtime.command({ type: 'create' }) as SessionView
        await fixture.runtime.command({ type: 'submit', sessionId: session.id, prompt: 'first' }); await fixture.runtime.waitForIdle(session.id)
        for (const pluginId of ['skills', 'subagents', 'observability']) await fixture.runtime.command({ type: 'plugin-set-enabled', pluginId, scope: 'global', enabled: false })
        const catalog = await fixture.runtime.command({ type: 'plugins', sessionId: session.id }) as PluginView
        expect(catalog.installed.find(plugin => plugin.id === 'observability')).toMatchObject({ enabled: false })
        expect(catalog.plugins.some(plugin => ['skills', 'subagents', 'observability'].includes(plugin.id))).toBe(false)
        await expect(fixture.runtime.command({ type: 'submit', sessionId: session.id, prompt: '/spawn 1 review' })).rejects.toThrow('已停用')
        await fixture.runtime.command({ type: 'submit', sessionId: session.id, prompt: 'second' }); await fixture.runtime.waitForIdle(session.id)
        expect(fixture.requests[1]!.tools.some(tool => tool.function.name.startsWith('subagent_'))).toBe(false)
        expect((await fixture.runtime.command({ type: 'observability', sessionId: session.id, action: 'summary' }) as ObservabilityView).totalRuns).toBe(1)
        await fixture.restart()
        expect((await fixture.runtime.command({ type: 'plugins' }) as PluginView).installed.find(plugin => plugin.id === 'skills')?.enabled).toBe(false)
        await expect(fixture.runtime.command({ type: 'plugin-set-enabled', pluginId: 'host-durability', scope: 'global', enabled: false })).rejects.toThrow('不是可停用')
    } finally { await fixture.close() }
})

it('projects actual installed plugins and reinstalls a bundled plugin through the shared configuration', async () => {
    const fixture = await synthetic(() => ({ text: 'installation verified' }))
    try {
        await fixture.runtime.command({ type: 'plugin-install', action: 'remove', pluginId: 'subagents', scope: 'global' })
        const removed = await fixture.runtime.command({ type: 'plugins' }) as PluginView
        expect(removed.installed.some(item => item.id === 'subagents')).toBe(false)
        expect(removed.marketplace.find(item => item.id === 'subagents')?.installed).toBe(false)
        const session = await fixture.runtime.command({ type: 'create' }) as SessionView
        await fixture.runtime.command({ type: 'submit', sessionId: session.id, prompt: 'without subagents' }); await fixture.runtime.waitForIdle(session.id)
        expect(fixture.requests[0]!.tools.some(item => item.function.name === 'subagent_start')).toBe(false)
        await fixture.runtime.command({ type: 'plugin-install', action: 'install', pluginId: 'subagents', scope: 'global' }); await fixture.restart()
        const installed = await fixture.runtime.command({ type: 'plugins' }) as PluginView
        expect(installed.installed.find(item => item.id === 'subagents')?.enabled).toBe(true)
        expect(installed.marketplace.find(item => item.id === 'subagents')?.installed).toBe(true)
        await fixture.runtime.command({ type: 'submit', sessionId: session.id, prompt: 'with subagents' }); await fixture.runtime.waitForIdle(session.id)
        expect(fixture.requests[1]!.tools.some(item => item.function.name === 'subagent_start')).toBe(true)
    } finally { await fixture.close() }
})

it('inherits plugin settings per field and keeps Memory module activation separate from memory reading', async () => {
    const fixture = await synthetic(() => ({ text: 'unused' }), config => { config.plugins.skills = false })
    try {
        const workspace = join(fixture.root, 'project'); await mkdir(join(workspace, '.quifox'), { recursive: true })
        await writeFile(join(workspace, '.quifox/config.json'), JSON.stringify({ plugins: { skills: true } }))
        await fixture.runtime.command({ type: 'plugin-set-enabled', pluginId: 'observability', workspace, scope: 'workspace', enabled: false })
        expect(JSON.parse(await readFile(join(workspace, '.quifox/config.json'), 'utf8'))).toMatchObject({ plugins: { skills: true, observability: false } })
        expect(JSON.parse(await readFile(join(fixture.root, 'config.json'), 'utf8')).plugins).toEqual({ skills: false })
        await fixture.runtime.command({ type: 'plugin-set-enabled', pluginId: 'memory', scope: 'global', enabled: false })
        const saved = JSON.parse(await readFile(join(fixture.root, 'config.json'), 'utf8'))
        expect(saved.memory.enabled).toBe(true); expect(saved.plugins.memory).toBe(false)
    } finally { await fixture.close() }
})

it('advertises Agent definitions only when the effective Agent has the start tool and preserves earlier user history', async () => {
    const fixture = await synthetic(() => ({ text: 'reviewed' }))
    try {
        await mkdir(join(fixture.root, 'agents'), { recursive: true })
        await writeFile(join(fixture.root, 'agents', 'reviewer.md'), '---\nname: reviewer\ndescription: Independent reviewer\ntools: Read\n---\nReview only.')
        const session = await fixture.runtime.command({ type: 'create' }) as SessionView
        await fixture.runtime.command({ type: 'submit', sessionId: session.id, prompt: 'first user request' }); await fixture.runtime.waitForIdle(session.id)
        const first = fixture.requests[0]!
        expect(first.tools.some(tool => tool.function.name === 'subagent_start')).toBe(true)
        expect(first.messages.some(message => message.role === 'system' && message.content?.includes('Available Agent definitions for subagent_start'))).toBe(true)
        await fixture.runtime.command({ type: 'plugin-set-enabled', pluginId: 'subagents', scope: 'global', enabled: false })
        await fixture.runtime.command({ type: 'submit', sessionId: session.id, prompt: 'second user request' }); await fixture.runtime.waitForIdle(session.id)
        const second = fixture.requests[1]!
        expect(second.tools.some(tool => tool.function.name.startsWith('subagent_'))).toBe(false)
        expect(second.messages.some(message => message.role === 'system' && message.content?.includes('Available Agent definitions for subagent_start'))).toBe(false)
        expect(second.messages.some(message => message.role === 'user' && message.content === 'first user request')).toBe(true)
        await fixture.runtime.command({ type: 'plugin-set-enabled', pluginId: 'subagents', scope: 'global', enabled: true })
        const limited = await fixture.runtime.command({ type: 'create', agent: 'reviewer' }) as SessionView
        await fixture.runtime.command({ type: 'submit', sessionId: limited.id, prompt: 'restricted review' }); await fixture.runtime.waitForIdle(limited.id)
        const request = fixture.requests[2]!
        expect(request.tools.some(tool => tool.function.name === 'subagent_start')).toBe(false)
        expect(request.messages.some(message => message.role === 'system' && message.content?.includes('Available Agent definitions for subagent_start'))).toBe(false)
        expect(request.messages.some(message => message.role === 'system' && message.content?.includes('Review only.'))).toBe(true)
    } finally { await fixture.close() }
})

it('rejects a plugin toggle during an active model request without changing its config or tool contract', async () => {
    let finish!: () => void
    const blocked = new Promise<void>(resolve => { finish = resolve })
    const fixture = await synthetic(async () => { await blocked; return { text: 'completed' } })
    try {
        const session = await fixture.runtime.command({ type: 'create' }) as SessionView
        const before = await readFile(join(fixture.root, 'config.json'), 'utf8')
        await fixture.runtime.command({ type: 'submit', sessionId: session.id, prompt: 'long request' })
        await expect.poll(() => fixture.requests.length).toBe(1)
        await expect(fixture.runtime.command({ type: 'plugin-set-enabled', pluginId: 'subagents', scope: 'global', enabled: false })).rejects.toThrow('运行和后台任务结束')
        expect(await readFile(join(fixture.root, 'config.json'), 'utf8')).toBe(before)
        expect(fixture.requests[0]!.tools.some(tool => tool.function.name === 'subagent_start')).toBe(true)
        finish(); await fixture.runtime.waitForIdle(session.id)
    } finally { finish(); await fixture.close() }
})
