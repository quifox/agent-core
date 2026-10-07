import type {
    HttpRequest,
    HttpStreamResponse,
    HttpTransport
} from './http.js'

/** 微信小程序响应头事件。 */
export interface WeappHeadersReceived {
    /** 开发者服务器返回的响应头。 */
    readonly header: Readonly<Record<string, string>>
    /** 响应状态码；微信开发者工具的 headers 事件可能缺失。 */
    readonly statusCode?: number
}

/** 微信小程序分块响应事件。 */
export interface WeappChunkReceived {
    /** 本次到达的原始字节。 */
    readonly data: ArrayBuffer
}

/** 微信小程序请求成功回调参数。 */
export interface WeappRequestSuccess {
    /** 完整响应数据；只在未触发 chunk 事件时作为字节兜底。 */
    readonly data: ArrayBuffer
    /** HTTP 状态码。 */
    readonly statusCode: number
    /** 开发者服务器返回的响应头。 */
    readonly header: Readonly<Record<string, string>>
}

/** 微信小程序请求失败回调参数。 */
export interface WeappRequestFailure {
    /** 微信网络层错误文本。 */
    readonly errMsg: string
    /** 可选的微信 errno。 */
    readonly errno?: number
}

/** Provider 所需的最小 `wx.request` 选项形状。 */
export interface WeappRequestOptions {
    /** 请求地址。 */
    readonly url: string
    /** HTTP 方法。 */
    readonly method?: string
    /** 微信 API 使用的请求头字段。 */
    readonly header?: Readonly<Record<string, string>>
    /** JSON 文本请求体。 */
    readonly data?: string
    /** 要求微信以 ArrayBuffer 返回响应。 */
    readonly responseType: 'arraybuffer'
    /** 要求微信开启 chunked response 事件。 */
    readonly enableChunked: true
    /**
     * 请求完整结束后的成功回调。
     *
     * @param response - 微信请求的最终响应。
     */
    readonly success: (response: WeappRequestSuccess) => void
    /**
     * 请求失败后的回调。
     *
     * @param failure - 微信网络层失败信息。
     */
    readonly fail: (failure: WeappRequestFailure) => void
}

/** Provider 所需的最小微信 RequestTask 形状。 */
export interface WeappRequestTask {
    /** 中止当前请求。 */
    abort(): void
    /**
     * 注册 HTTP 响应头监听器。
     *
     * @param listener - 响应头到达时的回调。
     */
    onHeadersReceived?(listener: (event: WeappHeadersReceived) => void): void
    /**
     * 注册 chunked response 监听器。
     *
     * @param listener - 单个字节 chunk 到达时的回调。
     */
    onChunkReceived?(listener: (event: WeappChunkReceived) => void): void
}

/** 微信流式请求在首个响应字节到达前允许等待的时长。 */
export interface WeappStreamTimeoutOptions {
    /** 首个响应字节的最长等待毫秒数；未设置时不额外限制。 */
    readonly firstByteTimeoutMs?: number
    /** 两个相邻响应字节 chunk 的最长静默毫秒数；未设置时不额外限制。 */
    readonly idleChunkTimeoutMs?: number
}

/** 一个字节块的无正文协议形状。 */
export interface WeappByteChunkShape {
    /** 字节块总长度。 */
    readonly byteLength: number
    /** ASCII LF 字节数，用于验证 SSE 行边界没有在传输层丢失。 */
    readonly lineFeedCount: number
}

/** 不暴露响应正文的微信字节流生命周期观察者。 */
export interface WeappByteStreamObserver {
    /** 已从微信回调隔离并接受进队列的一个字节 chunk。 */
    onChunkQueued?(chunk: WeappByteChunkShape): void
    /** Provider 即将从队列交给 SSE 解析器的一个字节 chunk。 */
    onChunkRead?(chunk: WeappByteChunkShape): void
}

/**
 * 可注入的微信小程序请求函数。
 *
 * @param options - Provider 组装的最小请求选项。
 * @returns 支持 Abort 和 chunk 事件的 RequestTask。
 */
