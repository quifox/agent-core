// @vitest-environment jsdom
import { afterEach, expect, it, vi } from 'vitest'
import { act, cleanup, fireEvent, render, screen, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { defaultConfig, publicConfig, type EngineFrame, type InputRoutingReceipt, type RuntimeCommand, type RuntimeEvent, type RuntimeSnapshot, type SessionView } from '@quifox/shared-runtime'
import { App } from '../src/app.js'
import { DesktopEngine } from '../src/engine.js'
import { nativeViews } from '../src/native-views.js'
import { Settings } from '../src/settings.js'

vi.mock('../src/native-views.js', () => ({ nativeViews: { chooseDirectory: vi.fn(), asset: async () => 'asset://synthetic', external: async () => {} } }))

afterEach(() => { cleanup(); vi.restoreAllMocks(); vi.unstubAllGlobals() })

function fixture(observation = false) {
    vi.mocked(nativeViews.chooseDirectory).mockReset().mockResolvedValue(null)
    vi.stubGlobal('ResizeObserver', class { observe() {} unobserve() {} disconnect() {} })
    Object.defineProperty(Element.prototype, 'scrollIntoView', { configurable: true, value: vi.fn() })
    Object.defineProperty(Element.prototype, 'scrollTo', { configurable: true, value: vi.fn() })
    Object.defineProperty(HTMLDialogElement.prototype, 'showModal', { configurable: true, value: function (this: HTMLDialogElement) { this.open = true } })
    Object.defineProperty(HTMLDialogElement.prototype, 'close', { configurable: true, value: function (this: HTMLDialogElement) { this.open = false } })
    const commands: RuntimeCommand[] = [], config = defaultConfig('/synthetic')
    config.model.baseUrl = 'https://synthetic.test/?token=synthetic-hidden'
    const session: SessionView = { id: 'session', title: 'New session', workspace: '/synthetic', status: 'idle', updatedAt: '2026-01-01', resumeAvailable: false,
        messages: [], events: [], pendingMessages: [], approvals: [], toolStates: [], backgroundTasks: [], guidance: [], skills: { skills: [], issues: [] },
        memory: { enabled: true, processing: false, content: '', summaries: 0 } }
    const snapshot: RuntimeSnapshot = { configurationRevision: 'fixture', config: publicConfig(config), sessions: [] }
    const projectConfig = structuredClone(snapshot.config)
    let receive!: (frame: EngineFrame) => void, failSubmit = true, failCreateOnce = false, failMcpConnect = false, holdConfig = false, holdRead = false
    let mcpStatus: { id: string; enabled: boolean; globalEnabled?: boolean; transport: string; source: 'global' | 'project'; status: string; toolCount: number }[] = []
    let pendingConfig = '', pendingRead = '', pendingCreation = '', holdCreation = false, delayedSession: string | undefined
    const pendingSessionSnapshots: string[] = []
    let routingReceipt: InputRoutingReceipt | undefined, failCatalogRefresh = false
    let rejectDirectory = false
    let holdProjectResources = false, pendingResources = ''
    let holdAutoResources = false, pendingAutoResources = ''
    const pickWorkspace = vi.mocked(nativeViews.chooseDirectory)
    const engine = new DesktopEngine({ start: async callback => { receive = callback; callback({ kind: 'ready', protocol: 1 }) }, write: async ({ id, command }) => {
        commands.push(command)
        if (command.type === 'resources' && command.workspace === null && holdAutoResources) { pendingAutoResources = id; return }
        if (observation && command.type === 'plugins') { receive({ kind: 'response', id, ok: true, value: { scope: 'configuration', plugins: [], marketplace: [], installed: [{ id: 'observability', name: '运行观察', description: 'Observe', enabled: true, globalEnabled: true, source: 'builtin', surface: { kind: 'observability', title: '运行观察' } }] } }); return }
        if (observation && command.type === 'observability') { receive({ kind: 'response', id, ok: true, value: { runs: [], comparison: [], recoveries: [] } }); return }
        if (command.type === 'resources' && command.workspace === '/synthetic/second project' && rejectDirectory) { receive({ kind: 'response', id, ok: false, error: 'Synthetic directory unreadable' }); return }
        if (command.type === 'resources' && command.workspace === '/synthetic/second project' && holdProjectResources && commands.filter(item => item.type === 'resources' && item.workspace === '/synthetic/second project').length > 1) { pendingResources = id; return }
        if (command.type === 'snapshot' && command.sessionId === delayedSession && delayedSession) { pendingSessionSnapshots.push(id); return }
        if (command.type === 'model-catalog' && failCatalogRefresh) { receive({ kind: 'response', id, ok: false, error: 'Synthetic directory unavailable' }); return }
        if (command.type === 'mcp' && command.action === 'connect' && failMcpConnect) { mcpStatus = mcpStatus.map(server => ({ ...server, status: 'error' })); receive({ kind: 'response', id, ok: false, error: 'Synthetic MCP connection failed' }); return }
        if (command.type === 'config' && holdConfig) { pendingConfig = id; return }
        if (command.type === 'config') {
            const patch = command.patch as { preferences?: { uiScale?: number } }
            if (patch.preferences?.uiScale !== undefined) snapshot.config.preferences.uiScale = patch.preferences.uiScale
        }
        if (command.type === 'project' && command.action === 'read' && holdRead) { pendingRead = id; return }
        if (command.type === 'project' && command.action === 'read') { receive({ kind: 'response', id, ok: true, value: { workspace: command.workspace ?? '/synthetic', path: '/synthetic/report.md', relativePath: 'report.md', kind: 'text', bytes: 8, content: '# Report', truncated: false } }); return }
        if (command.type === 'submit' && failSubmit) { receive({ kind: 'response', id, ok: false, error: 'Synthetic rejected admission' }); return }
        if (command.type === 'create') { session.workspace = command.workspace ?? '/synthetic/automatic'; snapshot.sessions = [session] }
        if (command.type === 'create' && holdCreation) { pendingCreation = id; return }
        if (command.type === 'create' && failCreateOnce) { failCreateOnce = false; receive({ kind: 'response', id, ok: false, error: 'Synthetic lost creation acknowledgement' }); return }
        const value = command.type === 'resources' ? { workspace: '/synthetic', skillsEnabled: config.plugins.skills !== false && config.installedPlugins.includes('skills'), skills: { skills: [{ id: 'global/review', name: 'review', description: 'Review source', root: 'global', directory: 'review' }], issues: [] }, agents: { agents: [], issues: [] }, guidance: [], configSources: [], memory: session.memory } : command.type === 'plugins' ? { scope: 'configuration', plugins: [{ id: 'skills' }, { id: 'memory' }], installed: [{ id: 'skills', name: '技能', description: 'Skills', source: 'builtin', enabled: true, globalEnabled: true }, { id: 'memory', name: '记忆', description: 'Memory', source: 'builtin', enabled: true, globalEnabled: true }], marketplace: [] } : command.type === 'memory-file' ? { path: '/synthetic/memory.md', content: '', exists: true } : command.type === 'model-catalog' ? { providers: [{ id: 'deepseek', name: 'DeepSeek', baseUrl: 'https://api.deepseek.com/' }], models: [{ id: 'deepseek-flash', name: 'Flash', reasoning: true }], source: 'models.dev', cached: true } : command.type === 'submit' && routingReceipt ? structuredClone(routingReceipt) : command.type === 'snapshot' ? structuredClone(command.sessionId ? snapshot.sessions.find(item => item.id === command.sessionId) ?? session : snapshot) : command.type === 'create' ? structuredClone(session) : command.type === 'mcp' ? mcpStatus : command.type === 'project' ? { path: '.', entries: [{ name: 'report.md', kind: 'file' }], truncated: false } : { accepted: true }
        receive({ kind: 'response', id, ok: true, value: command.type === 'resources' ? { ...value, workspace: command.workspace ?? '/synthetic', config: command.workspace === '/synthetic/second project' ? projectConfig : snapshot.config } : value })
    } })
    return { engine, commands, snapshot, session, pickWorkspace, projectConfig, publish: (event: RuntimeEvent) => receive({ kind: 'event', event }), rejectDirectory: () => { rejectDirectory = true }, failCatalog: () => { failCatalogRefresh = true }, acceptSubmissions: () => { failSubmit = false }, setRoutingReceipt: (value: InputRoutingReceipt) => { routingReceipt = value }, loseCreationAck: () => { failCreateOnce = true }, failMcp: () => { failMcpConnect = true }, setMcp: (value: typeof mcpStatus) => { mcpStatus = value }, delayConfig: () => { holdConfig = true }, delayRead: () => { holdRead = true },
        finishConfig: () => receive({ kind: 'response', id: pendingConfig, ok: true, value: {} }),
        holdProjectResources: () => { holdProjectResources = true },
        holdAutoResources: () => { holdAutoResources = true },
        finishAutoResources: () => { holdAutoResources = false; receive({ kind: 'response', id: pendingAutoResources, ok: true, value: { workspace: '/synthetic/preview', config: snapshot.config, skillsEnabled: true, skills: { skills: [], issues: [] }, agents: { agents: [], issues: [] }, guidance: [], configSources: [], memory: session.memory } }) },
        finishResources: () => receive({ kind: 'response', id: pendingResources, ok: true, value: { workspace: '/synthetic/second project', config: projectConfig, skillsEnabled: true, skills: { skills: [], issues: [] }, agents: { agents: [], issues: [] }, guidance: [], configSources: [], memory: session.memory } }),
        finishRead: () => receive({ kind: 'response', id: pendingRead, ok: true, value: { path: 'report.md', content: 'OLD WORKSPACE CONTENT', truncated: false } }),
        delayCreation: () => { holdCreation = true }, finishCreation: () => receive({ kind: 'response', id: pendingCreation, ok: true, value: structuredClone(session) }),
        delaySession: (id: string) => { delayedSession = id }, finishSession: () => {
            const value = snapshot.sessions.find(item => item.id === delayedSession); delayedSession = undefined
            for (const id of pendingSessionSnapshots.splice(0)) receive({ kind: 'response', id, ok: true, value: structuredClone(value) })
        } }
}

it('keeps streamed text visible across model-end until its transcript replacement arrives', async () => {
    const user = userEvent.setup(), host = fixture()
    host.snapshot.sessions = [host.session]
    render(<App engine={host.engine}/>); await user.click(await screen.findByRole('button', { name: 'New session' }))
    host.delaySession('session')
    await act(async () => { host.publish({ version: 1, sessionId: 'session', sequence: 1, timestamp: '2026-10-13T00:00:00Z', type: 'agent', data: { type: 'text-delta', delta: 'Visible stream' } }) })
    await screen.findByText('Visible stream')
    await act(async () => { host.publish({ version: 1, sessionId: 'session', sequence: 2, timestamp: '2026-10-13T00:00:01Z', type: 'agent', data: { type: 'model-end' } }) })
    expect(screen.getByText('Visible stream')).toBeDefined()
    host.session.messages = [{ id: 'reply', origin: 'assistant', message: { role: 'assistant', content: 'Visible stream', reasoning: 'Prior reasoning' } }]
    host.session.eventSequence = 2; host.session.liveText = ''
    await act(async () => { host.finishSession() })
    await screen.findByText('思考过程')
    expect(screen.getAllByText('Visible stream')).toHaveLength(1)
    const body = screen.getByText('思考过程').closest('.message-body')!
    expect(body.querySelector('details')!.compareDocumentPosition(body.querySelector('.markdown')!) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy()
})

it('shows queue count, deletion and guidance beside message previews with one pause or resume action', async () => {
    const user = userEvent.setup(), host = fixture()
    host.snapshot.sessions = [host.session]
    host.session.status = 'running'; host.session.pendingMessages = [{ id: 'q1', prompt: 'Queued instruction', mode: 'queue', status: 'pending' }]
    render(<App engine={host.engine}/>); await user.click(await screen.findByRole('button', { name: 'New session' }))
    expect(await screen.findByText('1 条消息排队中')).toBeDefined()
    expect(screen.getByTitle('Queued instruction')).toBeDefined()
    await user.click(screen.getByRole('button', { name: '删除排队消息：Queued instruction' }))
    expect(host.commands).toContainEqual({ type: 'inbox', sessionId: 'session', action: 'cancel', messageId: 'q1' })
    await user.click(screen.getByRole('button', { name: '引导消息：Queued instruction' }))
    expect(host.commands).toContainEqual({ type: 'inbox', sessionId: 'session', action: 'steer', messageId: 'q1' })
    expect(screen.queryByRole('button', { name: /^停止$/ })).toBeNull()
    await user.click(screen.getByRole('button', { name: '暂停执行' }))
    expect(host.commands).toContainEqual({ type: 'stop', sessionId: 'session' })
    host.session.status = 'stopped'; host.session.resumeAvailable = true
    await act(async () => { host.publish({ version: 1, sessionId: 'session', sequence: 1, timestamp: '2026-10-13T00:00:00Z', type: 'session', data: {} }) })
    await user.click(await screen.findByRole('button', { name: '恢复执行' }))
    expect(host.commands).toContainEqual({ type: 'resume', sessionId: 'session', mode: 'replan' })
    expect(screen.queryByRole('button', { name: '重新规划' })).toBeNull()
})

it('keeps sidebar collapse and navigation in the window toolbar outside page content', async () => {
    const user = userEvent.setup(), host = fixture()
    render(<App engine={host.engine}/>); await screen.findByRole('textbox', { name: '给 quifox 的消息' })
    const toolbar = screen.getByRole('banner', { name: '窗口工具栏' })
    expect(screen.getByRole('main').contains(toolbar)).toBe(false)
    expect(within(toolbar).getByRole('button', { name: '后退' })).toBeDefined()
    expect(within(toolbar).getByRole('button', { name: '前进' })).toBeDefined()
    await user.click(within(toolbar).getByRole('button', { name: '折叠会话侧栏' }))
    expect(document.getElementById('session-sidebar')).toHaveProperty('hidden', true)
    await user.click(within(toolbar).getByRole('button', { name: '展开会话侧栏' }))
    await user.click(screen.getByRole('button', { name: '打开设置' }))
    expect(within(toolbar).getByRole('heading', { level: 1 })).toHaveProperty('textContent', '设置')
    await user.click(within(toolbar).getByRole('button', { name: '后退' }))
    expect(screen.getByRole('textbox', { name: '给 quifox 的消息' })).toBeDefined()
})

it('waits for the actual automatic-workspace preview before querying plugins and offers global configuration until a directory is selected', async () => {
    const user = userEvent.setup(), host = fixture(); host.holdAutoResources()
    render(<App engine={host.engine}/>); await user.click(await screen.findByRole('button', { name: '插件' }))
    expect(host.commands.some(command => command.type === 'plugins')).toBe(false)
    await act(async () => host.finishAutoResources())
    await screen.findByRole('button', { name: '查看技能' })
    expect(host.commands).toContainEqual({ type: 'plugins', workspace: '/synthetic/preview' })
    await user.click(screen.getByRole('combobox', { name: '插件启停作用域' }))
    expect(screen.queryByRole('option', { name: '当前工作目录' })).toBeNull()
})

it.each(['success', 'failure'] as const)('does not let a late MCP %s response overwrite the newly selected settings workspace', async outcome => {
    const user = userEvent.setup(), host = fixture()
    const pending = new Map<string, { resolve(value: unknown): void; reject(error: Error): void }>()
    const command = async (input: RuntimeCommand): Promise<unknown> => {
        if (input.type === 'mcp') return new Promise((resolve, reject) => pending.set(input.workspace!, { resolve, reject }))
        if (input.type === 'model-catalog') return { providers: [], models: [], source: 'models.dev', cached: true }
        return { workspace: input.type === 'resources' ? input.workspace : '/synthetic', config: host.snapshot.config, skillsEnabled: true, skills: { skills: [], issues: [] }, agents: { agents: [], issues: [] }, guidance: [], configSources: [], memory: host.session.memory }
    }
    const props = { config: host.snapshot.config, close() {}, save: async () => {}, command }
    const mounted = render(<Settings {...props} workspace="/synthetic/old"/>)
    await user.click(screen.getByRole('button', { name: 'MCP' }))
    await expect.poll(() => pending.has('/synthetic/old')).toBe(true)
    mounted.rerender(<Settings {...props} workspace="/synthetic/new"/>)
    await expect.poll(() => pending.has('/synthetic/new')).toBe(true)
    const server = { id: 'new-server', transport: 'http', enabled: true, globalEnabled: true, status: 'connected', toolCount: 1, source: 'global' }
    await act(async () => pending.get('/synthetic/new')!.resolve([server]))
    await screen.findByText('new-server', { selector: 'strong' })
    await act(async () => { if (outcome === 'success') pending.get('/synthetic/old')!.resolve([{ ...server, id: 'old-server' }]); else pending.get('/synthetic/old')!.reject(new Error('Old workspace failed')) })
    expect(screen.getByText('new-server', { selector: 'strong' })).toBeDefined()
    expect(screen.queryByText('old-server', { selector: 'strong' })).toBeNull()
    expect(screen.queryByText('MCP 状态读取失败。')).toBeNull()
})

it('opens settings from an expanded workspace and restores its tabs when going back', async () => {
    const user = userEvent.setup(), host = fixture()
    render(<App engine={host.engine}/>); await user.click(await screen.findByRole('button', { name: '打开工作区' }))
    await user.click(await screen.findByRole('treeitem', { name: 'report.md' }))
    await screen.findByRole('tab', { name: 'report.md' })
    await user.click(screen.getByRole('button', { name: '放大工作区' }))
    await user.click(screen.getByRole('button', { name: '打开设置' }))
    expect(screen.getByRole('heading', { name: '模型', level: 3 })).toBeDefined()
    expect(screen.queryByRole('button', { name: '还原工作区' })).toBeNull()
    await user.click(screen.getByRole('button', { name: '后退' }))
    expect(screen.getByRole('tab', { name: 'report.md' }).getAttribute('aria-selected')).toBe('true')
    expect(screen.getByRole('button', { name: '还原工作区' })).toBeDefined()
})

it('navigates backward and forward across pages while preserving the chat draft and clearing forward history on a new branch', async () => {
    const user = userEvent.setup(), host = fixture()
    render(<App engine={host.engine}/>); const input = await screen.findByRole('textbox', { name: '给 quifox 的消息' })
    await user.type(input, 'preserve navigation draft')
    expect(screen.getByRole('button', { name: '后退' })).toHaveProperty('disabled', true)
    await user.click(screen.getByRole('button', { name: '插件' }))
    await screen.findByRole('button', { name: '查看技能' })
    await user.click(screen.getByRole('button', { name: '插件' }))
    await user.click(screen.getByRole('button', { name: '打开设置' }))
    expect(screen.getByRole('heading', { level: 1 })).toHaveProperty('textContent', '设置')
    await user.click(screen.getByRole('button', { name: '后退' }))
    expect(screen.getByRole('heading', { level: 1 })).toHaveProperty('textContent', '插件')
    await user.click(screen.getByRole('button', { name: '后退' }))
    expect(screen.getByRole('textbox', { name: '给 quifox 的消息' })).toHaveProperty('value', 'preserve navigation draft')
    await user.click(screen.getByRole('button', { name: '前进' }))
    expect(screen.getByRole('heading', { level: 1 })).toHaveProperty('textContent', '插件')
    await user.click(screen.getByRole('button', { name: 'QuiFox' }))
    expect(screen.getByRole('button', { name: '前进' })).toHaveProperty('disabled', true)
    expect(host.commands.some(command => ['create', 'submit', 'stop', 'config'].includes(command.type))).toBe(false)
})

it('restores the selected observation and its filter across page unmounts without changing the original chat draft', async () => {
    const user = userEvent.setup(), host = fixture(true); host.snapshot.sessions = [host.session]
    render(<App engine={host.engine}/>); await user.type(await screen.findByRole('textbox', { name: '给 quifox 的消息' }), 'original chat draft')
    await user.click(screen.getByRole('button', { name: '插件' }))
    await user.click(await screen.findByRole('button', { name: '查看运行观察' }))
    await user.type(screen.getByRole('textbox', { name: '筛选观察会话' }), 'New')
    await user.click(screen.getByRole('button', { name: '观察New session' }))
    await screen.findByRole('region', { name: '暂无运行记录' })
    await user.click(screen.getByRole('button', { name: '打开设置' }))
    await user.click(screen.getByRole('button', { name: '后退' }))
    await screen.findByRole('region', { name: '暂无运行记录' })
    expect(screen.getByText('New session', { selector: '.observation-target strong' })).toBeDefined()
    await user.click(screen.getByRole('button', { name: '后退' }))
    expect(screen.getByRole('textbox', { name: '筛选观察会话' })).toHaveProperty('value', 'New')
    await expect.poll(() => document.activeElement).toBe(screen.getByRole('button', { name: '观察New session' }))
    await user.click(screen.getByRole('button', { name: '前进' })); await screen.findByRole('region', { name: '暂无运行记录' })
    await user.click(screen.getByRole('button', { name: '后退' }))
    await user.click(screen.getByRole('button', { name: '后退' })); await screen.findByRole('button', { name: '查看运行观察' })
    await user.click(screen.getByRole('button', { name: '后退' }))
    expect(screen.getByRole('textbox', { name: '给 quifox 的消息' })).toHaveProperty('value', 'original chat draft')
    expect(host.commands.some(command => ['create', 'submit', 'stop', 'config'].includes(command.type))).toBe(false)
})

it('restores conversation identities and their own drafts when navigating backward and forward', async () => {
    const user = userEvent.setup(), host = fixture()
    host.snapshot.sessions = [host.session, { ...host.session, id: 'other-session', title: '另一个会话', workspace: '/synthetic/second project' }]
    render(<App engine={host.engine}/>); await user.click(await screen.findByRole('button', { name: 'New session' }))
    await user.type(screen.getByRole('textbox', { name: '给 quifox 的消息' }), 'first session draft')
    await user.click(screen.getByRole('button', { name: '另一个会话' }))
    await user.type(screen.getByRole('textbox', { name: '给 quifox 的消息' }), 'other session draft')
    await user.click(screen.getByRole('button', { name: '后退' }))
    await screen.findByRole('heading', { name: 'New session', level: 1 })
    expect(screen.getByRole('textbox', { name: '给 quifox 的消息' })).toHaveProperty('value', 'first session draft')
    await user.click(screen.getByRole('button', { name: '前进' }))
    await screen.findByRole('heading', { name: '另一个会话', level: 1 })
    expect(screen.getByRole('textbox', { name: '给 quifox 的消息' })).toHaveProperty('value', 'other session draft')
    expect(host.commands.some(command => ['create', 'submit', 'stop', 'config'].includes(command.type))).toBe(false)
})

it('opens a folder without a new Host or model call and uses it for the next conversation', async () => {
    const user = userEvent.setup(), host = fixture(); host.acceptSubmissions(); host.pickWorkspace.mockResolvedValue('/synthetic/second project')
    render(<App engine={host.engine}/>); const input = await screen.findByRole('textbox', { name: '给 quifox 的消息' })
    await user.type(input, 'preserve project draft')
    await user.click(screen.getByRole('button', { name: '选择工作目录' }))
    await expect.poll(() => screen.getByRole('button', { name: '选择工作目录' }).textContent).toContain('second project')
    expect(input).toHaveProperty('value', 'preserve project draft')
    expect(host.commands.filter(command => ['create', 'submit', 'config'].includes(command.type))).toEqual([])
    await user.click(screen.getByRole('button', { name: '发送消息' }))
    await expect.poll(() => host.commands.some(command => command.type === 'submit')).toBe(true)
    expect(host.commands.find(command => command.type === 'create')).toMatchObject({ workspace: '/synthetic/second project' })
})

it('keeps the selected project and draft when the directory picker is cancelled', async () => {
    const user = userEvent.setup(), host = fixture(); host.pickWorkspace.mockResolvedValueOnce('/synthetic/second project')
    render(<App engine={host.engine}/>); await user.click(await screen.findByRole('button', { name: '选择工作目录' }))
    await user.type(screen.getByRole('textbox', { name: '给 quifox 的消息' }), 'existing session draft')
    await user.click(screen.getByRole('button', { name: '选择工作目录' }))
    await expect.poll(() => host.pickWorkspace.mock.calls.length).toBe(2)
    expect(screen.getByRole('button', { name: '选择工作目录' }).textContent).toContain('second project')
    expect(screen.getByRole('textbox', { name: '给 quifox 的消息' })).toHaveProperty('value', 'existing session draft')
    expect(host.commands.filter(command => command.type === 'create')).toEqual([])
})

it('requests a dated workspace only on the first message when no directory was selected', async () => {
    const user = userEvent.setup(), host = fixture(); host.acceptSubmissions()
    render(<App engine={host.engine}/>); await user.type(await screen.findByRole('textbox', { name: '给 quifox 的消息' }), 'Start work')
    expect(host.commands.some(command => command.type === 'create')).toBe(false)
    await user.click(screen.getByRole('button', { name: '发送消息' }))
    await expect.poll(() => host.commands.some(command => command.type === 'submit')).toBe(true)
    expect(host.commands.find(command => command.type === 'create')).toMatchObject({ workspace: null })
})

it('keeps the blank chat and its draft when the native directory picker fails', async () => {
    const user = userEvent.setup(), host = fixture(); host.pickWorkspace.mockRejectedValue(new Error('Synthetic picker unavailable'))
    render(<App engine={host.engine}/>); await screen.findByRole('button', { name: '选择工作目录' })
    await user.type(screen.getByRole('textbox', { name: '给 quifox 的消息' }), 'preserve after failure')
    await user.click(screen.getByRole('button', { name: '选择工作目录' })); await screen.findByRole('alert')
    expect(screen.getByRole('heading', { level: 1 })).toHaveProperty('textContent', '新的会话')
    expect(screen.getByRole('textbox', { name: '给 quifox 的消息' })).toHaveProperty('value', 'preserve after failure')
    expect(host.commands.some(command => command.type === 'create')).toBe(false)
})

it('shows project model defaults and queries plugins for the selected folder before any conversation exists', async () => {
    const user = userEvent.setup(), host = fixture(); host.pickWorkspace.mockResolvedValue('/synthetic/second project')
    host.projectConfig.model.model = 'project-model'; host.projectConfig.model.reasoningEfforts = ['high', 'max']; host.projectConfig.preferences.reasoningEffort = 'max'
    render(<App engine={host.engine}/>); await user.click(await screen.findByRole('button', { name: '选择工作目录' }))
    await expect.poll(() => screen.getByRole('combobox', { name: '当前会话模型' }).textContent).toContain('project-model')
    expect(screen.getByRole('combobox', { name: '思考强度' }).textContent).toBe('max')
    await user.click(screen.getByRole('button', { name: '插件' })); await screen.findByRole('button', { name: '查看技能' })
    expect(host.commands).toContainEqual({ type: 'plugins', workspace: '/synthetic/second project' })
    expect(host.commands.some(command => command.type === 'create' || command.type === 'submit')).toBe(false)
})

it('keeps the previous directory and draft when the selected folder cannot be validated', async () => {
    const user = userEvent.setup(), host = fixture(); host.rejectDirectory(); host.pickWorkspace.mockResolvedValue('/synthetic/second project')
    render(<App engine={host.engine}/>); await screen.findByRole('button', { name: '选择工作目录' })
    await user.type(screen.getByRole('textbox', { name: '给 quifox 的消息' }), 'keep invalid directory draft')
    await user.click(screen.getByRole('button', { name: '选择工作目录' })); await screen.findByRole('alert')
    expect(screen.getByRole('button', { name: '选择工作目录' }).textContent).toContain('按日期创建')
    expect(screen.getByRole('textbox', { name: '给 quifox 的消息' })).toHaveProperty('value', 'keep invalid directory draft')
    expect(host.commands.some(command => command.type === 'create')).toBe(false)
})

it('waits for the new project projection before allowing overrides or an Enter submission', async () => {
    const user = userEvent.setup(), host = fixture(); host.holdProjectResources(); host.pickWorkspace.mockResolvedValue('/synthetic/second project')
    host.projectConfig.model.model = 'new-project-model'; host.projectConfig.model.reasoningEfforts = ['max']
    render(<App engine={host.engine}/>); await screen.findByRole('button', { name: '选择工作目录' })
    await user.type(screen.getByRole('textbox', { name: '给 quifox 的消息' }), 'preserve while loading')
    await user.click(screen.getByRole('button', { name: '选择工作目录' })); await expect.poll(() => screen.getByRole('button', { name: '选择工作目录' }).textContent).toContain('second project')
    expect(screen.getByRole('combobox', { name: '当前会话模型' })).toHaveProperty('disabled', true)
    expect(screen.queryByRole('combobox', { name: '思考强度' })).toBeNull()
    expect(screen.getByRole('combobox', { name: '当前会话权限' })).toHaveProperty('disabled', true)
    await user.click(screen.getByRole('textbox', { name: '给 quifox 的消息' })); await user.keyboard('{Enter}')
    expect(host.commands.some(command => command.type === 'create' || command.type === 'submit')).toBe(false)
    expect(screen.getByRole('textbox', { name: '给 quifox 的消息' })).toHaveProperty('value', 'preserve while loading')
    await act(async () => host.finishResources())
    await expect.poll(() => screen.getByRole('combobox', { name: '当前会话模型' }).textContent).toContain('new-project-model')
    expect(screen.getByRole('combobox', { name: '当前会话模型' })).toHaveProperty('disabled', false)
})

it('starts a blank conversation from history without a creation dialog or a saved empty session', async () => {
    const user = userEvent.setup(), host = fixture()
    host.session.title = 'Previous task'; host.snapshot.sessions = [host.session]
    host.session.messages = [{ id: 'before', origin: 'human', message: { role: 'user', content: 'Previous message' } }]
    render(<App engine={host.engine}/>)
    await user.click(await screen.findByRole('button', { name: 'Previous task' }))
    await screen.findByText('Previous message')
    await user.type(screen.getByRole('textbox', { name: '给 quifox 的消息' }), 'Keep previous draft')
    await user.click(screen.getByRole('button', { name: /新建会话/ }))
    expect(screen.queryByRole('dialog')).toBeNull()
    expect(await screen.findByRole('heading', { name: '新的会话' })).toBeDefined()
    const input = screen.getByRole('textbox', { name: '给 quifox 的消息' })
    expect(input).toHaveProperty('value', ''); expect(document.activeElement).toBe(input)
    expect(screen.queryByText('Previous message')).toBeNull()
    expect(host.commands.some(command => command.type === 'create')).toBe(false)
    await user.type(input, 'Discard this blank draft'); await user.keyboard('{Meta>}n{/Meta}')
    expect(input).toHaveProperty('value', ''); expect(screen.queryByRole('dialog')).toBeNull()
    await user.click(screen.getByRole('button', { name: 'Previous task' }))
    expect(await screen.findByRole('textbox', { name: '给 quifox 的消息' })).toHaveProperty('value', 'Keep previous draft')
})

it('selects the first-message working directory through the native picker and preserves a cancelled choice', async () => {
    const user = userEvent.setup(), host = fixture(); host.acceptSubmissions()
    render(<App engine={host.engine}/>)
    const picker = await screen.findByRole('button', { name: '选择工作目录' })
    const input = screen.getByRole('textbox', { name: '给 quifox 的消息' })
    await user.type(input, 'Keep directory draft'); await user.click(picker)
    expect(picker.textContent).toContain('按日期创建'); expect(input).toHaveProperty('value', 'Keep directory draft')
    expect(screen.queryByRole('textbox', { name: '工作目录' })).toBeNull()
    expect(host.commands.some(command => command.type === 'create')).toBe(false)
    vi.mocked(nativeViews.chooseDirectory).mockResolvedValueOnce('/synthetic/chosen')
    await user.click(picker)
    expect(picker.textContent).toContain('chosen'); expect(document.activeElement).toBe(input)
    expect(nativeViews.chooseDirectory).toHaveBeenCalledWith('/synthetic', '选择工作目录')
    await user.click(screen.getByRole('button', { name: '发送消息' }))
    await expect.poll(() => host.commands.some(command => command.type === 'submit')).toBe(true)
    expect(host.commands.find(command => command.type === 'create')).toMatchObject({ workspace: '/synthetic/chosen' })
    expect(screen.queryByRole('button', { name: '选择工作目录' })).toBeNull()
    expect(screen.getByLabelText('会话工作目录').textContent).toContain('chosen')
})

it('hides the reasoning control when no supported effort levels are configured', async () => {
    const host = fixture()
    render(<App engine={host.engine}/>)
    await expect.poll(() => screen.queryAllByText('deepseek-flash').length).toBeGreaterThan(0)
    expect(screen.queryByRole('combobox', { name: '思考强度' })).toBeNull()
    expect(screen.queryByText('思考档位未配置')).toBeNull()
    expect(screen.queryByText('Enter 发送 · Shift Enter 换行')).toBeNull()
})

it('keeps edits made while the first-message session creation is awaiting acknowledgement', async () => {
    const user = userEvent.setup(), host = fixture(); host.acceptSubmissions(); host.delayCreation()
    render(<App engine={host.engine}/>)
    await expect.poll(() => screen.queryAllByText('deepseek-flash').length).toBeGreaterThan(0)
    const input = screen.getByRole('textbox', { name: '给 quifox 的消息' })
    await user.type(input, 'Original message'); await user.click(screen.getByRole('button', { name: '发送消息' }))
    await expect.poll(() => host.commands.some(command => command.type === 'create')).toBe(true)
    await user.clear(input); await user.type(input, 'Edited draft'); host.finishCreation()
    await expect.poll(() => host.commands.some(command => command.type === 'submit')).toBe(true)
    expect(host.commands.find(command => command.type === 'submit')).toMatchObject({ prompt: 'Original message' })
    await expect.poll(() => (input as HTMLTextAreaElement).value).toBe('Edited draft')
})

it('cannot apply old reasoning settings while the newly selected conversation is still loading', async () => {
    const user = userEvent.setup(), host = fixture()
    host.snapshot.config.model.reasoningEfforts = ['high', 'max']
    host.session.title = 'Thinking task'
    host.session.defaultModel = structuredClone(host.snapshot.config.model)
    const other: SessionView = { ...structuredClone(host.session), id: 'other', title: 'Plain task', defaultModel: { ...host.snapshot.config.model, reasoningEfforts: [] } }
    host.snapshot.sessions = [host.session, other]; host.delaySession(other.id)
    render(<App engine={host.engine}/>)
    await user.click(await screen.findByRole('button', { name: 'Thinking task' }))
    await screen.findByRole('combobox', { name: '思考强度' })
    await user.click(screen.getByRole('button', { name: 'Plain task' }))
    await expect.poll(() => host.commands.some(command => command.type === 'snapshot' && command.sessionId === other.id)).toBe(true)
    expect(screen.queryByRole('combobox', { name: '思考强度' })).toBeNull()
    expect(screen.getByRole('button', { name: '发送消息' })).toHaveProperty('disabled', true)
    host.finishSession(); await screen.findByRole('heading', { name: 'Plain task' })
    expect(screen.queryByRole('combobox', { name: '思考强度' })).toBeNull()
    expect(host.commands.some(command => command.type === 'session-config')).toBe(false)
})

it('retries an uncertain creation with the original identity and draft', async () => {
    const user = userEvent.setup(), host = fixture(); host.loseCreationAck(); host.acceptSubmissions()
    render(<App engine={host.engine}/>); await expect.poll(() => screen.queryAllByText('deepseek-flash').length).toBeGreaterThan(0)
    const input = screen.getByRole('textbox', { name: '给 quifox 的消息' }) as HTMLTextAreaElement
    await user.type(input, 'preserve uncertain creation'); await user.click(screen.getByRole('button', { name: '发送消息' }))
    await screen.findByRole('alert'); expect(input.value).toBe('preserve uncertain creation')
    await user.click(screen.getByRole('button', { name: '发送消息' })); await expect.poll(() => input.value).toBe('')
    const creations = host.commands.filter(command => command.type === 'create')
    expect(creations).toHaveLength(2); expect(creations[0]).toMatchObject({ workspace: null }); expect(creations[0]?.sessionId).toBeTruthy(); expect(creations[1]?.sessionId).toBe(creations[0]?.sessionId)
    expect(host.commands.filter(command => command.type === 'submit')).toHaveLength(1)
})

it('collapses either navigation without losing drafts and restores focus after closing a profile editor', async () => {
    const user = userEvent.setup(), host = fixture()
    render(<App engine={host.engine}/>); const input = await screen.findByRole('textbox', { name: '给 quifox 的消息' })
    await user.type(input, 'keep this draft')
    expect(screen.queryByRole('region', { name: '工作区' })).toBeNull()
    await user.click(screen.getByRole('button', { name: '打开工作区' }))
    expect(screen.getByRole('region', { name: '工作区' })).toBeDefined()
    await user.click(screen.getByRole('button', { name: '收起工作区' }))
    expect(input).toHaveProperty('value', 'keep this draft')
    await user.click(screen.getByRole('button', { name: '折叠会话侧栏' }))
    expect(screen.queryByRole('complementary', { name: '工作目录与会话' })).toBeNull()
    expect(screen.getByRole('button', { name: '展开会话侧栏' }).getAttribute('aria-expanded')).toBe('false')
    await user.click(screen.getByRole('button', { name: '展开会话侧栏' }))
    await user.click(screen.getByRole('button', { name: '打开设置' }))
    const editor = screen.getByRole('button', { name: '编辑默认连接' })
    await user.click(editor); await user.keyboard('{Escape}')
    expect(document.activeElement).toBe(editor)
    expect(screen.queryByRole('dialog')).toBeNull()
    await user.click(screen.getByRole('button', { name: '折叠设置导航' }))
    expect(screen.queryByRole('complementary', { name: '设置分类' })).toBeNull()
    await user.click(screen.getByRole('button', { name: '展开设置导航' }))
    await user.click(screen.getByRole('button', { name: '上下文' }))
    expect(screen.getByRole('spinbutton', { name: '安全余量' })).toHaveProperty('value', '10240')
    expect(screen.queryByRole('button', { name: '预算规则' })).toBeNull()
    await user.click(screen.getByRole('button', { name: '后退' }))
    expect(screen.getByRole('textbox', { name: '给 quifox 的消息' })).toHaveProperty('value', 'keep this draft')
})

it('places session access in the composer and keeps global default access in settings', async () => {
    const user = userEvent.setup(), host = fixture(); host.acceptSubmissions()
    render(<App engine={host.engine}/>); const picker = await screen.findByRole('combobox', { name: '当前会话权限' })
    await user.click(picker); await user.click(screen.getByRole('option', { name: '完全访问' }))
    await user.type(screen.getByRole('textbox', { name: '给 quifox 的消息' }), 'start with access')
    await user.click(screen.getByRole('button', { name: '发送消息' }))
    await expect.poll(() => host.commands.some(command => command.type === 'submit')).toBe(true)
    expect(host.commands.find(command => command.type === 'create')).toMatchObject({ approvalMode: 'allow' })
    await user.click(screen.getByRole('combobox', { name: '当前会话权限' })); await user.click(screen.getByRole('option', { name: '逐次询问' }))
    await expect.poll(() => host.commands.some(command => command.type === 'session-config')).toBe(true)
    expect(host.commands.find(command => command.type === 'session-config')).toMatchObject({ sessionId: 'session', approvalMode: 'ask' })
    await user.click(screen.getByRole('button', { name: '打开设置' })); await user.click(screen.getByRole('button', { name: '权限' }))
    expect(screen.getByRole('combobox', { name: '新会话默认权限' })).toBeDefined()
    expect(document.body.textContent).not.toContain('当前会话：')
    expect(document.body.textContent).not.toContain('全局授权')
})

it('completes a named recipient and keeps partially admitted routing input for an idempotent retry', async () => {
    const user = userEvent.setup(), host = fixture(); host.acceptSubmissions()
    host.session.title = '控制者'
    const child = { ...structuredClone(host.session), id: 'named-child', parentId: host.session.id, taskId: 'named-task', name: 'Turing', title: 'Agent Turing' }
    host.snapshot.sessions = [host.session, child]
    const agent = { sessionId: child.id, taskId: child.taskId, name: child.name, status: 'idle' as const }
    host.setRoutingReceipt({ kind: 'dispatch', accepted: false, deliveries: [{ agent, status: 'error', error: 'Synthetic rejected child admission' }] })
    render(<App engine={host.engine}/>); await user.click(await screen.findByRole('button', { name: /控制者/ }))
    const input = screen.getByRole('textbox', { name: '给 quifox 的消息' }) as HTMLTextAreaElement
    await user.type(input, '@Tu'); await screen.findByRole('option', { name: /Turing/ }); await user.keyboard('{Tab}')
    expect(input.value).toBe('@Turing ')
    await user.type(input, 'review the source'); await user.click(screen.getByRole('button', { name: '发送消息' }))
    await screen.findByRole('alert'); expect(input.value).toBe('@Turing review the source')
    host.setRoutingReceipt({ kind: 'dispatch', accepted: true, deliveries: [{ agent, status: 'queued' }] })
    await user.click(screen.getByRole('button', { name: '发送消息' })); await expect.poll(() => input.value).toBe('')
    const submitted = host.commands.filter(command => command.type === 'submit')
    expect(submitted).toHaveLength(2); expect(submitted[0]?.messageId).toBe(submitted[1]?.messageId)
    expect(submitted[0]).toMatchObject({ prompt: '@Turing review the source' })
    expect(screen.getByRole('button', { name: '打开 Agent Turing' })).toBeDefined()
})

it('does not offer global removal for a project MCP definition sharing the global identity', async () => {
    const user = userEvent.setup(), host = fixture()
    host.snapshot.config.mcp = [{ id: 'shared', enabled: true, transport: 'http', url: 'http://synthetic.test', argCount: 0, envKeys: [], headerNames: [] }]
    host.setMcp([{ id: 'shared', enabled: true, transport: 'http', source: 'project', status: 'untrusted', toolCount: 0 }])
    render(<App engine={host.engine}/>); await user.click(await screen.findByRole('button', { name: '打开设置' }))
    await user.click(screen.getByRole('button', { name: 'MCP' }))
    expect(await screen.findByRole('button', { name: '来自项目配置文件' })).toHaveProperty('disabled', true)
    expect(screen.queryByRole('button', { name: '移除全局配置' })).toBeNull()
    expect(host.commands.some(command => command.type === 'config')).toBe(false)
})

it('refreshes MCP status after a rejected connection while preserving the editable configuration', async () => {
    const user = userEvent.setup(), host = fixture(); host.failMcp()
    host.setMcp([{ id: 'local', enabled: true, globalEnabled: true, transport: 'stdio', source: 'global', status: 'disconnected', toolCount: 0 }])
    render(<App engine={host.engine}/>); await user.click(await screen.findByRole('button', { name: '打开设置' })); await user.click(screen.getByRole('button', { name: 'MCP' }))
    await user.click(await screen.findByRole('button', { name: '连接 / 重试' }))
    await screen.findByRole('alert'); await screen.findByText(/error · 0 个工具/)
    await screen.findByText('连接失败；请检查服务配置和运行状态，然后重试。')
    await user.click(screen.getByRole('button', { name: '＋ 添加 MCP' }))
    expect(screen.getByRole('textbox', { name: '名称' })).toHaveProperty('disabled', false)
    expect(screen.getByRole('button', { name: '连接 / 重试' })).toHaveProperty('disabled', false)
})

it('keeps the new session draft visible after rejected admission and clears it only after successful retry', async () => {
    const user = userEvent.setup(), host = fixture()
    render(<App engine={host.engine}/>); await expect.poll(() => screen.queryAllByText('deepseek-flash').length).toBeGreaterThan(0)
    const input = screen.getByRole('textbox', { name: '给 quifox 的消息' }) as HTMLTextAreaElement
    await user.type(input, 'preserve this draft'); await user.click(screen.getByRole('button', { name: '发送消息' }))
    await screen.findByRole('alert'); expect(input.value).toBe('preserve this draft')
    expect(host.commands.filter(command => command.type === 'create')).toHaveLength(1)
    host.acceptSubmissions(); await user.click(screen.getByRole('button', { name: '发送消息' }))
    await expect.poll(() => input.value).toBe('')
    expect(host.commands.filter(command => command.type === 'create')).toHaveLength(1)
    const inputs = host.commands.filter(command => command.type === 'submit')
    expect(inputs[0]?.messageId).toBe(inputs[1]?.messageId)
})

it('opens a fresh conversation instead of silently restoring history and renders Markdown after explicit selection', async () => {
    const user = userEvent.setup(), host = fixture()
    host.session.title = '历史任务'
    host.session.messages = [{ id: 'reply', origin: 'assistant', message: { role: 'assistant', content: '# 已验证结果\n\n```ts\nconst value = 1\n```\n\n- 第一项\n- 第二项' } }]
    host.snapshot.sessions = [host.session]
    render(<App engine={host.engine}/>)
    await screen.findByRole('button', { name: /历史任务/ })
    expect(screen.queryByRole('heading', { name: '已验证结果' })).toBeNull()
    await user.click(screen.getByRole('button', { name: /历史任务/ }))
    await screen.findByRole('heading', { name: '已验证结果' })
    expect(screen.getByText('const value = 1').tagName).toBe('CODE')
    expect(screen.getAllByRole('listitem')).toHaveLength(2)
    expect(screen.queryByRole('button', { name: 'Queue' })).toBeNull()
})

it('saves settings in the main pane without overwriting a hidden Base URL', async () => {
    const user = userEvent.setup(), host = fixture()
    render(<App engine={host.engine}/>); await expect.poll(() => screen.queryAllByText('deepseek-flash').length).toBeGreaterThan(0)
    const opener = screen.getByRole('button', { name: '打开设置' })
    await user.click(opener)
    expect(screen.queryByRole('dialog')).toBeNull()
    expect(screen.getByRole('region', { name: '设置', hidden: true })).toBeDefined()
    expect(screen.queryByRole('spinbutton', { name: '最大输出 Tokens' })).toBeNull()
    await user.click(screen.getByRole('button', { name: '编辑默认连接' }))
    expect(screen.getByRole('dialog', { name: '编辑模型连接' })).toBeDefined()
    const output = screen.getByRole('spinbutton', { name: '最大输出 Tokens' })
    await user.clear(output); await user.type(output, '2048'); await user.click(screen.getByRole('button', { name: '保存设置' }))
    await expect.poll(() => host.commands.some(command => command.type === 'config')).toBe(true)
    const patch = host.commands.find(command => command.type === 'config')
    expect(patch?.type === 'config' ? patch.patch : undefined).toMatchObject({ model: { maxOutputTokens: 2048 } })
    expect(patch?.type === 'config' ? (patch.patch as { model: object }).model : undefined).not.toHaveProperty('baseUrl')
    await user.click(screen.getByRole('button', { name: '后退' }))
    await expect.poll(() => document.activeElement).toBe(screen.getByRole('textbox', { name: '给 quifox 的消息' }))
    expect(document.body.textContent).not.toContain('synthetic-hidden')
})

it('selects the effective default effort directly and merges it with the matching menu option', async () => {
    const user = userEvent.setup(), host = fixture()
    host.snapshot.config.model.reasoningEffort = 'high'
    host.snapshot.config.model.reasoningEfforts = ['high', 'max']
    host.acceptSubmissions(); render(<App engine={host.engine}/>); await screen.findByRole('combobox', { name: '思考强度' })
    const picker = screen.getByRole('combobox', { name: '思考强度' })
    expect(picker.textContent).toBe('high')
    await user.click(picker)
    expect(screen.getAllByRole('option').map(option => option.textContent)).toEqual(['high✓', 'max'])
    expect(screen.queryByText(/继承设置/)).toBeNull()
    await user.click(screen.getByRole('option', { name: 'max' }))
    await user.click(picker); await user.click(screen.getByRole('option', { name: 'high' }))
    await user.type(screen.getByRole('textbox', { name: '给 quifox 的消息' }), 'use default reasoning')
    await user.click(screen.getByRole('button', { name: '发送消息' }))
    await expect.poll(() => host.commands.some(command => command.type === 'submit')).toBe(true)
    expect(host.commands.find(command => command.type === 'create')).not.toHaveProperty('reasoningEffort')
})

it('keeps committed settings visible until the slow Host response arrives', async () => {
    const user = userEvent.setup(), host = fixture(); host.delayConfig()
    render(<App engine={host.engine}/>); await user.click(await screen.findByRole('button', { name: '打开设置' }))
    await user.click(screen.getByRole('button', { name: '编辑默认连接' }))
    await user.click(screen.getByRole('button', { name: '保存设置' }))
    await screen.findByRole('status', { hidden: true })
    expect(screen.getByRole('region', { name: '设置', hidden: true })).toBeDefined()
    expect(screen.getByRole('button', { name: '关闭模型编辑' })).toHaveProperty('disabled', true)
    host.finishConfig(); await expect.poll(() => screen.queryByRole('dialog')).toBeNull()
})

it('keeps resources and plugins independent of session creation and preserves the conversation draft', async () => {
    const user = userEvent.setup(), host = fixture()
    render(<App engine={host.engine}/>); const input = await screen.findByRole('textbox', { name: '给 quifox 的消息' })
    await user.type(input, 'unfinished work')
    await user.click(screen.getByRole('button', { name: '打开设置' })); await user.click(screen.getByRole('button', { name: '技能' }))
    await screen.findByRole('heading', { name: 'review' })
    await user.click(screen.getByRole('button', { name: '记忆' })); await screen.findByText('0 份会话摘要')
    await user.click(screen.getByRole('button', { name: '后退' }))
    await user.click(screen.getByRole('button', { name: '插件' })); await screen.findByRole('button', { name: '查看技能' })
    expect(host.commands.some(command => command.type === 'create')).toBe(false)
    await user.click(screen.getByRole('button', { name: 'QuiFox' }))
    expect(screen.getByRole('textbox', { name: '给 quifox 的消息' })).toHaveProperty('value', 'unfinished work')
})

it('does not invent reasoning choices and lets an explicit override choose all six supported configuration values', async () => {
    const user = userEvent.setup(), host = fixture()
    render(<App engine={host.engine}/>); await expect.poll(() => screen.queryAllByText('deepseek-flash').length).toBeGreaterThan(0)
    expect(screen.queryByRole('combobox', { name: '思考强度' })).toBeNull()
    await user.click(screen.getByRole('button', { name: '打开设置' }))
    await user.click(screen.getByRole('button', { name: '编辑默认连接' }))
    await screen.findByText('目录接口未提供思考档位；如需设置，请手动配置。')
    await user.click(screen.getByRole('switch', { name: '手动配置能力' }))
    for (const level of ['none', 'low', 'medium', 'high', 'xhigh', 'max']) expect(screen.getByRole('checkbox', { name: level })).toBeDefined()
    await user.click(screen.getByRole('checkbox', { name: 'max' })); await user.click(screen.getByRole('button', { name: '保存设置' }))
    await expect.poll(() => host.commands.find(command => command.type === 'config')).toMatchObject({ patch: { model: { reasoningEfforts: ['max'] } } })
})

it('persists a custom Chat identity and clears the old implicit effort when automatic capabilities are selected', async () => {
    const user = userEvent.setup(), host = fixture()
    host.snapshot.config.model.reasoningEfforts = ['high']; host.snapshot.config.model.reasoningSource = 'configuration'; host.snapshot.config.model.reasoningEffort = 'high'
    render(<App engine={host.engine}/>); await user.click(await screen.findByRole('button', { name: '打开设置' }))
    await user.click(screen.getByRole('button', { name: '编辑默认连接' }))
    await user.click(screen.getByRole('combobox', { name: '供应商' })); await user.click(screen.getByRole('option', { name: '自定义 Chat' }))
    expect(screen.getByRole('textbox', { name: 'Provider' })).toHaveProperty('value', 'custom-chat')
    await user.click(screen.getByRole('button', { name: '保存设置' }))
    await expect.poll(() => host.commands.find(command => command.type === 'config')).toMatchObject({ patch: { model: { provider: 'custom-chat', reasoningEffort: null, reasoningEfforts: null } } })
})

it('keeps configured models usable when an automatic directory fetch fails without exposing a refresh button', async () => {
    const user = userEvent.setup(), host = fixture(); host.failCatalog()
    render(<App engine={host.engine}/>); await user.click(await screen.findByRole('button', { name: '打开设置' }))
    await user.click(screen.getByRole('button', { name: '编辑默认连接' }))
    await screen.findByText('Synthetic directory unavailable')
    expect(screen.getByRole('textbox', { name: '模型名称' })).toHaveProperty('value', 'deepseek-flash')
    expect(screen.getByRole('button', { name: '编辑默认连接', hidden: true })).toBeDefined()
    expect(screen.queryByRole('button', { name: '刷新目录' })).toBeNull()
})

it('ignores a file response from a workspace that was deselected while it was loading', async () => {
    const user = userEvent.setup(), host = fixture(); host.delayRead()
    host.session.title = 'workspace A'; host.snapshot.sessions = [host.session, { ...structuredClone(host.session), id: 'other', title: 'workspace B', workspace: '/synthetic/b' }]
    render(<App engine={host.engine}/>); await user.click(await screen.findByRole('button', { name: /workspace A/ }))
    await user.click(screen.getByRole('button', { name: '打开工作区' }))
    await user.click(await screen.findByRole('treeitem', { name: /report.md/ }))
    await user.click(screen.getByRole('button', { name: /workspace B/ })); host.finishRead()
    await expect.poll(() => screen.queryByRole('heading', { name: 'workspace B' })).not.toBeNull()
    expect(screen.queryByRole('dialog')).toBeNull(); expect(document.body.textContent).not.toContain('OLD WORKSPACE CONTENT')
})

it('uses one keyboard suggestion surface for Skills and Host commands before creating a session', async () => {
    const user = userEvent.setup(), host = fixture()
    render(<App engine={host.engine}/>)
    const input = await screen.findByRole('textbox', { name: '给 quifox 的消息' }) as HTMLTextAreaElement
    await user.type(input, '/')
    await screen.findByRole('option', { name: /spawn/ }); expect(screen.getByRole('option', { name: /review/ })).toBeDefined()
    await user.keyboard('{ArrowDown}{Enter}')
    expect(input.value).toBe('$global/review ')
    expect(host.commands.some(command => command.type === 'create')).toBe(false)
    await user.clear(input); await user.type(input, '$re')
    await user.keyboard('{Escape}'); expect(screen.queryByRole('listbox')).toBeNull(); expect(input.value).toBe('$re')
    await user.type(input, 'v'); await user.keyboard('{Tab}')
    expect(input.value).toBe('$global/review ')
})

it('persists keyboard UI scale changes and resets to 100 percent', async () => {
    const host = fixture()
    render(<App engine={host.engine}/>); await expect.poll(() => screen.queryAllByText('deepseek-flash').length).toBeGreaterThan(0)
    fireEvent.keyDown(window, { key: '+', metaKey: true })
    await expect.poll(() => host.commands.filter(command => command.type === 'config').length).toBe(1)
    expect(host.commands.find(command => command.type === 'config')).toMatchObject({ patch: { preferences: { uiScale: 1.1 } } })
    fireEvent.keyDown(window, { key: '0', ctrlKey: true })
    await expect.poll(() => host.commands.filter(command => command.type === 'config').length).toBe(2)
    expect(host.commands.filter(command => command.type === 'config').at(-1)).toMatchObject({ patch: { preferences: { uiScale: 1 } } })
})

it('keeps the open appearance zoom control synchronized with keyboard changes before saving other preferences', async () => {
    const host = fixture(), user = userEvent.setup()
    render(<App engine={host.engine}/>); await user.click(await screen.findByRole('button', { name: '打开设置' }))
    await user.click(screen.getByRole('button', { name: '外观' }))
    fireEvent.keyDown(window, { key: '-', metaKey: true })
    await expect.poll(() => screen.getByRole('combobox', { name: '界面缩放' }).textContent).toBe('90%')
    await user.click(screen.getByRole('button', { name: '保存外观' }))
    await expect.poll(() => host.commands.filter(command => command.type === 'config').length).toBe(2)
    expect(host.commands.filter(command => command.type === 'config').at(-1)).toMatchObject({ patch: { preferences: { uiScale: .9 } } })
})

it('filters settings resources and writes MCP toggles through the selected shared scope', async () => {
    const host = fixture(), user = userEvent.setup()
    host.pickWorkspace.mockResolvedValue('/synthetic')
    host.setMcp([{ id: 'docs', enabled: true, globalEnabled: false, transport: 'http', source: 'global', status: 'disconnected', toolCount: 0 }])
    render(<App engine={host.engine}/>)
    await user.click(await screen.findByRole('button', { name: '选择工作目录' }))
    await user.click(await screen.findByRole('button', { name: '打开设置' }))
    await user.click(screen.getByRole('button', { name: 'MCP' }))
    expect((await screen.findByRole('switch', { name: '启用 docs' })).getAttribute('aria-checked')).toBe('true')
    await user.click(screen.getByRole('switch', { name: '启用 docs' }))
    await expect.poll(() => host.commands.find(command => command.type === 'mcp-set-enabled')).toMatchObject({ scope: 'workspace', workspace: '/synthetic', serverId: 'docs', enabled: false })
    await user.click(screen.getByRole('combobox', { name: 'MCP 启停作用域' })); await user.click(screen.getByRole('option', { name: '全局' }))
    expect(screen.getByRole('switch', { name: '启用 docs' }).getAttribute('aria-checked')).toBe('false')
    await user.type(screen.getByRole('searchbox', { name: '筛选 MCP' }), 'missing')
    expect(screen.getByRole('region', { name: '没有匹配的 MCP' })).toBeDefined()
    await user.click(screen.getByRole('button', { name: '折叠设置导航' }))
    expect(screen.queryByRole('button', { name: '技能' })).toBeNull()
    await user.click(screen.getByRole('button', { name: '展开设置导航' })); await user.click(screen.getByRole('button', { name: '技能' }))
    await user.type(await screen.findByRole('searchbox', { name: '筛选技能' }), 'missing')
    expect(screen.queryByRole('heading', { name: 'review' })).toBeNull()
    expect(screen.getByRole('region', { name: '没有匹配的技能' })).toBeDefined()
    expect(host.commands.some(command => command.type === 'config')).toBe(false)
})
