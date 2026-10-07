import { decodeUtf8 } from './utf8.js'

/** Provider 内部使用的最小 SSE 事件。 */
export interface SseEvent {
    /** 合并多行 `data:` 后的事件内容。 */
    readonly data: string
}

/**
 * 将增量文本切分为兼容 LF、CRLF 与 CR 的行。
 *
 * @param chunks - 已完成 UTF-8 解码的增量文本。
 * @returns 不包含换行符的文本行。
 */
async function* readLines(
    chunks: AsyncIterable<string>
): AsyncGenerator<string> {
    let buffer = ''

    for await (const chunk of chunks) {
        buffer += chunk
        while (buffer.length > 0) {
            const carriageReturn = buffer.indexOf('\r')
            const lineFeed = buffer.indexOf('\n')
            const candidates = [carriageReturn, lineFeed]
                .filter((index) => index >= 0)
            if (candidates.length === 0) {
                break
            }

            const separatorIndex = Math.min(...candidates)
            const separator = buffer[separatorIndex]
            if (
                separator === '\r' &&
                separatorIndex === buffer.length - 1
            ) {
                break
            }
            const separatorLength = separator === '\r' &&
                buffer[separatorIndex + 1] === '\n'
                ? 2
                : 1
            yield buffer.slice(0, separatorIndex)
            buffer = buffer.slice(separatorIndex + separatorLength)
        }
    }

    if (buffer.endsWith('\r')) {
        yield buffer.slice(0, -1)
        buffer = ''
    }
    if (buffer.length > 0) {
        yield buffer
    }
}

/**
 * 从 SSE 字节流中解析 `data` 事件。
 *
 * comment、event、id 与 retry 字段不参与模型协议；多行 data 使用换行符
 * 合并，流末尾没有空行时仍会提交最后一个事件。
 *
 * @param bytes - Transport 返回的原始响应字节流。
 * @returns 按服务器发送顺序产生的 SSE data 事件。
 */
export async function* parseSse(
    bytes: AsyncIterable<Uint8Array>
): AsyncGenerator<SseEvent> {
    let dataLines: string[] = []
    let hasData = false

    for await (const line of readLines(decodeUtf8(bytes))) {
        if (line.length === 0) {
            if (hasData) {
                yield { data: dataLines.join('\n') }
            }
            dataLines = []
            hasData = false
            continue
        }
        if (line.startsWith(':')) {
            continue
        }

        const colonIndex = line.indexOf(':')
        const field = colonIndex < 0 ? line : line.slice(0, colonIndex)
        let value = colonIndex < 0 ? '' : line.slice(colonIndex + 1)
        if (value.startsWith(' ')) {
            value = value.slice(1)
        }
        if (field === 'data') {
            dataLines.push(value)
            hasData = true
        }
    }

    if (hasData) {
        yield { data: dataLines.join('\n') }
    }
}
