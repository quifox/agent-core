import { expect, it } from 'vitest'
import { cp, mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { execFile } from 'node:child_process'
import { createHash } from 'node:crypto'
import { tmpdir } from 'node:os'
import { join, sep } from 'node:path'
import { promisify } from 'node:util'
import type { ResourceView, SessionView } from '../src/protocol.js'
import { synthetic } from './synthetic.js'

it('preserves pinned Skill bytes when Git checks out files with Windows newline conversion enabled', async () => {
    const root = await mkdtemp(join(tmpdir(), 'quifox-skill-checkout-')), execute = promisify(execFile)
    const repository = join(root, 'repository'), checkout = join(root, 'checkout'), relative = 'quifox/runtime/skills/langchain'
    try {
        await mkdir(repository)
        await cp(new URL('../skills/langchain/', import.meta.url), join(repository, relative), { recursive: true })
        const attributes = await readFile(new URL('../../../.gitattributes', import.meta.url), 'utf8').catch(cause => {
            if ((cause as NodeJS.ErrnoException).code !== 'ENOENT') throw cause
            return undefined
        })
        if (attributes) await writeFile(join(repository, '.gitattributes'), attributes)
        await execute('git', ['init', '--quiet', '--template='], { cwd: repository })
        await execute('git', ['-c', 'core.autocrlf=false', 'add', '.'], { cwd: repository })
        await execute('git', ['-c', 'core.autocrlf=true', 'checkout-index', '--all', '--force', '--prefix=' + checkout.split(sep).join('/') + '/'], { cwd: repository })
        const hashes = JSON.parse(await readFile(new URL('../skills/langchain/content-hashes.json', import.meta.url), 'utf8')) as Record<string, string>
        for (const [name, hash] of Object.entries(hashes)) {
            const content = await readFile(join(checkout, relative, name))
            expect({ name, hash: createHash('sha256').update(content).digest('hex') }).toEqual({ name, hash })
        }
    } finally { await rm(root, { recursive: true, force: true }) }
})

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
