import { expect, it } from 'vitest'
import { mkdir, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import type { SessionView } from '../src/protocol.js'
import { synthetic } from './synthetic.js'

it('loads an exact selected Skill identity and a builtin-conflicting name through dollar selection', async () => {
    const fixture = await synthetic(() => ({ text: 'selected' }))
    try {
        const workspace = join(fixture.root, 'project'), global = join(fixture.root, 'skills', 'help'), local = join(workspace, '.agents', 'skills', 'help')
        await mkdir(global, { recursive: true }); await mkdir(local, { recursive: true })
        await writeFile(join(global, 'SKILL.md'), '---\nname: help\ndescription: Global selection.\n---\nGLOBAL_EXACT_BODY')
        await writeFile(join(local, 'SKILL.md'), '---\nname: help\ndescription: Local selection.\n---\nLOCAL_NEAREST_BODY')
        const session = await fixture.runtime.command({ type: 'create', workspace }) as SessionView
        await fixture.runtime.command({ type: 'submit', sessionId: session.id, prompt: '$global-skills/help review this' }); await fixture.runtime.waitForIdle(session.id)
        expect(JSON.stringify(fixture.requests[0]?.messages)).toContain('GLOBAL_EXACT_BODY'); expect(JSON.stringify(fixture.requests[0]?.messages)).not.toContain('LOCAL_NEAREST_BODY')
        await fixture.runtime.command({ type: 'submit', sessionId: session.id, prompt: '$help review the local skill' }); await fixture.runtime.waitForIdle(session.id)
        expect(JSON.stringify(fixture.requests[1]?.messages)).toContain('LOCAL_NEAREST_BODY')
    } finally { await fixture.close() }
})

it('does not discover or inject a Skill disabled by Host configuration', async () => {
    const fixture = await synthetic(() => ({ text: 'selected' }), config => {
        config.skills.disabled = ['global-skills/help']
    })
    try {
        const global = join(fixture.root, 'skills', 'help')
        await mkdir(global, { recursive: true })
        await writeFile(join(global, 'SKILL.md'), '---\nname: help\ndescription: Global selection.\n---\nDISABLED_SKILL_BODY')
        const session = await fixture.runtime.command({ type: 'create' }) as SessionView
        const resources = await fixture.runtime.command({ type: 'resources', workspace: fixture.root }) as { skills: { skills: { id: string }[] } }
        expect(resources.skills.skills.map(skill => skill.id)).toContain('global-skills/help')
        await fixture.runtime.command({ type: 'submit', sessionId: session.id, prompt: '$global-skills/help review this' }); await fixture.runtime.waitForIdle(session.id)
        expect(fixture.requests).toHaveLength(0)
        expect((await fixture.runtime.command({ type: 'snapshot', sessionId: session.id }) as SessionView).status).toBe('error')
    } finally { await fixture.close() }
})
