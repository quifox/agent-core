import { expect, it } from 'vitest'
import { createServer } from 'node:http'
import { once } from 'node:events'
import { readFile } from 'node:fs/promises'
import { join } from 'node:path'
import { randomUUID } from 'node:crypto'
import { Server } from '@modelcontextprotocol/sdk/server/index.js'
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js'
import { ListToolsRequestSchema, CallToolRequestSchema } from '@modelcontextprotocol/sdk/types.js'
import type { Transport } from '@modelcontextprotocol/sdk/shared/transport.js'
import { HostMcpClient } from '../src/mcp.js'
import type { SessionView, RuntimeEvent } from '../src/protocol.js'
import { synthetic } from './synthetic.js'
import { toolName } from '@quifox/agent-plugin-mcp'

it.each(['connect', 'initialize'] as const)('closes a Host during MCP %s without waiting for the handshake timeout', async mode => {
    let acknowledge!: () => void
    const received = new Promise<void>(resolve => { acknowledge = resolve })
    const http = createServer(async request => { for await (const _chunk of request) { /* Consume the initialize request without replying. */ } acknowledge() })
    http.listen(0, '127.0.0.1'); await once(http, 'listening')
    const fixture = await synthetic(() => ({ text: 'must not request the model' }), config => {
        config.mcp = [{ id: 'pending', enabled: true, transport: 'http', url: `http://127.0.0.1:${(http.address() as { port: number }).port}`, args: [] }]
    })
    let pending: Promise<unknown> | undefined
    try {
        if (mode === 'connect') pending = fixture.runtime.command({ type: 'mcp', action: 'connect', serverId: 'pending' }).catch(error => error)
        else {
            const session = await fixture.runtime.command({ type: 'create' }) as SessionView
            pending = fixture.runtime.command({ type: 'submit', sessionId: session.id, prompt: 'initialize the configured tools' }).catch(error => error)
        }
        await received
        const close = fixture.runtime.close()
        let timeout: ReturnType<typeof setTimeout> | undefined
        try { expect(await Promise.race([close.then(() => true), new Promise<boolean>(resolve => { timeout = setTimeout(() => resolve(false), 1000) })])).toBe(true) }
        finally { clearTimeout(timeout) }
        expect(fixture.requests).toHaveLength(0)
    } finally { http.closeAllConnections(); http.close(); await pending; await fixture.close() }
})

it('stops one Agent during MCP initialization promptly without waiting for a shared handshake', async () => {
    let acknowledge!: () => void
    const received = new Promise<void>(resolve => { acknowledge = resolve })
    const http = createServer(async request => { for await (const _chunk of request) { /* Leave initialize pending. */ } acknowledge() })
    http.listen(0, '127.0.0.1'); await once(http, 'listening')
    const fixture = await synthetic(() => ({ text: 'must not request the model' }), config => {
        config.mcp = [{ id: 'pending', enabled: true, transport: 'http', url: `http://127.0.0.1:${(http.address() as { port: number }).port}`, args: [] }]
    })
    try {
        const session = await fixture.runtime.command({ type: 'create' }) as SessionView
        await fixture.runtime.command({ type: 'submit', sessionId: session.id, prompt: 'stop while initialization is pending' })
        await received; await fixture.runtime.command({ type: 'stop', sessionId: session.id })
        let timeout: ReturnType<typeof setTimeout> | undefined
        try { expect(await Promise.race([fixture.runtime.waitForIdle(session.id).then(() => true), new Promise<boolean>(resolve => { timeout = setTimeout(() => resolve(false), 1000) })])).toBe(true) }
        finally { clearTimeout(timeout) }
        expect(fixture.requests).toHaveLength(0)
    } finally { http.closeAllConnections(); http.close(); await fixture.close() }
})

