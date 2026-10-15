import { expect, it, vi } from 'vitest'
import { render } from 'ink-testing-library'
import { defaultConfig, publicConfig, type ResourceView, type RuntimeCommand, type RuntimeEvent, type RuntimeSnapshot, type SessionView } from '@quifox/shared-runtime'
import { TerminalApp, type TerminalRuntime } from '../src/app.js'

it('renders structured tool receipts as readable facts without protocol identities or escaped newlines', async () => {
    const view: SessionView = { id: 'synthetic', title: 'Tool result', workspace: '/synthetic', status: 'idle', updatedAt: '2026-01-01', resumeAvailable: false,
        messages: [{ id: 'tool', origin: 'context', message: { role: 'tool', toolName: 'subagent_wait', toolCallId: 'internal-call', content: JSON.stringify({ status: 'completed', taskId: 'internal-task', name: 'Curie', text: 'First line\nSecond line' }) } }],
        events: [], pendingMessages: [], skills: { skills: [], issues: [] }, guidance: [], backgroundTasks: [], toolStates: [], approvals: [], memory: { enabled: false, processing: false, content: '', summaries: 0 } }
    const snapshot: RuntimeSnapshot = { configurationRevision: 'fixture', config: publicConfig(defaultConfig('/synthetic')), sessions: [view] }
    const runtime: TerminalRuntime = { close: async () => {}, subscribe: () => () => {}, command: async command => command.type === 'snapshot' ? structuredClone(command.sessionId ? view : snapshot) : {} }
    const app = render(<TerminalApp runtime={runtime} initialSessionId={view.id}/>)
    try {
        await expect.poll(() => app.lastFrame()).toContain('Second line')
        expect(app.lastFrame()).toContain('Curie'); expect(app.lastFrame()).toContain('已完成')
        expect(app.lastFrame()).not.toContain('internal-task'); expect(app.lastFrame()).not.toContain('taskId'); expect(app.lastFrame()).not.toContain('\\n')
    } finally { app.unmount() }
})

it('selects the effective effort directly without adding an inheritance menu item', async () => {
    const config = defaultConfig('/synthetic'); config.model.reasoningEfforts = ['low', 'high', 'max']
    const snapshot: RuntimeSnapshot = { configurationRevision: 'fixture', config: publicConfig(config), sessions: [] }, commands: RuntimeCommand[] = []
    const view: SessionView = { id: 'synthetic', title: 'Effort task', workspace: '/synthetic', status: 'idle', updatedAt: '2026-01-01', resumeAvailable: false,
        modelId: 'default', defaultModel: snapshot.config.model, reasoningEffort: 'high', messages: [], events: [], pendingMessages: [],
        skills: { skills: [], issues: [] }, guidance: [], backgroundTasks: [], toolStates: [], approvals: [], memory: { enabled: true, processing: false, content: '', summaries: 0 } }
    const runtime: TerminalRuntime = { close: async () => {}, subscribe: () => () => {}, command: async command => {
        commands.push(command); return command.type === 'snapshot' ? structuredClone(command.sessionId ? view : snapshot) : {}
    } }
    const app = render(<TerminalApp runtime={runtime} initialSessionId="synthetic"/>)
    try {
        await expect.poll(() => app.lastFrame()).toContain('Effort task')
        app.stdin.write('/effort'); app.stdin.write('\r')
        await expect.poll(() => app.lastFrame()).toContain('› high')
        expect(app.lastFrame()).not.toContain('继承设置')
        app.stdin.write('\r')
        await expect.poll(() => commands.find(command => command.type === 'session-config')).toMatchObject({ reasoningEffort: null })
    } finally { app.unmount() }
})

