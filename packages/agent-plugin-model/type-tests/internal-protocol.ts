import type { ModelEvent, ModelRequest } from '@quifox/agent-core'
import type { LanguageModel } from '../src/internal/model.js'

import {
    createOpenAICompatibleProvider,
    type HeaderSource,
    type HttpRequest,
    type HttpStreamResponse,
    type HttpTransport,
    type LanguageModelProvider,
    type ResponsesModelEvent
} from '../src/internal/index.js'

const transport: HttpTransport = {
    /**
     * 返回用于类型合同的最小字节流。
     *
     * @param request - 待发送的平台无关 HTTP 请求。
     * @returns 带有异步字节流的 HTTP 响应。
     */
    async stream(request: HttpRequest): Promise<HttpStreamResponse> {
        void request
        return {
            status: 200,
            headers: {},
            body: {
                /**
                 * 生成一个最小字节 chunk。
                 *
                 * @returns 可异步消费的字节流。
                 */
                async *[Symbol.asyncIterator](): AsyncGenerator<Uint8Array> {
                    yield new Uint8Array([1])
                }
            }
        }
    }
}

const provider: LanguageModelProvider = {
    id: 'type-test',
    /**
     * 创建一个最小语言模型。
     *
     * @param modelId - 供应商侧模型 ID。
     * @returns 满足 Agent Core 合同的模型。
     */
    languageModel(modelId: string): LanguageModel {
        return {
            provider: 'type-test',
            modelId,
            /**
             * 返回一个正常结束的模型流。
             *
             * @param request - Agent Core 组装的模型请求。
             * @returns 统一 ModelEvent 异步流。
             */
            async *stream(request: ModelRequest): AsyncGenerator<ModelEvent> {
                void request
                yield { type: 'finish', reason: 'stop' }
            }
        }
    }
}

const model: LanguageModel = provider.languageModel('model-id')
const headers: HeaderSource = async (request) => {
    void request
    return { authorization: 'Bearer type-test' }
}
const compatibleProvider: LanguageModelProvider =
    createOpenAICompatibleProvider({
        id: 'compatible-type-test',
        baseUrl: 'https://example.test/v1',
        transport,
        headers
    })
const compatibleModel: LanguageModel =
    compatibleProvider.languageModel('compatible-model')
const responsesFinish: ResponsesModelEvent = { type: 'finish', reason: 'stop', responseId: 'response-id' }
// @ts-expect-error Responses 完成事件必须携带服务端响应引用。
const invalidResponsesFinish: ResponsesModelEvent = { type: 'finish', reason: 'stop' }

void model
void compatibleModel
void transport
void responsesFinish
void invalidResponsesFinish
