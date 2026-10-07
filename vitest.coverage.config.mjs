import { existsSync, readFileSync, readdirSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { defineConfig } from 'vitest/config'

const aliases = []
const packages = new URL('./packages/', import.meta.url)
for (const directory of readdirSync(packages, { withFileTypes: true })) {
    if (!directory.isDirectory()) { continue }
    const owner = new URL(`${directory.name}/`, packages)
    const manifest = new URL('package.json', owner)
    if (!existsSync(manifest)) { continue }
    const pkg = JSON.parse(readFileSync(manifest, 'utf8'))
    for (const subpath of Object.keys(pkg.exports)) {
        const entry = subpath === '.' ? 'index' : subpath.slice(2)
        const name = subpath === '.' ? pkg.name : `${pkg.name}/${entry}`
        // Exercise collaborating packages' current sources, not their compiled copies.
        aliases.push({
            find: new RegExp(`^${name.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}$`),
            replacement: fileURLToPath(new URL(`src/${entry}.ts`, owner))
        })
    }
}

export default defineConfig({
    resolve: { alias: aliases },
    test: {
        include: ['packages/*/test/**/*.test.ts'],
        coverage: {
            enabled: true,
            provider: 'v8',
            include: ['packages/*/src/**/*.ts'],
            reporter: ['text', 'json', 'json-summary', 'html'],
            reportsDirectory: 'coverage'
        }
    }
})
