import type { ConversationMemory, MemoryNote, MemoryState, MemoryStore } from './contracts.js'

/** The last correction/forget that can invalidate a conversation's generated claims. */
export function maintenanceVersion(state: MemoryState, conversationId: string): number {
    let version = 0
    state.notes.forEach((note, index) => {
        if (note.kind !== 'remember' && (note.conversationId === undefined || note.conversationId === conversationId)) { version = index + 1 }
    })
    return version
}

/** Published globals cannot make an older, uncorrected conversation summary visible again. */
export function summaryVisible(state: MemoryState, memory: ConversationMemory): boolean {
    return !state.revoked.includes(memory.conversationId) && (memory.noteWatermark ?? 0) >= maintenanceVersion(state, memory.conversationId)
}

/** Preserve chronological corrections and later explicit reinstatement requests. */
export function maintenanceNotes(state: MemoryState, conversationId: string): Pick<MemoryNote, 'kind' | 'content' | 'createdAt'>[] {
    if (!maintenanceVersion(state, conversationId)) { return [] }
    return state.notes.filter(note => note.conversationId === undefined || note.conversationId === conversationId)
        .map(note => ({ kind: note.kind, content: note.content, createdAt: note.createdAt }))
}

/** Atomic owner-scoped edit; no mutation is published on false or failed compare-and-set. @param store - Host storage. @param ownerId - Trusted owner. @param edit - Candidate mutation. */
export async function updateMemoryState(store: MemoryStore, ownerId: string, edit: (state: MemoryState) => boolean): Promise<MemoryState | undefined> {
    for (let attempt = 0; attempt < 16; attempt += 1) {
        const current = await store.load(ownerId)
        const next = JSON.parse(JSON.stringify(current)) as MemoryState
        if (!edit(next)) { return undefined }
        next.revision = current.revision + 1
        if (await store.compareAndSet(ownerId, current.revision, next)) { return next }
    }
    throw new Error('Memory state changed repeatedly; retry the operation.')
}
