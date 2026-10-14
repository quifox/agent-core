import { spawn, type ChildProcess } from 'node:child_process'
import { mkdir, readFile, readdir, stat, realpath } from 'node:fs/promises'
import { dirname, resolve, basename, relative, isAbsolute, sep } from 'node:path'
import { createHash } from 'node:crypto'
import { existsSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { z } from 'zod'
import { defineTool, toolError, toolSuccess, type AgentTool, type AgentContext, type AgentPlugin, type ToolResult } from '@quifox/agent-core'
import type { BackgroundTasksPlugin } from '@quifox/agent-plugin-tasks'
import { isMissing, writeAtomic } from './config.js'
import { FileAccessError, toolSummary, type ToolInspection, type FileChange } from './tool-presentation.js'
import { withGitChanges } from './git-observation.js'

export async function canonicalPath(path: string): Promise<string> {
    try { return await realpath(path) } catch (error) {
        if (!isMissing(error) || dirname(path) === path) throw error
        return resolve(await canonicalPath(dirname(path)), basename(path))
    }
}

async function optionalFile(path: string): Promise<string | null> { try { return await readFile(path, 'utf8') } catch (error) { if (isMissing(error)) return null; throw error } }
function fileFailure<Data = unknown>(cause: unknown): ToolResult<Data> | undefined {
    const code = (cause as NodeJS.ErrnoException | undefined)?.code
    return code && ['ENOENT', 'EISDIR', 'ENOTDIR', 'EACCES', 'EPERM', 'ELOOP', 'ENAMETOOLONG'].includes(code)
        ? toolError<Data>(`File operation cannot use this path (${code}); choose an existing readable file or a valid directory.`, { code: 'FILE_PATH_INVALID' }) : undefined
}
function change(path: string, before: string | null, after: string | null): FileChange {
    const limit = 200_000
    return { path, before: before?.slice(0, limit) ?? null, after: after?.slice(0, limit) ?? null,
        ...((before?.length ?? 0) > limit || (after?.length ?? 0) > limit ? { truncated: true } : {}) }
}

/** Unknown shell syntax is executable and requires approval; this is an authorization classifier, not a sandbox. */
export async function inspectTool(workspace: string, call: { name: string; input: unknown }, readOnly = false): Promise<ToolInspection> {
    try {
    const input = call.input && typeof call.input === 'object' ? call.input as Record<string, unknown> : {}
    const file = ['read_file', 'list_files', 'write_file', 'apply_patch'].includes(call.name)
    const command = call.name === 'run_command'
    const inspection: ToolInspection = { summary: toolSummary(call), risk: file && ['write_file', 'apply_patch'].includes(call.name) ? 'write' : command || (!file && !readOnly) ? 'execute' : 'read-only' }
    if (!file && !command) return inspection
    const target = await canonicalPath(resolve(workspace, String(command ? input.cwd ?? '.' : input.path ?? '.')))
    const distance = relative(await realpath(workspace), target)
    if (isAbsolute(distance) || distance === '..' || distance.startsWith(`..${sep}`)) { inspection.risk = 'outside-workspace'; inspection.requiresApproval = true }
    inspection.target = target; inspection.authorizationIdentity = target
    if (['write_file', 'apply_patch'].includes(call.name)) {
        const before = await optionalFile(target)
        const after = call.name === 'write_file' ? String(input.content ?? '') : before === null ? String(input.newText ?? '') :
            typeof input.oldText === 'string' && input.oldText && before.split(input.oldText).length === 2 ? before.replace(input.oldText, String(input.newText ?? '')) : before
        inspection.change = change(target, before, after)
        inspection.authorizationIdentity += `:${createHash('sha256').update(before ?? 'missing-file').digest('hex')}:${before === null}`
    }
    return inspection
    } catch (cause) { const result = fileFailure(cause); if (result) throw new FileAccessError(result); throw cause }
}

export interface NativeToolsOptions { workspace: string; signal(): AbortSignal | undefined; tasks: BackgroundTasksPlugin; backgroundEnabled?: boolean }
const readPolicy = { sideEffect: 'none', approval: 'none', retrySafe: true } as const
const writePolicy = { sideEffect: 'external', approval: 'host' } as const

/** Files and native processes belong to this Host; every mutation uses the normal permission chain. */
export function nativeTools(options: NativeToolsOptions): AgentPlugin {
    const path = (value: string): string => resolve(options.workspace, value)
    return { id: 'host-native-tools', hooks: { onInitialize: async ctx => {
        const registerFile = <Schema extends z.ZodType, Data>(tool: AgentTool<Schema, Data>): void => {
            const execute = tool.execute.bind(tool)
            tool.execute = async (input, context) => { try { return await execute(input, context) } catch (cause) { const result = fileFailure<Data>(cause); if (result) return result; throw cause } }
            ctx.tools.register(tool)
        }
        registerFile(defineTool({ name: 'read_file', description: 'Read a UTF-8 file using one-based line ranges; truncated output requires a follow-up range.',
            inputSchema: z.object({ path: z.string().min(1), startLine: z.number().int().positive().default(1), limit: z.number().int().min(1).max(1000).default(200) }).strict(), policy: readPolicy,
            execute: async input => {
                const lines = (await readFile(path(input.path), 'utf8')).split('\n')
                const selected = lines.slice(input.startLine - 1, input.startLine - 1 + input.limit)
                let content = selected.join('\n'); const byteTruncated = Buffer.byteLength(content) > 200_000
                if (byteTruncated) content = Buffer.from(content).subarray(0, 200_000).toString('utf8')
                return toolSuccess(content, { startLine: input.startLine, lines: selected.length, truncated: byteTruncated || input.startLine - 1 + input.limit < lines.length })
            } }))
        registerFile(defineTool({ name: 'list_files', description: 'List immediate directory entries with file/directory kinds.',
            inputSchema: z.object({ path: z.string().default('.') }).strict(), policy: readPolicy,
            execute: async input => {
                const entries = await readdir(path(input.path), { withFileTypes: true })
                const data = entries.slice(0, 1000).map(entry => ({ name: entry.name, kind: entry.isDirectory() ? 'directory' : entry.isSymbolicLink() ? 'symlink' : 'file' }))
                return toolSuccess(JSON.stringify({ entries: data, truncated: entries.length > data.length }))
            } }))
        registerFile(defineTool({ name: 'write_file', description: 'Write exact UTF-8 content atomically. Requires Host approval.',
            inputSchema: z.object({ path: z.string().min(1), content: z.string() }).strict(), policy: writePolicy,
            execute: async input => { const target = await canonicalPath(path(input.path)), before = await optionalFile(target); await saveFile(target, input.content);
                return toolSuccess('File written.', { change: change(target, before, input.content) }) } }))
        registerFile(defineTool({ name: 'apply_patch', description: 'Replace exactly one matching oldText in a file. Empty oldText creates a missing file. Requires Host approval.',
            inputSchema: z.object({ path: z.string().min(1), oldText: z.string(), newText: z.string() }).strict(), policy: writePolicy,
            execute: async input => {
                const target = await canonicalPath(path(input.path))
                let original: string | undefined
                try { original = await readFile(target, 'utf8') } catch (error) { if (!isMissing(error)) throw error }
                if (original === undefined) {
                    if (input.oldText) return toolError('Patch source does not exist.', { code: 'PATCH_MISMATCH' })
                    await saveFile(target, input.newText); return toolSuccess('File created.', { change: change(target, null, input.newText) })
                }
                if (!input.oldText || original.split(input.oldText).length !== 2) return toolError('oldText must match exactly once.', { code: 'PATCH_MISMATCH' })
                const next = original.replace(input.oldText, input.newText)
                await saveFile(target, next); return toolSuccess('Patch applied.', { change: change(target, original, next) })
            } }))
        ctx.tools.register(defineTool({ name: 'run_command', description: `Run a native ${process.platform} shell command in the workspace.${options.backgroundEnabled === false ? '' : ' background returns a task identity immediately; use task_get/wait/cancel.'} Cancellation does not imply rollback.`,
            inputSchema: z.object({ command: z.string().trim().min(1), cwd: z.string().optional(), ...(options.backgroundEnabled === false ? {} : { background: z.boolean().default(false) }),
                timeoutMs: z.number().int().positive().max(86_400_000).optional() }).strict(), policy: writePolicy,
            execute: async (input, context: AgentContext) => {
                const execute = (signal?: AbortSignal): Promise<ToolResult> => withGitChanges(options.workspace, () => runCommand(input.command, path(input.cwd ?? '.'), signal, input.timeoutMs))
                if (!input.background) return execute(options.signal())
                const taskId = options.tasks.submit(context, signal => execute(signal))
                const receipt = { taskId, status: 'running' }
                return toolSuccess(JSON.stringify(receipt), receipt)
            } }))
    } } }
}

async function saveFile(path: string, content: string): Promise<void> {
    let mode = 0o644
    try { mode = (await stat(path)).mode & 0o777 } catch (error) { if (!isMissing(error)) throw error }
    await mkdir(dirname(path), { recursive: true }); await writeAtomic(path, content, mode)
}

/** Spawn uses standard native shell resolution; cancellation waits for close and preserves observed exit/output. */
export async function runCommand(command: string, cwd: string, signal?: AbortSignal, timeoutMs?: number): Promise<ToolResult> {
    signal?.throwIfAborted()
    return new Promise<ToolResult>((accept, reject) => {
        const executable = basename(process.execPath)
        const compiled = executable.startsWith('quifox-engine') || executable === 'quifox' || executable === 'quifox.exe'
        const modulePath = fileURLToPath(new URL('./process-supervisor-entry.js', import.meta.url))
        const sourcePath = existsSync(modulePath) ? modulePath : modulePath.replace(/\.js$/, '.ts')
        const arguments_ = compiled ? ['--quifox-supervisor', JSON.stringify({ command, cwd })] :
            [...(sourcePath.endsWith('.ts') && basename(process.execPath).startsWith('node') ? ['--experimental-strip-types', '--disable-warning=ExperimentalWarning'] : []),
                sourcePath, '--quifox-supervisor', JSON.stringify({ command, cwd })]
        const child = spawn(process.execPath, arguments_, { cwd, windowsHide: true, detached: process.platform !== 'win32', stdio: ['pipe', 'pipe', 'pipe'] })
        let stdout = '', stderr = '', truncated = false, cancelled = false
        let killTimer: ReturnType<typeof setTimeout> | undefined
        const collect = (current: string, chunk: Buffer): string => {
            const remaining = 100_000 - Buffer.byteLength(current)
            if (chunk.length > remaining) truncated = true
            return remaining > 0 ? current + chunk.subarray(0, remaining).toString('utf8') : current
        }
        child.stdout.on('data', (chunk: Buffer) => { stdout = collect(stdout, chunk) })
        child.stderr.on('data', (chunk: Buffer) => { stderr = collect(stderr, chunk) })
        const stop = (): void => {
            cancelled = true; child.stdin.end()
            killTimer ??= setTimeout(() => terminate(child, true), 3000)
        }
        signal?.addEventListener('abort', stop, { once: true })
        const timeout = timeoutMs === undefined ? undefined : setTimeout(stop, timeoutMs)
        const cleanup = (): void => { signal?.removeEventListener('abort', stop); if (timeout) clearTimeout(timeout); if (killTimer) clearTimeout(killTimer) }
        child.once('error', error => { cleanup(); reject(error) })
        child.once('close', (code, exitSignal) => {
            cleanup()
            const result = { stdout, stderr, exitCode: code, signal: exitSignal, cancelRequested: cancelled, truncated }
            accept(code === 0 ? toolSuccess(JSON.stringify(result), result) : toolError(JSON.stringify(result), { code: cancelled ? 'COMMAND_INTERRUPTED' : 'COMMAND_FAILED', data: result }))
        })
        if (signal?.aborted) stop()
    })
}

function terminate(child: ChildProcess, force: boolean): void {
    if (!child.pid) return
    if (process.platform === 'win32') {
        const killer = spawn('taskkill', ['/pid', String(child.pid), '/T', ...(force ? ['/F'] : [])], { windowsHide: true, stdio: 'ignore' })
        killer.on('error', () => { child.kill(force ? 'SIGKILL' : 'SIGTERM') })
    } else {
        try { process.kill(-child.pid, force ? 'SIGKILL' : 'SIGTERM') } catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ESRCH') child.kill(force ? 'SIGKILL' : 'SIGTERM') }
    }
}
