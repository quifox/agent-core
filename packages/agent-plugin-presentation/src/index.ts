import { z } from 'zod'
import { defineTool, toolError, toolSuccess, type AgentContext, type AgentPlugin } from '@quifox/agent-core'

/** A receipt from the actual presentation host, not from request dispatch. */
export type PresentationReceipt = { destination: 'panel'; viewId: string; target: string; kind: string } |
    { destination: 'external'; target: string }

export interface PresentationOptions {
    open(target: string, ctx: AgentContext): Promise<PresentationReceipt>
    context(): { set(key: string, content: string): void }
}

/** Register only in a host that can confirm user-visible views. */
export class PresentationPlugin implements AgentPlugin {
    id = 'presentation'
    readonly hooks

    constructor(options: PresentationOptions) {
        const tool = defineTool({
            name: 'open_view', description: 'Show a local file, image or video from any directory to the user in a Desktop tab. Relative paths resolve from the conversation working directory. HTTP(S) URLs open in the external browser. Return only confirmed destinations.',
            inputSchema: z.object({ target: z.string().min(1).max(4096).refine(value => !!value.trim()).describe('Absolute or relative local file path, or HTTP(S) URL.') }).strict(),
            policy: { sideEffect: 'ui', approval: 'none' },
            execute: async (input, ctx) => {
                try {
                    const receipt = await options.open(input.target, ctx)
                    if (!receipt.target.trim()) throw new Error('Invalid presentation receipt.')
                    if (receipt.destination === 'panel' && (!receipt.viewId || !receipt.kind)) throw new Error('View was not confirmed.')
                    return toolSuccess(receipt.destination === 'panel' ? `Opened ${receipt.target} in Desktop (${receipt.kind}, view ${receipt.viewId}).` :
                        `Handed ${receipt.target} to the external browser. Page loading is not confirmed.`, receipt)
                } catch (cause) {
                    return toolError(cause instanceof Error ? cause.message : 'Presentation was not confirmed.', { code: 'PRESENTATION_FAILED' })
                }
            }
        })
        this.hooks = {
            onInitialize: async (ctx: AgentContext): Promise<void> => { ctx.tools.register(tool) },
            beforeModel: async (ctx: AgentContext): Promise<{ action: 'continue' }> => {
                options.context().set('desktop-presentation', ctx.tools.get(tool.name) ?
                    'Desktop presentation is available in this request. Use open_view to show relevant local files, images or videos from any directory when helpful. Relative paths resolve from the working directory. URLs are handed to an external browser. Only a confirmed tool receipt proves a view was opened; never infer page load.' : '')
                return { action: 'continue' }
            }
        }
    }
}
