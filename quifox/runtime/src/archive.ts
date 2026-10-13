import { MemoryUnavailableError, type ConversationArchive, type MemoryConversation, type MemoryRecord, type SourceMatch } from '@quifox/agent-plugin-memory'
import type { SessionJournal } from './journal.js'

/** Source references are opaque session identities, never model-selected filesystem paths. */
export class HostArchive implements ConversationArchive {
    constructor(private readonly journal: SessionJournal, private readonly conversations: () => MemoryConversation[],
        private readonly deliver: (owner: string, from: string, to: string, content: string, id: string) => Promise<{ id: string; status: 'queued' }>) {}

    async list(ownerId: string): Promise<MemoryConversation[]> { return this.conversations().filter(item => item.ownerId === ownerId) }

    private async source(owner: string, ref: string): Promise<MemoryConversation> {
        const conversation = (await this.list(owner)).find(item => item.sourceRef === ref)
        if (!conversation) throw new MemoryUnavailableError()
        return conversation
    }

    async records(owner: string, ref: string): Promise<MemoryRecord[]> {
        const source = await this.source(owner, ref)
        const seen = new Set<string>()
        const result: MemoryRecord[] = []
        await this.journal.read(source.id, { latestStateOnly: true, onState: (input, line) => {
            const state = input as { session: { history: { id: string; message: MemoryRecord['message']; compaction?: unknown }[] }; origins: Record<string, MemoryRecord['origin']> }
            for (const entry of state.session.history) {
                if (seen.has(entry.id)) continue
                seen.add(entry.id)
                result.push({ id: entry.id, line, message: structuredClone(entry.message),
                    origin: entry.compaction ? 'memory' : state.origins[entry.id] ?? 'context' })
            }
        } })
        return result
    }

    async read(owner: string, ref: string, startLine: number, limit: number) {
        const source = await this.source(owner, ref)
        const lines = await this.journal.sourceLines(source.id)
        return { ref, startLine, lines: lines.slice(startLine - 1, startLine - 1 + limit), truncated: startLine - 1 + limit < lines.length }
    }

    async search(owner: string, query: string, limit: number, ids?: readonly string[]): Promise<SourceMatch[]> {
        const words = query.normalize('NFKC').toLocaleLowerCase().split(/\s+/).filter(Boolean)
        const matches: SourceMatch[] = []
        for (const source of (await this.list(owner)).filter(item => !ids || ids.includes(item.id))) {
            const lines = await this.journal.sourceLines(source.id)
            for (const [index, content] of lines.entries()) {
                const text = content.normalize('NFKC').toLocaleLowerCase()
                const score = words.filter(word => text.includes(word)).length
                const position = Math.max(0, Math.min(...words.filter(word => text.includes(word)).map(word => text.indexOf(word))) - 160)
                if (score) matches.push({ ref: source.sourceRef, conversationId: source.id, line: index + 1, title: source.title, content: content.slice(position, position + 1000), score })
            }
        }
        return matches.sort((a, b) => b.score - a.score || a.ref.localeCompare(b.ref) || (a.line ?? 0) - (b.line ?? 0)).slice(0, limit)
    }

    async send(owner: string, from: string, to: string, content: string, id: string) {
        await this.source(owner, `conversation:${from}`); await this.source(owner, `conversation:${to}`)
        return this.deliver(owner, from, to, content, id)
    }
}