it('talks to a standard MCP HTTP server, carries tool arguments and cancels the actual server operation', async () => {
    const server = new Server({ name: 'synthetic-mcp', version: '1.0.0' }, { capabilities: { tools: {} } })
    let cancelled = false, waiting = false
    server.setRequestHandler(ListToolsRequestSchema, async () => ({ tools: [{ name: 'echo', inputSchema: { type: 'object', properties: { text: { type: 'string' } }, required: ['text'] } }] }))
    server.setRequestHandler(CallToolRequestSchema, async (request, extra) => {
        if (request.params.arguments?.text === 'wait') { waiting = true; await new Promise<void>(resolve => { extra.signal.addEventListener('abort', () => { cancelled = true; resolve() }, { once: true }) }) }
        return { content: [{ type: 'text', text: String(request.params.arguments?.text) }] }
    })
    const transport = new StreamableHTTPServerTransport({ sessionIdGenerator: randomUUID })
    // SDK getter return types widen optional callbacks; keep the application compiler strict.
    await server.connect(transport as Transport)
    const http = createServer((request, response) => { void transport.handleRequest(request, response).catch(() => { if (!response.headersSent) response.writeHead(500); response.end() }) })
    http.listen(0, '127.0.0.1'); await once(http, 'listening')
    const client = new HostMcpClient({ id: 'synthetic', enabled: true, transport: 'http', url: `http://127.0.0.1:${(http.address() as { port: number }).port}`, args: [] }, '.')
    try {
        expect((await client.listTools()).tools[0]?.name).toBe('echo')
        expect(await client.callTool({ name: 'echo', arguments: { text: 'real MCP receipt' } })).toMatchObject({ content: [{ type: 'text', text: 'real MCP receipt' }] })
        const controller = new AbortController(), pending = client.callTool({ name: 'echo', arguments: { text: 'wait' } }, controller.signal).catch(error => error as Error)
        await expect.poll(() => waiting).toBe(true); controller.abort(); expect(await pending).toBeInstanceOf(Error)
        await expect.poll(() => cancelled).toBe(true)
        await client.close(); await expect(client.listTools()).rejects.toThrow('closed')
    } finally { await client.close(); await server.close(); http.closeAllConnections(); http.close() }
})

it('maps a standard MCP service into the real Agent tool loop and enforces the shared Host approval', async () => {
    const server = new Server({ name: 'synthetic-chain', version: '1.0.0' }, { capabilities: { tools: {} } })
    let executions = 0
    server.setRequestHandler(ListToolsRequestSchema, async () => ({ tools: [{ name: 'echo', inputSchema: { type: 'object', properties: { text: { type: 'string' } }, required: ['text'] } }] }))
    server.setRequestHandler(CallToolRequestSchema, async request => { executions += 1; return { content: [{ type: 'text', text: String(request.params.arguments?.text) }] } })
    const transport = new StreamableHTTPServerTransport({ sessionIdGenerator: randomUUID })
    await server.connect(transport as Transport)
    const http = createServer((request, response) => { void transport.handleRequest(request, response).catch(() => { if (!response.headersSent) response.writeHead(500); response.end() }) })
    http.listen(0, '127.0.0.1'); await once(http, 'listening')
    const fixture = await synthetic((_input, index) => index === 1 ? { calls: [{ id: 'actual-mcp-call', name: toolName('synthetic', 'echo'), input: { text: 'Actual MCP tool receipt' } }] } : { text: 'MCP observed' }, config => {
        config.mcp = [{ id: 'synthetic', enabled: true, transport: 'http', url: `http://127.0.0.1:${(http.address() as { port: number }).port}`, args: [] }]
    })
    let acceptApproval!: (event: RuntimeEvent) => void
    const approval = new Promise<RuntimeEvent>(resolve => { acceptApproval = resolve })
    fixture.runtime.subscribe(event => { if (event.type === 'approval') acceptApproval(event) })
    try {
        const session = await fixture.runtime.command({ type: 'create' }) as SessionView
        await fixture.runtime.command({ type: 'submit', sessionId: session.id, prompt: 'call the configured MCP tool' })
        const event = await approval
        expect(fixture.requests[0]?.tools.some(tool => tool.function.name === toolName('synthetic', 'echo'))).toBe(true)
        expect(executions).toBe(0)
        await fixture.runtime.command({ type: 'approve', sessionId: session.id, approvalId: (event.data as { id: string }).id, approved: true })
        await fixture.runtime.waitForIdle(session.id)
        expect(executions).toBe(1)
        expect(fixture.requests[1]?.messages.at(-1)?.content).toContain('Actual MCP tool receipt')
        expect((await fixture.runtime.command({ type: 'snapshot', sessionId: session.id }) as SessionView).messages.some(item => item.message.role === 'tool' && item.message.toolCallId === 'actual-mcp-call')).toBe(true)
    } finally { await fixture.close(); await server.close(); http.closeAllConnections(); http.close() }
})

