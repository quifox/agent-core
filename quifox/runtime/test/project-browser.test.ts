import { expect, it } from 'vitest'
import { writeFile, mkdir, symlink } from 'node:fs/promises'
import { join } from 'node:path'
import { synthetic } from './synthetic.js'

it('browses user-selected files and media without a session, including files outside the project', async () => {
    const fixture = await synthetic(() => ({ text: 'unused' }))
    try {
        await mkdir(join(fixture.root, 'project'))
        await writeFile(join(fixture.root, 'project', 'hello.ts'), 'export const hello = 1')
        await writeFile(join(fixture.root, 'project', 'image.png'), Buffer.from([137, 80, 78, 71, 0]))
        const command = { type: 'project' as const, workspace: join(fixture.root, 'project') }
        await expect(fixture.runtime.command({ ...command, action: 'read', path: 'hello.ts' })).resolves.toMatchObject({ kind: 'text', content: 'export const hello = 1', relativePath: 'hello.ts', truncated: false })
        await expect(fixture.runtime.command({ ...command, action: 'read', path: 'image.png' })).resolves.toMatchObject({ kind: 'image', relativePath: 'image.png' })
        await expect(fixture.runtime.command({ ...command, action: 'list' })).resolves.toMatchObject({ entries: expect.arrayContaining([{ name: 'hello.ts', kind: 'file' }]) })
        await writeFile(join(fixture.root, 'outside.txt'), 'outside the project')
        await symlink(join(fixture.root, 'outside.txt'), join(fixture.root, 'project', 'outside'))
        await expect(fixture.runtime.command({ ...command, action: 'read', path: 'outside' })).resolves.toMatchObject({ content: 'outside the project' })
        await expect(fixture.runtime.command({ ...command, action: 'read', path: '../outside.txt' })).resolves.toMatchObject({ content: 'outside the project' })
        await expect(fixture.runtime.command({ ...command, workspace: fixture.root, action: 'read', path: 'outside.txt' })).resolves.toMatchObject({ content: 'outside the project' })
    } finally { await fixture.close() }
})

it('finds files inside collapsed directories without following symlink escapes', async () => {
    const fixture = await synthetic(() => ({ text: 'unused' }))
    try {
        const workspace = join(fixture.root, 'project')
        await mkdir(join(workspace, 'nested'), { recursive: true })
        await writeFile(join(workspace, 'nested', 'needle.ts'), 'const value = 1')
        await symlink(fixture.root, join(workspace, 'outside'))
        await expect(fixture.runtime.command({ type: 'project', action: 'search', workspace, query: 'needle' })).resolves.toMatchObject({ paths: ['nested/needle.ts'], truncated: false })
        await expect(fixture.runtime.command({ type: 'project', action: 'search', workspace, query: 'config.json' })).resolves.toMatchObject({ paths: [] })
    } finally { await fixture.close() }
})
