import { resolveModelCapabilities, resolveModelLimits } from '@quifox/agent-plugin-model'
import { reasoningEffortSchema } from './config.js'
import type { ModelCatalogView } from './protocol.js'

const object = (value: unknown): Record<string, unknown> => value !== null && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : {}

/** Only Chat-compatible providers and text/tool models are offered by this Host. */
export function modelCatalog(catalog: unknown, selected?: string): ModelCatalogView {
    const providers: ModelCatalogView['providers'] = [], models: ModelCatalogView['models'] = []
    for (const [id, raw] of Object.entries(object(catalog))) {
        const provider = object(raw)
        if (!['@ai-sdk/openai', '@ai-sdk/openai-compatible'].includes(String(provider.npm)) || typeof provider.api !== 'string') continue
        let baseUrl: string
        try { const url = new URL(provider.api); if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password) continue; url.search = ''; url.hash = ''; baseUrl = url.toString() } catch { continue }
        providers.push({ id, name: typeof provider.name === 'string' ? provider.name : id, baseUrl })
        if (id !== selected) continue
        for (const [modelId, value] of Object.entries(object(provider.models))) {
            const model = object(value), modalities = object(model.modalities)
            if (model.tool_call !== true || !Array.isArray(modalities.output) || !modalities.output.includes('text')) continue
            try {
                const capabilities = resolveModelCapabilities(catalog, id, modelId)
                const reasoningEfforts = capabilities.reasoningEfforts?.filter((effort): effort is NonNullable<ModelCatalogView['models'][number]['reasoningEfforts']>[number] => reasoningEffortSchema.safeParse(effort).success)
                models.push({ id: modelId, name: typeof model.name === 'string' ? model.name : modelId, ...resolveModelLimits(catalog, id, modelId),
                    ...(capabilities.reasoning === undefined ? {} : { reasoning: capabilities.reasoning }), ...(reasoningEfforts === undefined ? {} : { reasoningEfforts }),
                    ...(capabilities.source ? { reasoningSource: capabilities.source } : {}) })
            } catch { /* An invalid registry row is not offered as a usable connection. */ }
        }
    }
    return { providers: providers.sort((left, right) => left.name.localeCompare(right.name)), models: models.sort((left, right) => left.name.localeCompare(right.name)), source: 'models.dev', cached: providers.length > 0 }
}
