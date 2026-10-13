import { z } from 'zod'

/** Opaque creation-order pagination, independent of summaries. */
export const conversationListInputSchema = z.object({
    limit: z.number().int().min(1).max(100).default(20),
    cursor: z.string().min(1).max(2_000).optional(),
    query: z.string().max(500).optional()
}).strict()

/** Preserve the original tool payload so durable retries have the same identity and content. */
export const memoryNoteInputSchema = z.object({
    kind: z.enum(['remember', 'correct', 'forget']),
    content: z.string().min(1).max(6_000),
    conversationId: z.string().min(1).optional()
}).strict()

/** The service validates ownership and delivery identity; parsing never normalizes tool content. */
export const conversationSendInputSchema = z.object({
    conversationId: z.string().min(1),
    content: z.string().min(1).max(6_000)
}).strict()
