import { existsSync } from 'node:fs'
import { fileURLToPath, pathToFileURL } from 'node:url'

// Keep the library free of entry-point effects when Bun embeds it in the sidecar binary.
const input = JSON.parse(process.argv[3] ?? '{}') as { command: string; cwd: string }
if (process.argv[2] !== '--quifox-supervisor' || typeof input.command !== 'string' || typeof input.cwd !== 'string') throw new Error('Invalid command supervisor arguments.')
const modulePath = fileURLToPath(new URL('./process-supervisor.js', import.meta.url))
const { commandSupervisor } = await import(pathToFileURL(existsSync(modulePath) ? modulePath : modulePath.replace(/\.js$/, '.ts')).href) as typeof import('./process-supervisor.js')
await commandSupervisor(input.command, input.cwd)