export type WeappRequest = (options: WeappRequestOptions) => WeappRequestTask

interface ByteWaiter {
    /**
     * 向等待者提交下一个迭代结果。
     *
     * @param result - 字节 chunk 或队列完成标记。
     */
    readonly resolve: (result: IteratorResult<Uint8Array>) => void
    /**
     * 以队列终端错误拒绝等待者。
     *
     * @param reason - Transport 或 Abort 产生的失败原因。
     */
    readonly reject: (reason?: unknown) => void
}

const NO_FAILURE = Symbol('NO_FAILURE')

/** 将回调式 chunk 转换为可等待的异步字节流。 */
class AsyncByteQueue implements AsyncIterableIterator<Uint8Array> {
    /** 尚未被消费的字节 chunk。 */
    private readonly chunks: Uint8Array[] = []
    /** 正在等待下一个 chunk 的消费者。 */
    private readonly waiters: ByteWaiter[] = []
    /** 当前队列是否已正常结束。 */
    private closed = false
    /** 当前队列的终端错误，或未失败哨兵值。 */
    private failure: unknown = NO_FAILURE;
    /** 可选的无正文生命周期观察者。 */
    private readonly observer: WeappByteStreamObserver | undefined

    constructor(observer: WeappByteStreamObserver | undefined) {
        this.observer = observer
    }

    /**
     * 返回队列自身作为异步迭代器。
     *
     * @returns 当前字节队列。
     */
    [Symbol.asyncIterator](): AsyncIterableIterator<Uint8Array> {
        return this
    }

    /**
     * 读取下一个 chunk，或等待队列结束。
     *
     * @returns 下一个字节 chunk 或完成标记。
     */
    next(): Promise<IteratorResult<Uint8Array>> {
        const chunk = this.chunks.shift()
        if (chunk !== undefined) {
            this.notifyChunkRead(chunk)
            return Promise.resolve({ value: chunk, done: false })
        }
        if (this.failure !== NO_FAILURE) {
            return Promise.reject(this.failure)
        }
        if (this.closed) {
            return Promise.resolve({ value: undefined, done: true })
        }
        return new Promise<IteratorResult<Uint8Array>>((resolve, reject) => {
            this.waiters.push({ resolve, reject })
        })
    }

    /**
     * 向队列写入一个字节 chunk。
     *
     * @param chunk - 刚从微信回调收到的字节。
     */
    push(chunk: Uint8Array): void {
        if (this.closed || this.failure !== NO_FAILURE) {
            return
        }
        const waiter = this.waiters.shift()
        this.notifyChunkQueued(chunk)
        if (waiter) {
            this.notifyChunkRead(chunk)
            waiter.resolve({ value: chunk, done: false })
            return
        }
        this.chunks.push(chunk)
    }

    /** 将观察者异常隔离在主网络流程之外。 */
    private notifyChunkQueued(chunk: Uint8Array): void {
        try {
            this.observer?.onChunkQueued?.(describeChunk(chunk))
        } catch {
            // 观察者只是诊断辅助，不能影响真实模型流。
        }
    }

    /** 将观察者异常隔离在主网络流程之外。 */
    private notifyChunkRead(chunk: Uint8Array): void {
        try {
            this.observer?.onChunkRead?.(describeChunk(chunk))
        } catch {
            // 观察者只是诊断辅助，不能影响真实模型流。
        }
    }

    /** 正常关闭队列并唤醒所有等待者。 */
    close(): void {
        if (this.closed || this.failure !== NO_FAILURE) {
            return
        }
        this.closed = true
        for (const waiter of this.waiters.splice(0)) {
            waiter.resolve({ value: undefined, done: true })
        }
    }

    /**
     * 以错误终止队列并拒绝所有等待者。
     *
     * @param error - 需要传递给消费者的终端错误。
     */
    fail(error: unknown): void {
        if (this.closed || this.failure !== NO_FAILURE) {
            return
        }
        this.failure = error
        for (const waiter of this.waiters.splice(0)) {
            waiter.reject(error)
        }
    }
}

