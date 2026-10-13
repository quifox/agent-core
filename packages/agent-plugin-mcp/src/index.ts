import { Ajv } from 'ajv'
import { Ajv2020 } from 'ajv/dist/2020.js'
import { z } from 'zod'
import { defineTool, toolError, toolSuccess, type AgentContext, type AgentHooks, type AgentPlugin, type ToolPolicy } from '@quifox/agent-core'

export interface McpToolDescription { name: string; description?: string; inputSchema: Record<string, unknown> }
export interface McpCallResult { content: Record<string, unknown>[]; structuredContent?: unknown; isError?: boolean }
export interface McpClientPort {
    listTools(input?: { cursor: string }): Promise<{ tools: McpToolDescription[]; nextCursor?: string }>
    callTool(input: { name: string; arguments: Record<string, unknown> }, signal?: AbortSignal): Promise<McpCallResult>
    close(): Promise<void>
}
export interface McpPluginOptions {
    namespace: string
    client: McpClientPort
    policy?(tool: McpToolDescription): ToolPolicy
    signal?(ctx: AgentContext): AbortSignal | undefined
}

/** Adapt a Host-owned MCP client to ordinary Core Tools without transport dependencies. */
export class McpPlugin implements AgentPlugin {
    id: string
    readonly hooks: AgentHooks
    private closed = false

    constructor(private readonly options: McpPluginOptions) {
        if (!/^[A-Za-z0-9_-]{1,20}$/.test(options.namespace)) throw new Error('Invalid MCP namespace.')
        this.id = `mcp:${options.namespace}`
        this.hooks = { onInitialize: async ctx => {
            const names = new Set<string>()
            const cursors = new Set<string>()
            let cursor: string | undefined
            do {
                const page = await options.client.listTools(cursor === undefined ? undefined : { cursor })
                for (const description of page.tools) {
                    if (!description.name) throw new Error('MCP tool name is empty.')
                    const name = toolName(options.namespace, description.name)
                    if (names.has(name)) throw new Error('MCP tool identity collision.')
                    names.add(name)
                    const validator = description.inputSchema.$schema === 'http://json-schema.org/draft-07/schema#'
                        ? new Ajv({ allErrors: true, validateFormats: false }) : new Ajv2020({ allErrors: true, validateFormats: false })
                    if (description.inputSchema.$async === true) throw new Error('Asynchronous MCP argument schemas are unsupported.')
                    const validate = validator.compile(description.inputSchema)
                    const inputSchema = z.record(z.string(), z.unknown()).superRefine((input, refinement) => {
                        if (!validate(input)) refinement.addIssue({ code: 'custom', message: 'MCP arguments do not match the declared schema.' })
                    }).meta(description.inputSchema)
                    ctx.tools.register(defineTool({ name, description: description.description ?? description.name, inputSchema,
                        policy: options.policy?.(description) ?? { sideEffect: 'external', approval: 'host' },
                        execute: async (input, context) => {
                            if (this.closed) throw new Error('MCP client is closed.')
                            const result = await options.client.callTool({ name: description.name, arguments: input }, options.signal?.(context))
                            const content = JSON.stringify(result)
                            return result.isError ? toolError(content, { code: 'MCP_TOOL_ERROR', data: result }) : toolSuccess(content, result)
                        }
                    }))
                }
                cursor = page.nextCursor
                if (cursor !== undefined) {
                    if (cursors.has(cursor)) throw new Error('MCP pagination cursor repeated.')
                    cursors.add(cursor)
                }
            } while (cursor !== undefined)
        } }
    }

    /** The Host closes connections at application shutdown, not after each model turn. */
    async close(): Promise<void> {
        if (this.closed) return
        this.closed = true
        await this.options.client.close()
    }
}

/** Stable aliases keep punctuation-rich MCP identities compatible with Chat tool names. */
export function toolName(namespace: string, original: string): string {
    let hash = 2166136261
    for (const character of original) { hash ^= character.codePointAt(0)!; hash = Math.imul(hash, 16777619) >>> 0 }
    const readable = original.replace(/[^A-Za-z0-9_-]/g, '_').slice(0, 62 - namespace.length - 8)
    return `${namespace}_${readable}_${hash.toString(16).padStart(8, '0')}`
}
