import { defineTool, toolSuccess, type AgentContext, type AgentHooks, type AgentPlugin, type ModelTurnResult } from '@quifox/agent-core'
import { z } from 'zod'

export interface WorkflowModelOptions {
    input(ctx: AgentContext): unknown
    execute(input: unknown, ctx: AgentContext): Promise<string>
}

/** A workflow supplies the model capability while its Host owns compilation and execution. */
export class WorkflowModelPlugin implements AgentPlugin {
    readonly id = 'workflow-model'
    readonly hooks: AgentHooks
    constructor(options: WorkflowModelOptions) {
        this.hooks = { model: async function* (ctx): AsyncGenerator<never, ModelTurnResult, void> {
            const text = await options.execute(options.input(ctx), ctx)
            return { text, reasoning: '', toolCalls: [], usage: {}, finishReason: 'stop' }
        } }
    }
}

export interface WorkflowToolsOptions {
    inspect(script: string): Promise<unknown>
    save(name: string, script: string, ctx: AgentContext): Promise<unknown>
    run(source: { script?: string; name?: string }, input: Record<string, unknown>, ctx: AgentContext): Promise<unknown>
}

/** Ordinary tools delegate to the same Host workflow service used by the UI and API. */
export class WorkflowToolsPlugin implements AgentPlugin {
    readonly id = 'workflows'
    readonly hooks: AgentHooks
    constructor(options: WorkflowToolsOptions) {
        const tools = [
            defineTool({ name: 'workflow_inspect', description: 'Check a reusable TypeScript workflow and resolve its static method-call graph without executing it. Load the automatically discovered typescript-workflows Skill for authoring API and plugin documentation. Label named functions with JSDoc @node Label or @phase Label; do not write graph IDs or edges. Branches, loops and Promise.all use ordinary TypeScript. agent(name, {plugins:[id]}).ask<T>(prompt) creates a fresh Agent with the common Host plugins. args.question and args.messages contain this turn and outer user/assistant history. No imports, filesystem or network in scripts. Return a Markdown string. Display scripts using a dynamic-workflow fenced code block; runtime tracing supplies actual calls and states.', inputSchema: z.object({ script: z.string().min(1).max(200000) }).strict(), policy: { sideEffect: 'none', approval: 'none', retrySafe: true },
                execute: async ({ script }) => toolSuccess('工作流检查完成。', await options.inspect(script)) }),
            defineTool({ name: 'workflow_save', description: 'Save a reusable TypeScript workflow in the current workflow library.', inputSchema: z.object({ name: z.string().min(1).max(64), script: z.string().min(1).max(200000) }).strict(), policy: { sideEffect: 'external', approval: 'host' },
                execute: async ({ name, script }, ctx) => toolSuccess('工作流已保存。', await options.save(name, script, ctx)) }),
            defineTool({ name: 'workflow_run', description: 'Run a saved workflow or a one-time TypeScript script with explicit input. Use workflow_inspect to validate authored scripts first.',
                inputSchema: z.object({ name: z.string().min(1).optional(), script: z.string().min(1).max(200000).optional(), input: z.record(z.string(), z.unknown()).default({}) }).strict().refine(value => Boolean(value.name) !== Boolean(value.script), 'Choose exactly one workflow source.'), policy: { sideEffect: 'external', approval: 'host' },
                execute: async ({ name, script, input }, ctx) => { const value = await options.run({ ...(name ? { name } : {}), ...(script ? { script } : {}) }, input, ctx); return toolSuccess('工作流运行完成。', value) } })
        ] as const
        this.hooks = { onInitialize: async ctx => { ctx.tools.register(tools[0]); ctx.tools.register(tools[1]); ctx.tools.register(tools[2]) } }
    }
}
