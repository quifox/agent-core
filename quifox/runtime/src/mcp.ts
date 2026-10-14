import { Client } from '@modelcontextprotocol/sdk/client/index.js'
import { StdioClientTransport, getDefaultEnvironment } from '@modelcontextprotocol/sdk/client/stdio.js'
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js'
import type { Transport } from '@modelcontextprotocol/sdk/shared/transport.js'
import type { McpClientPort, McpCallResult } from '@quifox/agent-plugin-mcp'
import type { RuntimeConfig } from './config.js'

/** Cancel this caller while retaining the Host-owned connection for other Agents. */
export async function interruptMcp<T>(operation: () => Promise<T>, signal?: AbortSignal): Promise<T> {
    signal?.throwIfAborted()
    if (!signal) return operation()
    let reject!: (reason: unknown) => void
    const aborted = new Promise<never>((_resolve, failure) => { reject = failure })
    const abort = (): void => reject(signal.reason)
    signal.addEventListener('abort', abort, { once: true })
    try { return await Promise.race([operation(), aborted]) }
    finally { signal.removeEventListener('abort', abort) }
}

/** A lazy, shared transport owner; each Agent still registers its own ordinary MCP Tools. */
export class HostMcpClient implements McpClientPort {
    private connection: Promise<Client> | undefined
    private closeWork: Promise<void> | undefined
    private client: Client | undefined
    private transport: Transport | undefined
    private closed = false
    private failed = false
    private connected = false
    private toolCount = 0
    private readonly toolNames = new Set<string>()

    constructor(private readonly config: RuntimeConfig['mcp'][number], private readonly workspace: string, private readonly trusted = true) {}

    get status() { return { status: this.closed ? 'closed' : this.failed ? 'error' : this.connected ? 'connected' : this.connection ? 'connecting' : 'disconnected', toolCount: this.toolCount } }

    discoveryFailed(): void { this.failed = true; this.toolNames.clear(); this.toolCount = 0 }

    private connect(): Promise<Client> {
        if (this.closed) return Promise.reject(new Error('MCP connection is closed.'))
        if (!this.trusted) return Promise.reject(new Error('项目 MCP 尚未授权，请在设置中信任该目录的 MCP 配置。'))
        if (this.connection) return this.connection
        this.connection = (async () => {
            this.failed = false; this.connected = false
            const client = new Client({ name: 'quifox', version: '0.1.0' })
            this.client = client
            client.onclose = () => {
                if (this.client !== client) return
                this.connected = false
                if (!this.closed) { this.failed = true; this.connection = undefined; this.toolNames.clear(); this.toolCount = 0 }
            }
            const transport = this.config.transport === 'http' ? new StreamableHTTPClientTransport(new URL(this.config.url!), {
                ...(this.config.headers ? { requestInit: { headers: this.config.headers } } : {}) }) :
                new StdioClientTransport({ command: this.config.command!, args: this.config.args, cwd: this.workspace, stderr: 'pipe',
                    env: { ...getDefaultEnvironment(), ...this.config.env } })
            // SDK initialize failures start transport.close without joining it. Retain its one cleanup promise.
            const closeTransport = transport.close.bind(transport)
            let cleanup: Promise<void> | undefined
            transport.close = () => cleanup ??= closeTransport()
            this.transport = transport as Transport
            if (transport instanceof StdioClientTransport) transport.stderr?.on('data', () => {})
            // SDK getters explicitly return undefined while its Transport optional fields omit it.
            try { await client.connect(transport as Transport, { timeout: 20_000 }); if (this.closed) { await client.close(); throw new Error('MCP connection was closed.') }; this.connected = true; return client }
            catch (error) { await client.close().catch(() => {}); await transport.close().catch(() => {}); this.client = undefined; this.connection = undefined; this.failed = true; throw error }
        })()
        return this.connection
    }

    async listTools(input?: { cursor: string }) {
        const page = await (await this.connect()).listTools(input)
        this.failed = false
        if (!input?.cursor) this.toolNames.clear()
        for (const tool of page.tools) this.toolNames.add(tool.name)
        this.toolCount = this.toolNames.size
        return { tools: page.tools.map(tool => ({ name: tool.name, inputSchema: tool.inputSchema,
            ...(tool.description === undefined ? {} : { description: tool.description }) })), ...(page.nextCursor === undefined ? {} : { nextCursor: page.nextCursor }) }
    }

    async callTool(input: { name: string; arguments: Record<string, unknown> }, signal?: AbortSignal): Promise<McpCallResult> {
        signal?.throwIfAborted()
        const client = await interruptMcp(() => this.connect(), signal)
        signal?.throwIfAborted()
        const result = await client.callTool(input, undefined, signal ? { signal } : {})
        return result as McpCallResult
    }

    close(): Promise<void> { return this.closeWork ??= this.finishClose() }
    private async finishClose(): Promise<void> {
        this.closed = true; this.connected = false
        try { await this.client?.close() }
        finally { await this.transport?.close(); await this.connection?.catch(() => {}) }
    }
}
