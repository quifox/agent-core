import { expect, it } from 'vitest'
import { mkdtemp, readFile, rm } from 'node:fs/promises'
import { tmpdir, homedir } from 'node:os'
import { join } from 'node:path'
import { defaultConfig, loadConfig, publicConfig, runtimePaths, mergeConfig, selectModel } from '../src/config.js'

it('does not invent known-provider effort levels when the metadata API omits them', () => {
    const config = defaultConfig('/synthetic')
    expect(publicConfig(config).model).not.toHaveProperty('reasoningEfforts')
    config.model.reasoningEfforts = ['high', 'max']
    expect(() => selectModel(config, 'default', 'medium')).toThrow('不支持')
    expect(selectModel(config, 'default', 'max').model.reasoningEffort).toBe('max')
})

it('applies the global initial effort only to a supported model and preserves explicit capability overrides', () => {
    const config = defaultConfig('/synthetic')
    expect(selectModel(config).model.reasoningEffort).toBeUndefined()
    config.model.reasoningEfforts = ['high']
    expect(selectModel(config).model.reasoningEffort).toBe('high')
    config.model.reasoningEfforts = ['medium', 'xhigh']
    expect(selectModel(config).model.reasoningEffort).toBeUndefined()
    expect(selectModel(config, 'default', 'medium').model.reasoningEffort).toBe('medium')
    config.preferences.reasoningEffort = 'xhigh'
    expect(selectModel(config).model.reasoningEffort).toBe('xhigh')
    expect(publicConfig(config).model.reasoningSource).toBe('configuration')
    const automatic = mergeConfig(config, { model: { reasoningEfforts: null }, preferences: { reasoningEffort: 'high' } })
    expect(publicConfig(automatic).model).not.toHaveProperty('reasoningEfforts')
    const unknown = mergeConfig(automatic, { model: { provider: 'synthetic', model: 'unknown', contextWindow: 10000 } })
    expect(selectModel(unknown).model.reasoningEffort).toBeUndefined()
    expect(publicConfig(unknown).model).not.toHaveProperty('reasoningEfforts')
})

it('uses .quifox by default and loads an isolated JSON config without persisting environment secrets', async () => {
    expect(runtimePaths().root).toBe(join(homedir(), '.quifox'))
    const root = await mkdtemp(join(tmpdir(), 'quifox-config-'))
    try {
        const config = await loadConfig(root, '/synthetic/project', { MODEL_API_KEY: 'synthetic-secret', MODEL_ID: 'synthetic-model', MODEL_BASE_URL: 'https://model.test' })
        expect(config.model).toMatchObject({ model: 'synthetic-model', apiKey: 'synthetic-secret', baseUrl: 'https://model.test' })
        expect(await readFile(join(root, 'config.json'), 'utf8')).not.toContain('synthetic-secret')
        expect(JSON.stringify(publicConfig(config))).not.toContain('synthetic-secret')
    } finally { await rm(root, { recursive: true, force: true }) }
})

it('clears optional profile capacity and credentials while preserving omitted private fields', () => {
    const config = defaultConfig('/synthetic')
    config.models = [{ ...config.model, id: 'review', contextWindow: 1000, maxInputTokens: 900, apiKey: 'synthetic-private' }]
    const cleared = mergeConfig(config, { models: [{ id: 'review', contextWindow: null, maxInputTokens: null }] })
    expect(cleared.models[0]).not.toHaveProperty('contextWindow'); expect(cleared.models[0]).not.toHaveProperty('maxInputTokens')
    expect(cleared.models[0]?.apiKey).toBe('synthetic-private')
    expect(mergeConfig(config, { models: [{ id: 'review', model: 'another' }] }).models[0]).not.toHaveProperty('contextWindow')
    expect(mergeConfig(config, { models: [{ id: 'review', apiKey: null }] }).models[0]).not.toHaveProperty('apiKey')
})

it('does not carry connection credentials across a changed origin but preserves explicit replacements', () => {
    const config = defaultConfig('/synthetic')
    config.model.apiKey = 'synthetic-private'; config.model.providerOptions = { privateToken: 'synthetic-option' }
    config.models = [{ ...config.model, id: 'alternate' }]
    const changed = mergeConfig(config, { model: { baseUrl: 'https://another.test/v1' }, models: [{ id: 'alternate', baseUrl: 'https://another.test/v1' }] })
    for (const model of [changed.model, changed.models[0]]) { expect(model).not.toHaveProperty('apiKey'); expect(model).not.toHaveProperty('providerOptions') }
    expect(mergeConfig(config, { model: { baseUrl: 'https://another.test/v1', apiKey: 'explicit' } }).model.apiKey).toBe('explicit')
    expect(mergeConfig(config, { model: { baseUrl: 'https://api.deepseek.com/another-path' } }).model.apiKey).toBe('synthetic-private')
})

it('persists UI scale, MCP enabled state and disabled Skills through partial config merges', () => {
    const config = defaultConfig('/synthetic')
    expect(config.preferences.uiScale).toBe(1)
    expect(config.skills.disabled).toEqual([])

    config.mcp = [{ id: 'docs', enabled: true, transport: 'http', url: 'https://mcp.test', args: [] }]
    const changed = mergeConfig(config, {
        preferences: { uiScale: 1.2 },
        skills: { disabled: ['global-skills/code-review'] },
        mcp: [{ id: 'docs', enabled: false }]
    })
    expect(changed.preferences.uiScale).toBe(1.2)
    expect(changed.skills.disabled).toEqual(['global-skills/code-review'])
    expect(changed.mcp[0]).toMatchObject({ id: 'docs', enabled: false, url: 'https://mcp.test' })
    expect(changed).not.toHaveProperty('mcpDisabled')
    expect(() => mergeConfig(changed, { preferences: { uiScale: 1.8 } })).toThrow()
})
