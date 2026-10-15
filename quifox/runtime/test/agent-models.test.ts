import { expect, it } from 'vitest'
import type { SessionView } from '../src/protocol.js'
import { synthetic } from './synthetic.js'
import { loadConfig } from '../src/config.js'
import { mkdir, writeFile, readFile } from 'node:fs/promises'
import { join } from 'node:path'

it('uses high only for declared capabilities and disables DeepSeek thinking without sending an invalid effort', async () => {
    const fixture = await synthetic(() => ({ text: 'done' }), config => { config.model.provider = 'deepseek'; config.model.model = 'deepseek-flash'; config.model.reasoningEfforts = ['none', 'high'] })
    try {
        const parent = await fixture.runtime.command({ type: 'create' }) as SessionView
        await fixture.runtime.command({ type: 'submit', sessionId: parent.id, prompt: 'automatic high' }); await fixture.runtime.waitForIdle(parent.id)
        expect(fixture.requests[0]).toMatchObject({ reasoning_effort: 'high', thinking: { type: 'enabled' } })
        await fixture.runtime.command({ type: 'session-config', sessionId: parent.id, reasoningEffort: 'none' })
        await fixture.runtime.command({ type: 'submit', sessionId: parent.id, prompt: 'disabled thinking' }); await fixture.runtime.waitForIdle(parent.id)
        expect(fixture.requests[1]).toMatchObject({ thinking: { type: 'disabled' } })
        expect(fixture.requests[1]).not.toHaveProperty('reasoning_effort')
    } finally { await fixture.close() }
})

it('persists explicit session approval independently of global defaults without expanding role tools', async () => {
    const fixture = await synthetic(input => input.messages.at(-1)?.role === 'user' ?
        { calls: [{ id: 'write', name: 'apply_patch', input: { path: 'session-access.txt', oldText: '', newText: 'allowed' } }] } : { text: 'done' })
    try {
        const allowed = await fixture.runtime.command({ type: 'create', approvalMode: 'allow' }) as SessionView
        const ordinary = await fixture.runtime.command({ type: 'create' }) as SessionView
        expect(allowed.approvalMode).toBe('allow'); expect(ordinary.approvalMode).toBe('ask')
        await fixture.runtime.command({ type: 'submit', sessionId: allowed.id, prompt: 'write without a prompt' }); await fixture.runtime.waitForIdle(allowed.id)
        expect(await readFile(join(fixture.root, 'session-access.txt'), 'utf8')).toBe('allowed')
        await fixture.runtime.command({ type: 'session-config', sessionId: allowed.id, approvalMode: 'ask' })
        await fixture.runtime.command({ type: 'config', patch: { approval: 'allow' } }); await fixture.restart()
        expect((await fixture.runtime.command({ type: 'snapshot', sessionId: allowed.id }) as SessionView).approvalMode).toBe('ask')
        expect((await fixture.runtime.command({ type: 'snapshot', sessionId: ordinary.id }) as SessionView).approvalMode).toBe('allow')
        await mkdir(join(fixture.root, 'agents'), { recursive: true })
        await writeFile(join(fixture.root, 'agents', 'restricted.md'), '---\nname: restricted\ndescription: Restricted reviewer\ntools: Read\npermissionMode: plan\n---\nReview only.')
        const restricted = await fixture.runtime.command({ type: 'create', agent: 'restricted', approvalMode: 'allow' }) as SessionView
        expect(restricted.approvalMode).toBe('deny')
        await expect(fixture.runtime.command({ type: 'session-config', sessionId: restricted.id, approvalMode: 'allow' })).rejects.toThrow('权限限制')
        await fixture.runtime.command({ type: 'submit', sessionId: restricted.id, prompt: 'try to write' }); await fixture.runtime.waitForIdle(restricted.id)
        const result = await fixture.runtime.command({ type: 'snapshot', sessionId: restricted.id }) as SessionView
        expect(result.messages.some(item => item.message.role === 'tool' && item.message.content.includes('权限'))).toBe(true)
        expect((await loadConfig(fixture.root, fixture.root, {})).approval).toBe('allow')
    } finally { await fixture.close() }
})

