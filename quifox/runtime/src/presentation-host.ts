import type { PresentationReceipt } from '@quifox/agent-plugin-presentation'
import type { EngineFrame, PresentationReply, PresentationRequest } from './protocol.js'

export interface PresentationHost {
    open(request: PresentationRequest, signal?: AbortSignal): Promise<PresentationReceipt>
    confirm(requestId: string, reply: PresentationReply): void
}

/** UI requests use a separate channel identity so ordinary command processing never blocks. */
export class PresentationBridge implements PresentationHost {
    private readonly pending = new Map<string, { request: PresentationRequest; resolve(receipt: PresentationReceipt): void; reject(error: Error): void }>()
    private closed = false
    constructor(private readonly emit: (frame: EngineFrame) => Promise<void>, private readonly timeoutMs = 30_000) {}

    async open(request: PresentationRequest, signal?: AbortSignal): Promise<PresentationReceipt> {
        if (this.closed) throw new Error('展示宿主已关闭。')
        signal?.throwIfAborted()
        if (this.pending.has(request.id)) throw new Error('展示请求身份重复。')
        let timer: ReturnType<typeof setTimeout> | undefined
        const abort = (): void => {
            this.pending.get(request.id)?.reject(new Error('展示确认已取消；已经打开的视图或外部应用不会回滚。'))
            void this.emit({ kind: 'presentation-cancel', requestId: request.id }).catch(() => {})
        }
        try {
            return await new Promise<PresentationReceipt>((resolve, reject) => {
                this.pending.set(request.id, { request, resolve, reject })
                signal?.addEventListener('abort', abort, { once: true })
                timer = setTimeout(() => {
                    reject(new Error('界面未确认展示；视图或外部应用可能已打开，请核实后再重试。'))
                    void this.emit({ kind: 'presentation-cancel', requestId: request.id }).catch(() => {})
                }, this.timeoutMs)
                if (signal?.aborted) abort()
                else void this.emit({ kind: 'presentation', request }).catch(() => reject(new Error('展示连接失败，结果未确认。')))
            })
        } finally {
            if (timer) clearTimeout(timer)
            signal?.removeEventListener('abort', abort); this.pending.delete(request.id)
        }
    }

    confirm(requestId: string, reply: PresentationReply): void {
        const pending = this.pending.get(requestId)
        if (!pending) return
        if (!reply.ok) { pending.reject(new Error(reply.error)); return }
        const external = /^https?:\/\//i.test(pending.request.target)
        if (reply.receipt.target !== pending.request.target || (reply.receipt.destination === 'external') !== external) {
            const error = new Error('展示回执与请求不匹配，展示结果未确认。')
            pending.reject(error); throw error
        }
        pending.resolve(reply.receipt)
    }

    close(): void {
        this.closed = true
        for (const item of this.pending.values()) item.reject(new Error('展示窗口已关闭，结果未确认。'))
        this.pending.clear()
    }
}
