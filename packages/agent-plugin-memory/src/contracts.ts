import type { AgentMessage } from '@quifox/agent-core'

/** Trusted archive provenance; a user-shaped message is not necessarily human input. */
export type MemoryOrigin = 'human' | 'assistant' | 'other-agent' | 'commentary' | 'context' | 'tool' | 'memory' | 'system'

/** One immutable source record, with original JSONL identity and line number. */
export interface MemoryRecord {
    id: string
    line: number
    origin: MemoryOrigin
    message: AgentMessage
}

/** Authoritative conversation metadata supplied by the server. */
export interface MemoryConversation {
    id: string
    ownerId: string
    shortId: string
    title: string
    createdAt: string
    updatedAt: string
    sourceRef: string
    revision: number
    active: boolean
    generateMemory: boolean
}

/** A published, mechanically attributed conversation summary. */
export interface ConversationMemory {
    conversationId: string
    path: string
    title: string
    description: string
    summary: string
    sourceRef: string
    sourceUpdatedAt: string
    sourceRevision: number
    generatedAt: string
    usageCount: number
    noteWatermark?: number
    lastUsedAt?: string
}

/** Durable processing ownership; a stale worker cannot publish. */
export interface MemoryJob {
    token: string
    expiresAt: number
    retryAt: number
    watermark: number
    noteWatermark?: number
    error?: string
}

/** An explicit, append-only user correction. */
export interface MemoryNote {
    id: string
    createdAt: string
    kind: 'remember' | 'correct' | 'forget'
    content: string
    conversationId?: string
}

/** Single-owner persistent state; Markdown files are published projections. */
export interface MemoryState {
    revision: number
    summaries: Record<string, ConversationMemory>
    jobs: Record<string, MemoryJob>
    notes: MemoryNote[]
    revoked: string[]
    global: string
    consolidatedFingerprint: string
    consolidation?: MemoryJob
}

/** Host storage performs owner-scoped atomic compare-and-set, not model-directed I/O. */
export interface MemoryStore {
    load(ownerId: string): Promise<MemoryState>
    compareAndSet(ownerId: string, expectedRevision: number, next: MemoryState): Promise<boolean>
}

/** Bounded original-source read result. */
export interface SourceRead {
    ref: string
    startLine: number
    lines: string[]
    truncated: boolean
    /** UTF-16 position in the redacted physical line, when reading a fragment. */
    startOffset?: number
    lineFragment?: boolean
    nextLine?: number
    nextOffset?: number
    /** JSON maintenance data, or a bounded virtual reference readable with memory_read. */
    memoryUpdates?: string
}

/** Search results retain source identity and original line positions. */
export interface SourceMatch { ref: string; conversationId: string; line?: number; title?: string; content: string; score: number }

/** Server-owned Chat archives and persistent delivery. All arguments are user-scoped. */
export interface ConversationArchive {
    list(ownerId: string): Promise<MemoryConversation[]>
    records(ownerId: string, ref: string): Promise<MemoryRecord[]>
    read(ownerId: string, ref: string, startLine: number, limit: number): Promise<SourceRead>
    search(ownerId: string, query: string, limit: number, conversationIds?: readonly string[]): Promise<SourceMatch[]>
    send(ownerId: string, from: string, to: string, content: string, deliveryId: string): Promise<{ id: string; status: 'queued' | 'delivered' }>
}

/** Runtime policy mirrors Codex v2 defaults; time values use milliseconds. */
export interface MemoryPolicy {
    minIdleMs: number
    maxAgeMs: number
    maxUnusedMs: number
    maxConversations: number
    maxSummaries: number
    maxConcurrentExtractions: number
    inputTokens: number
    leaseMs: number
    retryMs: number
    maxConsolidationSteps: number
}

/** New state contains no unsupported user facts. */
export function emptyMemoryState(): MemoryState {
    return { revision: 0, summaries: {}, jobs: {}, notes: [], revoked: [], global: '', consolidatedFingerprint: '' }
}

/** Complete Codex-aligned defaults, overridden only by explicit host policy. */
export const DEFAULT_MEMORY_POLICY: Readonly<MemoryPolicy> = {
    minIdleMs: 6 * 3_600_000, maxAgeMs: 30 * 86_400_000, maxUnusedMs: 30 * 86_400_000,
    maxConversations: 16, maxSummaries: 256, maxConcurrentExtractions: 8,
    inputTokens: 150_000, leaseMs: 3_600_000, retryMs: 3_600_000, maxConsolidationSteps: 40
}
