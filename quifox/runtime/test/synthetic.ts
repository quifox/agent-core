import { createServer } from 'node:http'
import { once } from 'node:events'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { AgentMessage, ToolCall } from '@quifox/agent-core'
import { defaultConfig, saveConfig, type RuntimeConfig } from '../src/config.js'
import { QuiFoxRuntime } from '../src/runtime.js'

export interface SyntheticRequest { model: string; reasoning_effort?: string; messages: AgentMessage[]; tools: { function: { name: string } }[] }
export interface SyntheticResponse { text?: string; calls?: ToolCall[]; status?: number }

/** A real local HTTP boundary; request assertions remain in the calling test, not server callbacks. */
export async function synthetic(reply: (request: SyntheticRequest, index: number) => SyntheticResponse | Promise<SyntheticResponse>,
    configure?: (config: RuntimeConfig) => void) {
    const requests: SyntheticRequest[] = []
    const server = createServer(async (request, response) => {
        try {
            let text = ''; for await (const chunk of request) text += chunk
            const input = JSON.parse(text) as SyntheticRequest; requests.push(input)
            const result = await reply(input, requests.length)
            response.writeHead(result.status ?? 200, { 'Content-Type': 'text/event-stream' })
            if (result.status && result.status !== 200) { response.end('Synthetic failure'); return }
            const delta = result.calls ? { tool_calls: result.calls.map((call, index) => ({ index, id: call.id, type: 'function', function: { name: call.name, arguments: JSON.stringify(call.input) } })) } : { content: result.text ?? 'done' }
            response.end(`data: ${JSON.stringify({ choices: [{ delta }] })}\n\ndata: ${JSON.stringify({ choices: [{ delta: {}, finish_reason: result.calls ? 'tool_calls' : 'stop' }] })}\n\ndata: [DONE]\n\n`)
        } catch { if (!response.headersSent) response.writeHead(500); response.end('Synthetic fixture failure') }
    })
    server.listen(0, '127.0.0.1'); await once(server, 'listening')
    const root = await mkdtemp(join(tmpdir(), 'quifox-synthetic-'))
    const config = defaultConfig(root)
    config.model = { provider: 'synthetic', model: 'synthetic', baseUrl: `http://127.0.0.1:${(server.address() as { port: number }).port}`,
        apiKey: 'synthetic-key', contextWindow: 100000, maxOutputTokens: 1024 }
    config.memory.generate = false; configure?.(config); await saveConfig(root, config)
    let runtime = await QuiFoxRuntime.open({ root, workspace: root, environment: {}, globalSkillsRoot: join(root, 'isolated') })
    return { root, requests, get runtime() { return runtime }, restart: async () => {
        await runtime.close(); runtime = await QuiFoxRuntime.open({ root, workspace: root, environment: {}, globalSkillsRoot: join(root, 'isolated') }); return runtime
    }, close: async () => { await runtime.close(); server.closeAllConnections(); server.close(); await rm(root, { recursive: true, force: true }) } }
}