it('shows directory skills before creating a session and does not invent unknown reasoning levels', async () => {
    const commands: RuntimeCommand[] = []
    const snapshot: RuntimeSnapshot = { configurationRevision: 'fixture', config: publicConfig(defaultConfig('/synthetic')), sessions: [] }
    const resources: ResourceView = { workspace: '/synthetic', config: snapshot.config, skillsEnabled: true, configSources: [], guidance: [], agents: { agents: [], issues: [] },
        skills: { skills: [{ id: 'root/review', root: 'root', directory: 'review', name: 'review', description: 'Review a change', path: '/synthetic/skills/review/SKILL.md' }], issues: [] }, memory: { enabled: true, processing: false, content: '', summaries: 0 } }
    const runtime: TerminalRuntime = { close: async () => {}, subscribe: () => () => {}, command: async command => {
        commands.push(command); return command.type === 'resources' ? resources : snapshot
    } }
    const app = render(<TerminalApp runtime={runtime} showResume/>)
    try {
        await expect.poll(() => app.lastFrame()).toContain('恢复主会话')
        app.stdin.write('\u001b'); await expect.poll(() => app.lastFrame()?.includes('恢复主会话')).toBe(false)
        app.stdin.write('/skills'); app.stdin.write('\r')
        await expect.poll(() => app.lastFrame()).toContain('$root/review')
        app.stdin.write('\u001b'); await expect.poll(() => app.lastFrame()?.includes('$root/review')).toBe(false)
        app.stdin.write('/effort'); app.stdin.write('\r')
        await expect.poll(() => app.lastFrame()).toContain('目录接口未提供思考档位')
        expect(commands.some(command => command.type === 'create' || command.type === 'submit')).toBe(false)
    } finally { app.unmount() }
})

it('refreshes the open Memory panel after background completion using only bounded session snapshots', async () => {
    const commands: RuntimeCommand[] = []
    let listener: ((event: RuntimeEvent) => void) | undefined
    const view: SessionView = { id: 'synthetic', title: 'Memory task', workspace: '/synthetic', status: 'idle', updatedAt: '2026-01-01', resumeAvailable: false,
        messages: [], events: [], pendingMessages: [], skills: { skills: [], issues: [] }, guidance: [], backgroundTasks: [], toolStates: [],
        memory: { enabled: true, processing: true, content: 'old memory', summaries: 0 }, approvals: [] }
    const snapshot: RuntimeSnapshot = { configurationRevision: 'fixture', config: publicConfig(defaultConfig('/synthetic')), sessions: [view] }
    const runtime: TerminalRuntime = { close: async () => {}, subscribe: callback => { listener = callback; return () => { listener = undefined } }, command: async command => {
        commands.push(command); return command.type === 'snapshot' ? structuredClone(command.sessionId ? view : snapshot) : {}
    } }
    const app = render(<TerminalApp runtime={runtime} initialSessionId={view.id}/>)
    try {
        await expect.poll(() => app.lastFrame()).toContain('Memory task')
        app.stdin.write('/memory'); app.stdin.write('\r')
        await expect.poll(() => app.lastFrame()).toContain('old memory')
        view.memory = { enabled: true, processing: false, content: 'new consolidated memory', summaries: 1 }
        listener?.({ version: 1, sessionId: view.id, sequence: 1, timestamp: '2026-01-01T00:00:00Z', type: 'memory', data: { processing: false } })
        await expect.poll(() => app.lastFrame()).toContain('new consolidated memory')
        expect(app.lastFrame()).not.toContain('old memory')
        expect(commands.filter(command => command.type === 'snapshot' && command.sessionId).every(command => command.type === 'snapshot' && command.traceOnly && command.messageLimit === 60 && command.eventLimit === 300)).toBe(true)
    } finally { app.unmount() }
})

