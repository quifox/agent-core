const RESERVED_REQUEST_FIELDS = new Set([
    'model',
    'input',
    'messages',
    'stream',
    'previous_response_id',
    'tools',
    'tool_choice',
    'additional_tools',
    'functions',
    'function_call'
])

/**
 * 找出会覆盖模型会话或工具声明的 Provider 自定义字段。
 *
 * @param options - 调用方传入的供应商扩展字段。
 * @returns 首个协议保留字段；没有冲突时返回 undefined。
 */
export function findReservedProviderOption(
    options: Readonly<Record<string, unknown>> | undefined
): string | undefined {
    return Object.keys(options ?? {}).find((key) => RESERVED_REQUEST_FIELDS.has(key))
}
