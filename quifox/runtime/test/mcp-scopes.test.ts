import { expect, it } from 'vitest'
import { mkdir, readFile } from 'node:fs/promises'
import { join } from 'node:path'
import { QuiFoxRuntime } from '../src/runtime.js'
import { createServer } from 'node:http'
import { once } from 'node:events'
import { synthetic } from './synthetic.js'
import type { SessionView } from '../src/protocol.js'

it('writes MCP enabled in the selected scope and shares the same files between independent Hosts', async () => {
    const fixture = await synthetic(() => ({ text: 'done' }), config => { config.mcp = [{ id: 'docs', transport: 'http', url: 'http://127.0.0.1:1', args: [], enabled: false }] })
    let other: QuiFoxRuntime | undefined
    try {
        const workspace = join(fixture.root, 'workspace'); await mkdir(workspace)
        other = await QuiFoxRuntime.open({ root: fixture.root, environment: {}, globalSkillsRoot: join(fixture.root, 'isolated') })
        await fixture.runtime.command({ type: 'mcp-set-enabled', serverId: 'docs', scope: 'workspace', workspace, enabled: true })
        expect(JSON.parse(await readFile(join(workspace, '.quifox/config.json'), 'utf8'))).toEqual({ mcp: [{ id: 'docs', enabled: true }] })
        expect(JSON.parse(await readFile(join(fixture.root, 'config.json'), 'utf8')).mcp[0].enabled).toBe(false)
        expect(await other.command({ type: 'mcp', action: 'status', workspace })).toMatchObject([{ id: 'docs', enabled: true, globalEnabled: false, source: 'global' }])
        const scoped = await other.command({ type: 'create', workspace }) as SessionView
        expect(scoped.untrustedMcp).toEqual([])
        await fixture.runtime.command({ type: 'mcp-set-enabled', serverId: 'docs', scope: 'global', enabled: true })
        expect(await other.command({ type: 'mcp', action: 'status' })).toMatchObject([{ enabled: true }])
        await fixture.runtime.command({ type: 'mcp-set-enabled', serverId: 'docs', scope: 'workspace', workspace, enabled: false })
        expect(await other.command({ type: 'mcp', action: 'status', workspace })).toMatchObject([{ enabled: false, globalEnabled: true }])
        expect(await other.command({ type: 'mcp', action: 'status', workspace: fixture.root })).toMatchObject([{ enabled: true }])
    } finally { await other?.close(); await fixture.close() }
})

it('adopts another Host directory toggle before an idle session starts its next turn', async () => {
    let connections = 0
    const http = createServer((_request, response) => { connections += 1; response.writeHead(500); response.end() })
    http.listen(0, '127.0.0.1'); await once(http, 'listening')
    const fixture = await synthetic(() => ({ text: 'done' }), config => { config.mcp = [{ id: 'docs', transport: 'http', url: `http://127.0.0.1:${(http.address() as { port: number }).port}`, args: [], enabled: true }] })
    let other: QuiFoxRuntime | undefined
    try {
        const workspace = join(fixture.root, 'workspace'); await mkdir(workspace)
        const session = await fixture.runtime.command({ type: 'create', workspace }) as SessionView
        other = await QuiFoxRuntime.open({ root: fixture.root, environment: {}, globalSkillsRoot: join(fixture.root, 'isolated') })
        await other.command({ type: 'mcp-set-enabled', serverId: 'docs', scope: 'workspace', workspace, enabled: false })
        await fixture.runtime.command({ type: 'submit', sessionId: session.id, prompt: 'use the current configuration' })
        await fixture.runtime.waitForIdle(session.id)
        expect(connections).toBe(0)
        expect(fixture.requests).toHaveLength(1)
    } finally { await other?.close(); await fixture.close(); http.closeAllConnections(); http.close() }
})