it.each([[20, 12], [40, 24], [80, 24]])('keeps the latest message, brand and input visible in %ix%i cells', async (columns, rows) => {
    const view: SessionView = { id: 'synthetic', title: 'Long output', workspace: '/synthetic/long/workspace/path', status: 'idle', updatedAt: '2026-01-01', resumeAvailable: false,
        messages: [{ id: 'reply', origin: 'assistant', message: { role: 'assistant', content: Array.from({ length: 80 }, (_, index) => `line ${index}  `).join('\n') + '\nfinal marker' } }],
        events: [], pendingMessages: [], skills: { skills: [], issues: [] }, guidance: [], backgroundTasks: [], toolStates: [], memory: { enabled: true, processing: false, content: '', summaries: 0 }, approvals: [] }
    const snapshot: RuntimeSnapshot = { configurationRevision: 'fixture', config: publicConfig(defaultConfig('/synthetic')), sessions: [view] }
    const runtime: TerminalRuntime = { close: async () => {}, subscribe: () => () => {}, command: async command => command.type === 'snapshot' ? structuredClone(command.sessionId ? view : snapshot) : {} }
    const app = render(<TerminalApp runtime={runtime} initialSessionId="synthetic" />)
    try {
        Object.defineProperty(app.stdout, 'columns', { value: columns, configurable: true }); Object.defineProperty(app.stdout, 'rows', { value: rows, configurable: true })
        await expect.poll(() => app.lastFrame()).toContain('final marker')
        app.stdout.emit('resize')
        await expect.poll(() => app.lastFrame()?.split('\n').length).toBeLessThanOrEqual(rows)
        await expect.poll(() => app.lastFrame()).toContain('final marker')
        expect(app.lastFrame()).toContain('QUIFOX')
        app.stdin.write('\u001b[A')
        await expect.poll(() => app.lastFrame()?.includes('final marker')).toBe(false)
        app.stdin.write('very long draft '.repeat(30))
        await expect.poll(() => app.lastFrame()?.split('\n').length).toBeLessThanOrEqual(rows)
        expect(app.lastFrame()).toContain('QUIFOX')
    } finally { app.unmount() }
})

it('renders the fox and actual approval, routes approve/steer/stop keys and closes on Ctrl+C', async () => {
    const commands: RuntimeCommand[] = []
    const close = vi.fn(async () => {})
    const view: SessionView = { id: 'synthetic', title: 'Code task', workspace: '/synthetic', status: 'running', updatedAt: '2026-01-01', resumeAvailable: false,
        messages: [], events: [], pendingMessages: [], skills: { skills: [], issues: [] }, guidance: [], backgroundTasks: [], toolStates: [], memory: { enabled: true, processing: false, content: '', summaries: 0 },
        approvals: [{ id: 'approval', sessionId: 'synthetic', operationId: 'call', call: { id: 'call', name: 'write_file', input: { path: 'synthetic.txt' } } }] }
    const snapshot: RuntimeSnapshot = { configurationRevision: 'fixture', config: publicConfig(defaultConfig('/synthetic')), sessions: [view] }
    const runtime: TerminalRuntime = { close, subscribe: () => () => {}, command: async command => {
        commands.push(command)
        if (command.type === 'approve') view.approvals = []
        return command.type === 'snapshot' ? structuredClone(command.sessionId ? view : snapshot) : { accepted: true }
    } }
    snapshot.config.preferences.inputMode = 'steer'
    const app = render(<TerminalApp runtime={runtime} initialSessionId="synthetic" />)
    try {
        await expect.poll(() => app.lastFrame()).toContain('需要批准：write_file')
        expect(app.lastFrame()).toContain('QUIFOX'); expect(app.lastFrame()).toContain('▼')
        app.stdin.write('y'); app.stdin.write('n')
        expect(commands.some(command => command.type === 'approve')).toBe(false)
        app.stdin.write('\r')
        await expect.poll(() => commands.some(command => command.type === 'approve' && command.approved)).toBe(true)
        await expect.poll(() => app.lastFrame()?.includes('需要批准')).toBe(false)
        app.stdin.write('next step')
        await expect.poll(() => app.lastFrame()).toContain('next step')
        app.stdin.write('\r')
        await expect.poll(() => commands.some(command => command.type === 'submit' && command.prompt === 'next step' && command.mode === 'steer')).toBe(true)
        app.stdin.write('\u001b')
        await expect.poll(() => commands.some(command => command.type === 'stop')).toBe(true)
        app.stdin.write('\u0003')
        await expect.poll(() => close.mock.calls.length).toBe(1)
    } finally { app.unmount() }
})

