const REPLACEMENT_CHARACTER = '\uFFFD'

/**
 * 返回 UTF-8 首字节声明的序列长度。
 *
 * @param firstByte - 当前待解析的 UTF-8 首字节。
 * @returns 2 至 4 的合法序列长度；单字节或非法首字节返回 0。
 */
function sequenceLength(firstByte: number): number {
    if (firstByte >= 0xC2 && firstByte <= 0xDF) {
        return 2
    }
    if (firstByte >= 0xE0 && firstByte <= 0xEF) {
        return 3
    }
    if (firstByte >= 0xF0 && firstByte <= 0xF4) {
        return 4
    }
    return 0
}

/**
 * 判断候选字节是否为 UTF-8 continuation byte。
 *
 * @param byte - 待判断字节。
 * @returns 是否位于 `0x80..0xBF`。
 */
function isContinuationByte(byte: number): boolean {
    return byte >= 0x80 && byte <= 0xBF
}

/**
 * 判断完整字节序列是否为规范 UTF-8。
 *
 * @param bytes - 包含候选序列的字节数组。
 * @param offset - 首字节下标。
 * @param length - 首字节声明的序列长度。
 * @returns continuation byte、过长编码与代理区间是否都合法。
 */
function isValidSequence(
    bytes: readonly number[],
    offset: number,
    length: number
): boolean {
    for (let index = 1; index < length; index += 1) {
        if (!isContinuationByte(bytes[offset + index] ?? -1)) {
            return false
        }
    }

    const first = bytes[offset] ?? -1
    const second = bytes[offset + 1] ?? -1
    if (length === 3) {
        if (first === 0xE0 && second < 0xA0) {
            return false
        }
        if (first === 0xED && second > 0x9F) {
            return false
        }
    }
    if (length === 4) {
        if (first === 0xF0 && second < 0x90) {
            return false
        }
        if (first === 0xF4 && second > 0x8F) {
            return false
        }
    }
    return true
}

/**
 * 将一个已校验的 UTF-8 序列转换为 Unicode code point。
 *
 * @param bytes - 包含合法序列的字节数组。
 * @param offset - 首字节下标。
 * @param length - UTF-8 序列长度。
 * @returns 对应的 Unicode code point。
 */
function decodeCodePoint(
    bytes: readonly number[],
    offset: number,
    length: number
): number {
    const first = bytes[offset] ?? 0
    if (length === 2) {
        return ((first & 0x1F) << 6) |
            ((bytes[offset + 1] ?? 0) & 0x3F)
    }
    if (length === 3) {
        return ((first & 0x0F) << 12) |
            (((bytes[offset + 1] ?? 0) & 0x3F) << 6) |
            ((bytes[offset + 2] ?? 0) & 0x3F)
    }
    return ((first & 0x07) << 18) |
        (((bytes[offset + 1] ?? 0) & 0x3F) << 12) |
        (((bytes[offset + 2] ?? 0) & 0x3F) << 6) |
        ((bytes[offset + 3] ?? 0) & 0x3F)
}

/**
 * 将 Unicode code point 写为兼容旧 JavaScript 运行时的 UTF-16 字符串。
 *
 * 小程序运行时并不保证 `String.fromCodePoint` 可用或行为一致；UTF-8
 * 解码只需要 UTF-16 表示，因此对 BMP 直接写入 code unit，对增补平面
 * 显式写入代理对即可。
 *
 * @param codePoint - 已通过 UTF-8 规范性校验的 Unicode code point。
 * @returns 对应的 JavaScript 字符串。
 */
function codePointToString(codePoint: number): string {
    if (codePoint <= 0xFFFF) {
        return String.fromCharCode(codePoint)
    }

    const supplementary = codePoint - 0x1_0000
    return String.fromCharCode(
        0xD800 + (supplementary >> 10),
        0xDC00 + (supplementary & 0x3FF)
    )
}

/**
 * 增量解码 UTF-8 字节流，不依赖宿主 `TextDecoder`。
 *
 * 仅跨 chunk 保留尚未完整的多字节序列；非法序列输出 replacement
 * character，避免 Fetch 与微信小程序产生不同的解码行为。
 *
 * @param chunks - 按网络到达顺序产生的字节流。
 * @returns 按 chunk 增量产生的 Unicode 文本。
 */
export async function* decodeUtf8(
    chunks: AsyncIterable<Uint8Array>
): AsyncGenerator<string> {
    // 不在小程序流回调的字节视图上使用下标、slice 或 set。部分宿主对
    // TypedArray 迭代支持正常，但对这些视图操作的跨回调语义不稳定；普通
    // 数组只保存不完整的 UTF-8 序列，既小也与传输层解耦。
    const pending: number[] = []

    for await (const chunk of chunks) {
        const output: string[] = []
        for (const byte of chunk) {
            pending.push(byte)
            while (pending.length > 0) {
                const first = pending[0] ?? 0
                if (first <= 0x7F) {
                    output.push(String.fromCharCode(first))
                    pending.shift()
                    continue
                }

                const length = sequenceLength(first)
                if (length === 0) {
                    output.push(REPLACEMENT_CHARACTER)
                    pending.shift()
                    continue
                }
                if (pending.length < length) {
                    break
                }
                if (!isValidSequence(pending, 0, length)) {
                    output.push(REPLACEMENT_CHARACTER)
                    pending.shift()
                    continue
                }

                output.push(codePointToString(
                    decodeCodePoint(pending, 0, length)
                ))
                pending.splice(0, length)
            }
        }

        if (output.length > 0) {
            const text = output.join('')
            yield text
        }
    }

    if (pending.length > 0) {
        yield REPLACEMENT_CHARACTER
    }
}

/**
 * 在给定字符上限内收集 UTF-8 字节流。
 *
 * @param chunks - 需要收集的响应字节流。
 * @param maxCharacters - 允许保留的最大字符数。
 * @returns 完整文本，或带省略号的限长文本。
 */
export async function collectUtf8(
    chunks: AsyncIterable<Uint8Array>,
    maxCharacters: number
): Promise<string> {
    let output = ''
    for await (const text of decodeUtf8(chunks)) {
        output += text
        if (output.length > maxCharacters) {
            return output.slice(0, maxCharacters) + '…'
        }
    }
    return output
}
