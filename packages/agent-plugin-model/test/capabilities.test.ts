import { expect, it } from 'vitest'
import { resolveModelCapabilities } from '../src/capabilities.js'

it('keeps effort levels unknown when models.dev only declares a reasoning flag', () => {
    const catalog = { synthetic: { models: { chat: { reasoning: true }, ordinary: { reasoning: false } } } }
    expect(resolveModelCapabilities(catalog, 'synthetic', 'chat')).toEqual({ reasoning: true, source: 'models.dev' })
    expect(resolveModelCapabilities(catalog, 'synthetic', 'ordinary')).toEqual({ reasoning: false, reasoningEfforts: [], source: 'models.dev' })
    expect(resolveModelCapabilities(catalog, 'synthetic', 'unknown')).toEqual({})
})

it('prefers explicit capabilities to automatic declarations without inventing a provider default', () => {
    const catalog = { synthetic: { models: { chat: { reasoning: false } } } }
    expect(resolveModelCapabilities(catalog, 'synthetic', 'chat', { reasoningEfforts: ['medium', 'xhigh'] })).toEqual({
        reasoning: true, reasoningEfforts: ['medium', 'xhigh'], source: 'configuration'
    })
    expect(resolveModelCapabilities({}, 'deepseek', 'deepseek-flash')).toEqual({})
    expect(resolveModelCapabilities({}, 'deepseek', 'unknown')).toEqual({})
})
