import { execFileSync } from 'node:child_process'
import { mkdir, readFile } from 'node:fs/promises'
import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const directory = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const manifest = JSON.parse(await readFile(resolve(directory, 'package.json'), 'utf8')) as { version: string }
const output = resolve(directory, '../release/bin', process.platform === 'win32' ? 'quifox.exe' : 'quifox')
await mkdir(dirname(output), { recursive: true })
execFileSync('bun', ['build', resolve(directory, 'src/cli.tsx'), '--compile', '--no-compile-autoload-dotenv', '--define', `process.env.QUIFOX_VERSION=${JSON.stringify(manifest.version)}`, '--define', 'process.env.DEV="false"', '--outfile', output], { stdio: 'inherit' })
if (process.platform === 'darwin') {
    execFileSync('/usr/bin/codesign', ['--force', '--sign', process.env.APPLE_SIGNING_IDENTITY ?? '-', output], { stdio: 'inherit' })
    execFileSync('/usr/bin/codesign', ['--verify', '--strict', output], { stdio: 'inherit' })
}
