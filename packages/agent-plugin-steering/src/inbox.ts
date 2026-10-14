import { z } from 'zod'
import type { AgentHooks, AgentPlugin } from '@quifox/agent-core'
import { getConversation, type ChatInput } from '@quifox/agent-plugin-session'

const message = z.object({ id: z.string().min(1), prompt: z.string().min(1).refine(value => !!value.trim()),
    mode: z.enum(['steer', 'queue']), status: z.enum(['pending', 'staged', 'applied', 'cancelled']) }).strict()
const state = z.object({ version: z.literal(1), messages: z.array(message) }).strict().refine(value =>
    new Set(value.messages.map(item => item.id)).size === value.messages.length, 'Message identities must be unique.')

export type InboxMessage = z.infer<typeof message>
export type MessageInboxSnapshot = z.infer<typeof state>
export type MessageSubmission = Omit<InboxMessage, 'status'>

/** Owns message admission facts; the Host starts queued runs only after real Agent cleanup. */
export class MessageInboxPlugin implements AgentPlugin<ChatInput> {
    id = 'message-inbox'
    readonly hooks: AgentHooks<ChatInput>
    private readonly messages: InboxMessage[]

    constructor(snapshot: MessageInboxSnapshot = { version: 1, messages: [] }, options: { beforeAdmission?(): Promise<void> } = {}) {
        this.messages = state.parse(snapshot).messages
        this.hooks = {
            beforeModel: async ctx => {
                await options.beforeAdmission?.()
                const pending = this.messages.filter(item => item.status === 'pending' && item.mode === 'steer')
                if (pending.length) {
                    if (getConversation(ctx).conversation.appendSteeringMessages(pending.map(item => item.prompt))) {
                        for (const item of pending) item.status = 'staged'
                    }
                }
                return { action: 'continue' }
            },
            afterModel: async () => { this.commitStaged(); return { action: 'continue' } }
        }
    }

    /** Duplicate delivery of the same identity is idempotent; conflicting payloads are rejected. */
    post(input: MessageSubmission): InboxMessage {
        const next = message.parse({ ...input, status: 'pending' })
        const existing = this.messages.find(item => item.id === input.id)
        if (existing) {
            if (existing.prompt !== input.prompt || existing.mode !== input.mode) throw new Error('Message identity payload conflict.')
            return { ...existing }
        }
        this.messages.push(next)
        return { ...next }
    }

    /** Claim the next pending message after the previous run's stream has fully ended. */
    next(): InboxMessage | undefined {
        const next = this.messages.find(item => item.status === 'pending')
        if (!next) return undefined
        next.status = 'staged'
        return { ...next }
    }

    /** Host binds an already queued child input to its matching durable identity. */
    claim(id: string): InboxMessage | undefined {
        const next = this.messages.find(item => item.id === id && item.status === 'pending')
        if (!next) return undefined
        next.status = 'staged'; return { ...next }
    }

    /** Cancel only explicitly identified inputs that have not entered a Conversation request. */
    cancelPending(ids: readonly string[]): string[] {
        const selected = new Set(ids), cancelled: string[] = []
        for (const item of this.messages) if (item.status === 'pending' && selected.has(item.id)) { item.status = 'cancelled'; cancelled.push(item.id) }
        return cancelled
    }

    /** Promote a pending queue prefix without changing its durable delivery identities. */
    guideThrough(id: string): string[] {
        const end = this.messages.findIndex(item => item.id === id && item.status === 'pending' && item.mode === 'queue')
        if (end < 0) throw new Error('这条消息已进入请求，无法更改排队方式。')
        const guided: string[] = []
        for (const item of this.messages.slice(0, end + 1)) if (item.status === 'pending' && item.mode === 'queue') { item.mode = 'steer'; guided.push(item.id) }
        return guided
    }

    /** Host calls this only after atomically saving the matching Session snapshot. */
    commitStaged(): void { for (const item of this.messages) if (item.status === 'staged') item.status = 'applied' }

    /** Restore claims that were never admitted by Session, preserving original order. */
    restoreStaged(): void { for (const item of this.messages) if (item.status === 'staged') item.status = 'pending' }

    snapshot(): MessageInboxSnapshot { return { version: 1, messages: this.messages.map(item => ({ ...item })) } }

    /** Candidate paired with the next durable Session write; it does not change admission state. */
    committedSnapshot(): MessageInboxSnapshot {
        return { version: 1, messages: this.messages.map(item => ({ ...item, status: item.status === 'staged' ? 'applied' : item.status })) }
    }
}
