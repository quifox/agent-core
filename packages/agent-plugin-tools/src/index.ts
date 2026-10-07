import { z } from 'zod'
import { defineTool, toolError, toolSuccess, type AgentContext, type AgentHooks, type AgentPlugin, type AgentToolSet, type HookOrHooks, type ModelRequest } from '@quifox/agent-core'

/** 本插件族的信封；业务参数仍由最终工具的 Schema 校验。 */
const entrySchema = z.object({
    pluginId: z.string().min(1).optional().describe('目录中的精确 pluginId；查询时不传 tool 或 args'),
    tool: z.string().min(1).optional().describe('详情中的精确工具名；执行时同时提供 pluginId 和 args'),
    args: z.record(z.string(), z.unknown()).optional().describe('符合目标 inputSchema 的参数对象；无参数传 {}')
}).strict().refine(input => (
    input.pluginId === undefined && input.tool === undefined && input.args === undefined
) || (
    input.pluginId !== undefined && input.tool === undefined && input.args === undefined
) || (
    input.pluginId !== undefined && input.tool !== undefined && input.args !== undefined
), { message: '仅允许 {}、{pluginId} 或 {pluginId,tool,args} 三种输入组合' })


/** 具体工具插件的装配配置，不扩展 Core AgentPlugin。 */
export interface ToolPluginOptions<Input = unknown> {
    id: string
    name?: string
    description?: string
    after?: string
    toolSets: AgentToolSet[]
    hooks?: AgentHooks<Input>
}

/** 默认工具注册可覆盖或通过 super 调用；Core 不自动读取 toolSets。 */
export class ToolPlugin<Input = unknown> implements AgentPlugin<Input> {
    id: string
    name?: string
    description?: string
    after?: string
    toolSets: AgentToolSet[]
    hooks: AgentHooks<Input>

    /** @param options - 本工具插件的声明与可选钩子覆盖。 */
    constructor(options: ToolPluginOptions<Input>) {
        this.id = options.id
        if (options.name !== undefined) { this.name = options.name }
        if (options.description !== undefined) { this.description = options.description }
        if (options.after !== undefined) { this.after = options.after }
        this.toolSets = options.toolSets
        this.hooks = { onInitialize: async ctx => this.onInitialize(ctx), ...options.hooks }
    }

    /** @param ctx - 初始化窗口的工具目录。 */
    async onInitialize(ctx: AgentContext): Promise<void> {
        for (const set of this.toolSets) { for (const tool of set.tools) { ctx.tools.register(tool) } }
    }
}

/** 主入口和衍生插件共享的具体能力，Core 不识别它。 */
export interface ToolEntryPlugin extends ToolPlugin {
    request?: () => ModelRequest
}

/** @param name - 可以自由改名的入口工具。 @param request - 生成插件拥有的可变请求。 */
export function createToolEntryPlugin(name = 'plugin', request?: () => ModelRequest): ToolEntryPlugin {
    if (!name.trim()) { throw new Error('工具入口名称不能为空。') }
    const entry = defineTool({
        name, description: '发现并调用插件工具。{} 查询目录，{pluginId} 查询工具详情，{pluginId,tool,args} 执行。只用已知标识，无参数传 {}。',
        inputSchema: entrySchema, policy: { sideEffect: 'none', approval: 'none' },
        execute: async input => {
            if (input.tool !== undefined) {
                return toolError('插件或目标工具不匹配，请查询目录或详情。', { code: 'TOOL_NOT_FOUND' })
            }
            const data = input.pluginId === undefined ? { plugins: [] } : { pluginId: input.pluginId, tools: [] }
            return toolSuccess(JSON.stringify(data), data)
        }
    })
    const plugin: ToolEntryPlugin = new ToolPlugin({ id: 'tool-entry', toolSets: [{ id: 'tool-entry', tools: [entry] }], hooks: {
        beforeTool: async (_ctx, call) => {
            if (call.name === name && !entrySchema.safeParse(call.input).success) {
                return { action: 'result', result: toolError('工具入口参数不符合查询或执行格式。', { code: 'TOOL_INPUT_INVALID' }) }
            }
            return { action: 'continue' }
        }
    } })
    if (request) { plugin.request = request }
    return plugin
}

