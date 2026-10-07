/** Platform-neutral HTTP request used inside model plugins. */
export interface HttpRequest {
    /** 完整请求地址。 */
    readonly url: string
    /** HTTP 方法；未指定时由 Transport 选择默认值。 */
    readonly method?: string
    /** 已归一为字符串的请求头。 */
    readonly headers?: Readonly<Record<string, string>>
    /** 当前 Provider 发送的 JSON 文本请求体。 */
    readonly body?: string
    /** 由调用方提供的取消信号。 */
    readonly signal?: AbortSignal
}

/** 平台无关的流式 HTTP 响应。 */
export interface HttpStreamResponse {
    /** HTTP 状态码。 */
    readonly status: number
    /** 已归一为小写字符串键值的响应头。 */
    readonly headers: Readonly<Record<string, string>>
    /** 按实际到达顺序产生的响应字节流。 */
    readonly body: AsyncIterable<Uint8Array>
}

/**
 * Provider 使用的最小流式 HTTP 宿主边界。
 *
 * 具体实现可以适配标准 Fetch、`wx.request` 或其他运行时网络 API；
 * Transport 不理解 ModelEvent 或 Agent 生命周期。
 */
export interface HttpTransport {
    /**
     * 发起请求并在宿主获得响应元数据后返回字节流。
     *
     * @param request - 平台无关的 HTTP 请求。
     * @returns 状态、响应头与异步字节流。
     */
    stream(request: HttpRequest): Promise<HttpStreamResponse>
}

/**
 * 将 Fetch Headers 转换为只读字符串记录。
 *
 * @param headers - Fetch 响应头。
 * @returns 键名已由 Headers 归一的普通对象。
 */
function headersToRecord(headers: Headers): Readonly<Record<string, string>> {
    const record: Record<string, string> = {}
    headers.forEach((value, key) => {
        record[key] = value
    })
    return record
}

/**
 * 将标准 ReadableStream 适配为 Provider 使用的异步字节流。
 *
 * @param stream - Fetch 响应的可读字节流。
 * @returns 按读取顺序产生 chunk 的异步生成器。
 */
async function* readableStreamToAsyncIterable(
    stream: ReadableStream<Uint8Array>
): AsyncGenerator<Uint8Array> {
    const reader = stream.getReader()
    let completed = false
    try {
        while (true) {
            const result = await reader.read()
            if (result.done) {
                completed = true
                return
            }
            yield result.value
        }
    } finally {
        try {
            if (!completed) {
                await reader.cancel()
            }
        } finally {
            reader.releaseLock()
        }
    }
}

/** 基于宿主标准 Fetch API 的流式 HTTP Transport。 */
export class FetchHttpTransport implements HttpTransport {
    /** 显式注入的 Fetch 实现；未提供时在请求阶段读取宿主全局值。 */
    private readonly fetcher: typeof fetch | undefined

    /**
     * 创建 Fetch Transport。
     *
     * @param fetcher - 可选的 Fetch 实现，用于宿主适配或测试。
     */
    constructor(fetcher?: typeof fetch) {
        this.fetcher = fetcher
    }

    /**
     * 使用 Fetch 发起请求并返回增量字节流。
     *
     * @param request - 平台无关的 HTTP 请求。
     * @returns Fetch 响应状态、响应头和异步字节流。
     */
    async stream(request: HttpRequest): Promise<HttpStreamResponse> {
        const fetcher = this.fetcher ?? globalThis.fetch?.bind(globalThis)
        if (typeof fetcher !== 'function') {
            throw new TypeError(
                'Current runtime does not provide fetch; inject a compatible HttpTransport'
            )
        }

        const init: RequestInit = {
            method: request.method ?? 'POST',
            ...(request.headers === undefined
                ? {}
                : { headers: request.headers }),
            ...(request.body === undefined ? {} : { body: request.body }),
            ...(request.signal === undefined ? {} : { signal: request.signal })
        }
        const response = await fetcher(request.url, init)
        if (!response.body) {
            throw new TypeError('Fetch response does not contain a readable body')
        }

        return {
            status: response.status,
            headers: headersToRecord(response.headers),
            body: readableStreamToAsyncIterable(response.body)
        }
    }
}
