import { z } from 'zod'
import type { AgentContext } from './context.js'
import type { ToolCall } from './model.js'

export const TOOL_RESULT_STATUS = { SUCCESS: 'success', ERROR: 'error', DENIED: 'denied' } as const
export type ToolResultStatus = typeof TOOL_RESULT_STATUS[keyof typeof TOOL_RESULT_STATUS]

/** 工具结果是共享可变工作对象。 */
export interface ToolResult<TData = unknown> {
    status: ToolResultStatus
    content: string
    code?: string
    reason?: string
    data?: TData
}

export const TOOL_SIDE_EFFECT = { NONE: 'none', UI: 'ui', EXTERNAL: 'external' } as const
export type ToolSideEffect = typeof TOOL_SIDE_EFFECT[keyof typeof TOOL_SIDE_EFFECT]
export const TOOL_APPROVAL = { NONE: 'none', HOST: 'host' } as const
export type ToolApproval = typeof TOOL_APPROVAL[keyof typeof TOOL_APPROVAL]

/** 工具定义拥有的静态准入信息；不进入模型参数。 */
export interface ToolPolicy {
    sideEffect: ToolSideEffect
    approval: ToolApproval
    /** 工具保证结果未知时可安全重试；是否重试由插件决定，省略不提供保证。 */
    retrySafe?: boolean
}

/** 原调用的身份与当前结果；不携带准备中间态或执行次数。 */
export interface ToolRunResult<TData = unknown> {
    call: ToolCall
    result: ToolResult<TData>
}

/** 模型可见的工具合同。 */
export interface AgentToolDefinition {
    name: string
    description: string
    inputSchema: Readonly<Record<string, unknown>>
}

/** prepare 与 execute 同属一个工具；Prepared 只在工具执行入口内部传递。 */
export interface AgentTool<Schema extends z.ZodType = z.ZodType, TData = unknown,
    Ctx extends AgentContext = AgentContext, Prepared = z.output<Schema>> {
    name: string
    description: string
    inputSchema: Schema
    policy: ToolPolicy
    /** @param ctx - 当前共享协作对象。 @param rawInput - 最终目标的原始输入。 */
    prepare(ctx: Ctx, rawInput: unknown): Promise<Prepared>
    /** @param input - 本工具自己准备的参数。 @param ctx - 同一个共享协作对象。 */
    execute(input: Prepared, ctx: Ctx): Promise<ToolResult<TData>>
}

/** 工具分组仅用于初始化装配，不隐含模型可见性或特殊入口。 */
export interface AgentToolSet<Ctx extends AgentContext = AgentContext> {
    id: string
    tools: AgentTool<z.ZodType, unknown, Ctx>[]
}

/** 提供工具本地的默认 Zod 准备；可整体覆盖 prepare。 @param definition - 具体工具定义。 */
export function defineTool<Schema extends z.ZodType, TData = unknown, Ctx extends AgentContext = AgentContext, Prepared = z.output<Schema>>(
    definition: AgentTool<Schema, TData, Ctx, Prepared>
): AgentTool<Schema, TData, Ctx, Prepared>
export function defineTool<Schema extends z.ZodType, TData = unknown, Ctx extends AgentContext = AgentContext>(
    definition: Omit<AgentTool<Schema, TData, Ctx>, 'prepare'>
): AgentTool<Schema, TData, Ctx>
export function defineTool<Schema extends z.ZodType, TData = unknown,
    Ctx extends AgentContext = AgentContext, Prepared = z.output<Schema>>(
    definition: Omit<AgentTool<Schema, TData, Ctx, Prepared>, 'prepare'> &
        { prepare?: AgentTool<Schema, TData, Ctx, Prepared>['prepare'] }
): AgentTool<Schema, TData, Ctx, Prepared> {
    return {
        ...definition,
        prepare: definition.prepare ?? (async (_ctx, raw) => definition.inputSchema.parseAsync(raw) as Promise<Prepared>)
    }
}

/** @param definition - 显式分组，保留工具实例引用。 */
export function createToolSet<Ctx extends AgentContext = AgentContext>(definition: AgentToolSet<Ctx>): AgentToolSet<Ctx> {
    if (!definition.id.trim()) { throw new Error('ToolSet id must not be empty') }
    return definition
}

