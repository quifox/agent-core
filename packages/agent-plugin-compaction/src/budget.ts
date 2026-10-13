/** Model capacity and the caller's optional earlier compaction limits. */
export interface CompactionBudgetOptions {
    modelContextWindow: number
    maxOutputTokens: number
    context?: number
    compactTokens?: number
    safetyTokens?: number
    modelInputTokens?: number
}

/** Limits consumed by the existing conversation compaction adapter. */
export interface CompactionBudget {
    contextWindow: number
    maxInputTokens: number
}

/**
 * Resolve input capacity without allowing configuration to enlarge model limits.
 * @param options - Model limits, output reservation and compaction settings.
 * @returns Effective model window and positive input trigger threshold.
 */
export function resolveCompactionBudget(options: CompactionBudgetOptions): CompactionBudget {
    for (const [name, value] of Object.entries(options)) {
        if (value === undefined) { continue }
        if (!Number.isSafeInteger(value) || (name === 'safetyTokens' ? value < 0 : value <= 0)) {
            throw new Error(`Invalid compaction capacity: ${name}.`)
        }
    }
    const contextWindow = Math.min(options.modelContextWindow, options.context ?? options.modelContextWindow)
    const maxInputTokens = Math.min(
        contextWindow - options.maxOutputTokens - (options.safetyTokens ?? 1024),
        options.compactTokens ?? Infinity,
        options.modelInputTokens ?? Infinity
    )
    if (!Number.isSafeInteger(maxInputTokens) || maxInputTokens <= 0) {
        throw new Error('Output reservation and safety margin exhaust the model context.')
    }
    return { contextWindow, maxInputTokens }
}
