import { expect, it } from 'vitest'
import { resolveModelLimits } from '../src/limits.js'

it('resolves models.dev limits and keeps known model capacities as ceilings for local configuration', () => {
    const catalog = { provider: { models: { chat: { limit: { context: 10000, input: 8000, output: 2000 } } } } }
    expect(resolveModelLimits(catalog, 'provider', 'chat', { contextWindow: 20000, maxInputTokens: 6000 })).toEqual({
        contextWindow: 10000, maxInputTokens: 6000, maxOutputTokens: 2000
    })
})

it('keeps absent capacities unknown and permits explicit local fallback for an unknown model', () => {
    expect(resolveModelLimits({}, 'provider', 'unknown')).toEqual({})
    expect(resolveModelLimits({}, 'provider', 'unknown', { contextWindow: 8000 })).toEqual({ contextWindow: 8000 })
})

it.each([0, -1, NaN, Infinity, 1.5])('rejects invalid configured context capacity %s', contextWindow => {
    expect(() => resolveModelLimits({}, 'provider', 'unknown', { contextWindow })).toThrow()
})