it('uses the assigned child model profile default instead of the parent automatic effort', async () => {
    const fixture = await synthetic(input => input.messages.at(-1)?.content === 'assign another model' ?
        { calls: [{ id: 'assigned', name: 'subagent_start', input: { model: 'low-profile', prompt: 'independent child' } }] } : { text: 'done' }, config => {
        config.model.provider = 'deepseek'; config.model.model = 'deepseek-flash'
        config.model.reasoningEfforts = ['high']
        config.models = [{ ...config.model, provider: 'synthetic', id: 'low-profile', model: 'synthetic-low', reasoningEfforts: ['low'], reasoningEffort: 'low' }]
    })
    try {
        const parent = await fixture.runtime.command({ type: 'create' }) as SessionView
        await fixture.runtime.command({ type: 'submit', sessionId: parent.id, prompt: 'assign another model' }); await fixture.runtime.waitForIdle(parent.id)
        const snapshot = await fixture.runtime.command({ type: 'snapshot' }) as { sessions: SessionView[] }
        const child = snapshot.sessions.find(session => session.parentId === parent.id)
        expect(child).toBeDefined()
        await fixture.runtime.waitForIdle(child!.id)
        expect(fixture.requests.find(request => request.messages.at(-1)?.content === 'independent child')).toMatchObject({ model: 'synthetic-low', reasoning_effort: 'low' })
    } finally { await fixture.close() }
})

it('lets plan roles read through checked commands while denying writes in main and child sessions', async () => {
    const fixture = await synthetic(request => request.messages.at(-1)?.content === 'inspect safely' ? { calls: [
        { id: 'read', name: 'run_command', input: { command: 'cat source.txt' } },
        { id: 'write', name: 'run_command', input: { command: 'touch must-not-exist' } }
    ] } : request.messages.at(-1)?.content === 'delegate inspection' ? { calls: [
        { id: 'delegate', name: 'subagent_start', input: { agent: 'planner', prompt: 'inspect safely' } }
    ] } : { text: 'done' })
    try {
        await mkdir(join(fixture.root, 'agents'), { recursive: true })
        await writeFile(join(fixture.root, 'agents', 'planner.md'), '---\nname: planner\ndescription: Read-only planner\ntools: Bash\npermissionMode: plan\n---\nInspect without changes.')
        await writeFile(join(fixture.root, 'source.txt'), 'readable in plan mode')
        const planner = await fixture.runtime.command({ type: 'create', agent: 'planner' }) as SessionView
        await fixture.runtime.command({ type: 'submit', sessionId: planner.id, prompt: 'inspect safely' }); await fixture.runtime.waitForIdle(planner.id)
        const parent = await fixture.runtime.command({ type: 'create' }) as SessionView
        await fixture.runtime.command({ type: 'submit', sessionId: parent.id, prompt: 'delegate inspection' }); await fixture.runtime.waitForIdle(parent.id)
        const snapshot = await fixture.runtime.command({ type: 'snapshot' }) as { sessions: SessionView[] }
        const child = snapshot.sessions.find(session => session.parentId === parent.id)!
        await fixture.runtime.waitForIdle(child.id)
        const requests = fixture.requests.filter(request => request.messages.at(-1)?.content === 'inspect safely')
        expect(requests).toHaveLength(2)
        for (const request of requests) expect(request.tools.map(tool => tool.function.name)).toEqual(['run_command'])
        for (const id of [planner.id, child.id]) {
            const view = await fixture.runtime.command({ type: 'snapshot', sessionId: id }) as SessionView
            expect(view.messages.filter(item => item.message.role === 'tool').map(item => item.message.content)).toEqual([
                expect.stringContaining('readable in plan mode'), expect.stringContaining('不允许需要审批')
            ])
            expect(view.approvals).toHaveLength(0)
        }
        await expect(readFile(join(fixture.root, 'must-not-exist'))).rejects.toMatchObject({ code: 'ENOENT' })
    } finally { await fixture.close() }
})

