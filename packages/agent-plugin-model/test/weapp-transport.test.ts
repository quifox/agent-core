import { describe, expect, it, vi } from 'vitest'

import {
    WeappHttpTransport,
    type WeappChunkReceived,
    type WeappHeadersReceived,
    type WeappRequest,
    type WeappRequestFailure,
    type WeappRequestOptions,
    type WeappRequestSuccess,
    type WeappRequestTask
} from '../src/internal/weapp.js'

interface RequestHarness {
    /** 可注入 Transport 的 fake 微信请求函数。 */
    readonly requester: WeappRequest
    /** 当前 fake 请求被调用的次数。 */
    readonly requestCalls: number
    /** 当前 fake RequestTask 被中止的次数。 */
    readonly abortCalls: number
    /** 最近一次收到的请求选项。 */
    readonly options: WeappRequestOptions | undefined
    /**
     * 触发响应头事件。
     *
     * @param event - fake 微信响应头事件。
     */
    emitHeaders(event: WeappHeadersReceived): void
    /**
     * 触发响应字节事件。
     *
     * @param event - fake 微信响应 chunk 事件。
     */
    emitChunk(event: WeappChunkReceived): void
    /**
     * 触发请求成功回调。
     *
     * @param response - fake 微信完整响应。
     */
    succeed(response: WeappRequestSuccess): void
    /**
     * 触发请求失败回调。
     *
     * @param failure - fake 微信失败信息。
     */
    fail(failure: WeappRequestFailure): void
}

/**
 * 将数字数组转换为精确长度的 ArrayBuffer。
 *
 * @param values - 需要写入的字节值。
 * @returns 可交给微信 chunk 回调的 ArrayBuffer。
 */
function arrayBufferOf(values: readonly number[]): ArrayBuffer {
    return Uint8Array.from(values).buffer
}

/**
 * 创建可手动推进 headers、chunk、success 与 fail 的微信请求桩。
 *
 * @param supportsChunks - fake RequestTask 是否暴露分块监听能力。
 * @returns 可观察请求状态并主动触发回调的测试夹具。
 */
function createRequestHarness(supportsChunks = true): RequestHarness {
    let options: WeappRequestOptions | undefined
    let headersListener: ((event: WeappHeadersReceived) => void) | undefined
    let chunkListener: ((event: WeappChunkReceived) => void) | undefined
    let requestCalls = 0
    let abortCalls = 0

    const task: WeappRequestTask = {
        /** 中止 fake 请求。 */
        abort(): void {
            abortCalls += 1
        },
        /**
         * 保存响应头监听器。
         *
         * @param listener - 微信响应头回调。
         */
        onHeadersReceived(listener): void {
            headersListener = listener
        },
        ...(supportsChunks
            ? {
                /**
                 * 保存响应 chunk 监听器。
                 *
                 * @param listener - 微信分块响应回调。
                 */
                onChunkReceived(
                    listener: (event: WeappChunkReceived) => void
                ): void {
                    chunkListener = listener
                }
            }
            : {})
    }
    const requester: WeappRequest = (requestOptions) => {
        requestCalls += 1
        options = requestOptions
        return task
    }

    return {
        requester,
        get requestCalls(): number {
            return requestCalls
        },
        get abortCalls(): number {
            return abortCalls
        },
        get options(): WeappRequestOptions | undefined {
            return options
        },
        emitHeaders(event): void {
            if (!headersListener) {
                throw new Error('headers listener is not registered')
            }
            headersListener(event)
        },
        emitChunk(event): void {
            if (!chunkListener) {
                throw new Error('chunk listener is not registered')
            }
            chunkListener(event)
        },
        succeed(response): void {
            if (!options) {
                throw new Error('request options are not available')
            }
            options.success(response)
        },
        fail(failure): void {
            if (!options) {
                throw new Error('request options are not available')
            }
            options.fail(failure)
        }
    }
}

