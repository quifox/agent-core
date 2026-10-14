import { expect, it } from 'vitest'
import { mockRetrieveKnowledge } from '../src/retrieval.js'
import { defaultConfig } from '../src/config.js'
import { synthetic } from './synthetic.js'
import type { SessionView } from '../src/protocol.js'

it('returns clearly marked local mock evidence and narrows the synthetic document scope', async () => {
    const results = await mockRetrieveKnowledge({ question: 'parallel workflow', documentIds: ['mock-parallel'] })
    expect(results).toHaveLength(1)
    expect(results[0]).toMatchObject({ document: '[Mock] Parallel research', documentId: 'mock-parallel' })
    expect(results[0]?.content).toContain('Synthetic example')
    expect(await mockRetrieveKnowledge({ question: 'parallel workflow', documentIds: ['unknown'] })).toEqual([])
    expect(await mockRetrieveKnowledge({ question: 'unrelated question' })).toEqual([])
    expect(defaultConfig('/synthetic').installedPlugins).not.toContain('knowledge')
})
it('respects cancellation without opening a retrieval connection', async () => {
    const controller = new AbortController(); controller.abort(new Error('mock cancelled'))
    await expect(mockRetrieveKnowledge({ question: 'workflow' }, controller.signal)).rejects.toThrow('mock cancelled')
})
it('lets a workflow Agent invoke the mock interface through the normal tool loop', async () => {
    const fixture = await synthetic((_request, index) => index === 1
        ? { calls: [{ id: 'retrieval', name: 'knowledge_retrieve', input: { question: 'parallel workflow', documentIds: ['mock-parallel'] } }] }
        : { text: '**Mock answer** based on synthetic evidence.' })
    try {
        await fixture.runtime.command({ type: 'plugin-install', pluginId: 'knowledge', action: 'install', scope: 'global' })
        const script = 'return await agent("Research", {plugins:["knowledge"], tools:["knowledge_retrieve"]}).ask(String(args.question));'
        const session = await fixture.runtime.command({ type: 'create', workflow: { name: 'mock-example', script } }) as SessionView
        await fixture.runtime.command({ type: 'submit', sessionId: session.id, prompt: 'parallel workflow' }); await fixture.runtime.waitForIdle(session.id)
        expect((await fixture.runtime.command({ type: 'snapshot', sessionId: session.id }) as SessionView).messages.at(-1)?.message.content).toContain('Mock answer')
        expect(fixture.requests[0]?.tools.map(tool => tool.function.name)).toEqual(['knowledge_retrieve'])
        expect(JSON.stringify(fixture.requests[0]?.tools)).toContain('Mock')
        expect(fixture.requests[1]?.messages.find(message => message.role === 'tool')?.content).toContain('[Mock] Parallel research')
        await fixture.runtime.command({ type: 'plugin-set-enabled', pluginId: 'knowledge', scope: 'global', enabled: false })
        const other = await fixture.runtime.command({ type: 'create' }) as SessionView
        await fixture.runtime.command({ type: 'submit', sessionId: other.id, prompt: 'without mock' }); await fixture.runtime.waitForIdle(other.id)
        expect(fixture.requests.at(-1)?.tools.map(tool => tool.function.name)).not.toContain('knowledge_retrieve')
    } finally { await fixture.close() }
}, 15000)
