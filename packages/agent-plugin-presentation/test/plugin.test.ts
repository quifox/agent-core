import { expect, it } from 'vitest'
import { ToolRegistry, type AgentContext } from '@quifox/agent-core'
import { PresentationPlugin } from '../src/index.js'

it('allows the host to normalize the requested target and reports the actual destination', async () => {
    const plugin = new PresentationPlugin({ open: async () => ({ destination: 'panel', viewId: 'normalized', target: '/workspace/source.ts', kind: 'text' }), context: () => ({ set() {} }) })
    const ctx: AgentContext = { tools: new ToolRegistry(), plugins: [plugin] }
    await plugin.hooks.onInitialize(ctx)
    const tool = ctx.tools.get('open_view')!
    await expect(tool.execute(await tool.prepare(ctx, { target: './source.ts' }), ctx)).resolves.toMatchObject({ status: 'success', data: { target: '/workspace/source.ts' } })
})

it('returns only a confirmed view receipt and keeps its context request-only', async () => {
    let confirm!: (value: { destination: 'panel'; viewId: string; target: string; kind: string }) => void
    const contributions: string[] = []
    const plugin = new PresentationPlugin({ open: () => new Promise(resolve => { confirm = resolve }), context: () => ({ set: (_key, value) => contributions.push(value) }) })
    const ctx: AgentContext = { tools: new ToolRegistry(), plugins: [plugin] }
    await plugin.hooks.onInitialize(ctx)
    const tool = ctx.tools.get('open_view')!
    let settled = false
    const result = tool.execute(await tool.prepare(ctx, { target: 'image.png' }), ctx).then(value => { settled = true; return value })
    await Promise.resolve()
    expect(settled).toBe(false)
    confirm({ destination: 'panel', viewId: 'image-tab', target: 'image.png', kind: 'image' })
    await expect(result).resolves.toMatchObject({ status: 'success', data: { viewId: 'image-tab', destination: 'panel' } })
    expect(contributions).toEqual([])
})
