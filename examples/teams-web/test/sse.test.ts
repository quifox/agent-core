import { createServer } from 'node:http'
import { expect, it } from 'vitest'
import { SseChannel } from '../src/sse.js'

it('大段历史重连遇到写缓冲压力时仍按序补发，并保留期间新增事件', async () => {
    const channel = new SseChannel()
    for (let index = 0; index < 50; index += 1) { channel.publish({ index, content: '展示消息'.repeat(1024) }) }
    const server = createServer((_request, response) => {
        channel.connect(response, 10)
        channel.publish({ index: 50, content: '补发期间的新消息' })
    })
    await new Promise<void>(resolve => { server.listen(0, '127.0.0.1', resolve) })
    const address = server.address()
    if (!address || typeof address === 'string') { throw new Error('没有本地地址。') }
    const controller = new AbortController()
    try {
        const response = await fetch(`http://127.0.0.1:${address.port}`, { signal: controller.signal })
        const reader = response.body!.getReader()
        const decoder = new TextDecoder()
        let frames = ''
        while (!frames.includes('补发期间的新消息')) {
            const next = await reader.read()
            if (next.done) { break }
            frames += decoder.decode(next.value, { stream: true })
        }
        const ids = [...frames.matchAll(/^id: (\d+)$/gm)].map(match => Number(match[1]))
        expect(ids).toEqual(Array.from({ length: 41 }, (_value, index) => index + 11))
        expect(frames).toContain('补发期间的新消息')
    } finally {
        controller.abort()
        channel.close()
        await new Promise<void>(resolve => { server.close(() => { resolve() }) })
    }
})

it('新页面首次连接也提示已经超出缓存的历史，保留可用尾段', async () => {
    const channel = new SseChannel(2)
    for (let index = 0; index < 3; index += 1) { channel.publish({ index }) }
    const server = createServer((_request, response) => { channel.connect(response) })
    await new Promise<void>(resolve => { server.listen(0, '127.0.0.1', resolve) })
    const address = server.address()
    if (!address || typeof address === 'string') { throw new Error('没有本地地址。') }
    const controller = new AbortController()
    try {
        const response = await fetch(`http://127.0.0.1:${address.port}`, { signal: controller.signal })
        const reader = response.body!.getReader()
        let text = ''
        const decoder = new TextDecoder()
        while (!text.includes('id: 3\n')) {
            const next = await reader.read()
            if (next.done) { break }
            text += decoder.decode(next.value, { stream: true })
        }
        expect(text).toContain('history-gap')
        expect(text).not.toContain('id: 1\n')
        expect(text).toContain('id: 2\n')
    } finally {
        controller.abort()
        channel.close()
        await new Promise<void>(resolve => { server.close(() => { resolve() }) })
    }
})
