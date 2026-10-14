import { mkdir, readFile, readdir, unlink } from 'node:fs/promises'
import { createHash } from 'node:crypto'
import { join } from 'node:path'
import { z } from 'zod'
import { emptyMemoryState, renderConversationMemory, type MemoryState, type MemoryStore } from '@quifox/agent-plugin-memory'
import { isMissing, writeAtomic } from './config.js'
import { withFileLease } from './leases.js'

const nonnegative = z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER)
const job = z.object({ token: z.string(), expiresAt: nonnegative, retryAt: nonnegative, watermark: nonnegative, noteWatermark: nonnegative.optional(), error: z.string().optional() }).strict()
const summary = z.object({ conversationId: z.string(), path: z.string().regex(/^conversations\/[A-Za-z0-9_.-]+\.md$/), title: z.string(), description: z.string(),
    summary: z.string(), sourceRef: z.string(), sourceUpdatedAt: z.string(), sourceRevision: nonnegative, generatedAt: z.string(), usageCount: nonnegative,
    noteWatermark: nonnegative.optional(), lastUsedAt: z.string().optional() }).strict()
const note = z.object({ id: z.string(), createdAt: z.string(), kind: z.enum(['remember', 'correct', 'forget']), content: z.string(), conversationId: z.string().optional() }).strict()
const stateSchema = z.object({ revision: nonnegative, summaries: z.record(z.string(), summary), jobs: z.record(z.string(), job),
    notes: z.array(note), revoked: z.array(z.string()), global: z.string(), consolidatedFingerprint: z.string(), consolidation: job.optional() }).strict()

/** State JSON is authoritative; familiar Markdown documents are published projections. */
export class FileMemoryStore implements MemoryStore {
    private readonly writers = new Map<string, Promise<void>>()

    constructor(private readonly root: string, private readonly onProjectionError?: () => void) {}

    directory(ownerId: string): string { return join(this.root, createHash('sha256').update(ownerId).digest('hex')) }

    async load(ownerId: string): Promise<MemoryState> {
        let text: string
        try { text = await readFile(join(this.directory(ownerId), 'state.json'), 'utf8') }
        catch (error) { if (isMissing(error)) return emptyMemoryState(); throw error }
        return stateSchema.parse(JSON.parse(text)) as MemoryState
    }

    async compareAndSet(ownerId: string, expectedRevision: number, next: MemoryState): Promise<boolean> {
        next = stateSchema.parse(next) as MemoryState
        if (next.revision !== expectedRevision + 1) throw new Error('Invalid memory revision transition.')
        let accepted = false
        const pending = (this.writers.get(ownerId) ?? Promise.resolve()).catch(() => {}).then(() => withFileLease(join(this.directory(ownerId), 'state.json'), async () => {
            const current = await this.load(ownerId)
            if (current.revision !== expectedRevision) return
            const directory = this.directory(ownerId)
            await mkdir(join(directory, 'conversations'), { recursive: true, mode: 0o700 })
            await writeAtomic(join(directory, 'state.json'), JSON.stringify(next))
            accepted = true
            try {
                await writeAtomic(join(directory, 'memory.md'), next.global)
                const keep = new Set<string>()
                for (const summary of Object.values(next.summaries)) {
                    if (!/^conversations\/[A-Za-z0-9_.-]+\.md$/.test(summary.path)) throw new Error('Invalid memory projection path.')
                    keep.add(summary.path.slice('conversations/'.length))
                    await writeAtomic(join(directory, summary.path), renderConversationMemory(summary))
                }
                for (const file of await readdir(join(directory, 'conversations'))) {
                    if (/^[A-Za-z0-9_.-]+\.md$/.test(file) && !keep.has(file)) await unlink(join(directory, 'conversations', file))
                }
            } catch { try { this.onProjectionError?.() } catch { /* Projection observers do not control CAS. */ } }
        }))
        this.writers.set(ownerId, pending)
        await pending
        return accepted
    }

    async flush(): Promise<void> { await Promise.all([...this.writers.values()]) }
}