it('honors a rejection selected immediately before Enter without approving the tool', async () => {
    const commands: RuntimeCommand[] = []
    const view: SessionView = { id: 'approval-session', title: 'Approval task', workspace: '/synthetic', status: 'running', updatedAt: '2026-01-01', resumeAvailable: false,
        messages: [], events: [], pendingMessages: [], skills: { skills: [], issues: [] }, guidance: [], backgroundTasks: [], toolStates: [],
        memory: { enabled: false, processing: false, content: '', summaries: 0 },
        approvals: [{ id: 'approval', sessionId: 'approval-session', operationId: 'operation', call: { id: 'call', name: 'write_file', input: { path: 'synthetic.txt' } } }] }
    const snapshot: RuntimeSnapshot = { configurationRevision: 'fixture', config: publicConfig(defaultConfig('/synthetic')), sessions: [view] }
    const runtime: TerminalRuntime = { close: async () => {}, subscribe: () => () => {}, command: async command => {
        commands.push(command)
        if (command.type === 'approve') view.approvals = []
        return command.type === 'snapshot' ? structuredClone(command.sessionId ? view : snapshot) : { accepted: true }
    } }
    const app = render(<TerminalApp runtime={runtime} initialSessionId={view.id}/>)
    try {
        await expect.poll(() => app.lastFrame()).toContain('拒绝并回复')
        app.stdin.write('\u001b[B'); app.stdin.write('\r')
        await expect.poll(() => commands.find(command => command.type === 'approve')).toMatchObject({ approvalId: 'approval', approved: false })
        expect(commands.some(command => command.type === 'submit')).toBe(false)
    } finally { app.unmount() }
})

it('denies with a reply through the keyboard menu and restores the unsent message draft', async () => {
    const commands: RuntimeCommand[] = []
    let listener: ((event: RuntimeEvent) => void) | undefined
    const view: SessionView = { id: 'feedback-session', title: 'Feedback task', workspace: '/synthetic', status: 'running', updatedAt: '2026-01-01', resumeAvailable: false,
        messages: [], events: [], pendingMessages: [], skills: { skills: [], issues: [] }, guidance: [], backgroundTasks: [], toolStates: [], approvals: [],
        memory: { enabled: false, processing: false, content: '', summaries: 0 } }
    const snapshot: RuntimeSnapshot = { configurationRevision: 'fixture', config: publicConfig(defaultConfig('/synthetic')), sessions: [view] }
    const runtime: TerminalRuntime = { close: async () => {}, subscribe: callback => { listener = callback; return () => { listener = undefined } }, command: async command => {
        commands.push(command)
        if (command.type === 'approve') view.approvals = []
        return command.type === 'snapshot' ? structuredClone(command.sessionId ? view : snapshot) : { accepted: true }
    } }
    const app = render(<TerminalApp runtime={runtime} initialSessionId={view.id}/>)
    try {
        await expect.poll(() => app.lastFrame()).toContain('Feedback task')
        app.stdin.write('unsent task')
        await expect.poll(() => app.lastFrame()).toContain('unsent task')
        view.approvals = [{ id: 'approval', sessionId: view.id, operationId: 'operation', call: { id: 'call', name: 'write_file', input: { path: 'synthetic.txt' } } }]
        listener?.({ version: 1, sessionId: view.id, sequence: 1, timestamp: '2026-01-01T00:00:00Z', type: 'approval', data: view.approvals[0] })
        await expect.poll(() => app.lastFrame()).toContain('拒绝并回复')
        app.stdin.write('\u001b[A'); app.stdin.write('\r')
        await expect.poll(() => app.lastFrame()).toContain('拒绝说明')
        app.stdin.write('cancelled explanation'); app.stdin.write('\u001b')
        await expect.poll(() => app.lastFrame()).toContain('拒绝并回复')
        expect(app.lastFrame()).toContain('› 拒绝并回复')
        expect(commands.some(command => command.type === 'approve')).toBe(false)
        app.stdin.write('\r')
        await expect.poll(() => app.lastFrame()).toContain('拒绝说明')
        app.stdin.write('请先读取文件'); app.stdin.write('\r')
        await expect.poll(() => commands.find(command => command.type === 'approve')).toMatchObject({ approved: false, feedback: '请先读取文件' })
        await expect.poll(() => app.lastFrame()).toContain('unsent task')
        expect(commands.some(command => command.type === 'submit')).toBe(false)
    } finally { app.unmount() }
})

