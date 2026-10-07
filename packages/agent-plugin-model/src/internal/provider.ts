import type { LanguageModel } from './model.js'

/**
 * Internal factory for protocol clients owned by model plugins.
 *
 * Agent Core never consumes this interface; model plugins create and own clients.
 */
export interface LanguageModelProvider {
    /** Internal provider identifier. */
    readonly id: string

    /**
     * Create a protocol client with shared connection settings.
     *
     * @param modelId - Model identifier accepted by the upstream service.
     * @returns Internal protocol client used by a model plugin.
     */
    languageModel(modelId: string): LanguageModel
}
