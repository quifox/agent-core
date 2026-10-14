import { expect, it } from 'vitest'
import { createAgent, type AgentContext } from '@quifox/agent-core'
import { KnowledgePlugin } from '../src/index.js'

it('exposes a directly callable retrieval tool with readable evidence and typed sources', async () => {
    let context: AgentContext | undefined
    const agent = createAgent({ plugins: [new KnowledgePlugin(async () => [{ content: 'Synthetic evidence', document: 'Guide', score: .9 }]), { id: 'capture', hooks: { onInitialize: async ctx => { context = ctx }, onRunStart: async () => ({ action: 'stop', value: undefined }) } }] })
    await agent.run({})
    expect(context!.tools.get('knowledge_retrieve')!.description).not.toContain('Mock')
    const result = await context!.tools.get('knowledge_retrieve')!.execute({ question: 'A general knowledge question' }, context!)
    expect(result.content).toContain('[1] Guide\nSynthetic evidence')
    expect(result.data).toEqual({ chunks: [{ content: 'Synthetic evidence', document: 'Guide', score: .9 }] })
})