it('keeps DeepSeek protocol selection in the connection picker without a raw Provider field', async () => {
    const commands: RuntimeCommand[] = []
    const view: SessionView = { id: 'models-session', title: 'Model task', workspace: '/synthetic', status: 'idle', updatedAt: '2026-01-01', resumeAvailable: false,
        messages: [], events: [], pendingMessages: [], skills: { skills: [], issues: [] }, guidance: [], backgroundTasks: [], toolStates: [], approvals: [],
        memory: { enabled: false, processing: false, content: '', summaries: 0 } }
    const snapshot: RuntimeSnapshot = { configurationRevision: 'fixture', config: publicConfig(defaultConfig('/synthetic')), sessions: [view] }
    const runtime: TerminalRuntime = { close: async () => {}, subscribe: () => () => {}, command: async command => {
        commands.push(command); return command.type === 'snapshot' ? structuredClone(command.sessionId ? view : snapshot) : { accepted: true }
    } }
    const app = render(<TerminalApp runtime={runtime} initialSessionId={view.id}/>)
    try {
        await expect.poll(() => app.lastFrame()).toContain('Model task')
        app.stdin.write('/model'); app.stdin.write('\r')
        await expect.poll(() => app.lastFrame()).toContain('添加模型连接')
        app.stdin.write('\u001b[B'); app.stdin.write('\r')
        await expect.poll(() => app.lastFrame()).toContain('连接类型')
        app.stdin.write('\r')
        for (const [label, value] of [['配置名称', 'review-model'], ['模型名称', 'deepseek-flash'], ['Base URL', 'https://api.deepseek.com'], ['上下文容量', '100000'], ['最大输出 Tokens', ''], ['API Key', 'synthetic-key']]) {
            await expect.poll(() => app.lastFrame()).toContain(`添加模型 · ${label}`)
            expect(app.lastFrame()).not.toContain('Provider')
            if (value) app.stdin.write(value)
            app.stdin.write('\r')
        }
        await expect.poll(() => commands.find(command => command.type === 'config')).toMatchObject({ patch: { models: [{ id: 'review-model', provider: 'deepseek', model: 'deepseek-flash' }] } })
    } finally { app.unmount() }
})