/** @param value - 插件内部有序处理器。 */
function ordered<T>(value: HookOrHooks<T> | undefined): T[] {
    return value === undefined ? [] : Array.isArray(value) ? value : [value]
}

/** 不嵌套调用 handler，只修改计划与查询结果。 @param parent - 本插件族的主入口。 @param extension - 提供业务工具的插件。 */
export function deriveToolPlugin<Input = unknown>(parent: ToolEntryPlugin, extension: ToolPluginOptions<Input>): ToolPlugin<Input> {
    const entry = parent.toolSets[0]?.tools[0]
    if (!entry || entry.inputSchema !== entrySchema || parent.id === extension.id) { throw new Error('衍生插件需要本插件族的独立入口。') }
    if (extension.after !== undefined && extension.after !== parent.id) { throw new Error('衍生适配不能覆盖其他 after 声明。') }
    const names = new Set(extension.toolSets.flatMap(set => set.tools.map(tool => tool.name)))
    const hooks = extension.hooks ?? {}
    const adapter: AgentHooks<Input> = {
        beforeModel: async ctx => {
            if (!ctx.tools.isRegistered(entry)) { return { action: 'continue' } }
            if (!parent.request) { throw new Error('衍生工具需要主入口绑定生成插件的请求能力。') }
            const request = parent.request()
            request.tools = request.tools.filter(tool => !names.has(tool.name))
            return { action: 'continue' }
        },
        beforeTool: async (ctx, call) => {
            if (names.has(call.name)) { return { action: 'result', result: toolError('请通过已注册入口调用此工具。', { code: 'TOOL_NOT_FOUND' }) } }
            if (call.name !== entry.name || !ctx.tools.isRegistered(entry)) { return { action: 'continue' } }
            const parsed = entrySchema.safeParse(call.input)
            if (!parsed.success || parsed.data.pluginId !== extension.id || parsed.data.tool === undefined) { return { action: 'continue' } }
            if (!names.has(parsed.data.tool)) { return { action: 'result', result: toolError('插件与工具归属不匹配。', { code: 'TOOL_NOT_FOUND' }) } }
            call.name = parsed.data.tool
            call.input = parsed.data.args
            return { action: 'continue' }
        },
        afterTool: async (ctx, run) => {
            if (!ctx.tools.isRegistered(entry) || run.call.name !== entry.name || run.result.status !== 'success') { return { action: 'continue' } }
            const parsed = entrySchema.safeParse(run.call.input)
            if (!parsed.success || parsed.data.tool !== undefined) { return { action: 'continue' } }
            const definitions = ctx.tools.definitions().filter(tool => names.has(tool.name))
            if (!definitions.length) { return { action: 'continue' } }
            if (parsed.data.pluginId === undefined) {
                const previous = run.result.data as { plugins: unknown[] }
                const data = { plugins: [...previous.plugins, { pluginId: extension.id, name: extension.name ?? extension.id, description: extension.description ?? extension.id }] }
                Object.assign(run.result, toolSuccess(JSON.stringify(data), data))
            } else if (parsed.data.pluginId === extension.id) {
                const data = { pluginId: extension.id, tools: definitions }
                Object.assign(run.result, toolSuccess(JSON.stringify(data), data))
            }
            return { action: 'continue' }
        }
    }
    const derived = new ToolPlugin<Input>({ ...extension, after: parent.id, hooks: {
        ...hooks,
        onRegister: [...ordered(hooks.onRegister), async plugins => {
            if (!plugins.includes(parent as AgentPlugin<Input>)) {
                const index = plugins.indexOf(derived)
                if (index >= 0) { plugins.splice(index, 1) }
            }
        }],
        beforeModel: [...ordered(adapter.beforeModel), ...ordered(hooks.beforeModel)],
        beforeTool: [...ordered(adapter.beforeTool), ...ordered(hooks.beforeTool)],
        afterTool: [...ordered(adapter.afterTool), ...ordered(hooks.afterTool)]
    } })
    return derived
}
