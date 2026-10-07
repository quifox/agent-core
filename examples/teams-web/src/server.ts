import { createServer, type IncomingMessage, type ServerResponse } from 'node:http'
import { mkdirSync, createWriteStream, readFileSync } from 'node:fs'
import { resolve, dirname } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { z } from 'zod'
import { createAgent, type AgentPlugin } from '@quifox/agent-core'
import { ChatModelPlugin, type ChatModelPluginOptions } from '@quifox/agent-plugin-model'
import { ChatSessionPlugin, ChatConversationPlugin, type ChatInput } from '@quifox/agent-plugin-session'
import { createSystemPromptPlugin } from '@quifox/agent-plugin-system-prompt'
import { RunSteeringPlugin } from '@quifox/agent-plugin-steering'
import { EventPublisherPlugin, type PublishedEvent } from '@quifox/agent-plugin-events'
import { TeamsPlugin } from '@quifox/agent-plugin-teams'
import { SseChannel } from './sse.js'
import { DEFAULT_TASK, MEMBERS, type MemberId } from './shared.js'
import { ROLE_PROMPTS } from './task.js'

const runSchema = z.object({
    prompt: z.string().trim().min(1).max(6000),
    member: z.enum(['A', 'B', 'C', 'D']).default('A')
}).strict()
const directory = dirname(fileURLToPath(import.meta.url))
const memberIds = MEMBERS.map(member => member.id)

/** 模型连接留在服务端；测试可以注入可控 Adapter。 */
export interface DemoOptions {
    models: Record<MemberId, Omit<ChatModelPluginOptions, 'session'>>
    modelId: string
    logDirectory?: string
}

/** @param response - HTTP 输出。 @param status - 状态码。 @param value - 公开数据。 */
function json(response: ServerResponse, status: number, value: unknown): void {
    response.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' })
    response.end(JSON.stringify(value))
}

/** @param request - 有界的外部 JSON 输入。 */
async function body(request: IncomingMessage): Promise<unknown> {
    const chunks: Buffer[] = []
    let bytes = 0
    for await (const chunk of request) {
        const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(String(chunk))
        bytes += buffer.length
        if (bytes > 20_000) { throw new Error('请求内容过长。') }
        chunks.push(buffer)
    }
    return JSON.parse(Buffer.concat(chunks).toString('utf8')) as unknown
}

