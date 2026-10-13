import type { ConversationMemory, MemoryConversation } from './contracts.js'
import { redactMemorySecrets, truncateMemoryText, utf8Bytes } from './evidence.js'

/** Render deterministic navigation; model text supplies knowledge, never file identity. */
export function renderGlobalMemory(draft: string, memories: readonly ConversationMemory[]): string {
    const body = redactMemorySecrets(draft).replace(/^v1\r?\n\s*/, '').split(/^## What's in Memory\s*$/m)[0]!.trimEnd()
    if (utf8Bytes(body) > 8_000 || !['## User Profile', '## User preferences', '## General Tips'].every(heading => body.split('\n').includes(heading))) {
        throw new Error('Global memory needs the three semantic sections within 8000 UTF-8 bytes.')
    }
    let text = `v1\n\n${body}\n\n## What's in Memory\n`
    const ordered = [...memories].sort((a, b) => b.sourceUpdatedAt.localeCompare(a.sourceUpdatedAt) || a.conversationId.localeCompare(b.conversationId))
    for (const memory of ordered) {
        const title = navigationText(memory.title, 300)
        const description = navigationText(memory.description, 500)
        const entry = `- ${memory.path} — ${title}: ${description}; conversation_id=${memory.conversationId}\n`
        if (utf8Bytes(text + entry) >= 10_000) { break }
        text += entry
    }
    return validateGlobalMemory(text, memories)
}

/** Build a stable, time-prefixed identity; titles are deliberately not filename keys. @param conversation - Trusted source metadata. */
export function conversationMemoryPath(conversation: MemoryConversation): string {
    if (!/^[A-Za-z0-9_-]{1,64}$/.test(conversation.shortId)) { throw new Error('Invalid conversation short ID.') }
    const timestamp = new Date(conversation.createdAt).toISOString().replace(/:/g, '-').replace(/\.\d{3}Z$/, 'Z')
    return `conversations/${timestamp}-${conversation.shortId}.md`
}

/** Program-owned front matter always uses actual source identities. @param memory - Published summary. */
export function renderConversationMemory(memory: ConversationMemory): string {
    return ['---', `conversation_id: ${JSON.stringify(memory.conversationId)}`, `title: ${JSON.stringify(memory.title)}`,
        `description: ${JSON.stringify(memory.description)}`, `source_updated_at: ${JSON.stringify(memory.sourceUpdatedAt)}`,
        `source_revision: ${memory.sourceRevision}`, `sources:\n  - ref: ${JSON.stringify(memory.sourceRef)}`,
        `generated_at: ${JSON.stringify(memory.generatedAt)}`, '---', '', memory.summary, ''].join('\n')
}

/** Match v2 structure and validate exact supplied file pointers. @param text - Candidate. @param memories - Allowed published sources. */
export function validateGlobalMemory(text: string, memories: readonly ConversationMemory[]): string {
    const clean = redactMemorySecrets(text)
    if (utf8Bytes(clean) >= 10_000 || clean.split('\n')[0] !== 'v1' ||
        !['## User Profile', '## User preferences', '## General Tips', "## What's in Memory"].every(heading => clean.split('\n').some(line => line.trim() === heading))) {
        throw new Error('Invalid global memory format or UTF-8 budget.')
    }
    const paths = new Set(memories.map(memory => memory.path))
    const pointers = [
        ...[...clean.matchAll(/^\s*-\s+(conversations\/\S+)/gm)].map(match => match[1]!),
        ...[...clean.matchAll(/(?<!\\)\[[^\]\n]*\]\(([^)\s]+)\)/g)].map(match => match[1]!).filter(path => path.includes('conversations/'))
    ]
    for (const pointer of pointers) {
        if (!paths.has(pointer)) { throw new Error('Memory source pointers must be exact existing relative paths.') }
    }
    const ids = new Set(memories.map(memory => memory.conversationId))
    for (const match of clean.matchAll(/(?<!\\)\[memory:([^\]]+)\]/g)) {
        if (!ids.has(match[1]!)) { throw new Error('Global memory contains an unsupported conversation identifier.') }
    }
    return clean
}

/** Escape metadata as text so a title cannot create a second Markdown pointer. */
function navigationText(text: string, bytes: number): string {
    return truncateMemoryText(text.replace(/[\r\n]+/g, ' '), bytes).replace(/[\\[\]()*_`<>#]/g, '\\$&')
}
