/** Supplied metadata describes capabilities, not endpoint availability or a generation default. */
export interface ModelCapabilities {
    reasoning?: boolean
    reasoningEfforts?: string[]
    source?: 'configuration' | 'models.dev'
}

/** Resolve only declared capabilities; a reasoning flag never implies particular effort levels. */
export function resolveModelCapabilities(catalog: unknown, provider: string, model: string, configured: { reasoningEfforts?: readonly string[] | undefined } = {}): ModelCapabilities {
    if (configured.reasoningEfforts !== undefined) return { reasoning: configured.reasoningEfforts.some(effort => effort !== 'none'), reasoningEfforts: [...configured.reasoningEfforts], source: 'configuration' }
    const object = (value: unknown): Record<string, unknown> => value !== null && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : {}
    const entry = object(object(object(object(catalog)[provider]).models)[model])
    if (entry.reasoning === false) return { reasoning: false, reasoningEfforts: [], source: 'models.dev' }
    return entry.reasoning === true ? { reasoning: true, source: 'models.dev' } : {}
}
