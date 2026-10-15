import { defineTool, toolError, toolSuccess, type AgentContext, type AgentHooks, type AgentPlugin, type ModelTurnResult } from '@quifox/agent-core'
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
    run(source: { script?: string; name?: string; path?: string }, input: Record<string, unknown>, ctx: AgentContext): Promise<unknown>
    context?(ctx: AgentContext): { set(key: string, content: string): void }
    skillPath?: string
    libraryPath?: string
}

/** Expected authoring or source errors are returned to the model for correction. */
export class WorkflowInputError extends Error {}

/** Ordinary tools delegate to the same Host workflow service used by the UI and API. */
export class WorkflowToolsPlugin implements AgentPlugin {
    readonly id = 'workflows'
    readonly hooks: AgentHooks
    constructor(options: WorkflowToolsOptions) {
        const tool = defineTool({ name: 'workflow_run', description: 'Run a TypeScript workflow with explicit input. Choose a .ts file path (relative to the workspace or absolute), a library name, or an inline script. Validation runs before execution and reports authoring errors for correction.',
            inputSchema: z.object({ name: z.string().min(1).optional(), path: z.string().min(1).optional(), script: z.string().min(1).max(200000).optional(), input: z.record(z.string(), z.unknown()).default({}) }).strict().refine(value => [value.name, value.path, value.script].filter(Boolean).length === 1, 'Choose exactly one workflow source.'), policy: { sideEffect: 'external', approval: 'host' },
            execute: async ({ name, path, script, input }, ctx) => {
                try {
                    const value = await options.run({ ...(name ? { name } : {}), ...(path ? { path } : {}), ...(script ? { script } : {}) }, input, ctx)
                    return toolSuccess(typeof value === 'string' ? value : JSON.stringify(value) ?? 'Workflow completed.', value)
                } catch (cause) { if (cause instanceof WorkflowInputError) return toolError(cause.message, { code: 'WORKFLOW_INPUT_INVALID' }); throw cause }
            } })
        this.hooks = { onInitialize: async ctx => { ctx.tools.register(tool) }, beforeModel: async ctx => {
            options.context?.(ctx).set('workflows', ctx.tools.get(tool.name) ? [
                ctx.tools.get('run_command') ? `Read the TypeScript workflow Skill${options.skillPath ? ` at ${options.skillPath}` : ' before authoring workflows'}.` : '',
                ctx.tools.get('run_command') || ctx.tools.get('apply_patch') ? `Save .ts files with ordinary file operations${options.libraryPath ? `; the workflow library is ${options.libraryPath}` : ''}.` : '',
                'workflow_run validates and executes a file or one-time script. Display scripts in a dynamic-workflow fenced block for the GUI graph.'
            ].filter(Boolean).join(' ') : '')
            return { action: 'continue' }
        } }
    }
}
