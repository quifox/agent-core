import { expect, it } from 'vitest'
import { mkdir, readFile, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import type { SessionView } from '../src/protocol.js'
import { synthetic } from './synthetic.js'

it('advertises the slim toolset, real skill paths and only enabled plugin instructions', async () => {
    const fixture = await synthetic(() => ({ text: 'done' }))
    try {
        const session = await fixture.runtime.command({ type: 'create' }) as SessionView
        const skill = session.skills.skills.find(skill => skill.name === 'typescript-workflows')!
        expect(await readFile(skill.path, 'utf8')).toContain('workflow_run')
        await fixture.runtime.command({ type: 'submit', sessionId: session.id, prompt: 'inspect capabilities' }); await fixture.runtime.waitForIdle(session.id)
        const names = fixture.requests[0]!.tools.map(tool => tool.function.name)
        expect(names).toHaveLength(18)
        expect(names).toEqual(expect.arrayContaining(['run_command', 'apply_patch', 'memory_note', 'skill_list', 'workflow_run', 'task_wait', 'task_cancel']))
        for (const removed of ['read_file', 'list_files', 'write_file', 'skill_load', 'skill_read', 'workflow_inspect', 'workflow_save', 'task_get']) {
            expect(names).not.toContain(removed)
            expect(fixture.requests[0]!.messages.filter(message => message.role === 'system').map(message => message.content).join('\n')).not.toContain(removed)
        }
        await fixture.runtime.command({ type: 'config', patch: { plugins: { skills: false, workflows: false, 'host-native-tools': false, 'background-tasks': false } } })
        await fixture.runtime.command({ type: 'submit', sessionId: session.id, prompt: 'inspect disabled capabilities' }); await fixture.runtime.waitForIdle(session.id)
        const instructions = fixture.requests[1]!.messages.filter(message => message.role === 'system').map(message => message.content).join('\n')
        expect(instructions).not.toContain('workflow_run')
        expect(instructions).not.toContain('task_wait')
        expect(instructions).not.toContain('run_command')
        expect(instructions).not.toContain('skill_list')
    } finally { await fixture.close() }
})

it('omits file-reading and saving instructions when a workflow role has no file tools', async () => {
    const fixture = await synthetic(() => ({ text: 'done' }))
    try {
        await mkdir(join(fixture.root, 'agents'), { recursive: true })
        await writeFile(join(fixture.root, 'agents', 'workflow-only.md'), '---\nname: workflow-only\ndescription: Run supplied workflows\ntools: workflow_run\n---\nRun the provided script.')
        const session = await fixture.runtime.command({ type: 'create', agent: 'workflow-only' }) as SessionView
        await fixture.runtime.command({ type: 'submit', sessionId: session.id, prompt: 'inspect available actions' }); await fixture.runtime.waitForIdle(session.id)
        const request = fixture.requests[0]!
        expect(request.tools.map(tool => tool.function.name)).toEqual(['workflow_run'])
        const instructions = request.messages.filter(message => message.role === 'system').map(message => message.content).join('\n')
        expect(instructions).toContain('workflow_run validates and executes')
        expect(instructions).not.toContain('Read the TypeScript workflow Skill')
        expect(instructions).not.toContain('Save .ts files')
    } finally { await fixture.close() }
})

it('keeps a catalog-only role on metadata without unavailable reading instructions', async () => {
    const fixture = await synthetic(() => ({ text: 'done' }))
    try {
        await mkdir(join(fixture.root, 'agents'), { recursive: true })
        await writeFile(join(fixture.root, 'agents', 'catalog-only.md'), '---\nname: catalog-only\ndescription: Discover metadata\ntools: skill_list\n---\nList available metadata.')
        const session = await fixture.runtime.command({ type: 'create', agent: 'catalog-only' }) as SessionView
        await fixture.runtime.command({ type: 'submit', sessionId: session.id, prompt: 'inspect skills' }); await fixture.runtime.waitForIdle(session.id)
        const request = fixture.requests[0]!
        expect(request.tools.map(tool => tool.function.name)).toEqual(['skill_list'])
        const instructions = request.messages.filter(message => message.role === 'system').map(message => message.content).join('\n')
        expect(instructions).toContain('Use skill_list to rescan')
        expect(instructions).not.toContain('Read the relevant file before applying a skill')
        expect(instructions).not.toContain('Use run_command for file reads')
    } finally { await fixture.close() }
})
