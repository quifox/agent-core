import type { AgentContext } from './context.js'
import { normalizeAgentError } from './errors.js'
import type { ToolCall } from './model.js'
import { resolveRegisteredTool, toolError, type ToolResult } from './tools.js'

/** 唯一工具入口；prepare 的值留在工具内部。 @param ctx - 共享上下文。 @param call - 最终调用。 @internal */
export async function executeTool(ctx: AgentContext, call: ToolCall): Promise<ToolResult> {
    const tool = resolveRegisteredTool(ctx.tools, call.name)
    if (!tool) { return toolError('工具不存在。', { code: 'TOOL_NOT_FOUND' }) }
    try { return await tool.invoke(ctx, call.input) }
    catch (cause) {
        throw normalizeAgentError(cause, { code: 'TOOL_FAILED', phase: 'tool', message: '工具执行未取得有效回执。' })
    }
}
