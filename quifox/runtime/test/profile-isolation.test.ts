import { expect, it, vi } from 'vitest'
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { defaultConfig, saveConfig, workspaceConfig } from '../src/config.js'

const profile = vi.hoisted(() => ({ home: '' }))
vi.mock('node:os', async importOriginal => ({ ...await importOriginal<object>(), homedir: () => profile.home }))

it('keeps a custom user profile independent from the default user configuration in an ancestor', async () => {
    const root = await mkdtemp(join(tmpdir(), 'quifox-profile-'))
    try {
        profile.home = root
        const app = join(root, 'alternate'), workspace = join(root, 'project')
        await mkdir(app); await mkdir(workspace); await mkdir(join(root, '.quifox'))
        const config = defaultConfig(workspace); await saveConfig(app, config)
        await writeFile(join(root, '.quifox', 'config.json'), JSON.stringify({ model: { model: 'must-not-inherit', apiKey: 'synthetic-other-profile-key' } }))
        const effective = await workspaceConfig(config, workspace, app)
        expect(effective.config.model.model).toBe(config.model.model)
        expect(effective.config.model.apiKey).toBeUndefined()
        expect(effective.sources).toEqual([join(app, 'config.json')])
    } finally { await rm(root, { recursive: true, force: true }) }
})
