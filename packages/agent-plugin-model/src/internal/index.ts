/** Implementation entry for cooperating model plugins; not an application API. */
export type { LanguageModel } from './model.js'
export { collectChatOutput, generateSummary } from './output.js'
export type {
    HttpRequest,
    HttpStreamResponse,
    HttpTransport
} from './http.js'
export { FetchHttpTransport } from './http.js'
export {
    createDeepSeekProvider,
    DEEPSEEK_FLASH_HIGH_THINKING_SETTINGS
} from './deepseek.js'
export type { DeepSeekProviderOptions } from './deepseek.js'
export { createOpenAICompatibleProvider } from './openai-compatible.js'
export type {
    HeaderResolver,
    HeaderSource,
    OpenAICompatibleProviderOptions
} from './openai-compatible.js'
export { createOpenAIResponsesProvider, toResponsesRequest } from './openai-responses.js'
export type { OpenAIResponsesProviderOptions, OpenAIResponsesRequestBody } from './openai-responses.js'
export type { LanguageModelProvider } from './provider.js'

export type { ResponsesModelRequest, ResponsesModelEvent, ResponsesLanguageModel, ResponsesProvider } from './openai-responses.js'

export { selectResponsesInputMessages } from './openai-responses.js'
