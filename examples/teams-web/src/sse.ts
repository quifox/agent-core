import type { ServerResponse } from 'node:http'

interface Entry { id: number; frame: string }
interface Client { cursor: number; waiting: boolean }

/** 独立的展示出口；写缓冲压力由 drain 续传处理，不阻塞 Agent。 */
export class SseChannel {
    private sequence = 0
    private readonly history: Entry[] = []
    private readonly clients = new Map<ServerResponse, Client>()

    /** @param capacity - 展示缓存容量，不是业务邮箱。 */
    constructor(private readonly capacity = 5000) {}

    /** @param value - 即刻编码的展示事实。 */
    publish(value: unknown): void {
        const frame = `id: ${++this.sequence}\ndata: ${JSON.stringify(value)}\n\n`
        this.history.push({ id: this.sequence, frame })
        if (this.history.length > this.capacity) { this.history.shift() }
        for (const [response, client] of this.clients) { this.flush(response, client) }
    }

    /** @param response - 本次 SSE 连接。 @param after - 重连时最后收到的序号。 */
    connect(response: ServerResponse, after = 0): void {
        response.writeHead(200, { 'Content-Type': 'text/event-stream; charset=utf-8', 'Cache-Control': 'no-cache', 'Connection': 'keep-alive' })
        response.write(': connected\n\n')
        const client = { cursor: after, waiting: false }
        this.clients.set(response, client)
        response.on('error', () => { response.destroy() })
        const heartbeat = setInterval(() => {
            if (!client.waiting && !response.destroyed && !response.write(': heartbeat\n\n')) { this.waitForDrain(response, client) }
        }, 15_000)
        response.once('close', () => { clearInterval(heartbeat); this.clients.delete(response) })
        this.flush(response, client)
    }

    /** @param response - 独立连接。 @param client - 最后已交给 Node 写缓冲的事件序号。 */
    private flush(response: ServerResponse, client: Client): void {
        if (response.destroyed) { this.clients.delete(response); return }
        if (client.waiting) { return }
        const oldest = this.history[0]?.id
        if (oldest && client.cursor < oldest - 1) {
            response.write(`data: ${JSON.stringify({ kind: 'history-gap' })}\n\n`)
            client.cursor = oldest - 1
        }
        for (const entry of this.history) {
            if (entry.id <= client.cursor) { continue }
            // write=false 已接纳本帧，只要求暂停下一帧；不能销毁连接。
            client.cursor = entry.id
            if (!response.write(entry.frame)) {
                this.waitForDrain(response, client)
                return
            }
        }
    }

    /** @param response - 暂时写满的连接。 @param client - 共享写入状态。 */
    private waitForDrain(response: ServerResponse, client: Client): void {
        client.waiting = true
        response.once('drain', () => { client.waiting = false; this.flush(response, client) })
    }

    /** 释放展示连接，不取消 Agent。 */
    close(): void { for (const response of this.clients.keys()) { response.destroy() }; this.clients.clear() }
}