describe('WeappHttpTransport', () => {
    it('在 success 前返回响应并逐块输出 onChunkReceived 数据', async () => {
        const harness = createRequestHarness()
        const lifecycle: string[] = []
        const transport = new WeappHttpTransport(
            harness.requester,
            {},
            {
                onChunkQueued: (chunk) => {
                    lifecycle.push(`queued:${chunk.byteLength}/${chunk.lineFeedCount}`)
                },
                onChunkRead: (chunk) => {
                    lifecycle.push(`read:${chunk.byteLength}/${chunk.lineFeedCount}`)
                }
            }
        )

        const responsePromise = transport.stream({
            url: 'https://example.test/v1/chat/completions',
            method: 'POST',
            headers: { authorization: 'Bearer test' },
            body: '{"stream":true}'
        })

        expect(harness.options).toMatchObject({
            url: 'https://example.test/v1/chat/completions',
            method: 'POST',
            header: { authorization: 'Bearer test' },
            data: '{"stream":true}',
            responseType: 'arraybuffer',
            enableChunked: true
        })
        harness.emitHeaders({
            statusCode: 200,
            header: {
                'Content-Type': 'text/event-stream',
                'X-Provider': 'test'
            }
        })
        const response = await responsePromise
        const iterator = response.body[Symbol.asyncIterator]()

        const first = iterator.next()
        harness.emitChunk({ data: arrayBufferOf([1, 2]) })
        await expect(first).resolves.toEqual({
            value: new Uint8Array([1, 2]),
            done: false
        })

        const second = iterator.next()
        harness.emitChunk({ data: arrayBufferOf([3]) })
        await expect(second).resolves.toEqual({
            value: new Uint8Array([3]),
            done: false
        })

        const completed = iterator.next()
        harness.succeed({
            statusCode: 200,
            header: {},
            data: arrayBufferOf([])
        })
        await expect(completed).resolves.toEqual({
            value: undefined,
            done: true
        })
        expect(response.status).toBe(200)
        expect(response.headers).toEqual({
            'content-type': 'text/event-stream',
            'x-provider': 'test'
        })
        expect(lifecycle).toEqual([
            'queued:2/0',
            'read:2/0',
            'queued:1/0',
            'read:1/0'
        ])
    })

    it('已有流式回调时仍保留 success 携带的终态字节', async () => {
        const harness = createRequestHarness()
        const transport = new WeappHttpTransport(harness.requester)
        const responsePromise = transport.stream({ url: 'https://example.test' })

        harness.emitHeaders({ statusCode: 200, header: {} })
        const response = await responsePromise
        const iterator = response.body[Symbol.asyncIterator]()

        const first = iterator.next()
        harness.emitChunk({ data: arrayBufferOf([1, 2]) })
        await expect(first).resolves.toEqual({
            value: new Uint8Array([1, 2]),
            done: false
        })

        const terminal = iterator.next()
        harness.succeed({
            statusCode: 200,
            header: {},
            data: arrayBufferOf([3, 4])
        })
        await expect(terminal).resolves.toEqual({
            value: new Uint8Array([3, 4]),
            done: false
        })
        await expect(iterator.next()).resolves.toEqual({
            value: undefined,
            done: true
        })
    })

    it('在微信回调返回后保留独立的 chunk 字节副本', async () => {
        const harness = createRequestHarness()
        const transport = new WeappHttpTransport(harness.requester)
        const responsePromise = transport.stream({ url: 'https://example.test' })

        harness.emitHeaders({ statusCode: 200, header: {} })
        const response = await responsePromise
        const iterator = response.body[Symbol.asyncIterator]()
        const pending = iterator.next()
        const source = Uint8Array.of(1, 2)

        harness.emitChunk({ data: source.buffer })
        source[0] = 9

        await expect(pending).resolves.toEqual({
            value: new Uint8Array([1, 2]),
            done: false
        })
        harness.succeed({
            statusCode: 200,
            header: {},
            data: arrayBufferOf([])
        })
    })

    it('headers 事件缺少状态码时缓存 chunk 并等待 success', async () => {
        const harness = createRequestHarness()
        const transport = new WeappHttpTransport(harness.requester)
        let responseSettled = false

        const responsePromise = transport.stream({ url: 'https://example.test' })
        void responsePromise.then(() => {
            responseSettled = true
        })
        harness.emitHeaders({ header: { 'Content-Type': 'text/event-stream' } })
        harness.emitChunk({ data: arrayBufferOf([7, 8]) })
        await Promise.resolve()
        expect(responseSettled).toBe(false)

        harness.succeed({
            statusCode: 206,
            header: { 'Content-Type': 'text/event-stream' },
            data: arrayBufferOf([9])
        })
        const response = await responsePromise
        expect(response.status).toBe(206)
        await expect(response.body[Symbol.asyncIterator]().next()).resolves.toEqual({
            value: new Uint8Array([7, 8]),
            done: false
        })
    })

    it('请求前已取消时不调用 wx.request', async () => {
        const harness = createRequestHarness()
        const transport = new WeappHttpTransport(harness.requester)
        const controller = new AbortController()
        const reason = new Error('cancel before request')
        controller.abort(reason)

        await expect(transport.stream({
            url: 'https://example.test',
            signal: controller.signal
        })).rejects.toBe(reason)
        expect(harness.requestCalls).toBe(0)
        expect(harness.abortCalls).toBe(0)
    })

    it('流返回前取消时拒绝响应并且 RequestTask 只中止一次', async () => {
        const harness = createRequestHarness()
        const transport = new WeappHttpTransport(harness.requester)
        const controller = new AbortController()
        const reason = new Error('cancel before headers')
        const responsePromise = transport.stream({
            url: 'https://example.test',
            signal: controller.signal
        })

        controller.abort(reason)
        controller.abort(new Error('ignored second abort'))

        await expect(responsePromise).rejects.toBe(reason)
        expect(harness.abortCalls).toBe(1)
    })

    it('流消费中取消时以 Abort reason 唤醒等待中的 iterator', async () => {
        const harness = createRequestHarness()
        const transport = new WeappHttpTransport(harness.requester)
        const controller = new AbortController()
        const reason = new Error('cancel during stream')
        const responsePromise = transport.stream({
            url: 'https://example.test',
            signal: controller.signal
        })
        harness.emitHeaders({ statusCode: 200, header: {} })
        const response = await responsePromise
        const pendingChunk = response.body[Symbol.asyncIterator]().next()

        controller.abort(reason)

        await expect(pendingChunk).rejects.toBe(reason)
        expect(harness.abortCalls).toBe(1)
    })

    it('响应头到达后仍在首个字节等待超时时中止请求', async () => {
        vi.useFakeTimers()
        try {
            const harness = createRequestHarness()
            const transport = new WeappHttpTransport(harness.requester, {
                firstByteTimeoutMs: 10
            })
            const responsePromise = transport.stream({ url: 'https://example.test' })
            harness.emitHeaders({ statusCode: 200, header: {} })
            const response = await responsePromise
            const firstChunk = response.body[Symbol.asyncIterator]().next()
            const firstChunkFailure = expect(firstChunk).rejects.toThrow(
                'first response byte'
            )

            await vi.advanceTimersByTimeAsync(10)

            await firstChunkFailure
            expect(harness.abortCalls).toBe(1)
        } finally {
            vi.useRealTimers()
        }
    })

    it('持续收到 chunk 时刷新空闲等待，只有后续静默才中止请求', async () => {
        vi.useFakeTimers()
        try {
            const harness = createRequestHarness()
            const transport = new WeappHttpTransport(harness.requester, {
                idleChunkTimeoutMs: 10
            })
            const responsePromise = transport.stream({ url: 'https://example.test' })
            harness.emitHeaders({ statusCode: 200, header: {} })
            const response = await responsePromise
            const iterator = response.body[Symbol.asyncIterator]()

            const firstChunk = iterator.next()
            harness.emitChunk({ data: arrayBufferOf([1]) })
            await expect(firstChunk).resolves.toEqual({
                value: new Uint8Array([1]),
                done: false
            })

            await vi.advanceTimersByTimeAsync(9)
            const secondChunk = iterator.next()
            harness.emitChunk({ data: arrayBufferOf([2]) })
            await expect(secondChunk).resolves.toEqual({
                value: new Uint8Array([2]),
                done: false
            })

            const silentChunk = iterator.next()
            const silentChunkFailure = expect(silentChunk).rejects.toThrow(
                'stream idle timeout'
            )
            await vi.advanceTimersByTimeAsync(9)
            expect(harness.abortCalls).toBe(0)
            await vi.advanceTimersByTimeAsync(1)

            await silentChunkFailure
            expect(harness.abortCalls).toBe(1)
        } finally {
            vi.useRealTimers()
        }
    })

    it('RequestTask.abort 同步触发 fail 时仍保留调用方 Abort reason', async () => {
        let requestOptions: WeappRequestOptions | undefined
        const requester: WeappRequest = (options) => {
            requestOptions = options
            return {
                /** 中止后同步模拟微信 fail 回调。 */
                abort(): void {
                    requestOptions?.fail({ errMsg: 'request:fail abort' })
                },
                /**
                 * 接收但不触发 fake chunk 回调。
                 *
                 * @param _listener - 微信分块响应回调。
                 */
                onChunkReceived(_listener): void {}
            }
        }
        const transport = new WeappHttpTransport(requester)
        const controller = new AbortController()
        const reason = new Error('caller abort reason')
        const responsePromise = transport.stream({
            url: 'https://example.test',
            signal: controller.signal
        })

        controller.abort(reason)

        await expect(responsePromise).rejects.toBe(reason)
    })

    it('request fail 在流返回前拒绝响应', async () => {
        const harness = createRequestHarness()
        const transport = new WeappHttpTransport(harness.requester)
        const responsePromise = transport.stream({ url: 'https://example.test' })

        harness.fail({ errMsg: 'request:fail timeout', errno: 600005 })

        await expect(responsePromise).rejects.toThrow('request:fail timeout')
    })

    it('request fail 在流返回后拒绝等待中的 iterator', async () => {
        const harness = createRequestHarness()
        const transport = new WeappHttpTransport(harness.requester)
        const responsePromise = transport.stream({ url: 'https://example.test' })
        harness.emitHeaders({ statusCode: 200, header: {} })
        const response = await responsePromise
        const pendingChunk = response.body[Symbol.asyncIterator]().next()

        harness.fail({ errMsg: 'request:fail connection reset' })

        await expect(pendingChunk).rejects.toThrow(
            'request:fail connection reset'
        )
    })

    it('缺少 onChunkReceived 时明确失败且中止请求', async () => {
        const harness = createRequestHarness(false)
        const transport = new WeappHttpTransport(harness.requester)

        await expect(transport.stream({
            url: 'https://example.test'
        })).rejects.toThrow('onChunkReceived')
        expect(harness.abortCalls).toBe(1)
    })
})
