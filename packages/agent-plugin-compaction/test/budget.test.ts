import { expect, it } from 'vitest'
import { resolveCompactionBudget } from '../src/index.js'

it('caps user context at model capacity and allows an earlier compaction threshold', () => {
    expect(resolveCompactionBudget({ modelContextWindow: 10_000, context: 20_000,
        maxOutputTokens: 1_000, safetyTokens: 500, compactTokens: 7_000 }))
        .toEqual({ contextWindow: 10_000, maxInputTokens: 7_000 })
})

it('reserves output and safety margin after applying a smaller user context', () => {
    expect(resolveCompactionBudget({ modelContextWindow: 10_000, context: 8_000,
        maxOutputTokens: 1_000, safetyTokens: 500, compactTokens: 20_000 }))
        .toEqual({ contextWindow: 8_000, maxInputTokens: 6_500 })
})

it('honors an independent model input limit and the default safety reservation', () => {
    expect(resolveCompactionBudget({ modelContextWindow: 10_000, maxOutputTokens: 1_000 }))
        .toEqual({ contextWindow: 10_000, maxInputTokens: 7_976 })
    expect(resolveCompactionBudget({ modelContextWindow: 10_000, maxOutputTokens: 1_000,
        modelInputTokens: 5_000 })).toEqual({ contextWindow: 10_000, maxInputTokens: 5_000 })
})

it.each([
    { context: 0 }, { context: -1 }, { compactTokens: 0 }, { safetyTokens: -1 },
    { maxOutputTokens: 0 }, { maxOutputTokens: 9_000 }, { modelInputTokens: 0 }
])('rejects unusable compaction capacity %j before a request can be sent', override => {
    expect(() => resolveCompactionBudget({ modelContextWindow: 10_000, maxOutputTokens: 1_000, ...override }))
        .toThrow()
})