it('keeps the latest streaming delta visible without waiting for a structural snapshot', async () => {
    let listener: ((event: RuntimeEvent) => void) | undefined
    const view: SessionView = { id: 'streaming', title: 'Streaming', workspace: '/synthetic', status: 'running', updatedAt: '2026-01-01', resumeAvailable: false,
        messages: [{ id: 'history', origin: 'assistant', message: { role: 'assistant', content: 'history line\n'.repeat(80) + 'HISTORY_TAIL' } }],
        events: [], eventSequence: 0, pendingMessages: [], skills: { skills: [], issues: [] }, guidance: [], backgroundTasks: [], toolStates: [], memory: { enabled: true, processing: false, content: '', summaries: 0 }, approvals: [] }
    const snapshot: RuntimeSnapshot = { configurationRevision: 'fixture', config: publicConfig(defaultConfig('/synthetic')), sessions: [view] }
    const runtime: TerminalRuntime = { close: async () => {}, subscribe: callback => { listener = callback; return () => { listener = undefined } }, command: async command => command.type === 'snapshot' ? structuredClone(command.sessionId ? view : snapshot) : {} }
    const app = render(<TerminalApp runtime={runtime} initialSessionId={view.id}/>)
    try {
        Object.defineProperty(app.stdout, 'columns', { value: 40, configurable: true }); Object.defineProperty(app.stdout, 'rows', { value: 24, configurable: true }); app.stdout.emit('resize')
        await expect.poll(() => app.lastFrame()).toContain('HISTORY_TAIL')
        for (let index = 1; index <= 1000; index++) listener?.({ version: 1, sessionId: view.id, sequence: index, timestamp: '2026-01-01T00:00:00Z', type: 'agent', data: { type: 'text-delta', delta: index === 1000 ? 'LIVE_FINAL_MARKER' : `stream line ${index}\n` } })
        await expect.poll(() => app.lastFrame(), { timeout: 1000 }).toContain('LIVE_FINAL_MARKER')
        expect(app.lastFrame()?.split('\n').length).toBeLessThanOrEqual(24)
        expect(app.lastFrame()).not.toContain('Enter 发送 · / 命令')
    } finally { app.unmount() }
})

it('keeps every slash command reachable and routes spawn arguments and recipient completion through the shared Host', async () => {
    const commands: RuntimeCommand[] = []
    const view: SessionView = { id: 'parent', title: '输入路由', workspace: '/synthetic', status: 'idle', updatedAt: '2026-01-01', resumeAvailable: false,
        messages: [], events: [], pendingMessages: [], skills: { skills: [], issues: [] }, guidance: [], backgroundTasks: [], toolStates: [], memory: { enabled: false, processing: false, content: '', summaries: 0 }, approvals: [] }
    const child = { ...view, id: 'child', name: 'Turing', title: 'Agent Turing', parentId: 'parent', taskId: 'child-task' }
    const snapshot: RuntimeSnapshot = { configurationRevision: 'fixture', config: publicConfig(defaultConfig('/synthetic')), sessions: [view] }
    const runtime: TerminalRuntime = { close: async () => {}, subscribe: () => () => {}, command: async command => {
        commands.push(command)
        if (command.type === 'submit' && command.prompt.startsWith('/spawn')) { snapshot.sessions.push(child); return { kind: 'spawn', accepted: true, agents: [{ sessionId: child.id, taskId: child.taskId, name: child.name, status: 'idle' }], errors: [] } }
        return command.type === 'snapshot' ? structuredClone(command.sessionId ? view : snapshot) : { accepted: true }
    } }
    const app = render(<TerminalApp runtime={runtime} initialSessionId={view.id}/>)
    try {
        Object.defineProperty(app.stdout, 'columns', { value: 80, configurable: true }); Object.defineProperty(app.stdout, 'rows', { value: 24, configurable: true }); app.stdout.emit('resize')
        await expect.poll(() => app.lastFrame()).toContain('输入路由')
        app.stdin.write('/')
        await expect.poll(() => app.lastFrame()).toContain('/model')
        app.stdin.write('\u001b[A')
        await expect.poll(() => app.lastFrame()).toContain('/help')
        app.stdin.write('\u001b'); app.stdin.write('\u007f'); app.stdin.write('/spawn 1 preserve requirements'); app.stdin.write('\r')
        await expect.poll(() => app.lastFrame()).toContain('@Turing')
        expect(commands.find(command => command.type === 'submit' && command.prompt.startsWith('/spawn'))).toMatchObject({ prompt: '/spawn 1 preserve requirements', messageId: expect.any(String) })
        app.stdin.write('\u001b')
        await expect.poll(() => app.lastFrame()).not.toContain('已创建')
        app.stdin.write('@Tu')
        await expect.poll(() => app.lastFrame()).toContain('› @Tu')
        app.stdin.write('\t'); app.stdin.write('review the code'); app.stdin.write('\r')
        await expect.poll(() => commands.filter(command => command.type === 'submit').map(command => command.prompt)).toContain('@Turing review the code')
        expect(app.lastFrame()).not.toContain('Ctrl+C 退出')
    } finally { app.unmount() }
})