it('selects a named Chat model and reasoning effort for one session without changing another session', async () => {
    const fixture = await synthetic(() => ({ text: 'model reply' }))
    try {
        const before = await loadConfig(fixture.root, fixture.root, {})
        await fixture.runtime.command({ type: 'config', patch: { models: [{ ...before.model,
            id: 'alternate', model: 'synthetic-alternate' }] } })
        const chosen = await fixture.runtime.command({ type: 'create', modelId: 'alternate', reasoningEffort: 'high' }) as SessionView
        const ordinary = await fixture.runtime.command({ type: 'create' }) as SessionView
        await fixture.runtime.command({ type: 'submit', sessionId: chosen.id, prompt: 'chosen model' }); await fixture.runtime.waitForIdle(chosen.id)
        await fixture.runtime.command({ type: 'submit', sessionId: ordinary.id, prompt: 'default model' }); await fixture.runtime.waitForIdle(ordinary.id)
        expect(fixture.requests.map(request => request.model)).toEqual(['synthetic-alternate', 'synthetic'])
        expect(fixture.requests[0]?.reasoning_effort).toBe('high')
        expect(fixture.requests[1]?.reasoning_effort).toBeUndefined()
    } finally { await fixture.close() }
})

it('applies an Agent Markdown model default and hides denied tools while preserving parent permissions', async () => {
    const fixture = await synthetic((input, index) => index === 1 ? { calls: [{ id: 'start', name: 'subagent_start', input: { agent: 'reviewer', prompt: 'review only' } }] } :
        input.messages.at(-1)?.content === 'review only' ? { calls: [{ id: 'write', name: 'apply_patch', input: { path: 'must-not-write.txt', oldText: '', newText: 'denied' } }] } : { text: 'done' })
    try {
        const config = await loadConfig(fixture.root, fixture.root, {})
        await fixture.runtime.command({ type: 'config', patch: { models: [{ ...config.model, id: 'review-model', model: 'synthetic-review' }] } })
        await mkdir(join(fixture.root, 'agents'), { recursive: true })
        await writeFile(join(fixture.root, 'agents', 'reviewer.md'), '---\nname: reviewer\ndescription: Independent reviewer\nmodel: review-model\ntools: skill_list, Edit\ndisallowedTools: Edit\npermissionMode: default\n---\nFollow the original requirements and only review.')
        const parent = await fixture.runtime.command({ type: 'create' }) as SessionView
        await fixture.runtime.command({ type: 'submit', sessionId: parent.id, prompt: 'run reviewer' }); await fixture.runtime.waitForIdle(parent.id)
        const snapshot = await fixture.runtime.command({ type: 'snapshot' }) as { sessions: SessionView[] }
        const child = snapshot.sessions.find(item => item.parentId === parent.id)!
        await fixture.runtime.waitForIdle(child.id)
        const requests = fixture.requests.filter(input => input.model === 'synthetic-review')
        expect(requests.length).toBeGreaterThan(0)
        expect(requests[0]?.tools.map(item => item.function.name)).toEqual(['skill_list'])
        expect(requests[0]?.messages.some(message => message.content.includes('only review'))).toBe(true)
        expect((await fixture.runtime.command({ type: 'snapshot', sessionId: child.id }) as SessionView).messages.some(item => item.message.role === 'tool' && item.message.content.includes('权限'))).toBe(true)
    } finally { await fixture.close() }
})

it('creates a passive child with an assigned model through start without exposing a second fork tool', async () => {
    const fixture = await synthetic((_input, index) => index === 1 ? { calls: [{ id: 'start', name: 'subagent_start', input: { model: 'alternate' } }] } : { text: 'done' })
    try {
        const config = await loadConfig(fixture.root, fixture.root, {})
        await fixture.runtime.command({ type: 'config', patch: { models: [{ ...config.model, id: 'alternate', model: 'synthetic-alternate' }] } })
        const parent = await fixture.runtime.command({ type: 'create', reasoningEffort: 'high' }) as SessionView
        await fixture.runtime.command({ type: 'submit', sessionId: parent.id, prompt: 'preserve a reviewer' }); await fixture.runtime.waitForIdle(parent.id)
        const snapshot = await fixture.runtime.command({ type: 'snapshot' }) as { sessions: SessionView[] }
        const child = snapshot.sessions.find(item => item.parentId === parent.id)!
        expect(child?.status).toBe('idle'); expect(fixture.requests).toHaveLength(2)
        expect(fixture.requests[0]?.tools.map(item => item.function.name)).not.toContain('subagent_fork')
        await fixture.runtime.command({ type: 'submit', sessionId: child.id, prompt: 'wake reviewer' }); await fixture.runtime.waitForIdle(child.id)
        expect(fixture.requests.at(-1)?.model).toBe('synthetic-alternate')
        expect(fixture.requests.at(-1)?.reasoning_effort).toBe('high')
    } finally { await fixture.close() }
})

