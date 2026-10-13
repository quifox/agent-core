import { execFileSync } from 'node:child_process'
import { mkdir } from 'node:fs/promises'
import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const directory = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const triple = execFileSync('rustc', ['--print', 'host-tuple'], { encoding: 'utf8' }).trim()
if (!/^[a-z0-9_-]+$/.test(triple)) throw new Error('Rust host target is unavailable.')
const output = resolve(directory, 'src-tauri', 'binaries', `quifox-engine-${triple}${process.platform === 'win32' ? '.exe' : ''}`)
await mkdir(dirname(output), { recursive: true })
execFileSync('bun', ['build', resolve(directory, '../runtime/src/sidecar.ts'), '--compile', '--no-compile-autoload-dotenv', '--outfile', output], { stdio: 'inherit' })
if (process.platform === 'darwin') {
    // Bun embeds the program after its linker signature; seal the completed native artifact.
    execFileSync('/usr/bin/codesign', ['--force', '--sign', process.env.APPLE_SIGNING_IDENTITY ?? '-', output], { stdio: 'inherit' })
    execFileSync('/usr/bin/codesign', ['--verify', '--strict', output], { stdio: 'inherit' })
}
execFileSync('bun', ['x', '--no-install', 'tauri', 'icon', resolve(directory, 'src/assets/fox.svg'), '--output', resolve(directory, 'src-tauri/icons')], { cwd: directory, stdio: 'inherit' })
