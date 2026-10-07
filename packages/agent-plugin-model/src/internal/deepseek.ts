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
 * DeepSeek Flash 在 Chat Completions 中使用的高思考默认模型配置。
 *
 * 65,536 是 DeepSeek 当前 high thinking 的官方默认输出预算，而不是遗留的
 * 4K / 8K 经验值；总运行时长和 Agent 步数仍由调用方独立限制。
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
