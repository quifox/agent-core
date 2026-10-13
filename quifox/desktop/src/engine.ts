import { Channel, invoke, isTauri } from '@tauri-apps/api/core'
import type { CommandEnvelope, EngineFrame, PresentationRequest, PresentationReply, RuntimeCommand, RuntimeEvent } from '@quifox/shared-runtime'
type Receipt = Extract<PresentationReply, { ok: true }>['receipt']
type PresentationHandler = (request: PresentationRequest, signal: AbortSignal) => Promise<Receipt>

export interface EnginePort { start(receive: (frame: EngineFrame) => void): Promise<void>; write(envelope: CommandEnvelope): Promise<void> }
const nativePort: EnginePort = {
    async start(receive) {
        if (!isTauri()) throw new Error('请通过 quifox Desktop 打开；浏览器预览没有原生引擎。')
        const onFrame = new Channel<EngineFrame>(); onFrame.onmessage = receive
        await invoke('engine_start', { onFrame })
    },
    async write(envelope) { await invoke('engine_command', { envelope }) }
}

/** Correlates command responses while real events arrive independently on the same Channel. */
export class DesktopEngine {
    private readiness: Promise<void> | undefined
    private failure: Error | undefined
    private generation = 0
    private readonly pending = new Map<string, { accept(value: unknown): void; reject(error: Error): void }>()
    private readonly listeners = new Set<(event: RuntimeEvent) => void>()
    private readonly faults = new Set<(error: string) => void>()
    private presenter: PresentationHandler | undefined
    private readonly presentations = new Map<string, AbortController>()

    constructor(private readonly port: EnginePort = nativePort) {}

    connect(): Promise<void> {
        if (this.readiness) return this.readiness
        const generation = ++this.generation
        this.readiness = new Promise<void>((accept, reject) => {
            const fail = (error: Error): void => {
                this.cancelPresentations()
                this.failure = error; reject(error)
                for (const pending of this.pending.values()) pending.reject(error)
                this.pending.clear()
                for (const listener of this.faults) try { listener(error.message) } catch { /* Observers do not own transport state. */ }
            }
            const timeout = setTimeout(() => fail(new Error('引擎连接超时。')), 20_000)
            void this.port.start(frame => {
                if (generation !== this.generation) return
                if (frame.kind === 'ready') { clearTimeout(timeout); accept() }
                else if (frame.kind === 'fatal') { clearTimeout(timeout); fail(new Error(frame.error)) }
                else if (frame.kind === 'event') { for (const listener of this.listeners) try { listener(frame.event) } catch { /* Observers cannot interrupt command receipts. */ } }
                else if (frame.kind === 'presentation') { this.present(frame.request) }
                else if (frame.kind === 'presentation-cancel') { this.presentations.get(frame.requestId)?.abort(); this.presentations.delete(frame.requestId) }
                else { const pending = this.pending.get(frame.id); if (!pending) return; this.pending.delete(frame.id); if (frame.ok) pending.accept(frame.value); else pending.reject(new Error(frame.error)) }
            }).catch(error => { clearTimeout(timeout); if (generation === this.generation) fail(error instanceof Error ? error : new Error('引擎连接失败。')) })
        })
        return this.readiness
    }

    async command(command: RuntimeCommand): Promise<unknown> {
        await this.connect()
        if (this.failure) throw this.failure
        const id = crypto.randomUUID()
        return new Promise<unknown>((accept, reject) => {
            this.pending.set(id, { accept, reject })
            void this.port.write({ id, command }).catch(error => { this.pending.delete(id); reject(error) })
        })
    }

    subscribe(listener: (event: RuntimeEvent) => void): () => void { this.listeners.add(listener); return () => this.listeners.delete(listener) }
    onError(listener: (error: string) => void): () => void { this.faults.add(listener); return () => this.faults.delete(listener) }
    onPresentation(handler: PresentationHandler): () => void {
        this.presenter = handler
        return () => { if (this.presenter === handler) { this.presenter = undefined; this.cancelPresentations() } }
    }
    private present(request: PresentationRequest): void {
        if (this.presentations.has(request.id)) return
        const controller = new AbortController(); this.presentations.set(request.id, controller)
        const work = this.presenter ? this.presenter(request, controller.signal) : Promise.reject(new Error('GUI 展示面板尚未就绪。'))
        void work.then(receipt => ({ ok: true, receipt }) as PresentationReply, cause => ({ ok: false, error: cause instanceof Error ? cause.message : '界面未确认展示。' }) as PresentationReply)
            .then(async reply => {
                if (!controller.signal.aborted && !this.failure) await this.command({ type: 'presentation-reply', requestId: request.id, reply })
            }).catch(cause => { for (const listener of this.faults) try { listener(cause instanceof Error ? cause.message : '展示回执发送失败。') } catch { /* Observation only. */ } })
            .finally(() => { if (this.presentations.get(request.id) === controller) this.presentations.delete(request.id) })
    }
    private cancelPresentations(): void {
        for (const [requestId, controller] of this.presentations) {
            controller.abort()
            void this.port.write({ id: crypto.randomUUID(), command: { type: 'presentation-reply', requestId,
                reply: { ok: false, error: '展示连接已结束，结果未确认；已打开的视图或外部应用不会回滚。' } } }).catch(() => {})
        }
        this.presentations.clear()
    }
    reconnect(): Promise<void> {
        this.cancelPresentations()
        for (const pending of this.pending.values()) pending.reject(new Error('引擎正在重新连接；请核对已提交操作的实际状态。'))
        this.pending.clear(); this.readiness = undefined; this.failure = undefined
        return this.connect()
    }
}
