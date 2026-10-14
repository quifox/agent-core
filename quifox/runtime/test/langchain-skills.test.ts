import { expect, it } from 'vitest'
import { readFile } from 'node:fs/promises'
import type { ResourceView, SessionView } from '../src/protocol.js'
import { synthetic } from './synthetic.js'

it('installs a Skill-only LangChain plugin with readable references and removes its catalog on disable', async () => {
    const fixture = await synthetic((_request, index) => index === 1 ? { calls: [{ id: 'reference', name: 'skill_read', input: { skill: 'langgraph-fundamentals', path: 'references/typescript.md' } }] } : { text: 'skill loaded' })
    try {
        const before = await fixture.runtime.command({ type: 'resources' }) as ResourceView
        expect(before.skills.skills.some(skill => skill.name === 'langgraph-fundamentals')).toBe(false)
        await fixture.runtime.command({ type: 'plugin-install', pluginId: 'langchain', action: 'install', scope: 'global' })
        const session = await fixture.runtime.command({ type: 'create' }) as SessionView
        expect(session.skills.skills.map(skill => skill.name)).toEqual(expect.arrayContaining(['langgraph-fundamentals', 'langgraph-persistence', 'langgraph-human-in-the-loop', 'langgraph-cli', 'langgraph-typescript-quickstart', 'workflow-production-design', 'workflow-release-checklist']))
        await fixture.runtime.command({ type: 'submit', sessionId: session.id, prompt: '$langgraph-fundamentals use TypeScript' }); await fixture.runtime.waitForIdle(session.id)
        expect(JSON.stringify(fixture.requests[0]!.messages)).toContain('StateGraph')
        const reference = await readFile(new URL('../skills/langchain/langgraph-fundamentals/references/typescript.md', import.meta.url), 'utf8')
        expect(fixture.requests[1]!.messages.find(message => message.role === 'tool')?.content).toBe(reference)
        expect(fixture.requests[0]!.tools.some(tool => tool.function.name.startsWith('langchain_'))).toBe(false)
        await fixture.runtime.command({ type: 'plugin-set-enabled', pluginId: 'langchain', scope: 'global', enabled: false })
        const after = await fixture.runtime.command({ type: 'resources' }) as ResourceView
        expect(after.skills.skills.some(skill => skill.name.startsWith('langgraph-') || skill.name === 'workflow-production-design')).toBe(false)
        expect(after.skills.skills.map(skill => skill.name)).toContain('typescript-workflows')
    } finally { await fixture.close() }
}, 15000)
