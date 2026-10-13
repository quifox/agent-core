import { expect, it } from 'vitest'
import { join } from 'node:path'
import type { RuntimeEvent, SessionView } from '../src/protocol.js'
import { FileMemoryStore } from '../src/memory-store.js'
import { synthetic } from './synthetic.js'
import { mkdir, writeFile } from 'node:fs/promises'
import { emptyMemoryState } from '@quifox/agent-plugin-memory'
import { SessionJournal } from '../src/journal.js'

it('runs both existing Memory stages over real Chat HTTP and publishes completion to the selected UI', async () => {
    let published = false
    const global = "v1\n\n## User Profile\n\n## User preferences\nKeep task plans concise.\n\n## General Tips\n\n## What's in Memory\n"
    const fixture = await synthetic(input => {
        const tools = input.tools ?? []
        if (!tools.length) return { text: JSON.stringify({ description: 'Task planning preference', summary: 'The human explicitly asked for concise task plans.' }) }
        if (tools.some(tool => tool.function.name === 'memory_publish')) {
            if (!published) { published = true; return { calls: [{ id: 'publish-memory', name: 'memory_publish', input: { content: global } }] } }
            return { text: 'Memory publication complete.' }
        }
        return { text: 'Acknowledged.' }
    }, config => { config.memory.generate = true; config.memory.minIdleMs = 0 })
    const events: RuntimeEvent[] = []
    fixture.runtime.subscribe(event => events.push(event))
    try {
        const source = await fixture.runtime.command({ type: 'create' }) as SessionView
        await fixture.runtime.command({ type: 'submit', sessionId: source.id, prompt: 'Keep task plans concise.' }); await fixture.runtime.waitForIdle(source.id)
        await expect.poll(async () => (await fixture.runtime.command({ type: 'snapshot', sessionId: source.id }) as SessionView).memory.processing).toBe(false)
        const current = await fixture.runtime.command({ type: 'create' }) as SessionView
        await fixture.runtime.command({ type: 'memory', sessionId: current.id })
        await expect.poll(async () => (await fixture.runtime.command({ type: 'snapshot', sessionId: current.id }) as SessionView).memory.summaries).toBe(1)
        await expect.poll(async () => (await fixture.runtime.command({ type: 'snapshot', sessionId: current.id }) as SessionView).memory.processing).toBe(false)
        await expect.poll(async () => (await fixture.runtime.command({ type: 'snapshot', sessionId: current.id }) as SessionView).memory.content).toContain('Keep task plans concise.')
        const state = await new FileMemoryStore(join(fixture.root, 'memory')).load('local')
        expect(Object.keys(state.summaries)).toEqual([source.id])
        expect(state.summaries[source.id]?.sourceRef).toBe(`conversation:${source.id}`)
        await expect.poll(() => events.some(event => event.sessionId === current.id && event.type === 'memory' && (event.data as { content: string; processing: boolean }).content.includes('Keep task plans concise.') && !(event.data as { processing: boolean }).processing)).toBe(true)
        expect(fixture.requests.find(input => !input.tools?.length)?.messages.some(message => message.content.includes('Keep task plans concise.'))).toBe(true)
        await fixture.restart()
        expect((await fixture.runtime.command({ type: 'snapshot', sessionId: current.id }) as SessionView).memory.content).toContain('Keep task plans concise.')
    } finally { await fixture.close() }
})

it('honors project Memory opt-outs in prompts, display and later global extraction', async () => {
    const fixture = await synthetic(() => ({ text: 'ordinary project reply' }), config => { config.memory.generate = true; config.memory.minIdleMs = 0 })
    try {
        const store = new FileMemoryStore(join(fixture.root, 'memory'))
        await store.compareAndSet('local', 0, { ...emptyMemoryState(), revision: 1, global: 'Synthetic private global memory' })
        const workspace = join(fixture.root, 'project')
        await mkdir(join(workspace, '.quifox'), { recursive: true })
        await writeFile(join(workspace, '.quifox', 'config.json'), JSON.stringify({ memory: { enabled: false, generate: false } }))
        const source = await fixture.runtime.command({ type: 'create', workspace }) as SessionView
        await fixture.runtime.command({ type: 'submit', sessionId: source.id, prompt: 'project without Memory' }); await fixture.runtime.waitForIdle(source.id)
        const view = await fixture.runtime.command({ type: 'snapshot', sessionId: source.id }) as SessionView
        expect(view.memory).toMatchObject({ enabled: false, processing: false, content: '' })
        expect(JSON.stringify(fixture.requests[0]?.messages)).not.toContain('Synthetic private global memory')
        const saved = (await new SessionJournal(fixture.runtime.paths.sessions).read(source.id)).records.filter(record => record.kind === 'state').at(-1)!.state as { metadata: { generateMemory: boolean } }
        expect(saved.metadata.generateMemory).toBe(false)
        const ordinary = await fixture.runtime.command({ type: 'create' }) as SessionView
        await fixture.runtime.command({ type: 'memory', sessionId: ordinary.id })
        await expect.poll(async () => (await fixture.runtime.command({ type: 'snapshot', sessionId: ordinary.id }) as SessionView).memory.processing).toBe(false)
        expect(fixture.requests.filter(request => !request.tools.length)).toHaveLength(0)
        expect(JSON.stringify(fixture.requests.slice(1))).not.toContain('project without Memory')
    } finally { await fixture.close() }
})