/** 一个长期服务端团队、四个独立事件出口和共享邮箱。 @param options - 服务端模型与可选展示记录目录。 */
export function createDemoServer(options: DemoOptions) {
    const channels = new Map(memberIds.map(id => [id, new SseChannel()]))
    const mailbox = new SseChannel()
    const teams = new TeamsPlugin()
    const controller = new AbortController()
    const agents = new Map<MemberId, ReturnType<typeof createAgent<ChatInput>>>()
    let inputSequence = 0
    const log = options.logDirectory ? (() => {
        mkdirSync(options.logDirectory!, { recursive: true })
        return createWriteStream(resolve(options.logDirectory!, `team-${Date.now()}.jsonl`))
    })() : undefined
    let logClosed = false
    log?.on('error', () => { logClosed = true })
    const record = (source: string, event: unknown): void => {
        if (!logClosed) { log?.write(`${JSON.stringify({ at: new Date().toISOString(), source, event })}\n`) }
    }
    const detachMailbox = teams.subscribe(event => {
        const at = new Date().toISOString()
        mailbox.publish({ kind: 'mailbox', at, event })
        record('mailbox', { at, event })
    })

    for (const definition of MEMBERS) {
        const session = new ChatSessionPlugin({ id: definition.id, ownerId: 'teams-web' })
        const conversation = new ChatConversationPlugin({ session, generation: new ChatModelPlugin({ session,
            ...options.models[definition.id], signal: () => controller.signal,
            settings: { maxOutputTokens: 16_384, providerOptions: { thinking: { type: 'disabled' } } } }) })
        let steps = 0
        const budget: AgentPlugin<ChatInput> = { id: 'demo-budget', hooks: {
            onRunStart: async () => { steps = 0; return { action: 'continue' } },
            beforeStep: async () => ++steps > 40
                ? { action: 'stop', reason: '展示单轮已达到步数预算。' }
                : { action: 'continue' }
        } }
        const events = new EventPublisherPlugin<ChatInput>({ sourceId: definition.id, publish: (event: PublishedEvent) => {
            channels.get(definition.id)!.publish({ kind: 'agent', at: new Date().toISOString(), value: event })
            record(definition.id, event)
        } })
        const identity = createSystemPromptPlugin(conversation, ROLE_PROMPTS[definition.id])
        const agent = createAgent<ChatInput>({ plugins: [
            new RunSteeringPlugin(), conversation, identity, budget, events, teams
        ] })
        teams.register(definition.id, agent, conversation)
        agents.set(definition.id, agent)
    }

    /** @param prompt - 新用户消息。 @param member - 直接接收消息的成员。 */
    function submit(prompt: string, member: MemberId): string {
        const id = `input-${++inputSequence}`
        const at = new Date().toISOString()
        mailbox.publish({ kind: 'input', at, id, member, prompt })
        record('input', { at, id, member, prompt })
        void agents.get(member)!.run({ prompt }).then(outcome => {
            const endedAt = new Date().toISOString()
            mailbox.publish({ kind: 'input-result', at: endedAt, id, member, ok: outcome.ok })
            record('input-result', { at: endedAt, id, member, ok: outcome.ok })
        }, () => {
            const endedAt = new Date().toISOString()
            mailbox.publish({ kind: 'input-result', at: endedAt, id, member, ok: false })
            record('input-result', { at: endedAt, id, member, ok: false })
        })
        return id
    }

    const server = createServer((request, response) => {
        void (async () => {
            if (!request.headers.host || !['127.0.0.1', 'localhost'].includes(request.headers.host.split(':')[0]!)) {
                json(response, 403, { error: '只接受本机地址。' }); return
            }
            const url = new URL(request.url ?? '/', 'http://127.0.0.1')
            if (request.method === 'GET' && url.pathname === '/api/config') {
                json(response, 200, {
                    members: MEMBERS,
                    model: options.modelId,
                    task: DEFAULT_TASK,
                    states: Object.fromEntries(memberIds.map(id => [id, teams.getStatus(id).state]))
                })
                return
            }
            if (request.method === 'GET' && url.pathname.startsWith('/events/')) {
                const id = url.pathname.slice('/events/'.length)
                const channel = id === 'mailbox' ? mailbox : channels.get(id as MemberId)
                if (!channel) { json(response, 404, { error: '事件来源不存在。' }); return }
                const after = Number(request.headers['last-event-id'] ?? 0)
                channel.connect(response, Number.isSafeInteger(after) && after >= 0 ? after : 0)
                return
            }
            if (request.method === 'POST' && url.pathname === '/api/runs') {
                const origin = request.headers.origin
                if (origin && origin !== `http://${request.headers.host}`) {
                    json(response, 403, { error: '只接受同源提交。' }); return
                }
                if (!request.headers['content-type']?.startsWith('application/json')) {
                    json(response, 415, { error: '请提交 JSON。' }); return
                }
                const parsed = runSchema.safeParse(await body(request))
                if (!parsed.success) { json(response, 400, { error: '请输入有效消息和成员。' }); return }
                json(response, 202, { accepted: true, id: submit(parsed.data.prompt, parsed.data.member) })
                return
            }
            const assets: Record<string, [string, string]> = {
                '/': [resolve(directory, '../public/index.html'), 'text/html; charset=utf-8'],
                '/style.css': [resolve(directory, '../public/style.css'), 'text/css; charset=utf-8'],
                '/ui.js': [resolve(directory, 'ui.js'), 'text/javascript; charset=utf-8'],
                '/shared.js': [resolve(directory, 'shared.js'), 'text/javascript; charset=utf-8']
            }
            const asset = request.method === 'GET' ? assets[url.pathname] : undefined
            if (asset) {
                response.writeHead(200, { 'Content-Type': asset[1] })
                response.end(readFileSync(asset[0]))
                return
            }
            json(response, 404, { error: '页面不存在。' })
        })().catch(() => {
            if (!response.headersSent) { json(response, 400, { error: '请求未能完成，请检查输入。' }) }
            else { response.end() }
        })
    })
    /** 关闭服务端连接与模型请求。 */
    function close(): void {
        controller.abort()
        detachMailbox()
        if (!logClosed) { logClosed = true; log?.end() }
        mailbox.close()
        for (const channel of channels.values()) { channel.close() }
        server.close()
    }
    return { server, close }
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
    const apiKey = process.env.MODEL_API_KEY
    const baseUrl = process.env.MODEL_BASE_URL
    const modelId = process.env.MODEL_ID
    if (!apiKey || !baseUrl || !modelId) { throw new Error('请通过服务端 ENV 配置模型 Key、地址和名称。') }
    const models = Object.fromEntries(memberIds.map(id => [id, { model: modelId, baseUrl, apiKey }])) as DemoOptions['models']
    const application = createDemoServer({ models, modelId,
        ...(process.env.TEAMS_RECORD_EVENTS === '1' ? { logDirectory: resolve(directory, '../artifacts') } : {}) })
    application.server.listen(Number(process.env.TEAMS_PORT ?? 18731), '127.0.0.1', () => {
        console.log(`Teams Web: http://127.0.0.1:${process.env.TEAMS_PORT ?? 18731} · model=${modelId}`)
    })
    process.once('SIGINT', application.close)
    process.once('SIGTERM', application.close)
}
