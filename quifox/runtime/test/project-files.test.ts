import { expect, it } from 'vitest'
import { mkdir, mkdtemp, rm, symlink, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createProjectFiles } from '../src/project-files.js'

it('discovers only ancestors and confines references to the selected real skill directory', async () => {
    const root = await mkdtemp(join(tmpdir(), 'quifox-files-'))
    try {
        const repo = join(root, 'repo')
        const home = join(root, 'home')
        const skill = join(repo, '.agents', 'skills', 'example')
        await mkdir(join(repo, '.git'), { recursive: true }); await mkdir(join(repo, 'src'), { recursive: true })
        await mkdir(home); await mkdir(join(skill, 'references'), { recursive: true })
        await writeFile(join(skill, 'SKILL.md'), '---\nname: example\ndescription: Example skill.\n---\nBODY MUST BE LAZY')
        await writeFile(join(root, 'outside.md'), 'outside')
        await symlink(join(root, 'outside.md'), join(skill, 'references', 'escape.md'))
        const discovery = await createProjectFiles(join(repo, 'src'), home)
        expect(discovery.scopes.length).toBeGreaterThan(3)
        const source = discovery.roots.filter(root => root.startsWith('project-skills-')).at(-2)!
        expect(await discovery.files.metadata(source, 'example/SKILL.md')).toBe('name: example\ndescription: Example skill.')
        await expect(discovery.files.read(source, 'example/references/escape.md')).rejects.toThrow('outside')
    } finally { await rm(root, { recursive: true, force: true }) }
})
