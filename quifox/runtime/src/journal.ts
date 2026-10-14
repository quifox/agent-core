import { mkdir, open, readFile, readdir, truncate } from 'node:fs/promises'
import { join } from 'node:path'
import { isMissing } from './config.js'
import { applyStateChanges, stateChanges, stateRevision } from './state-delta.js'

export interface JournalRead { records: Record<string, unknown>[]; ignoredTail: boolean; validBytes: number; needsNewline: boolean }

/** One serialized writer per session; the Host must hold that session's cross-process lease. */
export class SessionJournal {
    private readonly queues = new Map<string, Promise<void>>()
    private readonly checked = new Set<string>()
    private readonly states = new Map<string, unknown>()

    constructor(readonly directory: string) {}

    path(id: string): string {
        if (!/^[A-Za-z0-9_-]{1,96}$/.test(id)) throw new Error('Invalid session identity.')
        return join(this.directory, `${id}.jsonl`)
    }

    async list(): Promise<string[]> {
        let names: string[]
        try { names = await readdir(this.directory) } catch (error) { if (isMissing(error)) return []; throw error }
        return names.filter(name => /^[A-Za-z0-9_-]{1,96}\.jsonl$/.test(name)).map(name => name.slice(0, -6)).sort()
    }

    async read(id: string, options?: { latestStateOnly?: boolean; onState?(state: unknown, line: number): void }): Promise<JournalRead> {
        let text: string
        try { text = await readFile(this.path(id), 'utf8') }
        catch (error) { if (isMissing(error)) return { records: [], ignoredTail: false, validBytes: 0, needsNewline: false }; throw error }
        const lines = text.split('\n')
        const records: Record<string, unknown>[] = []
        let validBytes = 0
        let ignoredTail = false
        let state: unknown
        let stateIndex = -1
        for (let index = 0; index < lines.length; index += 1) {
            const line = lines[index]!
            if (index === lines.length - 1 && !line) break
            try {
                const record: unknown = JSON.parse(line)
                if (!record || typeof record !== 'object' || Array.isArray(record)) throw new Error('Invalid JSONL record.')
                const entry = record as Record<string, unknown>
                if (entry.kind === 'state-delta') {
                    if (entry.version !== 1 || state === undefined || entry.baseRevision !== stateRevision(state)) throw new Error('Invalid state delta base.')
                    state = applyStateChanges(state, entry.changes)
                    options?.onState?.(state, index + 1)
                    if (options?.latestStateOnly && stateIndex >= 0) records[stateIndex] = { kind: 'discarded-state' }
                    records.push({ kind: 'state', state }); stateIndex = records.length - 1
                } else {
                    if (entry.kind === 'state') {
                        state = entry.state; options?.onState?.(state, index + 1)
                        if (options?.latestStateOnly && stateIndex >= 0) records[stateIndex] = { kind: 'discarded-state' }
                        stateIndex = records.length
                    }
                    records.push(entry)
                }
                validBytes += Buffer.byteLength(line + (index < lines.length - 1 ? '\n' : ''))
            } catch (error) {
                if (error instanceof SyntaxError && index === lines.length - 1 && !text.endsWith('\n')) { ignoredTail = true; break }
                throw new Error(`会话归档第 ${index + 1} 行损坏，未继续恢复。`, { cause: error })
            }
        }
        return { records: options?.latestStateOnly ? records.filter(record => record.kind !== 'discarded-state') : records, ignoredTail, validBytes, needsNewline: !ignoredTail && !!text && !text.endsWith('\n') }
    }

    async sourceLines(id: string): Promise<string[]> {
        const valid = await this.read(id, { latestStateOnly: true })
        const bytes = await readFile(this.path(id))
        const lines = bytes.subarray(0, valid.validBytes).toString('utf8').split('\n')
        if (lines.at(-1) === '') lines.pop()
        return lines
    }

    /** Write and sync a complete state/event record before acknowledging critical persistence. */
    append(id: string, record: Record<string, unknown>): Promise<void> {
        const path = this.path(id)
        const captured = JSON.parse(JSON.stringify(record)) as Record<string, unknown>
        const pending = (this.queues.get(id) ?? Promise.resolve()).catch(() => {}).then(async () => {
            await mkdir(this.directory, { recursive: true, mode: 0o700 })
            let prefix = ''
            if (!this.checked.has(id)) {
                const current = await this.read(id)
                if (current.ignoredTail) await truncate(path, current.validBytes)
                if (current.needsNewline) prefix = '\n'
                const state = [...current.records].reverse().find(record => record.kind === 'state')?.state
                if (state !== undefined) this.states.set(id, state)
                this.checked.add(id)
            }
            const previous = this.states.get(id)
            const stored = captured.kind === 'state' && previous !== undefined ? {
                kind: 'state-delta', version: 1, baseRevision: stateRevision(previous), changes: stateChanges(previous, captured.state)
            } : captured
            const line = `${JSON.stringify(stored)}\n`
            const handle = await open(path, 'a', 0o600)
            try { await handle.writeFile(prefix + line); await handle.sync(); if (captured.kind === 'state') this.states.set(id, captured.state) }
            catch (error) { this.invalidateWriter(id); throw error }
            finally { await handle.close() }
        })
        this.queues.set(id, pending)
        return pending
    }

    async flush(): Promise<void> { await Promise.all([...this.queues.values()]) }
    /** A newly acquired session lease must reload the last committed state before emitting another delta. */
    invalidateWriter(id: string): void { this.checked.delete(id); this.states.delete(id) }
}