/** @param content - 模型可读结果。 @param data - 可选业务数据。 */
export function toolSuccess<TData = unknown>(content: string, data?: TData): ToolResult<TData> {
    return data === undefined ? { status: 'success', content } : { status: 'success', content, data }
}

/** @param content - 模型可读失败。 @param options - 错误码与可选数据。 */
export function toolError<TData = unknown>(content: string, options: { code?: string; reason?: string; data?: TData } = {}): ToolResult<TData> {
    return { status: 'error', content, ...options }
}

/** @param content - 拒绝原因。 @param options - 可选业务数据。 */
export function toolDenied<TData = unknown>(content: string, options: { code?: string; reason?: string; data?: TData } = {}): ToolResult<TData> {
    return { status: 'denied', content, ...options }
}

/** 注册时绑定类型，执行入口仅接触原始输入。 */
interface RegisteredTool {
    source: object
    name: string
    description: string
    inputSchema: z.ZodType
    policy: ToolPolicy
    invoke(ctx: AgentContext, raw: unknown): Promise<ToolResult>
}

const catalogs = new WeakMap<ToolRegistry, Map<string, RegisteredTool>>()

/** @param registry - 所属注册表。 @param name - 最终目标。 @internal */
export function resolveRegisteredTool(registry: ToolRegistry, name: string): RegisteredTool | undefined {
    return catalogs.get(registry)?.get(name)
}

/** 初始化阶段可装配，随后固定；公开原工具对象，保留既有登记绑定。 */
export class ToolRegistry {
    private sealed = false

    /** 创建空表；工具插件负责初始化注册。 */
    constructor() { catalogs.set(this, new Map()) }

    /** @param tool - 由工具插件提供的实例。 */
    register<Schema extends z.ZodType, Data, Ctx extends AgentContext, Prepared>(tool: AgentTool<Schema, Data, Ctx, Prepared>): this {
        this.assertMutable()
        const catalog = catalogs.get(this)!
        if (!tool.name.trim() || catalog.has(tool.name)) { throw new Error(`Tool already registered or invalid: ${tool.name}`) }
        const prepare = tool.prepare.bind(tool)
        const execute = tool.execute.bind(tool)
        catalog.set(tool.name, {
            source: tool, name: tool.name, description: tool.description,
            inputSchema: tool.inputSchema, policy: { ...tool.policy },
            invoke: async (ctx, raw) => {
                const input = await prepare(ctx as Ctx, raw)
                return execute(input, ctx as Ctx)
            }
        })
        return this
    }

    /** @param name - 初始化中移除的工具。 */
    remove(name: string): void { this.assertMutable(); catalogs.get(this)!.delete(name) }

    /** @param name - 注册名称。 @returns 原工具对象；不存在时返回 undefined，不包装其方法。 */
    get(name: string): AgentTool | undefined {
        return catalogs.get(this)!.get(name)?.source as AgentTool | undefined
    }

    /** 返回原工具引用的有序快照，只复制数组容器。 */
    values(): AgentTool[] {
        return [...catalogs.get(this)!.values()].map(tool => tool.source as AgentTool)
    }

    /** @param tool - 检查原工具对象，不只比较名称。 */
    isRegistered(tool: { name: string }): boolean { return catalogs.get(this)!.get(tool.name)?.source === tool }

    /** @param name - 准入插件读取最终目标的策略；不返回 handler。 */
    policy(name: string): ToolPolicy | undefined {
        const policy = catalogs.get(this)!.get(name)?.policy
        return policy ? { ...policy } : undefined
    }

    /** 导出模型工具描述；供应商投影由模型插件负责。 */
    definitions(): AgentToolDefinition[] {
        return [...catalogs.get(this)!.values()].map(tool => ({
            name: tool.name, description: tool.description,
            inputSchema: z.toJSONSchema(tool.inputSchema, { io: 'input' })
        }))
    }

    /** 首次初始化结束后调用；不冻结 Context 工作对象。 @internal */
    seal(): void { this.sealed = true }

    /** 防止运行中改变注册事实。 */
    private assertMutable(): void {
        if (this.sealed) { throw new Error('工具注册表已经固定；请使用新的 Agent 装配。') }
    }
}