/**
 * 将微信响应头键名归一为小写。
 *
 * @param headers - 微信回调返回的响应头。
 * @returns 键名为小写的独立响应头记录。
 */
function normalizeHeaders(
    headers: Readonly<Record<string, string>>
): Readonly<Record<string, string>> {
    const normalized: Record<string, string> = {}
    for (const [key, value] of Object.entries(headers)) {
        normalized[key.toLowerCase()] = value
    }
    return normalized
}

/**
 * 读取 AbortSignal 的终止原因。
 *
 * @param signal - 已终止的请求信号。
 * @returns 调用方原始 reason，或稳定的兜底 Error。
 */
function abortReason(signal: AbortSignal): unknown {
    return signal.reason ?? new Error('Request aborted')
}

/**
 * 将微信失败回调转换为标准 Error。
 *
 * @param failure - 微信网络层失败信息。
 * @returns 保留原始回调作为 cause 的错误。
 */
function requestFailureError(failure: WeappRequestFailure): Error {
    return new Error(failure.errMsg, { cause: failure })
}

/**
 * 复制微信回调临时持有的 ArrayBuffer，避免 RequestTask 在回调返回后复用底层字节。
 *
 * @param data - 当前 headers/chunk/success 回调给出的原始字节。
 * @returns 可安全跨异步边界消费的独立字节数组。
 */
function copyResponseBytes(data: ArrayBuffer): Uint8Array {
    return new Uint8Array(new Uint8Array(data))
}

/** 提取不含正文的 SSE 行边界统计。 */
function describeChunk(chunk: Uint8Array): WeappByteChunkShape {
    let lineFeedCount = 0
    for (const byte of chunk) {
        if (byte === 0x0A) {
            lineFeedCount += 1
        }
    }
    return { byteLength: chunk.byteLength, lineFeedCount }
}

/** 使用注入 `wx.request` 形状的微信小程序流式 Transport。 */
export class WeappHttpTransport implements HttpTransport {
    /** 宿主提供的微信请求函数。 */
    private readonly requester: WeappRequest
    /** 仅约束网络静默，不限制持续产出字节的流总时长。 */
    private readonly timeoutOptions: WeappStreamTimeoutOptions
    /** 可选的无正文传输边界观察者。 */
    private readonly observer: WeappByteStreamObserver | undefined

    /**
     * 创建不读取全局 `wx` 的微信 Transport。
     *
     * @param requester - 宿主注入的 `wx.request` 适配函数。
     * @param timeoutOptions - 可选的首字节等待上限。
     */
    constructor(
        requester: WeappRequest,
        timeoutOptions: WeappStreamTimeoutOptions = {},
        observer?: WeappByteStreamObserver
    ) {
        this.requester = requester
        this.timeoutOptions = timeoutOptions
        this.observer = observer
    }