it('distinguishes identically titled sessions in the resume picker without duplicate React keys', async () => {
    const error = vi.spyOn(console, 'error').mockImplementation(() => {})
    const first: SessionView = { id: 'first', title: 'New session', workspace: '/synthetic', status: 'idle', updatedAt: '2026-01-01', resumeAvailable: false,
        messages: [], events: [], pendingMessages: [], skills: { skills: [], issues: [] }, guidance: [], backgroundTasks: [], toolStates: [], memory: { enabled: true, processing: false, content: '', summaries: 0 }, approvals: [] }
    const second = { ...first, id: 'second' }, commands: RuntimeCommand[] = []
    const snapshot: RuntimeSnapshot = { configurationRevision: 'fixture', config: publicConfig(defaultConfig('/synthetic')), sessions: [first, second] }
    const runtime: TerminalRuntime = { close: async () => {}, subscribe: () => () => {}, command: async command => {
        commands.push(command); return command.type === 'snapshot' ? structuredClone(command.sessionId ? command.sessionId === 'second' ? second : first : snapshot) : {}
    } }
    const app = render(<TerminalApp runtime={runtime} initialSessionId="first" />)
    try {
        await expect.poll(() => app.lastFrame()).toContain('新会话')
        app.stdin.write('/resume'); app.stdin.write('\r')
        await expect.poll(() => app.lastFrame()).toContain('恢复主会话')
        expect(error.mock.calls.some(call => String(call[0]).includes('same key'))).toBe(false)
        app.stdin.write('\u001b[B')
        await expect.poll(() => app.lastFrame()).toContain('› second · New session')
        app.stdin.write('\r')
        await expect.poll(() => commands.some(command => command.type === 'snapshot' && command.sessionId === 'second')).toBe(true)
        expect(error.mock.calls.some(call => String(call[0]).includes('same key'))).toBe(false)
    } finally { app.unmount(); error.mockRestore() }
})

it('starts a fresh main session and filters slash commands with Tab completion', async () => {
    const commands: RuntimeCommand[] = []
    const view: SessionView = { id: 'fresh', title: '新的主会话', workspace: '/synthetic', status: 'idle', updatedAt: '2026-01-01', resumeAvailable: false,
        messages: [], events: [], pendingMessages: [], skills: { skills: [], issues: [] }, guidance: [], backgroundTasks: [], toolStates: [], memory: { enabled: true, processing: false, content: '', summaries: 0 }, approvals: [] }
    const snapshot: RuntimeSnapshot = { configurationRevision: 'fixture', config: publicConfig(defaultConfig('/synthetic')), sessions: [{ ...view, id: 'old-child', title: '不应自动选择的子会话', parentId: 'parent' }] }
    view.skills.skills = [{ id: 'global/code-review', root: 'global', directory: 'code-review', path: '/synthetic/global/code-review/SKILL.md', name: 'code-review', description: 'older skill description' },
        { id: 'project/code-review', root: 'project', directory: 'code-review', path: '/synthetic/project/code-review/SKILL.md', name: 'code-review', description: 'nearest skill description' }]
    const runtime: TerminalRuntime = { close: async () => {}, subscribe: () => () => {}, command: async command => {
        commands.push(command)
        if (command.type === 'create') { snapshot.sessions.push(view); return structuredClone(view) }
        return command.type === 'snapshot' ? structuredClone(command.sessionId ? view : snapshot) : {}
    } }
    const app = render(<TerminalApp runtime={runtime} />)
    try {
        await expect.poll(() => commands.filter(command => command.type === 'create').length).toBe(1)
        await expect.poll(() => app.lastFrame()).toContain('新的主会话')
        expect(app.lastFrame()).not.toContain('不应自动选择的子会话')
        app.stdin.write('/co')
        await expect.poll(() => app.lastFrame()).toContain('/config')
        expect(app.lastFrame()?.split('/code-review')).toHaveLength(2)
        expect(app.lastFrame()).toContain('nearest skill description'); expect(app.lastFrame()).not.toContain('older skill description')
        app.stdin.write('\t')
        await expect.poll(() => app.lastFrame()).toContain('/config')
        app.stdin.write('\r')
        await expect.poll(() => app.lastFrame()).toContain('全局工具权限')
    } finally { app.unmount() }
})

