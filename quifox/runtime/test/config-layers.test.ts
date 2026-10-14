import { expect, it } from 'vitest'
import { mkdir, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import type { SessionView } from '../src/protocol.js'
import { synthetic } from './synthetic.js'
import { loadConfig, workspaceConfig } from '../src/config.js'

it.each(['project', 'global'])('reports a same-ID project MCP definition pointing to %s without exposing removal of the global server', async destination => {
    const fixture = await synthetic(() => ({ text: 'unused' }), config => {
        config.mcp = [{ id: 'shared', enabled: true, transport: 'http', url: 'http://127.0.0.1:1/global', args: [] }]
    })
    try {
        const workspace = join(fixture.root, 'project')
        await mkdir(join(workspace, '.quifox'), { recursive: true })
        await writeFile(join(workspace, '.quifox', 'config.json'), JSON.stringify({ mcp: [{ id: 'shared', transport: 'http', url: `http://127.0.0.1:1/${destination}` }] }))
        const session = await fixture.runtime.command({ type: 'create', workspace }) as SessionView
        expect(await fixture.runtime.command({ type: 'mcp', sessionId: session.id, action: 'status' })).toMatchObject([{ id: 'shared', source: 'project' }])
        expect(await fixture.runtime.command({ type: 'mcp', action: 'status' })).toMatchObject([{ id: 'shared', source: 'global' }])
        expect((await loadConfig(fixture.root, fixture.root, {})).mcp[0]?.url).toBe('http://127.0.0.1:1/global')
    } finally { await fixture.close() }
})

it('inherits global and ancestor workspace configuration with the nearest value winning', async () => {
    const fixture = await synthetic(() => ({ text: 'layered' }))
    try {
        const parent = join(fixture.root, 'project'), child = join(parent, 'nested')
        await mkdir(join(parent, '.quifox'), { recursive: true }); await mkdir(join(child, '.quifox'), { recursive: true })
        await writeFile(join(parent, '.quifox', 'config.json'), JSON.stringify({ model: { reasoningEffort: 'low', temperature: 0.1 }, preferences: { inputMode: 'steer' } }))
        await writeFile(join(child, '.quifox', 'config.json'), JSON.stringify({ model: { reasoningEffort: 'high' } }))
        const session = await fixture.runtime.command({ type: 'create', workspace: child }) as SessionView
        await fixture.runtime.command({ type: 'submit', sessionId: session.id, prompt: 'check layered configuration' }); await fixture.runtime.waitForIdle(session.id)
        expect(fixture.requests[0]?.reasoning_effort).toBe('high')
        expect((await fixture.runtime.command({ type: 'snapshot', sessionId: session.id }) as SessionView).reasoningEffort).toBe('high')
    } finally { await fixture.close() }
})

it('keeps an untrusted project MCP disabled while allowing an ordinary model turn', async () => {
    const fixture = await synthetic(() => ({ text: 'ordinary reply with untrusted tools disabled' }))
    try {
        const workspace = join(fixture.root, 'project')
        await mkdir(join(workspace, '.quifox'), { recursive: true })
        await writeFile(join(workspace, '.quifox', 'config.json'), JSON.stringify({ mcp: [{ id: 'untrusted', transport: 'http', url: 'http://127.0.0.1:1' }] }))
        const session = await fixture.runtime.command({ type: 'create', workspace }) as SessionView
        await fixture.runtime.command({ type: 'submit', sessionId: session.id, prompt: 'use ordinary project tools' }); await fixture.runtime.waitForIdle(session.id)
        const view = await fixture.runtime.command({ type: 'snapshot', sessionId: session.id }) as SessionView
        expect(view.status).toBe('idle'); expect(view.untrustedMcp).toEqual(['untrusted'])
        expect(fixture.requests).toHaveLength(1)
        expect(fixture.requests[0]?.tools.some(tool => tool.function.name.startsWith('untrusted_'))).toBe(false)
        expect(await fixture.runtime.command({ type: 'mcp', sessionId: session.id, action: 'status' })).toMatchObject([{ id: 'untrusted', status: 'untrusted' }])
    } finally { await fixture.close() }
})

it('does not inherit credentials when a project redirects a global model connection to another origin', async () => {
    const fixture = await synthetic(() => ({ text: 'unused' }), config => {
        config.model.providerOptions = { headers: { authorization: 'synthetic-global-header' } }
        config.models = [{ ...config.model, id: 'alternate' }]
    })
    try {
        const workspace = join(fixture.root, 'project')
        await mkdir(join(workspace, '.quifox'), { recursive: true })
        await writeFile(join(workspace, '.quifox', 'config.json'), JSON.stringify({ model: { baseUrl: 'https://synthetic-other.test' }, models: [{ id: 'alternate', baseUrl: 'https://synthetic-other.test' }] }))
        const base = await loadConfig(fixture.root, fixture.root, {}), effective = await workspaceConfig(base, workspace, fixture.root)
        expect(effective.config.model.apiKey).toBeUndefined(); expect(effective.config.model.providerOptions).toBeUndefined()
        expect(effective.config.models[0]?.apiKey).toBeUndefined(); expect(effective.config.models[0]?.providerOptions).toBeUndefined()
        await writeFile(join(workspace, '.quifox', 'config.json'), JSON.stringify({ model: { baseUrl: 'https://synthetic-other.test', apiKey: 'synthetic-project-key' } }))
        expect((await workspaceConfig(base, workspace, fixture.root)).config.model.apiKey).toBe('synthetic-project-key')
        await writeFile(join(workspace, '.quifox', 'config.json'), JSON.stringify({ model: { baseUrl: `${base.model.baseUrl}/v1` } }))
        expect((await workspaceConfig(base, workspace, fixture.root)).config.model.apiKey).toBe(base.model.apiKey)
    } finally { await fixture.close() }
})

it.each([false, true])('does not let a project raise global ask authorization, including trusted MCP=%s', async trusted => {
    const fixture = await synthetic(() => ({ text: 'unused' }))
    try {
        const workspace = join(fixture.root, 'project')
        await mkdir(join(workspace, '.quifox'), { recursive: true })
        await writeFile(join(workspace, '.quifox', 'config.json'), JSON.stringify({ approval: 'allow' }))
        const base = await loadConfig(fixture.root, fixture.root, {})
        if (trusted) base.trustedProjects = [workspace]
        expect((await workspaceConfig(base, workspace, fixture.root)).config.approval).toBe('ask')
    } finally { await fixture.close() }
})

it('requires a project model destination to be declared in the user model list before any request', async () => {
    const fixture = await synthetic(() => ({ text: 'unused' }))
    try {
        const workspace = join(fixture.root, 'project')
        await mkdir(join(workspace, '.quifox'), { recursive: true })
        await writeFile(join(workspace, '.quifox', 'config.json'), JSON.stringify({ model: { baseUrl: 'https://synthetic-undeclared.test', apiKey: 'synthetic-project-key' } }))
        await expect(fixture.runtime.command({ type: 'create', workspace })).rejects.toThrow('全局连接')
        expect(fixture.requests).toHaveLength(0)
        const base = await loadConfig(fixture.root, fixture.root, {})
        await fixture.runtime.command({ type: 'config', patch: { models: [{ ...base.model, id: 'declared', baseUrl: 'https://synthetic-undeclared.test' }] } })
        expect((await fixture.runtime.command({ type: 'create', workspace }) as SessionView).workspace).toBe(workspace)
        expect(fixture.requests).toHaveLength(0)
    } finally { await fixture.close() }
})

it('does not let project Memory settings re-enable globally disabled features', async () => {
    const fixture = await synthetic(() => ({ text: 'unused' }), config => { config.memory.enabled = false; config.memory.generate = false })
    try {
        const workspace = join(fixture.root, 'project')
        await mkdir(join(workspace, '.quifox'), { recursive: true })
        await writeFile(join(workspace, '.quifox', 'config.json'), JSON.stringify({ memory: { enabled: true, generate: true } }))
        const session = await fixture.runtime.command({ type: 'create', workspace }) as SessionView
        expect(session.memory).toMatchObject({ enabled: false, processing: false, content: '' })
        await fixture.runtime.command({ type: 'memory', sessionId: session.id })
        expect(fixture.requests).toHaveLength(0)
    } finally { await fixture.close() }
})
