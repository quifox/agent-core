import type { ModelSettings } from '@quifox/agent-core'

import {
    createOpenAICompatibleProvider,
    type OpenAICompatibleProviderOptions
} from './openai-compatible.js'
import type { LanguageModelProvider } from './provider.js'

/** DeepSeek Provider 的连接配置；认证信息只应存在于可信宿主。 */
export type DeepSeekProviderOptions = Omit<
    OpenAICompatibleProviderOptions,
    'id' | 'assistantReasoningField'
>

/**
 * Explicit opt-in settings for the DeepSeek example, never automatic model metadata.
 * Callers must verify their endpoint's support and may override every value.
 */
export const DEEPSEEK_FLASH_HIGH_THINKING_SETTINGS = {
    maxOutputTokens: 65_536,
    reasoning: { type: 'effort', effort: 'high' },
    providerOptions: {
        thinking: { type: 'enabled' }
    }
} satisfies ModelSettings

/**
 * 创建 DeepSeek Chat Completions Provider。
 *
 * 该 Provider 复用 OpenAI-compatible 的 HTTP、SSE 和 Tool 解析，但在有 Tool
 * 的后续回合按 DeepSeek 要求回传 Assistant 的 reasoning_content 字段。
 *
 * @param options - DeepSeek endpoint、认证与宿主 Transport。
 * @returns 可按模型 ID 创建统一 LanguageModel 的 Provider 工厂。
 */
export function createDeepSeekProvider(
    options: DeepSeekProviderOptions
): LanguageModelProvider {
    return createOpenAICompatibleProvider({
        ...options,
        id: 'deepseek',
        assistantReasoningField: 'reasoning_content'
    })
}
