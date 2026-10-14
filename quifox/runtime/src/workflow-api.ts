import { createServer, type Server } from 'node:http'
import { once } from 'node:events'
import { randomBytes, timingSafeEqual } from 'node:crypto'
import { z } from 'zod'
import type { RuntimeCommand, SessionView } from './protocol.js'

export interface WorkflowDeployment { id: string; name: string; workspace: string; url: string; token: string }
export class WorkflowApi {
    private server: Server | undefined
    private closing = false
    private readonly sessions = new Set<string>()
    constructor(private readonly command: (command: RuntimeCommand) => Promise<unknown>, private readonly workflow: { name: string; script: string }, private readonly workspace: string) {}
    async start(): Promise<Pick<WorkflowDeployment, 'url' | 'token'>> {
        const token = randomBytes(32).toString('hex')
        this.server = createServer(async (request, response) => {
            response.setHeader('Content-Type', 'application/json')
            response.setHeader('Cache-Control', 'no-store')
            const supplied = Buffer.from(request.headers.authorization?.replace(/^Bearer /, '') ?? ''), expected = Buffer.from(token)
            if (supplied.length !== expected.length || !timingSafeEqual(supplied, expected)) { response.writeHead(401); response.end('{"error":"unauthorized"}'); return }
            try {
                if (this.closing) { response.writeHead(503); response.end('{"error":"service_closing"}'); return }
                const path = (request.url ?? '').split('?')[0]!, id = path.split('/')[2]
                if (request.method === 'POST' && path === '/runs') {
                    let bytes = 0
                    const chunks: Buffer[] = []
                    for await (const chunk of request) { const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(String(chunk)); bytes += buffer.length; if (bytes > 200000) throw new Error('Input exceeds budget.'); chunks.push(buffer) }
                    const text = Buffer.concat(chunks).toString('utf8')
                    const input = z.object({ question: z.string().trim().min(1).max(100000), sessionId: z.uuid().optional() }).strict().parse(JSON.parse(text))
                    if (input.sessionId && !this.sessions.has(input.sessionId)) { response.writeHead(404); response.end('{"error":"not_found"}'); return }
                    const sessionId = input.sessionId ?? (await this.command({ type: 'create', title: this.workflow.name, workspace: this.workspace, workflow: this.workflow }) as SessionView).id
                    this.sessions.add(sessionId)
                    if (this.closing) { await this.command({ type: 'stop', sessionId }); throw new Error('Service is closing.') }
                    await this.command({ type: 'submit', sessionId, prompt: input.question })
                    response.writeHead(202); response.end(JSON.stringify({ sessionId, status: 'accepted' })); return
                }
                if (!id || !this.sessions.has(id)) { response.writeHead(404); response.end('{"error":"not_found"}'); return }
                if (request.method === 'POST' && path === '/runs/' + id + '/stop') {
                    await this.command({ type: 'stop', sessionId: id }); response.end('{"status":"stop_requested"}'); return
                }
                if (request.method === 'GET' && path === '/runs/' + id) {
                    const view = await this.command({ type: 'snapshot', sessionId: id, traceOnly: true, eventLimit: 1000 }) as SessionView
                    response.end(JSON.stringify({ sessionId: id, status: view.status, output: view.messages.filter(entry => entry.message.role === 'assistant').at(-1)?.message.content ?? '', approvals: view.approvals.length, workflow: view.workflow, events: view.events.filter(event => event.type === 'workflow') })); return
                }
                response.writeHead(405); response.end('{"error":"method_not_allowed"}')
            } catch { response.writeHead(400); response.end('{"error":"operation_failed"}') }
        })
        this.server.listen(0, '127.0.0.1'); await once(this.server, 'listening')
        return { url: 'http://127.0.0.1:' + (this.server.address() as { port: number }).port, token }
    }
    async close(): Promise<void> {
        this.closing = true
        for (const id of this.sessions) await this.command({ type: 'stop', sessionId: id }).catch(() => {})
        const server = this.server; this.server = undefined
        if (server) { server.closeAllConnections(); await new Promise<void>((resolve, reject) => server.close(error => error ? reject(error) : resolve())) }
    }
}
