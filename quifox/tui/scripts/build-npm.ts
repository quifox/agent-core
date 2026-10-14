import { execFileSync } from 'node:child_process'
import { chmod, cp, mkdir, readdir, readFile, rm, writeFile } from 'node:fs/promises'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const root = resolve(dirname(fileURLToPath(import.meta.url)), '../../..')
const output = resolve(process.argv[2] ?? join(root, 'quifox/release/npm/quifox'))
const manifest = JSON.parse(await readFile(join(root, 'quifox/tui/package.json'), 'utf8')) as { version: string }
// Repeated builds must not ship files left by an older bundle or dependency graph.
await rm(join(output, 'bin'), { recursive: true, force: true })
await rm(join(output, 'licenses'), { recursive: true, force: true })
await mkdir(join(output, 'bin'), { recursive: true })
const graph = join(output, '.build-inputs.json')
execFileSync('bun', ['build', 'quifox/tui/src/cli.tsx', 'quifox/runtime/src/process-supervisor-entry.ts', 'quifox/runtime/src/process-supervisor.ts',
    '--target=node', '--format=esm', '--entry-naming=[name].js', '--outdir', join(output, 'bin'), `--metafile=${graph}`,
    '--define', `process.env.QUIFOX_VERSION=${JSON.stringify(manifest.version)}`, '--define', 'process.env.DEV="false"'], { cwd: root, stdio: 'inherit' })
await chmod(join(output, 'bin/cli.js'), 0o755)
await cp(join(root, 'LICENSE'), join(output, 'LICENSE'))
await writeFile(join(output, 'README.md'), '# QuiFox\n\n[English](README.md) | [简体中文](README.zh-CN.md)\n\nA terminal Agent using the same QuiFox TUI and shared runtime. Requires Node.js 22.12+; Bun is not required.\n\n```sh\nnpm install --global quifox\nquifox\n```\n\nRun from the project directory, or pass `--workspace /path/to/project`. Configure the model with `MODEL_API_KEY`, `MODEL_BASE_URL`, `MODEL_ID` or `~/.quifox/config.json`. Use `quifox --help` for CLI options.\n\n[Full TUI guide](https://github.com/quifox/agent-core/blob/main/quifox/tui/README.md)\n')
await writeFile(join(output, 'README.zh-CN.md'), '# QuiFox\n\n[English](README.md) | [简体中文](README.zh-CN.md)\n\n终端 Agent，使用相同的 QuiFox TUI 与共享运行时。需要 Node.js 22.12+，无须安装 Bun。\n\n```sh\nnpm install --global quifox\nquifox\n```\n\n从项目目录启动，或传入 `--workspace /path/to/project`。模型通过 `MODEL_API_KEY`、`MODEL_BASE_URL`、`MODEL_ID` 或 `~/.quifox/config.json` 配置。`quifox --help` 显示启动选项。\n\n[完整 TUI 指南](https://github.com/quifox/agent-core/blob/main/quifox/tui/README.zh-CN.md)\n')

const inventory: { name: string; version: string; license: string; notices: string[]; source?: string }[] = []
// These pinned upstream packages omit the repository license from their npm archive.
const upstream: Record<string, { file: string; source: string }> = {
    'react-devtools-core@8.0.0': { file: 'react-devtools-core.LICENSE', source: 'https://github.com/react/react/blob/1d34f91dfde6bba84d08b683aaba164c7194dacb/LICENSE' },
    'yoga-layout@3.2.1': { file: 'yoga-layout.LICENSE', source: 'https://github.com/react/yoga/blob/v3.2.1/LICENSE' }
}
const seen = new Set<string>(), owners = new Map<string, string>()
async function owner(directory: string): Promise<string> {
    const known = owners.get(directory)
    if (known) return known
    try {
        const value = JSON.parse(await readFile(join(directory, 'package.json'), 'utf8')) as { name?: string; version?: string }
        if (value.name && value.version) { owners.set(directory, directory); return directory }
    }
    catch (error) {
        if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error
    }
    if (directory === dirname(directory)) throw new Error('A bundled dependency has no package identity.')
    const value = await owner(dirname(directory)); owners.set(directory, value); return value
}
const inputs = JSON.parse(await readFile(graph, 'utf8')) as { inputs: Record<string, unknown> }
for (const input of Object.keys(inputs.inputs)) {
    const directory = await owner(dirname(resolve(root, input)))
    const dependency = JSON.parse(await readFile(join(directory, 'package.json'), 'utf8')) as { name: string; version: string; license?: string }
    const key = `${dependency.name}-${dependency.version}`.replace(/[^a-zA-Z0-9._-]/g, '_'), notices: string[] = []
    if (seen.has(key)) continue
    seen.add(key)
    for (const file of await readdir(directory, { withFileTypes: true })) {
        if (!file.isFile() || !/^(?:licen[cs]e|notice|copying|copyright)(?:[._-].*)?$/i.test(file.name)) continue
        await mkdir(join(output, 'licenses', key), { recursive: true })
        await cp(join(directory, file.name), join(output, 'licenses', key, file.name))
        notices.push(`${key}/${file.name}`)
    }
    const fallback = upstream[`${dependency.name}@${dependency.version}`]
    if (!notices.length && (dirname(directory) === join(root, 'packages') || dirname(directory) === join(root, 'quifox')) && dependency.license === 'MIT') notices.push('../LICENSE')
    if (!notices.length && fallback) {
        await mkdir(join(output, 'licenses', key), { recursive: true })
        await cp(join(root, 'quifox/tui/licenses', fallback.file), join(output, 'licenses', key, 'LICENSE'))
        notices.push(`${key}/LICENSE`)
    }
    if (!notices.length) throw new Error(`Bundled dependency ${dependency.name}@${dependency.version} has no license text.`)
    inventory.push({ name: dependency.name, version: dependency.version, license: dependency.license ?? 'unspecified', notices, ...(fallback ? { source: fallback.source } : {}) })
}
await mkdir(join(output, 'licenses'), { recursive: true })
await writeFile(join(output, 'licenses/inventory.json'), `${JSON.stringify(inventory.sort((a, b) => a.name.localeCompare(b.name)), null, 2)}\n`)
await rm(graph)
await writeFile(join(output, 'package.json'), `${JSON.stringify({ name: 'quifox', version: manifest.version, private: true,
    description: 'QuiFox terminal Agent', type: 'module', license: 'MIT', engines: { node: '>=22.12.0' },
    bin: { quifox: 'bin/cli.js' }, files: ['bin', 'licenses', 'LICENSE', 'README.md', 'README.zh-CN.md'],
    repository: { type: 'git', url: 'https://github.com/quifox/agent-core.git', directory: 'quifox/tui' },
    publishConfig: { access: 'public' } }, null, 2)}\n`)
