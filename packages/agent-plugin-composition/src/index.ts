import { createAgent } from '@quifox/agent-core'
import type { Agent, AgentContext, AgentHooks, AgentPlugin, AgentRunOutcome } from '@quifox/agent-core'

/** Host 持有 Agent 引用；插件负责在最后收尾时交接。 */
export interface PluginCompositionOptions<Input = unknown, Ctx extends AgentContext = AgentContext> {
    /** @param nextAgent - 下一轮使用的新 Agent。 */
    replaceAgent(nextAgent: Agent<Input, Ctx>): void | Promise<void>
}

interface Run<Input, Ctx extends AgentContext> {
    pending?: AgentPlugin<Input, Ctx>[]
}

/** 暂存真实插件组合，自动在最后一个收尾钩子中替换外部引用。 */
export class PluginCompositionPlugin<Input = unknown, Ctx extends AgentContext = AgentContext> implements AgentPlugin<Input, Ctx> {
    readonly id = 'plugin-composition'
    readonly hooks: AgentHooks<Input, Ctx>
    private readonly tail: AgentPlugin<Input, Ctx>
    private readonly runs = new Map<AgentRunOutcome, Run<Input, Ctx>>()

    /** @param options - Host 的引用切换回调。 */
    constructor(private readonly options: PluginCompositionOptions<Input, Ctx>) {
        const tail: AgentPlugin<Input, Ctx> = {
            id: 'plugin-composition-tail',
            hooks: {
                onRegister: async plugins => {
                    for (let index = plugins.length - 1; index >= 0; index--) {
                        if (plugins[index] === tail) { plugins.splice(index, 1) }
                    }
                    if (plugins.includes(this)) { plugins.push(tail) }
                },
                onRunEnd: async (ctx, outcome) => { await this.finish(ctx, outcome) }
            }
        }
        this.tail = tail
        this.hooks = {
            onRegister: async plugins => {
                if (!plugins.includes(tail)) { plugins.push(tail) }
            },
            onInitialize: async ctx => {
                this.assertFinalCleanup(ctx)
            },
            onRunStart: async (_ctx, _input, outcome) => {
                if (!this.runs.has(outcome)) { this.runs.set(outcome, {}) }
                return { action: 'continue' }
            }
        }
    }

    /** @param plugins - 下一轮完整有序组合；不传输 JSON 句柄或文件路径。 */
    setNextPlugins(plugins: AgentPlugin<Input, Ctx>[]): void {
        const run = [...this.runs.values()].at(-1)
        if (!run) { throw new Error('插件组合没有当前运行。') }
        // 只移除本 owner 的内部收尾对象，不推断其他插件的依赖。
        run.pending = plugins.filter(plugin => plugin !== this.tail)
    }

    /** @param ctx - 原 Context。 @param outcome - 最后收尾时的运行结果。 */
    private async finish(ctx: Ctx, outcome: AgentRunOutcome): Promise<void> {
        const run = this.runs.get(outcome)
        if (!run) { return }
        this.runs.delete(outcome)
        if (!outcome.ok || run.pending === undefined) { return }
        this.assertFinalCleanup(ctx)
        const nextAgent = createAgent<Input, Ctx>({ plugins: run.pending })
        await this.options.replaceAgent(nextAgent)
    }

    /** @param ctx - Hook 对象可变，因此交接前也检查实际收尾顺序。 */
    private assertFinalCleanup(ctx: Ctx): void {
        const plugins = ctx.plugins as readonly AgentPlugin<Input, Ctx>[]
        const final = plugins.filter(plugin => {
            const hook = plugin.hooks?.onRunEnd
            return hook !== undefined && (!Array.isArray(hook) || hook.length > 0)
        }).at(-1)
        if (final !== this.tail) { throw new Error('插件组合必须位于最后一个 onRunEnd 收尾位置。') }
    }
}
