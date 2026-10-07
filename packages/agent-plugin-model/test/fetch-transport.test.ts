import { describe, expect, it } from 'vitest'

import { FetchHttpTransport } from '../src/index.js'

describe('FetchHttpTransport', () => {
    it('传递请求并按到达顺序输出响应字节', async () => {
        let capturedInput: RequestInfo | URL | undefined
        let capturedInit: RequestInit | undefined
        const fetcher: typeof fetch = async (input, init) => {
            capturedInput = input
            capturedInit = init
            return new Response(new ReadableStream<Uint8Array>({
                /**
                 * 写入两个可观察的字节 chunk。
                 *
                 * @param controller - 当前可读流的控制器。
                 */
                start(controller): void {
                    controller.enqueue(new Uint8Array([1, 2]))
                    controller.enqueue(new Uint8Array([3]))
                    controller.close()
                }
            }), {
                status: 201,
                headers: {
                    'content-type': 'text/event-stream',
                    'x-provider': 'test'
                }
            })
        }
        const controller = new AbortController()
        const transport = new FetchHttpTransport(fetcher)

        const response = await transport.stream({
            url: 'https://example.test/v1/chat/completions',
            method: 'POST',
            headers: { authorization: 'Bearer test' },
            body: '{"stream":true}',
            signal: controller.signal
        })
        const chunks: number[][] = []
        for await (const chunk of response.body) {
            chunks.push([...chunk])
        }

        expect(capturedInput).toBe('https://example.test/v1/chat/completions')
        expect(capturedInit).toEqual({
            method: 'POST',
            headers: { authorization: 'Bearer test' },
            body: '{"stream":true}',
            signal: controller.signal
        })
        expect(response.status).toBe(201)
        expect(response.headers).toEqual({
            'content-type': 'text/event-stream',
            'x-provider': 'test'
        })
        expect(chunks).toEqual([[1, 2], [3]])
    })

    it('消费者提前停止时即使 cancel 失败也释放 reader lock', async () => {
        const cancelError = new Error('cancel failed')
        const stream = new ReadableStream<Uint8Array>({
            /**
             * 写入首个 chunk 并保持流打开。
             *
             * @param controller - 当前可读流的控制器。
             */
            start(controller): void {
                controller.enqueue(new Uint8Array([1]))
            },
            /**
             * 模拟宿主取消流失败。
             *
             * @returns 固定拒绝的 Promise。
             */
            cancel(): Promise<never> {
                return Promise.reject(cancelError)
            }
        })
        const fetcher: typeof fetch = async () => new Response(stream)
        const response = await new FetchHttpTransport(fetcher).stream({
            url: 'https://example.test/stream'
        })
        const iterator = response.body[Symbol.asyncIterator]()

        await expect(iterator.next()).resolves.toEqual({
            value: new Uint8Array([1]),
            done: false
        })
        await expect(iterator.return?.()).rejects.toBe(cancelError)
        expect(stream.locked).toBe(false)
    })
})
