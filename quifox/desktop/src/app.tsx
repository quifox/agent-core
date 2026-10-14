import { useCallback, useEffect, useMemo, useRef, useState, type CSSProperties, type MouseEvent } from 'react'
import type { InputRoutingReceipt, ResourceView, RuntimeCommand, RuntimeSnapshot, SessionView, WorkflowDocument } from '@quifox/shared-runtime'
import { WorkflowProvider, WorkflowMenu, WorkflowLayout, WorkflowDock } from './workflows.js'
import { inputSuggestions, agentRecipients } from '@quifox/shared-runtime/input-routing'
import { defaultShortcuts } from '@quifox/shared-runtime/preferences'
import { DesktopEngine } from './engine.js'
import { Conversation, MarkdownBody } from './presentation.js'
import { ApprovalCards, QueuedMessages } from './conversation-controls.js'
import { Settings } from './settings.js'
import { Workspace, type WorkspaceHandle } from './workspace.js'
import { nativeViews } from './native-views.js'
import { flushSync } from 'react-dom'
import { basename, NavigationControls, SessionNavigation, useNavigationHistory } from './navigation.js'
import { SelectMenu } from './select-menu.js'
import { Plugins } from './plugins.js'
import { Icon } from './icons.js'
import { shortcutKey, shortcutLabel } from './shortcuts.js'
import { StatusMessage } from './ui.js'
import fox from './assets/fox.svg'
import { ThreadPrimitive } from '@assistant-ui/react'
import { ChatRuntime } from './chat-runtime.js'

export { Trace } from './presentation.js'
const messageOf = (cause: unknown): string => cause instanceof Error ? cause.message : '操作未完成。'
type Effort = NonNullable<SessionView['reasoningEffort']>

