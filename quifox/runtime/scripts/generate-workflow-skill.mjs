import { readFile, readdir, writeFile } from 'node:fs/promises'
import { createHash } from 'node:crypto'
const names = ['SKILL.md', 'recovery.md', 'templates/parallel-retrieval.ts', 'templates/safe-retry.ts']
const resources = Object.fromEntries(await Promise.all(names.map(async name => [name, await readFile(new URL('../skills/typescript-workflows/' + name, import.meta.url), 'utf8')])))
const langchainResources = {}
async function collect(directory, prefix = '') {
    for (const entry of await readdir(directory, { withFileTypes: true })) {
        const name = prefix + entry.name
        if (entry.isDirectory()) await collect(new URL(entry.name + '/', directory), name + '/')
        else if (entry.isFile() && name.endsWith('.md')) langchainResources[name] = await readFile(new URL(entry.name, directory), 'utf8')
    }
}
await collect(new URL('../skills/langchain/', import.meta.url))
const fingerprints = JSON.parse(await readFile(new URL('../skills/langchain/content-hashes.json', import.meta.url), 'utf8'))
for (const [name, hash] of Object.entries(fingerprints)) {
    const content = await readFile(new URL('../skills/langchain/' + name, import.meta.url))
    if (createHash('sha256').update(content).digest('hex') !== hash) throw new Error('LangChain skill snapshot changed: ' + name)
}
for (const name of Object.keys(langchainResources)) if (!fingerprints[name]) throw new Error('Unrecorded LangChain skill resource: ' + name)
await writeFile(new URL('../src/workflow-skill.generated.ts', import.meta.url), 'export const workflowResources: Record<string, string> = ' + JSON.stringify(resources) + '\nexport const workflowSkill = workflowResources["SKILL.md"]!\nexport const langchainResources: Record<string, string> = ' + JSON.stringify(langchainResources) + '\n')
