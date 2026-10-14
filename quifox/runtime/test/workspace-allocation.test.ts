import { expect, it, vi } from 'vitest'
import { stat, readdir } from 'node:fs/promises'
import { join } from 'node:path'
import { randomUUID } from 'node:crypto'
import { synthetic } from './synthetic.js'
import type { SessionView } from '../src/protocol.js'
import type { ResourceView } from '../src/protocol.js'

it('projects dated workspace defaults without creating directories and uses them for the new conversation', async () => {
    vi.useFakeTimers({ toFake: ['Date'] }); vi.setSystemTime(new Date(2026, 9, 13, 10))
    const fixture = await synthetic(() => ({ text: 'done' }))
    try {
        const resources = await fixture.runtime.command({ type: 'resources', workspace: null }) as ResourceView
        expect(resources.workspace).toBe(fixture.root)
        expect(resources.config.workspace).toBe(resources.workspace)
        const parent = join(fixture.root, 'workspaces', '2026-10-13')
        await expect(stat(parent)).rejects.toMatchObject({ code: 'ENOENT' })
        await expect(fixture.runtime.command({ type: 'plugins', workspace: resources.workspace })).resolves.toMatchObject({ scope: 'configuration', plugins: [] })
        const session = await fixture.runtime.command({ type: 'create', workspace: null }) as SessionView
        expect(session.defaultModel?.model).toBe(resources.config.model.model)
        expect(session.workspace).toBe(join(parent, 'new-chat'))
    } finally { await fixture.close(); vi.useRealTimers() }
})

it('allocates separate dated directories and reuses the original directory when creation is retried after midnight', async () => {
    vi.useFakeTimers({ toFake: ['Date'] }); vi.setSystemTime(new Date(2026, 9, 13, 23, 59))
    const fixture = await synthetic(() => ({ text: 'done' }))
    const id = randomUUID()
    try {
        const [one, two] = await Promise.all([
            fixture.runtime.command({ type: 'create', sessionId: id, workspace: null }),
            fixture.runtime.command({ type: 'create', workspace: null })
        ]) as SessionView[]
        const day = join(fixture.root, 'workspaces', '2026-10-13')
        expect(new Set([one!.workspace, two!.workspace])).toEqual(new Set([join(day, 'new-chat'), join(day, 'new-chat-2')]))
        expect((await stat(one!.workspace)).isDirectory()).toBe(true)
        vi.setSystemTime(new Date(2026, 9, 14, 0, 1)); await fixture.restart()
        const retried = await fixture.runtime.command({ type: 'create', sessionId: id, workspace: null }) as SessionView
        expect(retried.id).toBe(one!.id); expect(retried.workspace).toBe(one!.workspace)
        expect(await readdir(join(fixture.root, 'workspaces'))).toEqual(['2026-10-13'])
        const chosen = await fixture.runtime.command({ type: 'create', workspace: fixture.root }) as SessionView
        expect(chosen.workspace).toBe(fixture.root)
    } finally { await fixture.close(); vi.useRealTimers() }
})
