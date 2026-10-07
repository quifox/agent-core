import type { ModelEvent, ModelRequest } from '../../packages/agent-core/dist/index.js'
import type { ChatModelPluginOptions } from '../../packages/agent-plugin-model/dist/index.js'

export interface ScriptedModel {
    provider: string
    modelId: string
    stream(request: ModelRequest): AsyncIterable<ModelEvent>
}

export function chatModelOptions(source: ScriptedModel): Pick<ChatModelPluginOptions, 'model' | 'baseUrl' | 'transport'>