it('completes a Skill identity and reads persisted observability without creating another Agent', async () => {
    const commands: RuntimeCommand[] = []
    let listener: ((event: RuntimeEvent) => void) | undefined, running = false
    const view: SessionView = { id: 'observed', title: '观测任务', workspace: '/synthetic', status: 'idle', updatedAt: '2026-01-01', resumeAvailable: false,
        messages: [], events: [], pendingMessages: [], skills: { skills: [{ id: 'root/review', root: 'root', directory: 'review', name: 'review', description: 'Review source', path: '/synthetic/skills/review/SKILL.md' }], issues: [] },
        guidance: [], approvals: [], backgroundTasks: [], toolStates: [], memory: { enabled: false, processing: false, content: '', summaries: 0 } }
    const snapshot: RuntimeSnapshot = { configurationRevision: 'fixture', config: publicConfig(defaultConfig('/synthetic')), sessions: [view] }
    const runtime: TerminalRuntime = { close: async () => {}, subscribe: callback => { listener = callback; return () => { listener = undefined } }, command: async command => {
        commands.push(command)
        return command.type === 'snapshot' ? structuredClone(command.sessionId ? view : snapshot) : command.type === 'observability' ? {
            runs: [{ runId: 'run-one', status: running ? 'running' : 'success', durationMs: 50, modelCalls: 1, toolCalls: 0, toolErrors: 0, usage: {}, models: [], tools: [], pendingModels: running ? [{ index: 1, timestampMs: 0 }] : [], pendingTools: [], errors: [] }], recoveries: [], evaluations: [], totalRuns: 1
        } : {}
    } }
    const app = render(<TerminalApp runtime={runtime} initialSessionId={view.id}/>)
    try {
        await expect.poll(() => app.lastFrame()).toContain('观测任务')
        app.stdin.write('$re'); app.stdin.write('\t')
        await expect.poll(() => app.lastFrame()).toContain('$root/review')
        app.stdin.write('review source'); app.stdin.write('\r')
        await expect.poll(() => commands.find(command => command.type === 'submit')).toMatchObject({ prompt: '$root/review review source' })
        app.stdin.write('/observability'); app.stdin.write('\r')
        await expect.poll(() => app.lastFrame()).toContain('run-one')
        expect(app.lastFrame()).toContain('Tokens 未报告')
        running = true; view.eventSequence = 1
        listener?.({ version: 1, sessionId: view.id, sequence: 1, timestamp: '2026-01-01T00:00:00Z', type: 'observability', data: { type: 'model-start' } })
        await expect.poll(() => app.lastFrame()).toContain('模型 #1 · 运行中')
        running = false; view.eventSequence = 2
        listener?.({ version: 1, sessionId: view.id, sequence: 2, timestamp: '2026-01-01T00:00:01Z', type: 'observability', data: { type: 'run-end' } })
        await expect.poll(() => app.lastFrame()).not.toContain('模型 #1 · 运行中')
        expect(commands.some(command => command.type === 'observability' && command.action === 'summary' && command.sessionId === view.id)).toBe(true)
        expect(commands.some(command => command.type === 'create')).toBe(false)
    } finally { app.unmount() }
})
