import { parse } from 'shell-quote'
import { access, realpath } from 'node:fs/promises'
import { constants } from 'node:fs'
import { delimiter, isAbsolute, relative, resolve, sep } from 'node:path'

function inside(root: string, path: string): boolean {
    const distance = relative(root, path)
    return !isAbsolute(distance) && distance !== '..' && !distance.startsWith(`..${sep}`)
}

/** @param command - Original shell text. @param cwd - Prepared directory. @param workspace - Read-only exemption boundary. */
export async function commandIsReadOnly(command: string, cwd: string, workspace: string): Promise<boolean> {
    // shell-quote is a tokenizer, not a complete shell parser. Reject expansion and control syntax before tokenizing.
    const unsupported = '\n\r\\$`{}~*?[]();|&<>#'
    if (process.platform === 'win32' || command.length > 64_000 || [...command].some(character => unsupported.includes(character) || character.charCodeAt(0) < 32 && character !== '\t') || !completeLiterals(command)) return false
    let words: string[]
    try {
        const tokens = parse(command, () => { throw new Error('Dynamic shell word.') })
        if (tokens.some(token => typeof token !== 'string')) return false
        words = tokens as string[]
    } catch { return false }
    const [name, ...args] = words
    if (!name || name.includes('/') || name.includes('=')) return false
    const paths = readPaths(name, args)
    if (!paths || !await trustedExecutable(name, cwd)) return false
    if (name === 'rg' && process.env.RIPGREP_CONFIG_PATH && !args.includes('--no-config')) return false
    try {
        const root = await realpath(workspace), directory = await realpath(cwd)
        return inside(root, directory) && (await Promise.all(paths.map(async path => inside(root, await realpath(resolve(directory, path)))))).every(Boolean)
    } catch { return false }
}

/** The tokenizer accepts unclosed quotes; only complete literal words may enter the exemption path. */
function completeLiterals(command: string): boolean {
    const word = /[ \t]*(?:[^'"\s]+|'[^']*'|"[^"]*")+/y
    let offset = 0
    while (offset < command.length) {
        word.lastIndex = offset
        if (!word.exec(command)) return command.slice(offset).trim() === ''
        offset = word.lastIndex
    }
    return true
}

/** Account for arguments that turn otherwise read-only utilities into writers or arbitrary program launchers. */
function readPaths(name: string, args: string[]): string[] | undefined {
    if (name === 'pwd') return args.every(arg => arg === '-L' || arg === '-P') ? [] : undefined
    if (name === 'sed') {
        if (args[0] !== '-n' || !/^\d+(?:,\d+)?p$/.test(args[1] ?? '')) return undefined
        return args.length > 2 && args.slice(2).every(arg => !arg.startsWith('-')) ? args.slice(2) : undefined
    }
    const flags: Record<string, RegExp> = {
        ls: /^-[la1hdt]+$/, cat: /^-[nbsvET]+$/, wc: /^-[lwcm]+$/,
        rg: /^(?:-[nilisS]+|--files|--hidden|--no-ignore|--no-config|--line-number|--ignore-case)$/,
        head: /^-[ncvq]+$/, tail: /^-[ncvq]+$/
    }
    const allowed = flags[name]
    if (!allowed) return undefined
    const paths: string[] = []
    let literal = false, pattern = name !== 'rg' || args.includes('--files')
    for (let index = 0; index < args.length; index++) {
        const arg = args[index]!
        if (!literal && arg === '--') { literal = true; continue }
        if (!literal && arg.startsWith('-')) {
            if ((name === 'head' || name === 'tail') && (arg === '-n' || arg === '-c')) {
                if (!/^\d+$/.test(args[++index] ?? '')) return undefined
                continue
            }
            if (!allowed.test(arg)) return undefined
        } else if (!pattern) { pattern = true }
        else paths.push(arg)
    }
    return pattern && (name === 'ls' || paths.length > 0 || name === 'rg') ? paths : undefined
}

/** Reject workspace/PATH shadowing; only ordinary system or package-manager executables receive the read-only exemption. */
async function trustedExecutable(name: string, cwd: string): Promise<boolean> {
    if (process.env.LD_PRELOAD || process.env.DYLD_INSERT_LIBRARIES || process.env.BASH_ENV || process.env.ENV || Object.keys(process.env).some(key => key.startsWith('BASH_FUNC_'))) return false
    if (name === 'pwd') return true
    for (const directory of (process.env.PATH ?? '').split(delimiter)) {
        const candidate = resolve(cwd, directory || '.', name)
        try {
            await access(candidate, constants.X_OK)
            const actual = await realpath(candidate)
            return ['/bin', '/usr/bin', '/opt/homebrew', '/usr/local/Cellar', '/usr/local/bin'].some(root => inside(root, actual))
        } catch { /* Continue the same PATH search used by the shell. */ }
    }
    return false
}
