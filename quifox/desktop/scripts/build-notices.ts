import { execFileSync } from 'node:child_process'
import { cp, mkdir, readdir, readFile, realpath, writeFile } from 'node:fs/promises'
import { dirname, resolve, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const root = resolve(dirname(fileURLToPath(import.meta.url)), '../../..'), output = join(root, 'quifox/release/licenses')
await mkdir(output, { recursive: true })
await cp(join(root, 'LICENSE'), join(output, 'QuiFox-LICENSE'))
await cp(join(root, 'packages/agent-plugin-memory/LICENSE'), join(output, 'Memory-LICENSE'))
await cp(join(root, 'packages/agent-plugin-memory/NOTICE'), join(output, 'Memory-NOTICE'))
const inventory: { name: string; version: string; license: unknown; ecosystem: string; notices: string[] }[] = []
const seen = new Set<string>(), licenseFile = /^(?:licen[cs]e|notice|copying|copyright)(?:[._-].*)?$/i
async function collect(directory: string, name: string, version: string, license: unknown, ecosystem: string) {
    const key = `${ecosystem}-${name}-${version}`.replace(/[^a-zA-Z0-9._-]/g, '_')
    if (seen.has(key)) return
    seen.add(key)
    const notices: string[] = []
    for (const file of await readdir(directory, { withFileTypes: true })) if (file.isFile() && licenseFile.test(file.name)) {
        const target = `${key}/${file.name}`; await mkdir(join(output, key), { recursive: true }); await cp(join(directory, file.name), join(output, target)); notices.push(target)
    }
    inventory.push({ name, version, license, ecosystem, notices })
}
const cache = join(root, 'node_modules/.bun')
await collect(join(root, 'quifox/workflow-engine'), '@quifox/workflow-engine', '0.1.0', 'Apache-2.0', 'npm')
await collect(join(root, 'quifox/runtime/skills/langchain'), 'langchain-skills', '0.2-review', 'MIT', 'skills')
const skillEntry = inventory.find(item => item.name === 'langchain-skills')!
for (const file of ['skills-lock.json', 'content-hashes.json']) {
    const target = 'skills-langchain-skills-0.2-review/' + file
    await cp(join(root, 'quifox/runtime/skills/langchain', file), join(output, target)); skillEntry.notices.push(target)
}
for (const entry of await readdir(cache, { withFileTypes: true })) if (entry.isDirectory() && entry.name !== 'node_modules') {
    const modules = join(cache, entry.name, 'node_modules')
    for (const packageEntry of await readdir(modules, { withFileTypes: true })) {
        if (packageEntry.name === '.bin') continue
        const path = join(modules, packageEntry.name)
        const paths = packageEntry.name.startsWith('@') ? (await readdir(path)).map(item => join(path, item)) : [path]
        for (const directory of paths) {
            const actual = await realpath(directory)
            if (actual.startsWith(join(root, 'packages')) || actual.startsWith(join(root, 'quifox'))) continue
            const manifest = JSON.parse(await readFile(join(directory, 'package.json'), 'utf8')) as { name: string; version: string; license?: unknown }
            await collect(actual, manifest.name, manifest.version, manifest.license ?? 'unspecified', 'npm')
        }
    }
}
const metadata = JSON.parse(execFileSync('cargo', ['metadata', '--locked', '--format-version', '1', '--manifest-path', join(root, 'quifox/desktop/src-tauri/Cargo.toml')], { encoding: 'utf8', maxBuffer: 20_000_000 })) as { packages: { name: string; version: string; license: string | null; manifest_path: string; source: string | null }[] }
for (const item of metadata.packages) if (item.source) await collect(dirname(item.manifest_path), item.name, item.version, item.license ?? 'unspecified', 'cargo')
await writeFile(join(output, 'inventory.json'), `${JSON.stringify(inventory.sort((a, b) => a.name.localeCompare(b.name)), null, 2)}\n`)
await writeFile(join(output, 'Bun-NOTICE.txt'), `The compiled CLI and sidecar include Bun ${execFileSync('bun', ['--version'], { encoding: 'utf8' }).trim()}.\nBun and linked-library licensing and source/relinking instructions: https://bun.com/docs/project/license\nPinned Bun source: https://github.com/oven-sh/bun/tree/bun-v1.4.0\nThe dependency inventory includes installed npm and Cargo dependencies; it is broader than the shipped runtime graph.\n`)
