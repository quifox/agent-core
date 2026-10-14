import { z } from 'zod'

/** Actual model capacities; requested output and compaction settings are separate. */
export interface ModelLimits { contextWindow?: number; maxInputTokens?: number; maxOutputTokens?: number }

const capacity = z.number().int().positive().max(Number.MAX_SAFE_INTEGER)
const limits = z.object({ contextWindow: capacity.optional(), maxInputTokens: capacity.optional(), maxOutputTokens: capacity.optional() }).strict()
const catalogLimits = z.object({ context: capacity.optional(), input: capacity.optional(), output: capacity.optional() })

/** Resolve supplied models.dev data without network I/O; explicit local limits can only tighten known capacities. */
export function resolveModelLimits(catalog: unknown, provider: string, model: string, configured: ModelLimits = {}): ModelLimits {
    const entry = object(object(object(catalog)[provider]).models)[model]
    const raw = object(entry).limit
    const remote = raw === undefined ? {} : catalogLimits.parse(raw)
    const local = limits.parse(configured)
    const contextWindow = minimum(remote.context, local.contextWindow)
    const maxInputTokens = minimum(remote.input, local.maxInputTokens)
    const maxOutputTokens = minimum(remote.output, local.maxOutputTokens)
    return { ...(contextWindow === undefined ? {} : { contextWindow }), ...(maxInputTokens === undefined ? {} : { maxInputTokens }),
        ...(maxOutputTokens === undefined ? {} : { maxOutputTokens }) }
}

function object(value: unknown): Record<string, unknown> {
    return value !== null && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : {}
}

function minimum(left: number | undefined, right: number | undefined): number | undefined {
    return left === undefined ? right : right === undefined ? left : Math.min(left, right)
}
