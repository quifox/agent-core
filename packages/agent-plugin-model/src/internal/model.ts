import type { ModelEvent, ModelRequest } from '@quifox/agent-core'

/** Internal protocol client. Agent Core never consumes this interface. */
export interface LanguageModel {
    provider: string
    modelId: string
    stream(request: ModelRequest): AsyncIterable<ModelEvent>
}