export function App({ engine }: { engine: DesktopEngine }) {
    const navigation = useNavigationHistory()
    const [snapshot, setSnapshot] = useState<RuntimeSnapshot>(), [loadedView, setView] = useState<SessionView>()
    const { panel, sessionId: selected } = navigation.location
    const workspace = navigation.location.workspace ?? null
    const view = loadedView?.id === selected ? loadedView : undefined
    const [snapshotRevision, setSnapshotRevision] = useState(0)
    const selectedRef = useRef<string | undefined>(undefined), selectionWorkspace = useRef<string | null>(null)
    const [drafts, setDrafts] = useState<Record<string, string>>({}), [modelId, setModelId] = useState('default'), [effort, setEffort] = useState<Effort | 'inherit'>('inherit')
    const [sidebarCollapsed, setSidebarCollapsed] = useState(false), [approval, setApproval] = useState<'ask' | 'allow'>()
    const [settingsCollapsed, setSettingsCollapsed] = useState(false)
    const [workspaceOpen, setWorkspaceOpen] = useState(false)
    const [workflowDock, setWorkflowDock] = useState<string>()
    const [workspaceExpanded, setWorkspaceExpanded] = useState(false), [workspaceWidth, setWorkspaceWidth] = useState(55)
    const workspaceView = useRef<WorkspaceHandle>(null), grid = useRef<HTMLDivElement>(null)
    const [error, setError] = useState<string>(), [busy, setBusy] = useState(false), busyRef = useRef(false)
    const [live, setLive] = useState(''), liveRef = useRef({ text: '', sequence: 0 }), [messageLimit, setMessageLimit] = useState(100), limitRef = useRef(100)
    const creations = useRef(new Map<string, string>()), admissions = useRef(new Map<string, { prompt: string; id: string; mode: 'queue' | 'steer' }>())
    const latestRefresh = useRef(0)
    const draft = drafts[selected ?? 'new'] ?? ''
    const input = useRef<HTMLTextAreaElement>(null)
    useEffect(() => { if (panel === 'chat') input.current?.focus() }, [panel])
    const [caret, setCaret] = useState(0), [recipientChoice, setRecipientChoice] = useState(0), [recipientsDismissed, setRecipientsDismissed] = useState(false)
    const [routing, setRouting] = useState<{ sessionId: string; receipt: InputRoutingReceipt }>()
    const [uiScale, setUiScale] = useState(1), scaleRef = useRef(1), scalePending = useRef(0), scaleQueue = useRef(Promise.resolve())
    useEffect(() => {
        if (!scalePending.current) { const value = snapshot?.config.preferences.uiScale ?? 1; scaleRef.current = value; setUiScale(value) }
    }, [snapshot?.config.preferences.uiScale])
    const [resourceState, setResourceState] = useState<{ workspace: string | null; view: ResourceView }>()
    const resourceWorkspace = view?.workspace ?? workspace
    const resources = resourceState?.workspace === resourceWorkspace ? resourceState.view : undefined
    const defaults = resources?.config ?? snapshot?.config
    const contextReady = panel === 'workflows' ? !!view?.workflow : selected ? !!view : !!resources
    const [resourceAttempt, setResourceAttempt] = useState(0)
    useEffect(() => {
        let active = true
        if (snapshot) void engine.command({ type: 'resources', workspace: resourceWorkspace }).then(value => { if (active) setResourceState({ workspace: resourceWorkspace, view: value as ResourceView }) }, cause => { if (active) setError(messageOf(cause)) })
        return () => { active = false }
    }, [engine, resourceWorkspace, snapshot?.configurationRevision, resourceAttempt])
    const completions = !recipientsDismissed ? inputSuggestions(draft, caret, {
        agents: selected ? agentRecipients(snapshot?.sessions ?? [], selected) : [],
        skills: (view ? view.skills.skills : resources?.skillsEnabled ? resources.skills.skills : []).filter(skill => !(resources?.disabledSkills ?? snapshot?.config.skills.disabled ?? []).includes(skill.id)),
        commands: [{ name: '/spawn', description: '创建待机子 Agent · /spawn [数量] [任务说明]' }]
    }) : []
    useEffect(() => { document.getElementById('composer-active-suggestion')?.scrollIntoView({ block: 'nearest' }) }, [recipientChoice, completions.length])
    const routingReceipt = routing && routing.sessionId === selected ? routing.receipt : undefined

    const refresh = useCallback(async () => {
        const ticket = ++latestRefresh.current, id = selectedRef.current
        const next = await engine.command({ type: 'snapshot' }) as RuntimeSnapshot
        const current = id ? await engine.command({ type: 'snapshot', sessionId: id, messageLimit: limitRef.current, eventLimit: 1000, traceOnly: true }) as SessionView : undefined
        if (ticket !== latestRefresh.current || id !== selectedRef.current) return
        setSnapshot(next); setSnapshotRevision(value => value + 1); setView(current)
        if (current && (current.eventSequence ?? 0) >= liveRef.current.sequence) {
            liveRef.current = { text: current.liveText ?? '', sequence: current.eventSequence ?? 0 }; setLive(liveRef.current.text)
        }
        if (current) { setModelId(current.modelId ?? 'default'); setEffort(current.reasoningEffortOverride ?? 'inherit') }
    }, [engine])

    useEffect(() => {
        let mounted = true, timer: ReturnType<typeof setTimeout> | undefined, paint: ReturnType<typeof setTimeout> | undefined
        const report = (cause: unknown): void => { if (mounted) setError(messageOf(cause)) }
        const schedule = (): void => { if (!timer) timer = setTimeout(() => { timer = undefined; if (mounted) void refresh().catch(report) }, 40) }
        void refresh().catch(report)
        const unsubscribe = engine.subscribe(event => {
            const data = event.data as { type?: string; text?: string; delta?: string }
            if (event.sessionId === selectedRef.current && event.sequence > liveRef.current.sequence) {
                liveRef.current.sequence = event.sequence
                if (event.type === 'agent' && data.type === 'text-delta') {
                    liveRef.current.text += data.text ?? data.delta ?? ''
                    if (!paint) paint = setTimeout(() => { paint = undefined; if (mounted) setLive(liveRef.current.text) }, 40)
                } else if (event.type === 'agent' && data.type === 'model-start') { liveRef.current.text = '' }
            }
            if (event.type !== 'agent' || !['text-delta', 'reasoning-delta', 'usage'].includes(data.type ?? '')) schedule()
        })
        const fault = engine.onError(value => { if (mounted) setError(value) }), poll = setInterval(schedule, 2500)
        return () => { mounted = false; unsubscribe(); fault(); clearInterval(poll); if (timer) clearTimeout(timer); if (paint) clearTimeout(paint) }
    }, [engine, refresh])
    const loadSelection = useCallback(async (id: string | undefined, directory: string | null): Promise<void> => {
        selectedRef.current = id; selectionWorkspace.current = directory; setView(undefined)
        if (!id) { setModelId('default'); setEffort('inherit'); setApproval(undefined) }
        setRecipientsDismissed(false); setRecipientChoice(0)
        limitRef.current = 100; setMessageLimit(100); liveRef.current = { text: '', sequence: 0 }; setLive('')
        await refresh()
    }, [refresh])
    useEffect(() => {
        if (selectedRef.current !== selected || (!selected && selectionWorkspace.current !== workspace)) void loadSelection(selected, workspace).catch(cause => setError(messageOf(cause)))
    }, [selected, workspace, loadSelection])
    const select = useCallback(async (id?: string, directory?: string | null): Promise<void> => {
        const path = directory === undefined ? snapshot?.sessions.find(session => session.id === id)?.workspace ?? workspace : directory
        navigation.navigate({ panel: snapshot?.sessions.find(session => session.id === id)?.workflowName ? 'workflows' : 'chat', sessionId: id, workspace: path, pluginId: undefined, observationId: undefined })
        await loadSelection(id, path)
    }, [navigation.navigate, loadSelection, snapshot?.sessions, workspace])
    const startNew = useCallback((): void => {
        if (busyRef.current) return
        setDrafts(current => ({ ...current, new: '' })); setModelId('default'); setEffort('inherit'); setApproval(undefined)
        setWorkspaceOpen(false); setWorkspaceExpanded(false); setError(undefined); setRouting(undefined)
        creations.current.clear(); admissions.current.delete('new')
        void select(undefined, null).catch(cause => setError(messageOf(cause)))
        queueMicrotask(() => input.current?.focus())
    }, [select])
    useEffect(() => {
        const shortcut = (event: KeyboardEvent): void => {
            const binding = shortcutKey(event), shortcuts = snapshot?.config.preferences.shortcuts ?? defaultShortcuts
            if (binding && [shortcuts.zoomIn, shortcuts.zoomOut, shortcuts.zoomReset].includes(binding)) {
                event.preventDefault()
                const value = binding === shortcuts.zoomReset ? 1 : Math.max(.8, Math.min(1.4, Math.round((scaleRef.current + (binding === shortcuts.zoomOut ? -.1 : .1)) * 10) / 10))
                scaleRef.current = value; setUiScale(value); scalePending.current += 1
                scaleQueue.current = scaleQueue.current.then(async () => {
                    try { await engine.command({ type: 'config', patch: { preferences: { uiScale: value } } }); await refresh() }
                    catch (cause) {
                        setError(messageOf(cause))
                        const actual = await engine.command({ type: 'snapshot' }).catch(() => undefined) as RuntimeSnapshot | undefined
                        if (actual && scalePending.current === 1) { scaleRef.current = actual.config.preferences.uiScale; setUiScale(scaleRef.current); setSnapshot(actual) }
                    }
                    finally { scalePending.current -= 1 }
                })
            }
            else if (binding === shortcuts.newSession) { event.preventDefault(); startNew() }
            else if (event.key === 'Escape' && !document.querySelector('dialog[open], [role="dialog"][aria-modal="true"]')) setWorkspaceOpen(false)
        }
        window.addEventListener('keydown', shortcut); return () => window.removeEventListener('keydown', shortcut)
    }, [engine, refresh, snapshot?.config.preferences.shortcuts, startNew])
    const selectAction = useCallback((id: string): void => { void select(id).catch(cause => setError(messageOf(cause))) }, [select])
    const command = useCallback((input: RuntimeCommand): Promise<unknown> => engine.command(input), [engine])
    const openWorkflow = useCallback((script: string): void => { setWorkflowDock(script); setWorkspaceOpen(false) }, [])
    const workflowContext = useMemo(() => ({ command, open: openWorkflow }), [command, openWorkflow])
    const chooseWorkflow = (document: WorkflowDocument): void => {
        action((async () => {
            const session = await engine.command({ type: 'create', title: document.name, workspace, modelId, workflow: { name: document.name, script: document.script } }) as SessionView
            navigation.navigate({ panel: 'workflows', sessionId: session.id, workspace: session.workspace })
            await loadSelection(session.id, session.workspace)
        })())
    }
    useEffect(() => engine.onPresentation(async (request, signal) => {
        if (/^https?:\/\//i.test(request.target)) {
            signal.throwIfAborted(); await nativeViews.external(request.target)
            return { destination: 'external', target: request.target }
        }
        flushSync(() => { navigation.navigate({ panel: 'chat' }); setWorkspaceOpen(true) })
        if (!workspaceView.current) throw new Error('工作区尚未就绪。')
        return workspaceView.current.openFile(request.target, request.workspace, request.sessionId, signal)
    }), [engine, navigation.navigate])
    const run = async (command: RuntimeCommand): Promise<void> => { setError(undefined); await engine.command(command); await refresh() }
    const action = (operation: Promise<unknown>): void => { void operation.catch(cause => setError(messageOf(cause))) }
    const setDraft = (text: string, position = text.length): void => { setDrafts(current => ({ ...current, [selected ?? 'new']: text })); setCaret(position); setRecipientsDismissed(false); setRecipientChoice(0) }
    const completeRecipient = (index = recipientChoice): void => {
        const completion = completions[Math.min(index, completions.length - 1)]
        if (!completion) return
        const head = draft.slice(0, completion.start) + completion.text
        setDraft(head + draft.slice(completion.end), head.length)
        input.current?.focus()
        queueMicrotask(() => input.current?.setSelectionRange(head.length, head.length))
    }
    const openSettings = (event: MouseEvent<HTMLButtonElement>): void => { event.currentTarget.focus(); navigation.navigate({ panel: 'settings' }) }
    const exclusive = async (operation: () => Promise<void>): Promise<void> => {
        if (busyRef.current) return
        busyRef.current = true; setBusy(true); setError(undefined)
        try { await operation() } finally { busyRef.current = false; setBusy(false) }
    }
    const chooseWorkspace = async (): Promise<void> => exclusive(async () => {
        const original = selectedRef.current
        const path = await nativeViews.chooseDirectory(resourceWorkspace ?? snapshot?.config.workspace ?? '', '选择工作目录')
        if (!path || original !== selectedRef.current) return
        const resource = await engine.command({ type: 'resources', workspace: path }) as ResourceView
        if (original !== selectedRef.current) return
        navigation.navigate({ workspace: resource.workspace })
        input.current?.focus()
    })
    const createSession = async (): Promise<SessionView> => {
        const input = { type: 'create' as const, workspace, modelId, ...(effort !== 'inherit' ? { reasoningEffort: effort } : {}), ...(approval ? { approvalMode: approval } : {}) }
        const identity = JSON.stringify(input), sessionId = creations.current.get(identity) ?? crypto.randomUUID()
        creations.current.set(identity, sessionId)
        const created = await engine.command({ ...input, sessionId }) as SessionView
        creations.current.delete(identity); setApproval(undefined)
        return created
    }
    const send = async (prompt = draft): Promise<void> => {
        if (!contextReady || !prompt.trim()) return
        if (view?.unavailable) throw new Error(view.unavailable)
        await exclusive(async () => {
            let id = selected, key = selected ?? 'new'
            const previous = admissions.current.get(key)
            const admission = previous?.prompt === prompt ? previous : { prompt, id: crypto.randomUUID(), mode: view?.preferences?.inputMode ?? defaults?.preferences.inputMode ?? 'queue' }
            admissions.current.set(key, admission)
            if (!id) {
                const created = await createSession()
                id = created.id; key = id
                admissions.current.set(key, admission)
                setDrafts(current => ({ ...current, new: '', [created.id]: current.new ?? prompt })); await select(id, created.workspace)
            }
            const receipt = await engine.command({ type: 'submit', sessionId: id, prompt, mode: admission.mode, messageId: admission.id }) as InputRoutingReceipt | undefined
            if (receipt?.kind === 'spawn' || receipt?.kind === 'dispatch') {
                setRouting({ sessionId: id, receipt }); await refresh()
                if (!receipt.accepted) throw new Error(receipt.kind === 'spawn' ? receipt.errors.join('；') : '部分子 Agent 消息未接纳，请重试同一条输入。')
            }
            admissions.current.delete(key); admissions.current.delete('new')
            setDrafts(current => current[key] === prompt ? { ...current, [key]: '' } : current); await refresh()
        })
    }
    const openFile = useCallback((path: string): void => {
        flushSync(() => setWorkspaceOpen(true))
        void workspaceView.current?.openFile(path, view?.workspace ?? workspace ?? snapshot?.config.workspace ?? '', selectedRef.current).catch(cause => setError(messageOf(cause)))
    }, [view?.workspace, workspace, snapshot?.config.workspace])
    const openChanges = (changes: Parameters<WorkspaceHandle['openDiff']>[0], title?: string): void => {
        setWorkspaceOpen(true); workspaceView.current?.openDiff(changes, title)
    }
    const resizeWorkspace = (event: React.PointerEvent<HTMLDivElement>): void => {
        if (!grid.current) return
        event.currentTarget.setPointerCapture(event.pointerId)
        const bounds = grid.current.getBoundingClientRect()
        const move = (event: PointerEvent): void => setWorkspaceWidth(Math.max(30, Math.min(75, (bounds.right - event.clientX) / bounds.width * 100)))
        const finish = (): void => { window.removeEventListener('pointermove', move); window.removeEventListener('pointerup', finish); window.removeEventListener('pointercancel', finish) }
        window.addEventListener('pointermove', move); window.addEventListener('pointerup', finish, { once: true }); window.addEventListener('pointercancel', finish, { once: true })
    }
    const changeSelection = (id: string, strength: Effort | 'inherit'): void => {
        if (selected) action(exclusive(() => run({ type: 'session-config', sessionId: selected, modelId: id, reasoningEffort: strength === 'inherit' ? null : strength })))
        else { setModelId(id); setEffort(strength) }
    }
    const profiles = [{ ...view?.defaultModel ?? defaults?.model, id: 'default', label: '默认' }, ...(view?.models ?? defaults?.models ?? [])]
    const changeApproval = (mode: 'ask' | 'allow'): void => {
        if (selected) action(exclusive(() => run({ type: 'session-config', sessionId: selected, approvalMode: mode })))
        else setApproval(mode)
    }
    const profile = profiles.find(model => model.id === modelId), efforts = profile?.reasoningEfforts ?? []
    const preferred = view?.preferences?.reasoningEffort ?? defaults?.preferences.reasoningEffort ?? 'high'
    const inherited = profile?.reasoningEffort ?? (efforts.includes(preferred) ? preferred : undefined)
    const effectiveEffort = effort === 'inherit' ? view?.reasoningEffort ?? inherited : effort
    const children = useMemo(() => snapshot?.sessions.filter(session => session.parentId === selected) ?? [], [snapshot?.sessions, selected])
    const theme = view?.preferences?.theme ?? defaults?.preferences.theme ?? 'system'
    const permissionMode = view?.approvalMode ?? approval ?? defaults?.approval ?? 'ask'

    const workspacePath = view?.workspace ?? workspace ?? snapshot?.config.workspace ?? ''
    const managementWorkspace = view?.workspace ?? workspace ?? resources?.workspace ?? workspacePath
    const directoryLabel = view?.workspace || workspace ? basename(view?.workspace ?? workspace!) : '默认目录 · 按日期创建'
    const pending = view?.pendingMessages ?? []
    const activeExecution = view?.status === 'running' || view?.backgroundTasks.some(task => task.status === 'running') || children.some(child => child.status === 'running')
    const composerAction = !draft.trim() && activeExecution ? 'stop' : !draft.trim() && view?.resumeAvailable ? 'resume' : 'send'
    return <WorkflowProvider value={workflowContext}><div className="app-shell" data-theme={theme} data-platform={/Mac/.test(navigator.platform) ? 'mac' : 'other'} style={{ '--ui-scale': uiScale, '--font-size-ui': `${view?.preferences?.fontSize ?? defaults?.preferences.fontSize ?? 18}px` } as CSSProperties}>
        <header className="window-toolbar" aria-label="窗口工具栏" data-tauri-drag-region><div className="window-navigation"><button className="icon-button" aria-label={panel === 'settings' ? settingsCollapsed ? '展开设置导航' : '折叠设置导航' : sidebarCollapsed ? '展开会话侧栏' : '折叠会话侧栏'} aria-expanded={panel === 'settings' ? !settingsCollapsed : !sidebarCollapsed} aria-controls={panel === 'settings' ? 'settings-navigation' : 'session-sidebar'} onClick={() => panel === 'settings' ? setSettingsCollapsed(value => !value) : setSidebarCollapsed(value => !value)}><Icon name="navigation"/></button><NavigationControls navigation={navigation} disabled={busy}/></div><h1 data-tauri-drag-region>{panel === 'workflows' ? '工作流' : panel === 'chat' ? view?.title ?? '新的会话' : panel === 'settings' ? '设置' : '插件'}</h1>
            {panel === 'chat' && <div className="window-actions">{view?.parentId && <button className="icon-button" aria-label="回到父会话" onClick={() => action(select(view.parentId))}><Icon name="agents"/></button>}<button className="icon-button" aria-label={workspaceOpen ? '切换工作区' : '打开工作区'} title={workspaceOpen ? '收起工作区' : '打开工作区'} onClick={() => { setWorkspaceOpen(value => !value); setWorkspaceExpanded(false) }} aria-pressed={workspaceOpen}><Icon name="navigation"/></button></div>}</header>
        <aside id="session-sidebar" className="sidebar" hidden={sidebarCollapsed || panel === 'settings'} aria-label="工作目录与会话">
            <button className="brand" aria-label="QuiFox" onClick={() => action(select())}><img src={fox} alt="蓝色身体、黄色耳朵的狐狸"/><span>QuiFox</span></button>
            <button className="new-session" disabled={busy} onClick={startNew}><Icon name="plus"/>新建会话 <kbd>{snapshot && shortcutLabel(snapshot.config.preferences.shortcuts.newSession)}</kbd></button>
            <button className="sidebar-link" aria-pressed={panel === 'plugins'} onClick={() => navigation.navigate({ panel: 'plugins', pluginId: undefined, observationId: undefined })}><Icon name="plugins"/>插件</button>
            {defaults?.installedPlugins.includes('workflows') && defaults.plugins.workflows !== false && <button className="sidebar-link" aria-pressed={panel === 'workflows'} onClick={() => navigation.navigate({ panel: 'workflows', sessionId: view?.workflow ? selected : undefined })}><Icon name="agents"/>工作流</button>}
            {panel === 'workflows' && <WorkflowMenu command={command} revision={snapshotRevision} choose={chooseWorkflow}/>}
            <div className="nav-title">历史会话</div>
            <SessionNavigation sessions={snapshot?.sessions ?? []} selected={selected} select={selectAction}/>
            <div className="sidebar-bottom"><button aria-label="打开设置" onClick={openSettings}><Icon name="settings"/>设置</button></div>
            <div className="connection">{snapshot ? snapshot.config.model.model : '连接引擎…'}</div>
        </aside>
        <main className="main-area">
            {error && <div className="operation-notice" role="alert"><span>{error}</span>{engine.disconnected && <button onClick={() => action(engine.reconnect().then(async () => { await refresh(); setResourceAttempt(value => value + 1); setError(undefined) }))}>重新连接</button>}<button aria-label="关闭操作提示" onClick={() => setError(undefined)}>×</button></div>}
            {view?.unavailable && <div className="error-banner" role="status">{view.unavailable}</div>}
            <div className="content-grid" ref={grid} data-workspace-expanded={panel === 'chat' && workspaceExpanded && workspaceOpen}><div className="conversation-column">
                {panel !== 'chat' && !contextReady ? <StatusMessage>正在读取工作目录配置…</StatusMessage> : panel === 'settings' && snapshot ? <Settings config={snapshot.config} view={view} workspace={managementWorkspace} collapsed={settingsCollapsed} workspaceScopeAvailable={!!view || !!workspace} save={patch => run({ type: 'config', patch })} command={command}/> : panel === 'plugins' ? <Plugins navigation={navigation} sessionId={selected} sessions={snapshot?.sessions} workspace={managementWorkspace} workspaceScopeAvailable={!!view || !!workspace} configurationRevision={snapshot?.configurationRevision} revision={snapshotRevision} command={command}/> : <>
                        <WorkflowLayout active={panel === 'workflows'} view={view} command={command}><ChatRuntime view={view} live={live} onSubmit={send} onCancel={async () => { if (view) await run({ type: 'stop', sessionId: view.id }) }}><ThreadPrimitive.Root className="chat-thread"><ThreadPrimitive.Viewport className="chat-scroll">
                            {!view?.messages.length && !live ? <div className="welcome"><img src={fox} alt="quifox 狐狸"/><h2>开始一项工作。</h2><div className="prompt-suggestions">{['理解这个项目的结构', '先制定一个实现计划', '审查最近的代码改动'].map(prompt => <button key={prompt} onClick={() => setDraft(prompt)}>{prompt} ↗</button>)}</div>{snapshot && !snapshot.config.model.hasApiKey && <button className="quiet" onClick={openSettings}>连接你的 Chat 模型 →</button>}</div> : <>
                                {view && (view.totalMessages ?? view.messages.length) > view.messages.length && <button className="load-history" disabled={messageLimit >= 5000} onClick={() => { limitRef.current = Math.min(5000, messageLimit + 100); setMessageLimit(limitRef.current); action(refresh()) }}>加载较早消息 · 已显示 {view.messages.length}/{view.totalMessages}</button>}
                                {view && <Conversation view={view} openFile={openFile} openChanges={openChanges}/>}{live && <article className="message assistant live-message">{view?.messages.filter(entry => entry.message.role !== 'tool').at(-1)?.message.role !== 'assistant' && <div className="message-label"><img src={fox} alt=""/>QuiFox <span className="stream-indicator"/></div>}<div className="message-body"><MarkdownBody content={live} openFile={openFile}/></div></article>}
                            </>}{pending.filter(message => message.mode === 'steer' || message.status === 'staged').map(message => <div className="messages" key={message.id}><article className="message user"><div className="message-body"><MarkdownBody content={message.prompt} openFile={openFile}/></div></article></div>)}
                            <ThreadPrimitive.ScrollToBottom className="jump-latest" aria-label="跳到最新消息">↓ 最新消息</ThreadPrimitive.ScrollToBottom>
                        </ThreadPrimitive.Viewport>
                        {view && <ApprovalCards view={view} command={async input => { await run(input) }} error={cause => setError(messageOf(cause))}/>}
                        {routingReceipt && <section className="routing-receipt" aria-label="子 Agent 接纳回执" role="status">{(routingReceipt.kind === 'spawn' ? routingReceipt.agents.map(agent => ({ agent, detail: '已创建 · 待机' })) : routingReceipt.deliveries.map(delivery => ({ agent: delivery.agent, detail: delivery.status === 'queued' ? '消息已接纳' : delivery.error ?? '未接纳' }))).map((item, index) => <div key={`${item.agent.taskId}-${index}`}><button aria-label={`打开 Agent ${item.agent.name}`} onClick={() => action(select(item.agent.sessionId))}>@{item.agent.name}</button><span>{item.detail}</span><code>{item.agent.taskId}</code></div>)}{routingReceipt.kind === 'spawn' && routingReceipt.errors.map((message, index) => <StatusMessage error key={index}>{message}</StatusMessage>)}</section>}
                        <div className="composer-wrap">
                            {view && <QueuedMessages view={view} command={async input => { await run(input) }} error={cause => setError(messageOf(cause))}/>}
                            <div className="composer-directory">{selected ? <span aria-label="会话工作目录" title={view?.workspace}><Icon name="folder"/><span className="ellipsis">{view ? directoryLabel : '加载工作目录…'}</span></span> : <button type="button" aria-label="选择工作目录" title={workspace ?? '发送首条消息时按日期创建独立工作目录'} disabled={busy || !snapshot} onClick={() => action(chooseWorkspace())}><Icon name="folder"/><span className="ellipsis">{directoryLabel}</span><Icon name="down"/></button>}</div>
                            {!!completions.length && <div id="composer-suggestions" className="recipient-picker" role="listbox" aria-label="输入建议">{completions.map((completion, index) => <button key={completion.id} id={index === recipientChoice ? 'composer-active-suggestion' : undefined} type="button" role="option" aria-selected={index === recipientChoice} onMouseDown={event => event.preventDefault()} onClick={() => completeRecipient(index)}><span>{completion.label}</span><span className="suggestion-description">{completion.description}</span></button>)}</div>}<form className="composer" onSubmit={event => { event.preventDefault(); action(send()) }}><textarea ref={input} aria-label="给 quifox 的消息" aria-autocomplete="list" aria-controls={completions.length ? 'composer-suggestions' : undefined} aria-activedescendant={completions.length ? 'composer-active-suggestion' : undefined} placeholder="描述任务，或继续对话…" value={draft} onChange={event => setDraft(event.target.value, event.target.selectionStart)} onSelect={event => setCaret(event.currentTarget.selectionStart)} onKeyDown={event => {
                            if (event.nativeEvent.isComposing) return
                            if (completions.length) {
                                if (event.key === 'ArrowUp' || event.key === 'ArrowDown') { event.preventDefault(); setRecipientChoice(index => (index + (event.key === 'ArrowUp' ? -1 : 1) + completions.length) % completions.length); return }
                                if (event.key === 'Tab' || (event.key === 'Enter' && !event.shiftKey)) { event.preventDefault(); completeRecipient(); return }
                                if (event.key === 'Escape') { event.preventDefault(); setRecipientsDismissed(true); return }
                            }
                            if (event.key === 'Enter' && !event.shiftKey) { event.preventDefault(); action(send()) }
                        }}/>
                            <div className="composer-actions"><div className="permission-control" data-mode={permissionMode}><Icon name="shield"/><SelectMenu label="当前会话权限" value={permissionMode} disabled={!contextReady || busy || view?.status === 'running' || !!view?.unavailable || view?.approvalMode === 'deny'} above options={[{ value: 'ask', label: '逐次询问' }, { value: 'allow', label: '完全访问' }, ...(view?.approvalMode === 'deny' ? [{ value: 'deny', label: '受限权限' }] : [])]} onChange={value => changeApproval(value as 'ask' | 'allow')}/></div><div className="model-controls"><SelectMenu label="当前会话模型" value={modelId} disabled={!contextReady || busy || view?.status === 'running' || !!view?.unavailable} above options={profiles.map(model => ({ value: model.id, label: `${model.label ?? model.id} · ${model.model ?? ''}` }))} onChange={value => changeSelection(value, 'inherit')}/>{!!efforts.length && (!selected || !!view) && <SelectMenu label="思考强度" value={effectiveEffort ?? '选择思考强度'} disabled={!contextReady || busy || view?.status === 'running' || !!view?.unavailable} above options={efforts.map(value => ({ value, label: value === 'none' ? 'none · 关闭思考' : value }))} onChange={value => changeSelection(modelId, value === inherited ? 'inherit' : value as Effort)}/>}</div>
                                <button className="send-button" aria-label={composerAction === 'stop' ? '暂停执行' : composerAction === 'resume' ? '恢复执行' : '发送消息'} disabled={!contextReady || (composerAction === 'send' && !draft.trim()) || busy || !!view?.unavailable} type={composerAction === 'send' ? 'submit' : 'button'} onClick={() => { if (view && composerAction === 'stop') action(run({ type: 'stop', sessionId: view.id })); else if (view && composerAction === 'resume') action(run({ type: 'resume', sessionId: view.id, mode: 'replan' })) }}>{composerAction === 'stop' ? <Icon name="pause"/> : composerAction === 'resume' ? <Icon name="play"/> : '↑'}</button></div>
                        </form></div></ThreadPrimitive.Root></ChatRuntime></WorkflowLayout>
                    </>}
            </div><div className="workspace-splitter" hidden={panel !== 'chat' || !workspaceOpen || workspaceExpanded} role="separator" aria-label="调整工作区宽度" aria-orientation="vertical" aria-valuenow={Math.round(workspaceWidth)} aria-valuemin={30} aria-valuemax={75} tabIndex={0} onPointerDown={resizeWorkspace} onKeyDown={event => { if (event.key === 'ArrowLeft' || event.key === 'ArrowRight') { event.preventDefault(); setWorkspaceWidth(value => Math.max(30, Math.min(75, value + (event.key === 'ArrowLeft' ? 5 : -5)))) } }}/>
                <aside className="workspace-pane" hidden={panel !== 'chat' || !workspaceOpen} style={{ flexBasis: `${workspaceExpanded ? 100 : workspaceWidth}%` }}><Workspace ref={workspaceView} root={workspacePath} view={view} children={children} command={command} openChild={selectAction} close={() => { setWorkspaceOpen(false); setWorkspaceExpanded(false) }} expanded={workspaceExpanded} setExpanded={setWorkspaceExpanded} visible={panel === 'chat' && workspaceOpen} theme={theme} fontSize={view?.preferences?.fontSize ?? defaults?.preferences.fontSize ?? 18}/></aside>{workflowDock && <WorkflowDock key={workflowDock} script={workflowDock} command={command} openFile={openFile} close={() => setWorkflowDock(undefined)}/>}</div>
        </main>
    </div></WorkflowProvider>
}
