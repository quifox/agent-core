// Adapted from OpenAI Codex rollout_input.rs, commit 806d9732, Apache-2.0.
// Modified for authoritative Chat provenance and portable TypeScript.
import type { MemoryRecord } from './contracts.js'

const OMITTED = '[... response items omitted ...]\n'
const TRUNCATED = '[... content truncated ...]'
const TIERS = ['human', 'assistant', 'other-agent', 'commentary', 'context', 'tool'] as const

/** Measure UTF-8 without requiring a Node or platform-specific encoder. @param value - Text. */
export function utf8Bytes(value: string): number {
    let result = 0
    for (const character of value) {
        const point = character.codePointAt(0)!
        result += point < 128 ? 1 : point < 2048 ? 2 : point < 65536 ? 3 : 4
    }
    return result
}

/** Keep bounded head/tail evidence with an explicit omission. @param value - Text. @param budget - UTF-8 bytes. */
export function truncateMemoryText(value: string, budget: number): string {
    if (utf8Bytes(value) <= budget) { return value }
    if (budget < utf8Bytes(TRUNCATED)) { return '' }
    const available = budget - utf8Bytes(TRUNCATED)
    const characters = Array.from(value)
    let head = ''; let tail = ''; let bytes = 0
    for (const character of characters) {
        if (bytes + utf8Bytes(character) > Math.floor(available / 2)) { break }
        head += character; bytes += utf8Bytes(character)
    }
    for (let index = characters.length - 1; index >= 0; index -= 1) {
        const character = characters[index]!
        if (bytes + utf8Bytes(character) > available) { break }
        tail = character + tail; bytes += utf8Bytes(character)
    }
    return head + TRUNCATED + tail
}

/** Remove credential-bearing text before model input or generated storage. @param text - Evidence or candidate. */
export function redactMemorySecrets(text: string): string {
    return text.replace(/\b(?:sk-[A-Za-z0-9_-]{16,}|Bearer\s+[A-Za-z0-9._~-]{12,})\b/gi, '[REDACTED_SECRET]')
        .replace(/([?&](?:token|api_key|access_token|signature|secret)=)[^\s&#"']+/gi, '$1[REDACTED_SECRET]')
        .replace(/((?:api[_-]?key|password|access[_-]?token|secret)\s*[=:]\s*["']?)[^\s,"'}]+/gi, '$1[REDACTED_SECRET]')
}

/** Selected input is not a claim that the original transcript was fully summarized. */
export interface SelectedMemoryEvidence { text: string; bytes: number; selectedIds: string[]; truncatedIds: string[] }

/** Apply v2 provenance/newest-first selection, then restore chronology. @param records - Original records. @param tokenBudget - Approximate input tokens. */
export function selectMemoryEvidence(records: readonly MemoryRecord[], tokenBudget: number): SelectedMemoryEvidence {
    if (!Number.isSafeInteger(tokenBudget) || tokenBudget <= 0) { throw new Error('Memory input budget must be a positive integer.') }
    const questions = new Map<string, string>()
    const rows: { id: string; tier: typeof TIERS[number]; text: string; truncated: boolean }[] = []
    for (const record of records) {
        if (record.origin === 'memory' || record.origin === 'system' || record.message.role === 'system') { continue }
        const { message } = record
        if (message.role === 'assistant' && record.origin === 'assistant') {
            for (const call of message.toolCalls ?? []) {
                if (call.name === 'request_user_input') { questions.set(call.id, JSON.stringify(call.input)) }
            }
        }
        let tier = record.origin as typeof TIERS[number]
        let question: string | undefined
        if ((record.origin === 'human' || record.origin === 'tool') && message.role === 'tool' && message.toolName === 'request_user_input' && questions.has(message.toolCallId)) {
            try {
                const reply: unknown = JSON.parse(message.content)
                if (reply && typeof reply === 'object' && 'answers' in reply && JSON.stringify(reply).match(/"answers"\s*:\s*\[\s*"[^"\s]/)) {
                    question = questions.get(message.toolCallId); tier = 'human'
                }
            } catch { /* An unrecognized tool result remains ordinary tool evidence. */ }
        }
        const clean = message.role === 'assistant'
            ? { role: message.role, content: message.content, ...(message.toolCalls ? { toolCalls: message.toolCalls } : {}) }
            : message
        const original = `[${tier}] source_id=${record.id}\n${question ? `Assistant question: ${question}\nHuman reply: ` : ''}${JSON.stringify(clean)}\n`
        const text = truncateMemoryText(redactMemorySecrets(original), tier === 'tool' ? 8_000 : 9_904)
        rows.push({ id: record.id, tier, text, truncated: text !== redactMemorySecrets(original) })
    }
    const budget = tokenBudget * 4
    let remaining = Math.max(0, budget - utf8Bytes(OMITTED))
    const selected = new Map<number, string>()
    const truncatedIds: string[] = []
    for (const tier of TIERS) {
        for (let index = rows.length - 1; index >= 0; index -= 1) {
            const row = rows[index]!
            if (row.tier !== tier || remaining <= utf8Bytes(OMITTED) + 96) { continue }
            const text = truncateMemoryText(row.text, remaining - utf8Bytes(OMITTED) - 96)
            if (!text) { continue }
            selected.set(index, text)
            remaining -= utf8Bytes(text) + utf8Bytes(OMITTED)
            if (row.truncated || text !== row.text) { truncatedIds.push(row.id) }
        }
    }
    let text = ''; let gap = false
    const selectedIds: string[] = []
    for (let index = 0; index < rows.length; index += 1) {
        const content = selected.get(index)
        if (content !== undefined) { text += content; selectedIds.push(rows[index]!.id); gap = false }
        else if (!gap) { text += OMITTED; gap = true }
    }
    if (utf8Bytes(text) > budget) { throw new Error('Selected memory evidence exceeds the input budget.') }
    return { text, bytes: utf8Bytes(text), selectedIds, truncatedIds }
}
