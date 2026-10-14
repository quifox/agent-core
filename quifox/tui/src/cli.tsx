#!/usr/bin/env node
import { render } from 'ink'
import { QuiFoxRuntime, commandSupervisor, type SessionView } from '@quifox/shared-runtime'
import { TerminalApp } from './app.js'

function argument(name: string): string | undefined { const index = process.argv.indexOf(name); return index < 0 ? undefined : process.argv[index + 1] }
const root = argument('--root') ?? process.env.QUIFOX_ROOT
const workspace = argument('--workspace') ?? process.env.QUIFOX_WORKSPACE
const prompt = argument('--prompt')
const resume = argument('--resume')
if (process.argv.includes('--quifox-supervisor')) {
    const input = JSON.parse(argument('--quifox-supervisor') ?? '{}') as { command: string; cwd: string }
    if (typeof input.command !== 'string' || typeof input.cwd !== 'string') throw new Error('Invalid command supervisor arguments.')
    await commandSupervisor(input.command, input.cwd)
} else if (process.argv.includes('--version')) {
    process.stdout.write(`QuiFox ${process.env.QUIFOX_VERSION ?? 'development'}\n`)
} else if (process.argv.includes('--help')) {
    process.stdout.write('QUIFOX · terminal Agent\n--workspace <directory>  --root <isolated app directory>  --prompt <one turn>  --resume [sessionId]\nNew invocations start fresh conversations; --resume opens the history picker.\nmcp add <id> -- <command> [args...]  |  mcp add <id> --url <HTTP URL>  |  mcp list  |  mcp remove <id>\nMODEL_API_KEY / MODEL_BASE_URL / MODEL_ID configure the default Chat connection.\n')
} else {
    const runtime = await QuiFoxRuntime.open({ ...(root ? { root } : {}), ...(workspace ? { workspace } : {}) })
    try {
        const mcpIndex = process.argv.indexOf('mcp'), mcpAction = process.argv[mcpIndex + 1]
        if (mcpIndex >= 0) {
            const snapshot = await runtime.command({ type: 'snapshot' }) as { config: { mcp: { id: string }[] } }
            const id = process.argv[mcpIndex + 2]
            if (mcpAction === 'list') process.stdout.write(`${JSON.stringify(await runtime.command({ type: 'mcp', action: 'status' }), null, 2)}\n`)
            else if (mcpAction === 'remove' && id) { await runtime.command({ type: 'config', patch: { mcp: snapshot.config.mcp.filter(server => server.id !== id).map(server => ({ id: server.id })) } }); process.stdout.write('MCP removed.\n') }
            else if (mcpAction === 'add' && id) {
                const separator = process.argv.indexOf('--', mcpIndex), url = argument('--url')
                const server = url ? { id, transport: 'http', url } : { id, transport: 'stdio', command: process.argv[separator + 1], args: process.argv.slice(separator + 2) }
                if (!url && separator < 0) throw new Error('stdio MCP needs -- followed by a command and its arguments.')
                await runtime.command({ type: 'config', patch: { mcp: [...snapshot.config.mcp.filter(server => server.id !== id).map(server => ({ id: server.id })), server] } }); process.stdout.write('MCP added. Use /mcp to connect.\n')
            } else throw new Error('Use mcp add/list/remove; see --help.')
        } else if (prompt) {
            const session = await runtime.command({ type: 'create' }) as SessionView
            const unsubscribe = runtime.subscribe(event => {
                if (event.type === 'approval') {
                    process.stderr.write('Batch mode denied an operation requiring approval; run interactively.\n')
                    const approval = event.data as { id: string }
                    void runtime.command({ type: 'approve', sessionId: session.id, approvalId: approval.id, approved: false }).catch(() => {})
                    process.exitCode = 1
                }
            })
            await runtime.command({ type: 'submit', sessionId: session.id, prompt }); await runtime.waitForIdle(session.id); unsubscribe()
            const view = await runtime.command({ type: 'snapshot', sessionId: session.id }) as SessionView
            const last = [...view.messages].reverse().find(entry => entry.message.role === 'assistant')
            process.stdout.write(`${last?.message.content ?? ''}\n`)
            if (view.status !== 'idle') process.exitCode = 1
        } else {
            if (!process.stdin.isTTY) throw new Error('Interactive TUI needs a terminal; use --prompt for batch input.')
            const app = render(<TerminalApp runtime={runtime} {...(resume && !resume.startsWith('--') ? { initialSessionId: resume } : {})} showResume={process.argv.includes('--resume') && (!resume || resume.startsWith('--'))}/>, { exitOnCtrlC: false, alternateScreen: true, incrementalRendering: true })
            const stopped = (): void => { void runtime.close().finally(() => app.unmount()) }
            process.on('SIGTERM', stopped); process.on('SIGINT', stopped)
            try { await app.waitUntilExit() } finally { process.off('SIGTERM', stopped); process.off('SIGINT', stopped) }
        }
    } finally { await runtime.close() }
}
