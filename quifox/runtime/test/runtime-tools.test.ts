import { expect, it } from 'vitest'
import { createServer } from 'node:http'
import { once } from 'node:events'
import { mkdtemp, readFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { defaultConfig, saveConfig } from '../src/config.js'
import { QuiFoxRuntime } from '../src/runtime.js'
import type { RuntimeEvent, SessionView } from '../src/protocol.js'

it.each(['queue', 'steer'] as const)('executes an approved original tool, accepts %s at its boundary and persists actual tool receipts', async mode => {
    let requests = 0
    const inputs: { messages: { role: string; content: string }[]; tools: { function: { name: string } }[] }[] = []
    const server = createServer(async (request, response) => {
        let body = ''; for await (const chunk of request) body += chunk
        const input = JSON.parse(body) as { messages: { role: string; content: string }[]; tools: { function: { name: string } }[] }
        inputs.push(input)
        requests += 1
        response.writeHead(200, { 'Content-Type': 'text/event-stream' })
        const delta = requests === 1 ? { tool_calls: [{ index: 0, id: 'original-call', type: 'function', function: { name: 'write_file', arguments: JSON.stringify({ path: 'output.txt', content: 'actual content' }) } }] } :
            { content: requests === 2 ? 'written' : 'queued response' }
        response.end(`data: ${JSON.stringify({ choices: [{ delta }] })}\n\ndata: ${JSON.stringify({ choices: [{ delta: {}, finish_reason: requests === 1 ? 'tool_calls' : 'stop' }] })}\n\ndata: [DONE]\n\n`)
    })
    server.listen(0, '127.0.0.1'); await once(server, 'listening')
    const root = await mkdtemp(join(tmpdir(), 'quifox-tools-'))
    let runtime: QuiFoxRuntime | undefined
    try {
        const config = defaultConfig(root)
        config.model = { provider: 'synthetic', model: 'synthetic', baseUrl: `http://127.0.0.1:${(server.address() as { port: number }).port}`, apiKey: 'synthetic', contextWindow: 100000, maxOutputTokens: 1024 }
        config.memory.generate = false; await saveConfig(root, config)
        runtime = await QuiFoxRuntime.open({ root, workspace: root, environment: {}, globalSkillsRoot: join(root, 'isolated') })
        let approval!: (event: RuntimeEvent) => void
        const approved = new Promise<RuntimeEvent>(accept => { approval = accept })
        runtime.subscribe(event => { if (event.type === 'approval') approval(event) })
        const session = await runtime.command({ type: 'create' }) as SessionView
        await runtime.command({ type: 'submit', sessionId: session.id, prompt: 'write a file' })
        const event = await approved
        await expect(readFile(join(root, 'output.txt'), 'utf8')).rejects.toMatchObject({ code: 'ENOENT' })
        await runtime.command({ type: 'submit', sessionId: session.id, prompt: 'next turn', mode })
        await runtime.command({ type: 'approve', sessionId: session.id, approvalId: (event.data as { id: string }).id, approved: true })
        await runtime.waitForIdle(session.id)
        expect(await readFile(join(root, 'output.txt'), 'utf8')).toBe('actual content')
        const view = await runtime.command({ type: 'snapshot', sessionId: session.id }) as SessionView
        expect(view.status).toBe('idle'); expect(requests).toBe(mode === 'queue' ? 3 : 2)
        expect(inputs[1]!.messages.some(message => message.role === 'user' && message.content === 'next turn')).toBe(mode === 'steer')
        expect(inputs[0]!.tools.some(tool => tool.function.name === 'write_file')).toBe(true)
        expect(inputs[1]!.messages.some(message => message.role === 'tool' && message.content.includes('File written.'))).toBe(true)
        expect(view.messages.filter(item => item.message.role === 'user').map(item => item.message.content)).toEqual(['write a file', 'next turn'])
        expect(view.messages.find(item => item.message.role === 'tool')?.message).toMatchObject({ toolCallId: 'original-call', content: 'File written.' })
    } finally { await runtime?.close(); server.close(); await rm(root, { recursive: true, force: true }) }
})
