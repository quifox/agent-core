import JSON5 from 'json5'

/**
 * 解析完整工具参数；严格 JSON 失败时只接受确定的 JSON5 语法。
 *
 * JSON5 不补齐截断内容或缺失值，普通入口无需 Node API；约束见 https://json5.org/ 。
 * @param text - Provider 已收齐的 arguments 字符串。
 * @returns 仍须由目标工具 Schema 校验的数据。
 */
export function parseToolArguments(text: string): unknown {
    if (text.trim().length === 0) {
        return {}
    }
    try {
        return JSON.parse(text, requireFiniteNumber) as unknown
    } catch {
        return JSON5.parse(text, requireFiniteNumber) as unknown
    }
}

/**
 * 拒绝无法作为 JSON 数值交给业务 Schema 的 Infinity 和 NaN。
 *
 * @param _key - JSON 解析器提供的当前字段名称。
 * @param value - 当前已解析的字段值。
 * @returns 原值，不进行字符串到数字等业务转换。
 */
function requireFiniteNumber(_key: string, value: unknown): unknown {
    if (typeof value === 'number' && !Number.isFinite(value)) {
        throw new SyntaxError('Tool arguments must contain only finite numbers')
    }
    return value
}
