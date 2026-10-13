import { expect, it } from 'vitest'
import { mkdir, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { QuiFoxRuntime } from '../src/runtime.js'
import { synthetic } from './synthetic.js'
import type { SessionView } from '../src/protocol.js'
import { PresentationBridge } from '../src/presentation-host.js'
import type { PresentationRequest } from '../src/protocol.js'

it('accepts a pending display receipt even if the configuration changed to an invalid value during the run', async () => {
    const fixture = await synthetic((_request, index) => index === 1 ? { calls: [{ id: 'show-pending', name: 'open_view', input: { target: 'source.ts' } }] } : { text: 'confirmed' })
    let request: PresentationRequest | undefined, gui: QuiFoxRuntime | undefined
    const bridge = new PresentationBridge(async frame => { if (frame.kind === 'presentation') request = frame.request })
    try {
        await writeFile(join(fixture.root, 'source.ts'), 'const value = 1')
        await fixture.runtime.close()
        gui = await QuiFoxRuntime.open({ root: fixture.root, workspace: fixture.root, environment: {}, globalSkillsRoot: join(fixture.root, 'isolated'), presentation: bridge })
        const session = await gui.command({ type: 'create' }) as SessionView
        await gui.command({ type: 'submit', sessionId: session.id, prompt: 'show source' })
        await expect.poll(() => request?.id).toBeDefined()
        await writeFile(join(fixture.root, 'config.json'), '{}')
        await gui.command({ type: 'presentation-reply', requestId: request!.id, reply: { ok: true, receipt: { destination: 'panel', viewId: 'visible-tab', target: request!.target, kind: 'text' } } })
        await gui.waitForIdle(session.id)
        expect(fixture.requests).toHaveLength(2)
        expect(fixture.requests.at(-1)?.messages.find(message => message.role === 'tool')?.content).toContain('visible-tab')
    } finally { bridge.close(); await gui?.close(); await fixture.close() }
})

it('composes GUI tools and temporary context per host and preserves canonical history on TUI takeover', async () => {
    const fixture = await synthetic((_request, index) => index === 1 ? { calls: [{ id: 'open-one', name: 'open_view', input: { target: 'source.ts' } }] } : { text: 'confirmed' })
    let gui: QuiFoxRuntime | undefined
    let confirm!: () => void
    try {
        await writeFile(join(fixture.root, 'source.ts'), 'const value = 1')
        await fixture.runtime.close()
        gui = await QuiFoxRuntime.open({ root: fixture.root, workspace: fixture.root, environment: {}, globalSkillsRoot: join(fixture.root, 'isolated'), presentation: {
            open: request => new Promise(resolve => { confirm = () => resolve({ destination: 'panel', viewId: 'actual-view', kind: 'text', target: request.target }) }),
            confirm() {}
        } })
        const session = await gui.command({ type: 'create' }) as SessionView
        await gui.command({ type: 'submit', sessionId: session.id, prompt: 'show source' })
        await expect.poll(() => typeof confirm).toBe('function')
        expect(fixture.requests).toHaveLength(1)
        expect(fixture.requests[0]?.tools.map(tool => tool.function.name)).toContain('open_view')
        expect(fixture.requests[0]?.messages.filter(message => message.role === 'system').map(message => message.content).join('')).toContain('Desktop presentation')
        confirm(); await gui.waitForIdle(session.id)
        const displayed = await gui.command({ type: 'snapshot', sessionId: session.id }) as SessionView
        expect(displayed.messages.find(entry => entry.message.role === 'tool')?.message.content).toContain('actual-view')
        expect(displayed.messages.some(entry => entry.message.content.includes('Desktop presentation is available'))).toBe(false)
        await gui.close(); gui = undefined
        await fixture.restart()
        await fixture.runtime.command({ type: 'submit', sessionId: session.id, prompt: 'continue in TUI' }); await fixture.runtime.waitForIdle(session.id)
        expect(fixture.requests.at(-1)?.tools.map(tool => tool.function.name)).not.toContain('open_view')
        expect(fixture.requests.at(-1)?.messages.filter(message => message.role === 'system').map(message => message.content).join('')).not.toContain('Desktop presentation')
    } finally { await gui?.close(); await fixture.close() }
})

it('opens absolute files outside the session workspace as a read-only presentation without approval', async () => {
    const fixture = await synthetic((_request, index) => index === 1 ? { calls: [{ id: 'outside-view', name: 'open_view', input: { target: join(fixture.root, 'outside.png') } }] } : { text: 'displayed' })
    let gui: QuiFoxRuntime | undefined
    const shown: string[] = []
    try {
        await writeFile(join(fixture.root, 'outside.png'), Buffer.from([137, 80, 78, 71]))
        await mkdir(join(fixture.root, 'isolated'), { recursive: true })
        await fixture.runtime.close()
        gui = await QuiFoxRuntime.open({ root: fixture.root, environment: {}, globalSkillsRoot: join(fixture.root, 'isolated'), presentation: {
            open: async request => { shown.push(request.target); return { destination: 'panel', viewId: 'outside-tab', kind: 'image', target: request.target } }, confirm() {}
        } })
        const session = await gui.command({ type: 'create', workspace: join(fixture.root, 'isolated') }) as SessionView
        await gui.command({ type: 'submit', sessionId: session.id, prompt: 'show outside file' }); await gui.waitForIdle(session.id)
        const view = await gui.command({ type: 'snapshot', sessionId: session.id }) as SessionView
        expect(view.approvals).toEqual([])
        expect(shown).toHaveLength(1)
        expect(view.messages.find(entry => entry.message.role === 'tool')?.message.content).toContain('outside-tab')
    } finally { await gui?.close(); await fixture.close() }
})
