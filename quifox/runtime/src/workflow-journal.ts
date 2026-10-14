import { closeSync, constants, fsyncSync, mkdirSync, openSync, readFileSync, truncateSync, writeFileSync } from 'node:fs'
import { dirname } from 'node:path'
import { z } from 'zod'
import { InMemoryJournalStore, type JournalStorePort } from '@quifox/workflow-engine'
export interface DurableWorkflowJournal extends JournalStorePort { readonly failure: unknown }

const operations = ['createRun', 'updateRunStatus', 'updateRunUsage', 'updateRunCaps', 'updateRunScript', 'putActor', 'putNode', 'appendEvent'] as const
const recordSchema = z.object({ version: z.literal(1), identity: z.string().regex(/^[a-f0-9]{64}$/), sequence: z.number().int().nonnegative(), operation: z.enum(operations), args: z.array(z.unknown()).min(1).max(3) }).strict()
const mutations = new Set<string>(operations)

/** Synchronous commit before the engine publishes a result; execution is owned by the outer Session lease. */
export function workflowJournal(path: string, identity: string, redact: <T>(value: T) => T, failed?: (cause: unknown) => void): DurableWorkflowJournal {
    const store = new InMemoryJournalStore()
    let sequence = 0, failure: unknown
    mkdirSync(dirname(path), { recursive: true, mode: 0o700 })
    try {
        const reader = openSync(path, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0))
        let text: string
        try { text = readFileSync(reader, 'utf8') } finally { closeSync(reader) }
        const lines = text.split('\n')
        let validBytes = 0
        for (const [index, line] of lines.entries()) {
            if (index === lines.length - 1) { if (line) truncateSync(path, validBytes); break }
            const record = recordSchema.parse(JSON.parse(line))
            if (record.identity !== identity || record.sequence !== sequence) throw new Error('工作流检查点身份或序列不一致。')
            const method: unknown = Reflect.get(store, record.operation)
            if (typeof method !== 'function') throw new Error('工作流检查点操作无效。')
            Reflect.apply(method, store, record.args)
            sequence++; validBytes += Buffer.byteLength(line + '\n')
        }
    } catch (cause) { if ((cause as NodeJS.ErrnoException).code !== 'ENOENT') throw cause }
    const commit = (operation: string, args: unknown[]): void => {
        if (failure) return
        let handle: number | undefined
        try {
            handle = openSync(path, constants.O_WRONLY | constants.O_CREAT | constants.O_APPEND | (constants.O_NOFOLLOW ?? 0), 0o600)
            writeFileSync(handle, JSON.stringify(redact({ version: 1, identity, sequence, operation, args })) + '\n'); fsyncSync(handle); sequence++
        } catch (cause) { failure = cause; failed?.(cause) }
        finally { if (handle !== undefined) try { closeSync(handle) } catch (cause) { if (!failure) { failure = cause; failed?.(cause) } } }
    }
    return new Proxy(Object.assign(store, { failure: undefined as unknown }), { get(target, key) {
        if (key === 'failure') return failure
        const value: unknown = Reflect.get(target, key)
        if (typeof value !== 'function') return value
        return (...args: unknown[]): unknown => { const result: unknown = Reflect.apply(value, target, args); if (mutations.has(String(key))) commit(String(key), args); return result }
    } })
}