it('removes known MCP credentials before the tool receipt is archived or sent to the next model request', async () => {
    const secret = 'synthetic-mcp-credential-private'
    const server = new Server({ name: 'synthetic-secret', version: '1.0.0' }, { capabilities: { tools: {} } })
    server.setRequestHandler(ListToolsRequestSchema, async () => ({ tools: [{ name: 'echo', inputSchema: { type: 'object', properties: {} } }] }))
    server.setRequestHandler(CallToolRequestSchema, async () => ({ isError: true, content: [{ type: 'text', text: secret }] }))
    const transport = new StreamableHTTPServerTransport({ sessionIdGenerator: randomUUID })
    await server.connect(transport as Transport)
    const http = createServer((request, response) => { void transport.handleRequest(request, response).catch(() => response.end()) })
    http.listen(0, '127.0.0.1'); await once(http, 'listening')
    const fixture = await synthetic((_input, index) => index === 1 ? { calls: [{ id: 'secret-result', name: toolName('secret', 'echo'), input: {} }] } : { text: 'done' }, config => {
        config.approval = 'allow'; config.mcp = [{ id: 'secret', enabled: true, transport: 'http', url: `http://127.0.0.1:${(http.address() as { port: number }).port}`, headers: { authorization: secret }, args: [] }]
    })
    try {
        const session = await fixture.runtime.command({ type: 'create' }) as SessionView
        await fixture.runtime.command({ type: 'submit', sessionId: session.id, prompt: 'echo the MCP error' }); await fixture.runtime.waitForIdle(session.id)
        expect(fixture.requests).toHaveLength(2)
        expect(JSON.stringify(fixture.requests[1])).not.toContain(secret)
        expect(fixture.requests[1]?.messages.at(-1)?.content).toContain('[redacted]')
        expect(await readFile(join(fixture.root, 'sessions', `${session.id}.jsonl`), 'utf8')).not.toContain(secret)
    } finally { await fixture.close(); await server.close(); http.closeAllConnections(); http.close() }
})

it('keeps ordinary turns usable after failed MCP discovery and reconnects tools through a fresh idle composition', async () => {
    let available = false
    const server = new Server({ name: 'synthetic-retry', version: '1.0.0' }, { capabilities: { tools: {} } })
    server.setRequestHandler(ListToolsRequestSchema, async () => {
        if (!available) throw new Error('Synthetic discovery failure')
        return { tools: [{ name: 'echo', inputSchema: { type: 'object', properties: {} } }] }
    })
    server.setRequestHandler(CallToolRequestSchema, async () => ({ content: [{ type: 'text', text: 'reconnected receipt' }] }))
    const transport = new StreamableHTTPServerTransport({ sessionIdGenerator: randomUUID })
    await server.connect(transport as Transport)
    const http = createServer((request, response) => { void transport.handleRequest(request, response).catch(() => response.end()) })
    http.listen(0, '127.0.0.1'); await once(http, 'listening')
    const fixture = await synthetic(input => input.messages.at(-1)?.content === 'use the reconnected tool' ?
        { calls: [{ id: 'echo', name: toolName('retry', 'echo'), input: {} }] } : { text: 'ordinary model reply' }, config => {
        config.approval = 'allow'; config.mcp = [{ id: 'retry', enabled: true, transport: 'http', url: `http://127.0.0.1:${(http.address() as { port: number }).port}`, args: [] }]
    })
    try {
        const session = await fixture.runtime.command({ type: 'create' }) as SessionView
        await fixture.runtime.command({ type: 'submit', sessionId: session.id, prompt: 'ordinary turn despite unavailable MCP' }); await fixture.runtime.waitForIdle(session.id)
        expect((await fixture.runtime.command({ type: 'snapshot', sessionId: session.id }) as SessionView).status).toBe('idle')
        expect(fixture.requests).toHaveLength(1)
        expect(fixture.requests[0]?.tools.map(tool => tool.function.name)).not.toContain(toolName('retry', 'echo'))
        available = true
        await fixture.runtime.command({ type: 'mcp', action: 'connect', sessionId: session.id, serverId: 'retry' })
        await fixture.runtime.command({ type: 'submit', sessionId: session.id, prompt: 'use the reconnected tool' }); await fixture.runtime.waitForIdle(session.id)
        expect(fixture.requests[1]?.tools.map(tool => tool.function.name)).toContain(toolName('retry', 'echo'))
        expect(fixture.requests[2]?.messages.at(-1)?.content).toContain('reconnected receipt')
    } finally { await fixture.close(); await server.close(); http.closeAllConnections(); http.close() }
})

it('keeps a disabled MCP visible in status but does not connect or expose its tools', async () => {
    const fixture = await synthetic(() => ({ text: 'ordinary' }), config => {
        config.mcp = [{ id: 'disabled', enabled: false, transport: 'http', url: 'http://127.0.0.1:1', args: [] }]
    })
    try {
        expect(await fixture.runtime.command({ type: 'mcp', action: 'status' })).toMatchObject([{ id: 'disabled', status: 'disabled' }])
        await expect(fixture.runtime.command({ type: 'mcp', action: 'connect', serverId: 'disabled' })).rejects.toThrow('已禁用')
        const session = await fixture.runtime.command({ type: 'create' }) as SessionView
        await fixture.runtime.command({ type: 'submit', sessionId: session.id, prompt: 'ordinary turn' }); await fixture.runtime.waitForIdle(session.id)
        expect(fixture.requests[0]?.tools.some(tool => tool.function.name.includes('disabled'))).toBe(false)
    } finally { await fixture.close() }
})
