import { execFile } from 'node:child_process'
import { once } from 'node:events'
import { mkdtemp, mkdir, readFile, realpath, rm, writeFile } from 'node:fs/promises'
import { createServer } from 'node:http'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { promisify } from 'node:util'
import { expect, test } from 'vitest'

const execute = promisify(execFile)
const repository = resolve(dirname(fileURLToPath(import.meta.url)), '../../..')
const npm = process.platform === 'win32' ? process.execPath : 'npm'
const npmArguments = process.platform === 'win32' ? [join(dirname(process.execPath), 'node_modules/npm/bin/npm-cli.js')] : []

test('the packed npm TUI installs its command without Bun or workspace dependencies', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'quifox-npm-'))
    try {
        const output = join(directory, 'package'), prefix = join(directory, 'installation')
        await execute('bun', ['run', 'quifox/tui/scripts/build-npm.ts', output], { cwd: repository })
        const packed = JSON.parse((await execute(npm, [...npmArguments, 'pack', '--json', '--ignore-scripts', '--pack-destination', directory], { cwd: output })).stdout) as { filename: string; files: { path: string }[] }[]
        expect(packed[0]!.files.map(file => file.path).sort()).toEqual(expect.arrayContaining(['LICENSE', 'bin/cli.js', 'bin/process-supervisor-entry.js', 'bin/process-supervisor.js', 'licenses/inventory.json']))
        expect(packed[0]!.files.some(file => /(?:\.agents|config\.json|sessions|\.map$|build-inputs)/.test(file.path))).toBe(false)
        expect((await readFile(join(output, 'bin/cli.js'), 'utf8')).includes(repository)).toBe(false)
        const inventory = JSON.parse(await readFile(join(output, 'licenses/inventory.json'), 'utf8')) as { name: string; notices: string[] }[]
        expect(inventory.find(item => item.name === '@quifox/agent-plugin-memory')?.notices.some(file => file.endsWith('/NOTICE'))).toBe(true)
        expect(inventory.filter(item => item.notices.length === 0)).toEqual([])
        for (const item of inventory) for (const file of item.notices) expect((await readFile(join(output, 'licenses', file), 'utf8')).trim()).not.toBe('')
        await mkdir(prefix, { recursive: true })
        await execute(npm, [...npmArguments, 'install', '--global', '--prefix', prefix, '--ignore-scripts', '--no-audit', '--no-fund', join(directory, packed[0]!.filename)])
        const command = process.platform === 'win32' ? join(prefix, 'quifox.cmd') : join(prefix, 'bin', 'quifox')
        const result = process.platform === 'win32'
            ? await execute('cmd.exe', ['/d', '/s', '/c', `""${command}" --version"`])
            : await execute(command, ['--version'], { env: { ...process.env, PATH: dirname(process.execPath) } })
        const manifest = JSON.parse(await readFile(join(repository, 'quifox/tui/package.json'), 'utf8')) as { version: string }
        expect(result.stdout.trim()).toBe(`QuiFox ${manifest.version}`)

        const workspace = join(directory, 'workspace'), root = join(directory, 'profile')
        await mkdir(workspace); await mkdir(root)
        const requests: { messages: { role: string; content: string }[] }[] = []
        const server = createServer(async (request, response) => {
            let body = ''; for await (const chunk of request) body += chunk
            requests.push(JSON.parse(body) as typeof requests[number])
            const command = process.platform === 'win32' ? `"${process.execPath}" -p "process.cwd()"` : `'${process.execPath.replace(/'/g, "'\\''")}' -p 'process.cwd()'`
            const delta = requests.length === 1
                ? { tool_calls: [{ index: 0, id: 'synthetic-command', type: 'function', function: { name: 'run_command', arguments: JSON.stringify({ command }) } }] }
                : { content: 'package-tool-completed' }
            response.writeHead(200, { 'Content-Type': 'text/event-stream' })
            response.end(`data: ${JSON.stringify({ choices: [{ delta }] })}\n\ndata: ${JSON.stringify({ choices: [{ delta: {}, finish_reason: requests.length === 1 ? 'tool_calls' : 'stop' }] })}\n\ndata: [DONE]\n\n`)
        })
        server.listen(0, '127.0.0.1'); await once(server, 'listening')
        try {
            await writeFile(join(root, 'config.json'), JSON.stringify({ version: 1, workspace,
                model: { provider: 'synthetic', model: 'synthetic', baseUrl: `http://127.0.0.1:${(server.address() as { port: number }).port}`, apiKey: 'synthetic-key', contextWindow: 100000, maxOutputTokens: 1024 },
                compaction: { safetyTokens: 10240 }, memory: { enabled: false, generate: false, extractionFormat: 'text' }, approval: 'allow', mcp: [] }))
            const binary = process.platform === 'win32' ? join(prefix, 'node_modules/quifox/bin/cli.js') : join(prefix, 'lib/node_modules/quifox/bin/cli.js')
            const batch = await execute(process.execPath, [binary, '--root', root, '--prompt', 'Run a synthetic command.'], { cwd: workspace,
                env: { ...process.env, HOME: directory, USERPROFILE: directory, PATH: dirname(process.execPath), MODEL_API_KEY: '', MODEL_BASE_URL: '', MODEL_ID: '', QUIFOX_WORKSPACE: '', QUIFOX_ROOT: '' } })
            expect(batch.stdout.trim()).toBe('package-tool-completed')
            expect(requests).toHaveLength(2)
            const receipt = JSON.parse(requests[1]!.messages.find(message => message.role === 'tool')!.content) as { stdout: string; exitCode: number }
            expect(receipt.stdout.trim()).toBe(await realpath(workspace))
            expect(receipt.exitCode).toBe(0)
        } finally { server.closeAllConnections(); server.close() }
    } finally { await rm(directory, { recursive: true, force: true }) }
}, 60_000)