it('applies tightened role permissions after recomposition and passes the effective parent ceiling to a new child', async () => {
    const fixture = await synthetic(input => input.messages.at(-1)?.content === 'delegate after tightening' ?
        { calls: [{ id: 'start', name: 'subagent_start', input: { prompt: 'child request' } }] } : { text: 'done' }, config => { config.approval = 'allow' })
    try {
        await mkdir(join(fixture.root, 'agents'), { recursive: true })
        const role = join(fixture.root, 'agents', 'controller.md')
        await writeFile(role, '---\nname: controller\ndescription: Controller\ntools: skill_list, Bash, Agent\n---\nDelegate with the allowed tools.')
        const parent = await fixture.runtime.command({ type: 'create', agent: 'controller' }) as SessionView
        await writeFile(role, '---\nname: controller\ndescription: Controller\ntools: skill_list, Agent\ndisallowedTools: Bash\n---\nDelegate without shell access.')
        await fixture.runtime.command({ type: 'config', patch: { approval: 'allow' } })
        await fixture.runtime.command({ type: 'submit', sessionId: parent.id, prompt: 'delegate after tightening' }); await fixture.runtime.waitForIdle(parent.id)
        const snapshot = await fixture.runtime.command({ type: 'snapshot' }) as { sessions: SessionView[] }
        const child = snapshot.sessions.find(session => session.parentId === parent.id)!
        await fixture.runtime.waitForIdle(child.id)
        expect(fixture.requests[0]?.tools.map(tool => tool.function.name)).not.toContain('run_command')
        const childRequest = fixture.requests.find(request => request.messages.at(-1)?.content === 'child request')!
        expect(childRequest.tools.map(tool => tool.function.name)).not.toContain('run_command')
        expect(childRequest.tools.map(tool => tool.function.name)).toEqual(['skill_list'])
    } finally { await fixture.close() }
})

it('tightens existing role and child sessions when the user changes automatic authorization back to ask', async () => {
    const fixture = await synthetic(input => input.messages.at(-1)?.content === 'preserve a child' ?
        { calls: [{ id: 'start', name: 'subagent_start', input: {} }] } : input.messages.at(-1)?.role === 'user' ?
            { calls: [{ id: 'write', name: 'apply_patch', input: { path: 'approval-ceiling.txt', oldText: '', newText: 'requires current approval' } }] } : { text: 'done' }, config => { config.approval = 'allow' })
    try {
        await mkdir(join(fixture.root, 'agents'), { recursive: true })
        await writeFile(join(fixture.root, 'agents', 'controller.md'), '---\nname: controller\ndescription: Controller\n---\nUse the current approval policy.')
        const parent = await fixture.runtime.command({ type: 'create', agent: 'controller' }) as SessionView
        await fixture.runtime.command({ type: 'submit', sessionId: parent.id, prompt: 'preserve a child' }); await fixture.runtime.waitForIdle(parent.id)
        const snapshot = await fixture.runtime.command({ type: 'snapshot' }) as { sessions: SessionView[] }
        const child = snapshot.sessions.find(session => session.parentId === parent.id)!
        await fixture.runtime.command({ type: 'config', patch: { approval: 'ask' } })
        for (const id of [parent.id, child.id]) {
            await fixture.runtime.command({ type: 'submit', sessionId: id, prompt: 'write with the current policy' })
            await expect.poll(async () => (await fixture.runtime.command({ type: 'snapshot', sessionId: id }) as SessionView).approvals.length).toBe(1)
            const view = await fixture.runtime.command({ type: 'snapshot', sessionId: id }) as SessionView
            await fixture.runtime.command({ type: 'approve', sessionId: id, approvalId: view.approvals[0]!.id, approved: false })
            await fixture.runtime.waitForIdle(id)
        }
    } finally { await fixture.close() }
})
