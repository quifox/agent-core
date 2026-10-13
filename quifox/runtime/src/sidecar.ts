import { createInterface } from 'node:readline'
import { commandEnvelopeSchema, type EngineFrame, type RuntimeCommand } from './protocol.js'
import { QuiFoxRuntime } from './runtime.js'
import { commandSupervisor } from './process-supervisor.js'
import { displayFrame } from './display-projection.js'
import { PresentationBridge } from './presentation-host.js'

function argument(name: string): string | undefined { const index = process.argv.indexOf(name); return index < 0 ? undefined : process.argv[index + 1] }
let output = Promise.resolve()
function emit(frame: EngineFrame): Promise<void> {
    let line = `${JSON.stringify(displayFrame(frame))}\n`
    if (Buffer.byteLength(line) > 16 * 1024 * 1024) {
        if (frame.kind !== 'response') return Promise.resolve()
        line = `${JSON.stringify({ kind: 'response', id: frame.id, ok: false, error: '内容超过显示预算，请缩小消息或事件窗口后重试。' })}\n`
    }
    output = output.then(() => new Promise<void>((accept, reject) => { process.stdout.write(line, error => error ? reject(error) : accept()) }))
    return output
}

let runtime: QuiFoxRuntime | undefined
const presentation = new PresentationBridge(emit)
let closing: Promise<void> | undefined
async function close(): Promise<void> {
    closing ??= (async () => { presentation.close(); await runtime?.close(); await output.catch(() => {}) })()
    return closing
}
if (process.argv.includes('--quifox-supervisor')) {
    const input = JSON.parse(argument('--quifox-supervisor') ?? '{}') as { command: string; cwd: string }
    if (typeof input.command !== 'string' || typeof input.cwd !== 'string') throw new Error('Invalid command supervisor arguments.')
    await commandSupervisor(input.command, input.cwd)
} else {
process.stdout.on('error', () => { void close() })
process.on('SIGINT', () => { void close().finally(() => process.exit(0)) })
process.on('SIGTERM', () => { void close().finally(() => process.exit(0)) })

try {
    const root = argument('--root') ?? process.env.QUIFOX_ROOT
    const workspace = argument('--workspace') ?? process.env.QUIFOX_WORKSPACE ?? process.cwd()
    runtime = await QuiFoxRuntime.open({ presentation, ...(root ? { root } : {}), ...(workspace ? { workspace } : {}) })
    runtime.subscribe(event => { void emit({ kind: 'event', event }).catch(() => close()) })
    await emit({ kind: 'ready', protocol: 1 })
    const reader = createInterface({ input: process.stdin, crlfDelay: Infinity })
    const pending = new Map<string, { identity: string; promise: Promise<EngineFrame> }>()
    for await (const line of reader) {
        let id = 'invalid'
        try {
            const envelope = commandEnvelopeSchema.parse(JSON.parse(line)); id = envelope.id
            const identity = JSON.stringify(envelope.command)
            const existing = pending.get(id)
            if (existing && existing.identity !== identity) throw new Error('Command identity payload conflict.')
            let response = existing?.promise
            if (!response) {
                const command = envelope.command.type === 'submit' ? { ...envelope.command, messageId: envelope.command.messageId ?? id } : envelope.command
                response = runtime.command(command as RuntimeCommand).then(value => ({ kind: 'response', id: envelope.id, ok: true, value }) as EngineFrame,
                    () => ({ kind: 'response', id: envelope.id, ok: false, error: '操作未保存，请在本地日志查看原因。' }) as EngineFrame)
                pending.set(id, { identity, promise: response })
                if (pending.size > 500) pending.delete(pending.keys().next().value!)
            }
            void response.then(frame => emit(frame)).catch(() => close())
            if (envelope.command.type === 'close') { await response; reader.close(); break }
        } catch { await emit({ kind: 'response', id, ok: false, error: '命令格式或身份无效。' }) }
    }
    await close()
} catch {
    await emit({ kind: 'fatal', error: 'quifox 引擎无法打开配置或会话目录；请检查配置、归档和已有宿主。' }).catch(() => {})
    await close(); process.exitCode = 1
}
}