    /**
     * 通过 chunked `wx.request` 发起请求并返回异步字节流。
     *
     * @param request - Provider 组装的平台无关请求。
     * @returns 在已知 HTTP 状态后可立即消费的字节流。
     */
    async stream(request: HttpRequest): Promise<HttpStreamResponse> {
        if (request.signal?.aborted) {
            throw abortReason(request.signal)
        }

        const queue = new AsyncByteQueue(this.observer)
        let task: WeappRequestTask | undefined
        let responseSettled = false
        let terminal = false
        let abortCalled = false
        let firstByteTimeout: ReturnType<typeof setTimeout> | undefined
        let idleChunkTimeout: ReturnType<typeof setTimeout> | undefined

        return new Promise<HttpStreamResponse>((resolve, reject) => {
            /** 移除当前请求注册的 Abort 监听器。 */
            const cleanup = (): void => {
                request.signal?.removeEventListener('abort', onAbort)
                if (firstByteTimeout !== undefined) {
                    clearTimeout(firstByteTimeout)
                    firstByteTimeout = undefined
                }
                if (idleChunkTimeout !== undefined) {
                    clearTimeout(idleChunkTimeout)
                    idleChunkTimeout = undefined
                }
            }

            /** 使微信 RequestTask 至多执行一次 abort。 */
            const abortTask = (): void => {
                if (!abortCalled) {
                    abortCalled = true
                    try {
                        task?.abort()
                    } catch {
                        // 请求终态已先确定，宿主清理失败不得覆盖原始原因。
                    }
                }
            }

            /**
             * 在状态码可靠时只解析一次响应 Promise。
             *
             * @param status - HTTP 状态码。
             * @param headers - 已归一的响应头。
             */
            const resolveResponse = (
                status: number,
                headers: Readonly<Record<string, string>>
            ): void => {
                if (responseSettled) {
                    return
                }
                responseSettled = true
                resolve({ status, headers, body: queue })
            }

            /**
             * 以同一错误收口响应 Promise 或已返回的字节流。
             *
             * @param error - 终止请求的原始错误。
             */
            const fail = (error: unknown): void => {
                if (terminal) {
                    return
                }
                terminal = true
                cleanup()
                if (responseSettled) {
                    queue.fail(error)
                } else {
                    reject(error)
                }
            }

            /** 每个已到达的 chunk 都重新开始流静默计时。 */
            const armIdleChunkTimeout = (): void => {
                if (this.timeoutOptions.idleChunkTimeoutMs === undefined) {
                    return
                }
                if (idleChunkTimeout !== undefined) {
                    clearTimeout(idleChunkTimeout)
                }
                idleChunkTimeout = setTimeout(() => {
                    fail(new Error('Model stream idle timeout'))
                    abortTask()
                }, this.timeoutOptions.idleChunkTimeoutMs)
            }

            /** 在调用方取消时同步中止微信任务和字节流。 */
            const onAbort = (): void => {
                if (request.signal) {
                    fail(abortReason(request.signal))
                }
                abortTask()
            }

            const options: WeappRequestOptions = {
                url: request.url,
                method: request.method ?? 'POST',
                responseType: 'arraybuffer',
                enableChunked: true,
                ...(request.headers === undefined
                    ? {}
                    : { header: request.headers }),
                ...(request.body === undefined ? {} : { data: request.body }),
                success: (response) => {
                    if (terminal) {
                        return
                    }
                    if (response.data.byteLength > 0) {
                        queue.push(copyResponseBytes(response.data))
                    }
                    resolveResponse(
                        response.statusCode,
                        normalizeHeaders(response.header)
                    )
                    terminal = true
                    cleanup()
                    queue.close()
                },
                fail: (failure) => {
                    fail(requestFailureError(failure))
                }
            }

            try {
                task = this.requester(options)
            } catch (error) {
                fail(error)
                return
            }

            if (typeof task.onChunkReceived !== 'function') {
                fail(new TypeError(
                    'WeChat RequestTask does not support onChunkReceived; ' +
                    'use Mini Program base library 2.20.1 or later'
                ))
                abortTask()
                return
            }

            task.onHeadersReceived?.((event) => {
                if (typeof event.statusCode === 'number') {
                    resolveResponse(
                        event.statusCode,
                        normalizeHeaders(event.header)
                    )
                }
            })
            task.onChunkReceived((event) => {
                if (firstByteTimeout !== undefined) {
                    clearTimeout(firstByteTimeout)
                    firstByteTimeout = undefined
                }
                queue.push(copyResponseBytes(event.data))
                armIdleChunkTimeout()
            })

            request.signal?.addEventListener('abort', onAbort, { once: true })
            if (this.timeoutOptions.firstByteTimeoutMs !== undefined) {
                firstByteTimeout = setTimeout(() => {
                    fail(new Error(
                        'Model stream timed out waiting for first response byte'
                    ))
                    abortTask()
                }, this.timeoutOptions.firstByteTimeoutMs)
            }
            if (request.signal?.aborted) {
                onAbort()
            }
        })
    }
}
