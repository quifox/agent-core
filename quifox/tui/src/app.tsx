import { useCallback, useEffect, useRef, useState } from 'react'
import { Box, Text, measureElement, useApp, useInput, useStdout, type DOMElement } from 'ink'
import { toolSummary, agentRecipients, inputSuggestions, type ObservabilityView, type InputRoutingReceipt, type ResourceView, type RuntimeCommand, type RuntimeEvent, type RuntimeSnapshot, type SessionView } from '@quifox/shared-runtime'
import { stripVTControlCharacters } from 'node:util'
import { toolResultText, traceText } from './trace-text.js'

export interface TerminalRuntime { command(command: RuntimeCommand): Promise<unknown>; subscribe(listener: (event: RuntimeEvent) => void): () => void; close(): Promise<void> }

export function Fox() {
    return <Box flexDirection="column"><Text color="#F0CF58">{' /\\   /\\'}</Text><Text color="white">{'(  • . • )'}</Text><Text color="#18A4DA">{' \\  ▼  /'}</Text><Text color="#18A4DA">{'  /_   _\\~~'}</Text></Box>
}

/** Terminal controls call the shared Host; rendered messages and tasks are projections only. */
interface Choice { label: string; detail?: string; action(): Promise<void> }
interface Picker { title: string; choices: Choice[] }
interface Editor { label: string; secret?: boolean; save(value: string): Promise<void> }
const builtinCommands = [
    ['/new', '新的主会话'], ['/resume', '选择历史会话'], ['/tasks', '子任务与父会话'], ['/open', '按会话 ID 打开'], ['/spawn', '创建待机子 Agent'], ['/config', '可视配置'], ['/model', '切换当前模型'], ['/effort', '思考强度'],
    ['/mcp', '连接与配置 MCP'], ['/agents', 'Agent 定义'], ['/skills', '可用技能'], ['/memory', '运行时记忆'], ['/trace', '操作详情'], ['/observability', '运行指标与最近轨迹'],
    ['/continue', '恢复执行'], ['/stop', '停止'], ['/approve', '批准工具'], ['/deny', '拒绝工具'], ['/models', '刷新模型资料'], ['/help', '帮助']
] as const
const safe = (value: string): string => stripVTControlCharacters(value).replace(/\p{Cc}/gu, value => ['\n', '\t'].includes(value) ? value : '')

export function TerminalApp({ runtime, initialSessionId, showResume = false }: { runtime: TerminalRuntime; initialSessionId?: string; showResume?: boolean }) {
    const { exit } = useApp(), { stdout } = useStdout()
    const terminal = stdout as NodeJS.WritableStream & { columns?: number; rows?: number }
    const [snapshot, setSnapshot] = useState<RuntimeSnapshot>()
    const snapshotRef = useRef<RuntimeSnapshot | undefined>(undefined)
    const [view, setView] = useState<SessionView>()
    const [suggestionResources, setSuggestionResources] = useState<ResourceView>()
    const selected = useRef<string | undefined>(initialSessionId), starting = useRef<Promise<string> | undefined>(undefined)
    const [draft, setDraft] = useState(''), [cursor, setCursor] = useState(0)
    const [mentionsDismissed, setMentionsDismissed] = useState(false)
    const mentionsDismissedRef = useRef(false)
    const [picker, setPicker] = useState<Picker>(), [choice, setChoiceState] = useState(0), [editor, setEditor] = useState<Editor>(), editorRef = useRef<Editor | undefined>(undefined)
    const choiceRef = useRef(0)
    const setChoice = (value: number | ((previous: number) => number)): void => { choiceRef.current = typeof value === 'function' ? value(choiceRef.current) : value; setChoiceState(choiceRef.current) }
    const originalDraft = useRef(''), [live, setLive] = useState(''), liveRef = useRef(''), liveSequence = useRef(0)
    const resumeShown = useRef(false)
    const draftRef = useRef(''), cursorRef = useRef(0), submitting = useRef(false)
    const edit = (text: string, position: number): void => { draftRef.current = text; cursorRef.current = position; setDraft(text); setCursor(position); mentionsDismissedRef.current = false; setMentionsDismissed(false) }
    const [panel, setPanelState] = useState<string>(), [memoryPanel, setMemoryPanel] = useState(false), [error, setError] = useState<string>(), [width, setWidth] = useState(terminal.columns ?? 80)
    const [observabilityPanel, setObservabilityPanel] = useState(false), [observation, setObservation] = useState<ObservabilityView>()
    const setPanel = (value: string | undefined): void => { setMemoryPanel(false); setObservabilityPanel(false); setPanelState(value) }
    const [height, setHeight] = useState(terminal.rows ?? 24), [scroll, setScroll] = useState(0), [maxScroll, setMaxScroll] = useState(0)
    const viewport = useRef<DOMElement>(null), content = useRef<DOMElement>(null)
    const revision = useRef(0)
    const sessionDrafts = useRef(new Map<string, string>())
    const creations = useRef(new Map<string, string>()), initialCreation = useRef(crypto.randomUUID())
    const admissions = useRef(new Map<string, { prompt: string; id: string; mode: 'queue' | 'steer' }>())
    const beginSelection = useCallback((id: string): void => {
        if (!draftRef.current.startsWith('/')) sessionDrafts.current.set(selected.current ?? 'new', draftRef.current)
        revision.current += 1; selected.current = id; setView(undefined); liveRef.current = ''; liveSequence.current = 0; setLive(''); setPanel(undefined); setPicker(undefined)
        const restored = sessionDrafts.current.get(id) ?? ''; draftRef.current = restored; cursorRef.current = [...restored].length; setDraft(restored); setCursor(cursorRef.current)
    }, [])
    const refresh = useCallback(async () => {
        const ticket = ++revision.current
        const next = await runtime.command({ type: 'snapshot' }) as RuntimeSnapshot
        if (!selected.current && !showResume) {
            starting.current ??= runtime.command({ type: 'create', sessionId: initialCreation.current }).then(value => (value as SessionView).id).catch(cause => { starting.current = undefined; throw cause })
            selected.current = await starting.current
        }
        const id = selected.current
        const current = id ? await runtime.command({ type: 'snapshot', sessionId: id, messageLimit: 60, eventLimit: 300, traceOnly: true }) as SessionView : undefined
        if (ticket === revision.current && id === selected.current) {
            snapshotRef.current = next; setSnapshot(next); setView(current)
            if ((current?.eventSequence ?? 0) >= liveSequence.current) { liveRef.current = current?.liveText ?? liveText(current?.events ?? []); setLive(liveRef.current) }
            if (showResume && !resumeShown.current) { resumeShown.current = true; setPicker({ title: '恢复主会话', choices: next.sessions.filter(item => !item.parentId).sort((a, b) => b.updatedAt.localeCompare(a.updatedAt)).map(item => ({ label: `${item.id.slice(0, 8)} · ${item.title}${item.unavailable ? ' · 只读' : ''}`, detail: item.workspace, action: async () => { beginSelection(item.id); await refresh() } })) }) }
        }
    }, [runtime, showResume, beginSelection])
    useEffect(() => {
        let timer: ReturnType<typeof setTimeout> | undefined
        let mounted = true
        const update = (): void => { if (!timer) timer = setTimeout(() => { timer = undefined; if (mounted) void refresh().catch(() => setError('无法刷新会话。')) }, 40) }
        void refresh().catch(() => setError('无法加载会话。'))
        let paint: ReturnType<typeof setTimeout> | undefined
        const unsubscribe = runtime.subscribe(event => {
            const data = event.data as { type?: string; delta?: string }
            if (event.sessionId === selected.current && event.type === 'agent') {
                liveSequence.current = event.sequence
                if (data.type === 'text-delta') liveRef.current += data.delta ?? ''
                else if (['model-start', 'model-end', 'run-end'].includes(data.type ?? '')) liveRef.current = ''
                if (!paint) paint = setTimeout(() => { paint = undefined; if (mounted) setLive(liveRef.current) }, 40)
            }
            if (event.type !== 'agent' || !['text-delta', 'reasoning-delta', 'usage'].includes(data.type ?? '')) update()
        })
        const poll = setInterval(update, 1500)
        const resize = (): void => { setWidth(terminal.columns ?? 80); setHeight(terminal.rows ?? 24) }
        stdout.on('resize', resize)
        return () => { mounted = false; unsubscribe(); if (timer) clearTimeout(timer); if (paint) clearTimeout(paint); clearInterval(poll); stdout.off('resize', resize) }
    }, [refresh, runtime, stdout])
    useEffect(() => { setScroll(0) }, [panel, view?.id])
    useEffect(() => {
        let active = true
        if (observabilityPanel && view) void runtime.command({ type: 'observability', sessionId: view.id, action: 'summary' }).then(value => { if (active) setObservation(value as ObservabilityView) }, () => { if (active) setError('无法读取运行观测。') })
        return () => { active = false }
    }, [runtime, observabilityPanel, view?.id, view?.eventSequence])
    useEffect(() => {
        let active = true
        if (!view && snapshot) void runtime.command({ type: 'resources', workspace: snapshot.config.workspace }).then(value => { if (active) setSuggestionResources(value as ResourceView) }, () => { if (active) setError('无法读取输入建议。') })
        return () => { active = false }
    }, [runtime, view?.id, snapshot?.config.workspace, snapshot?.config.skills.disabled.join('\n')])

    const invoke = async (command: RuntimeCommand): Promise<void> => { setError(undefined); await runtime.command(command); await refresh() }
    const create = async (workspace?: string): Promise<void> => {
        const key = workspace ?? '', sessionId = creations.current.get(key) ?? crypto.randomUUID()
        creations.current.set(key, sessionId)
        const created = await runtime.command({ type: 'create', sessionId, ...(workspace ? { workspace } : {}) }) as SessionView
        creations.current.delete(key)
        beginSelection(created.id); await refresh()
    }
    const menu = (title: string, choices: Choice[]): void => { setPanel(undefined); setPicker({ title, choices }); setChoice(0) }
    const field = (label: string, value: string, save: Editor['save'], secret = false): void => {
        if (!editorRef.current) originalDraft.current = draftRef.current
        const next = { label, save, secret }; editorRef.current = next; setPicker(undefined); setEditor(next); edit(value, [...value].length)
    }
    const modelWizard = (): void => {
        const fields = ['id', 'provider', 'model', 'baseUrl', 'contextWindow', 'maxOutputTokens', 'apiKey'] as const
        const labels = ['配置 ID', 'Provider', '模型名称', 'Base URL', 'context 容量（已知模型可留空）', '最大输出 Tokens', 'API Key（可留空）']
        const values: Record<string, unknown> = {}
        const step = (index: number): void => field(`添加模型 · ${labels[index]}`, fields[index] === 'maxOutputTokens' ? '16384' : '', async value => {
            const name = fields[index]!
            if (!value.trim() && !['apiKey', 'contextWindow'].includes(name)) throw new Error('请填写此字段。')
            if (value) values[name] = ['contextWindow', 'maxOutputTokens'].includes(name) ? Number(value) : value
            if (index < fields.length - 1) step(index + 1)
            else await invoke({ type: 'config', patch: { models: [...snapshot?.config.models.filter(model => model.id !== values.id).map(model => ({ id: model.id })) ?? [], values] } })
        }, fields[index] === 'apiKey')
        step(0)
    }
    const mcpWizard = (): void => {
        const server: Record<string, unknown> = {}
        field('添加 MCP · Server ID', '', async id => {
            if (!id.trim()) throw new Error('请填写 Server ID。')
            server.id = id
            field('传输：stdio 或 http', 'stdio', async transport => {
                if (!['stdio', 'http'].includes(transport)) throw new Error('传输只能为 stdio 或 http。')
                server.transport = transport
                field(transport === 'stdio' ? '启动程序' : 'Server URL', '', async target => {
                    server[transport === 'stdio' ? 'command' : 'url'] = target
                    field(transport === 'stdio' ? '参数（JSON 数组）' : '认证请求头（可选 JSON）', transport === 'stdio' ? '[]' : '', async value => {
                        if (value) server[transport === 'stdio' ? 'args' : 'headers'] = JSON.parse(value) as unknown
                        if (transport === 'stdio') field('环境变量（可选 JSON）', '', async json => {
                            if (json) server.env = JSON.parse(json) as unknown
                            await invoke({ type: 'config', patch: { mcp: [...snapshot?.config.mcp.filter(item => item.id !== id).map(item => ({ id: item.id })) ?? [], server] } })
                        }, true)
                        else await invoke({ type: 'config', patch: { mcp: [...snapshot?.config.mcp.filter(item => item.id !== id).map(item => ({ id: item.id })) ?? [], server] } })
                    }, transport === 'http')
                })
            })
        })
    }
    const configure = (): void => menu('配置', [
        { label: `工具授权：全局${snapshot?.config.approval === 'allow' ? '直接' : '询问'} · 当前${view?.approvalMode === 'deny' ? '拒绝' : view?.approvalMode === 'allow' ? '直接' : '询问'}`, action: async () => { await invoke({ type: 'config', patch: { approval: snapshot?.config.approval === 'allow' ? 'ask' : 'allow' } }); setPicker(undefined) } },
        { label: `新消息：${snapshot?.config.preferences.inputMode === 'steer' ? '完整边界引导' : '当前轮后排队'}`, action: async () => { await invoke({ type: 'config', patch: { preferences: { inputMode: snapshot?.config.preferences.inputMode === 'steer' ? 'queue' : 'steer' } } }); setPicker(undefined) } },
        { label: '模型连接', action: async () => modelMenu() }, { label: 'MCP 服务', action: async () => mcpMenu() },
        { label: '默认模型名称', action: async () => field('默认 Chat 模型', snapshot?.config.model.model ?? '', async model => invoke({ type: 'config', patch: { model: { model } } })) },
        { label: '默认 Base URL', action: async () => field('Base URL（留空保留当前值）', '', async baseUrl => { if (baseUrl) await invoke({ type: 'config', patch: { model: { baseUrl } } }) }) },
        { label: '默认 API Key', action: async () => field('API Key（留空保留当前值）', '', async apiKey => { if (apiKey) await invoke({ type: 'config', patch: { model: { apiKey } } }) }, true) },
        { label: `Memory：${snapshot?.config.memory.enabled ? '开启' : '关闭'}`, action: async () => { await invoke({ type: 'config', patch: { memory: { enabled: !snapshot?.config.memory.enabled } } }); setPicker(undefined) } },
        { label: '配置来源', action: async () => { setPicker(undefined); setPanel((view?.configSources ?? []).join('\n')) } }
    ])
    const modelMenu = (): void => menu('当前会话模型', [
        ...[{ id: 'default', model: view?.defaultModel?.model ?? snapshot?.config.model.model ?? '默认' }, ...view?.models ?? snapshot?.config.models ?? []].map(model => ({
            label: `${view?.modelId === model.id ? '✓ ' : ''}${model.id} · ${model.model}`, action: async () => { if (view) await invoke({ type: 'session-config', sessionId: view.id, modelId: model.id, reasoningEffort: null }); setPicker(undefined) } })),
        { label: '添加模型连接', action: async () => modelWizard() }
    ])
    const mcpMenu = async (): Promise<void> => {
        const workspace = view?.workspace ?? snapshot?.config.workspace
        const servers = await runtime.command({ type: 'mcp', action: 'status', ...(view ? { sessionId: view.id } : {}) }) as { id: string; enabled: boolean; globalEnabled?: boolean; status: string; toolCount: number; source: 'global' | 'project' }[]
        menu('MCP 服务', [
            ...servers.map(server => ({ label: `${server.id} · ${server.status} · ${server.toolCount} tools`, action: async () => {
                menu(server.id, [
                    { label: `当前工作目录：${server.enabled ? '启用' : '禁用'} · 切换`, action: async () => { await invoke({ type: 'mcp-set-enabled', serverId: server.id, scope: 'workspace', ...(workspace ? { workspace } : {}), enabled: !server.enabled }); await mcpMenu() } },
                    ...(server.globalEnabled === undefined ? [] : [{ label: `全局：${server.globalEnabled ? '启用' : '禁用'} · 切换`, action: async () => { await invoke({ type: 'mcp-set-enabled', serverId: server.id, scope: 'global', enabled: !server.globalEnabled }); await mcpMenu() } }]),
                    { label: '连接 / 重试', action: async () => { await invoke({ type: 'mcp', action: 'connect', serverId: server.id, ...(view ? { sessionId: view.id } : {}) }); await mcpMenu() } },
                    ...(server.source === 'global' ? [{ label: '移除全局配置', action: async () => { await invoke({ type: 'config', patch: { mcp: snapshot?.config.mcp.filter(item => item.id !== server.id).map(item => ({ id: item.id })) ?? [] } }); await mcpMenu() } }] : [{ label: '来自项目配置文件 · 查看来源', action: async () => { setPicker(undefined); setPanel((view?.configSources ?? []).join('\n')) } }])
                ])
            } })),
            { label: '添加 stdio / HTTP server', action: async () => mcpWizard() },
            ...(view?.untrustedMcp?.length ? [{ label: '允许此目录的 MCP 配置', action: async () => { await invoke({ type: 'config', patch: { trustedProjects: [...snapshot?.config.trustedProjects ?? [], view.workspace] } }); await mcpMenu() } }] : [])
        ])
    }
    const resumeMenu = (): void => menu('恢复主会话', snapshot?.sessions.filter(item => !item.parentId).sort((a, b) => b.updatedAt.localeCompare(a.updatedAt)).map(session => ({
        label: `${session.id.slice(0, 8)} · ${session.title} · ${session.unavailable ? '只读' : session.status}`, detail: session.workspace, action: async () => { beginSelection(session.id); await refresh() }
    })) ?? [])
    const submit = async (text: string): Promise<void> => {
        if (text.startsWith('/')) {
            const space = text.indexOf(' '), name = space < 0 ? text : text.slice(0, space), argument = space < 0 ? '' : text.slice(space + 1).trim()
            switch (name) {
                case '/new': await create(argument || undefined); return
                case '/spawn': break
                case '/sessions': case '/resume': if (argument) { if (!snapshot?.sessions.some(item => item.id === argument)) throw new Error('会话不存在。'); beginSelection(argument); await refresh() } else resumeMenu(); return
                case '/open': { const session = snapshot?.sessions.find((item, index) => item.id === argument || String(index + 1) === argument); if (!session) throw new Error('会话不存在。'); beginSelection(session.id); await refresh(); return }
                case '/tasks': menu('任务与父会话', snapshot?.sessions.filter(item => item.parentId === view?.id || item.id === view?.parentId).map(item => ({
                    label: `${item.id === view?.parentId ? '↑ 父会话' : '↳ 子任务'} · ${item.title} · ${item.unavailable ? '只读' : item.status}`, detail: item.id,
                    action: async () => { beginSelection(item.id); await refresh() }
                })) ?? []); return
                case '/config': if (argument) { await invoke({ type: 'config', patch: JSON.parse(argument) }); setPanel('配置已保存。') } else configure(); return
                case '/model': if (argument && view) await invoke({ type: 'session-config', sessionId: view.id, modelId: argument, reasoningEffort: null }); else modelMenu(); return
                case '/effort': {
                    const model = !view || view.modelId === 'default' ? view?.defaultModel ?? snapshot?.config.model : view.models?.find(model => model.id === view.modelId)
                    if (!model?.reasoningEfforts?.length) { setPanel('目录接口未提供思考档位；请在模型配置中明确支持范围。'); return }
                    const preferred = view?.preferences?.reasoningEffort ?? snapshot?.config.preferences.reasoningEffort ?? 'high'
                    const inherited = model.reasoningEffort ?? (model.reasoningEfforts.includes(preferred) ? preferred : undefined)
                    const effective = view?.reasoningEffort ?? inherited
                    menu('思考强度', model.reasoningEfforts.map(effort => ({ label: effort,
                        action: async () => { if (view) await invoke({ type: 'session-config', sessionId: view.id, reasoningEffort: effort === inherited ? null : effort }); setPicker(undefined) } })))
                    setChoice(effective ? Math.max(0, model.reasoningEfforts.indexOf(effective)) : 0); return
                }
                case '/mcp': if (argument.startsWith('add ')) { await invoke({ type: 'config', patch: { mcp: [...snapshot?.config.mcp.map(item => ({ id: item.id })) ?? [], JSON.parse(argument.slice(4))] } }) } else await mcpMenu(); return
                case '/agents': { const resources = await runtime.command({ type: 'resources', ...(view ? { workspace: view.workspace } : {}) }) as ResourceView; setPanel(resources.agents.agents.map(agent => `${agent.name} · ${agent.model ?? 'inherit'} · 思考 ${agent.effort ?? '继承'}\n${agent.description}\n权限 ${agent.permissionMode ?? 'default'} · 工具 ${agent.tools?.join(', ') ?? '继承'} · 禁止 ${agent.disallowedTools?.join(', ') ?? '无'}\n${agent.source}`).join('\n\n') || '在 ~/.quifox/agents 或项目 .quifox/agents、.claude/agents 下添加 Agent .md 定义。'); return }
                case '/models': await invoke({ type: 'refresh-models' }); setPanel('模型资料已刷新；资料不代表请求验证通过。'); return
                case '/skills': { const resources = await runtime.command({ type: 'resources', ...(view ? { workspace: view.workspace } : {}) }) as ResourceView; setPanel(!resources.skillsEnabled ? '技能插件已停用；可在插件配置中启用。' : resources.skills.skills.filter(skill => !resources.disabledSkills?.includes(skill.id)).map(skill => `${skill.name} · ${skill.description}\n$${skill.id}`).join('\n\n') || '当前目录没有发现技能。'); return }
                case '/memory': if (view) { await invoke({ type: 'memory', sessionId: view.id }); setPanelState('Memory'); setMemoryPanel(true) } else { const resources = await runtime.command({ type: 'resources' }) as ResourceView; setPanel(resources.memory.content || '暂无记忆内容。') }; return
                case '/trace': setPanel(traceText(view?.events ?? [])); return
                case '/observability': {
                    if (!view) { setPanel('选择一个会话查看运行观测。'); return }
                    const summary = await runtime.command({ type: 'observability', sessionId: view.id, action: 'summary' }) as ObservabilityView
                    setObservation(summary); setPanelState('Observability'); setMemoryPanel(false); setObservabilityPanel(true)
                    return
                }
                case '/continue': if (view) await invoke({ type: 'resume', sessionId: view.id, mode: 'replan' }); return
                case '/stop': if (view) await invoke({ type: 'stop', sessionId: view.id }); return
                case '/approve': case '/deny': {
                    const approval = view?.approvals[0]
                    if (!view || !approval) throw new Error('当前没有待审批操作。')
                    await invoke({ type: 'approve', sessionId: view.id, approvalId: approval.id, approved: name === '/approve' }); return
                }
                case '/help': setPanel(builtinCommands.map(([name, description]) => `${name} · ${description}`).join('\n')); return
                default: if (!view?.skills.skills.some(skill => `/${skill.name}` === name)) throw new Error('命令或技能不存在；输入 / 筛选。')
            }
        }
        if (view?.unavailable) throw new Error(view.unavailable)
        let id = selected.current
        if (id && view?.id !== id) throw new Error('会话正在载入，请保留消息并稍后发送。')
        if (!id) { await create(); id = selected.current; edit(text, [...text].length) }
        if (id) {
            const previous = admissions.current.get(id)
            const admission = previous?.prompt === text ? previous : { prompt: text, id: crypto.randomUUID(), mode: view?.preferences?.inputMode ?? snapshot?.config.preferences.inputMode ?? 'queue' }
            admissions.current.set(id, admission)
            const receipt = await runtime.command({ type: 'submit', sessionId: id, prompt: text, mode: admission.mode, messageId: admission.id }) as InputRoutingReceipt | undefined
            await refresh()
            if (receipt?.kind === 'spawn') {
                setPanel(receipt.agents.map(agent => `Agent ${agent.name} 已创建 · 待机\n@${agent.name}  ${agent.taskId}`).join('\n\n'))
                if (!receipt.accepted) throw new Error(receipt.errors.join('；'))
            } else if (receipt?.kind === 'dispatch') {
                setPanel(receipt.deliveries.map(item => `@${item.agent.name} · ${item.status === 'queued' ? '消息已接纳' : item.error ?? '未接纳'}`).join('\n'))
                if (!receipt.accepted) throw new Error('部分子 Agent 消息未接纳，请重试同一条输入。')
            }
            admissions.current.delete(id)
        }
    }

    const suggest = (text: string, position: number) => inputSuggestions(text, [...text].slice(0, position).join('').length, {
        agents: selected.current ? agentRecipients(snapshotRef.current?.sessions ?? [], selected.current) : [],
        skills: (view ? view.skills.skills : suggestionResources?.skillsEnabled ? suggestionResources.skills.skills : []).filter(skill => !suggestionResources?.disabledSkills?.includes(skill.id)),
        commands: builtinCommands.map(([name, description]) => ({ name, description }))
    }).map(completion => ({ name: completion.label, description: completion.description, completion }))
    const currentModel = view?.modelId && view.modelId !== 'default' ? view.models?.find(model => model.id === view.modelId)?.model : view?.defaultModel?.model
    const suggestions = !editor && !mentionsDismissed ? suggest(draft, cursor) : []
    const complete = (items = suggestions): void => {
        const item = items[Math.min(choiceRef.current, items.length - 1)]
        if (!item) return
        const head = draftRef.current.slice(0, item.completion.start) + item.completion.text
        edit(head + draftRef.current.slice(item.completion.end), [...head].length)
        setChoice(0)
    }

    useInput((input, key) => {
        const inputSuggestions = !editorRef.current && !mentionsDismissedRef.current ? suggest(draftRef.current, cursorRef.current) : []
        const run = (operation: Promise<void>): void => { void operation.catch(cause => setError(cause instanceof SyntaxError ? '配置不是有效 JSON，请检查输入。' : editor?.secret ? '私密配置未保存，请检查格式与当前运行状态。' : cause instanceof Error ? cause.message : '操作未完成。')) }
        if (key.ctrl && input === 'c') { run(runtime.close().then(() => exit())); return }
        if (submitting.current && (editor || picker)) { setError('正在提交，请等待回执。'); return }
        if (key.escape) { if (editor) { editorRef.current = undefined; setEditor(undefined); edit(originalDraft.current, [...originalDraft.current].length) } else if (picker) setPicker(undefined); else if (panel) setPanel(undefined); else if (inputSuggestions.length) { mentionsDismissedRef.current = true; setMentionsDismissed(true) } else if (view) run(invoke({ type: 'stop', sessionId: view.id })); return }
        if (picker) {
            if (key.upArrow || key.downArrow) setChoice(index => (index + (key.upArrow ? -1 : 1) + picker.choices.length) % Math.max(1, picker.choices.length))
            if (key.return && picker.choices[choice] && !submitting.current) { submitting.current = true; run(picker.choices[choice]!.action().finally(() => { submitting.current = false })) }
            return
        }
        if (key.tab) { complete(inputSuggestions); return }
        if (key.upArrow || key.downArrow) {
            if (inputSuggestions.length) { setChoice(index => (index + (key.upArrow ? -1 : 1) + inputSuggestions.length) % inputSuggestions.length); return }
            const direction = key.upArrow ? -3 : 3
            setScroll(current => Math.max(0, Math.min(maxScroll, current + (panel ? direction : -direction)))); return
        }
        if (key.return && !key.shift) {
            if (inputSuggestions.length && (inputSuggestions[0]?.completion.kind !== 'command' || !inputSuggestions.some(item => item.name === draftRef.current.trim()))) { complete(inputSuggestions); return }
            if (editor) { if (!submitting.current) { submitting.current = true; const current = editor, value = draftRef.current; run(current.save(value).then(() => { if (editorRef.current === current) { editorRef.current = undefined; setEditor(undefined); edit(originalDraft.current, [...originalDraft.current].length) } }).finally(() => { submitting.current = false })) }; return }
            const original = draftRef.current, text = original.startsWith('/') ? original.trim() : original
            if (text.trim() && !submitting.current) {
                submitting.current = true; setPanel(undefined)
                const completed = text.startsWith('/') && !/\s/.test(text) && inputSuggestions.length && !inputSuggestions.some(item => item.name === text) ? inputSuggestions[Math.min(choiceRef.current, inputSuggestions.length - 1)]!.name : text
                run(submit(completed).then(() => { if (!editor && draftRef.current === original) edit('', 0) }).finally(() => { submitting.current = false }))
            }
            return
        }
        const characters = [...draftRef.current], position = cursorRef.current
        if (key.leftArrow) { edit(draftRef.current, Math.max(0, position - 1)); return }
        if (key.rightArrow) { edit(draftRef.current, Math.min(characters.length, position + 1)); return }
        if (key.home || (key.ctrl && input === 'a')) { edit(draftRef.current, 0); return }
        if (key.end || (key.ctrl && input === 'e')) { edit(draftRef.current, characters.length); return }
        if (key.backspace || key.delete) { if (position > 0) { characters.splice(position - 1, 1); edit(characters.join(''), position - 1) }; return }
        if (key.ctrl || key.meta) return
        const insertion = key.return ? '\n' : safe(input.replace(/\r/g, '\n'))
        setChoice(0)
        characters.splice(position, 0, ...insertion); edit(characters.join(''), position + [...insertion].length)
    })

    const approval = view?.approvals[0]
    const compact = height < 18, suggestionCount = Math.max(1, Math.min(compact ? 4 : 8, height - (compact ? 8 : 14)))
    const suggestionStart = Math.max(0, Math.min(choice, suggestions.length - 1) - suggestionCount + 1)
    const suggestionRows = Math.min(suggestions.length, suggestionCount) + Number(suggestions.length > suggestionCount)
    useEffect(() => {
        if (viewport.current && content.current) setMaxScroll(Math.max(0, Math.ceil(measureElement(content.current).height - measureElement(viewport.current).clientHeight)))
    }, [view, panel, width, height, error, live, picker, editor, suggestionRows])
    const characters = [...(editor?.secret ? '•'.repeat([...draft].length) : safe(draft))], span = Math.max(1, Math.floor((width - 15) / 2))
    const start = Math.min(Math.max(0, cursor - Math.floor(span / 2)), Math.max(0, characters.length - span))
    const beforeCursor = characters.slice(start, cursor).join('').replace(/\n/g, '↵'), afterCursor = characters.slice(cursor + 1, start + span).join('').replace(/\n/g, '↵')
    return <Box flexDirection="column" width={Math.max(20, width)} height={Math.max(12, height)} overflow="hidden" paddingX={1}>
        {compact ? <Box height={1} flexShrink={0}><Text bold color="#58a6eb" wrap="truncate">QUIFOX · {view?.status ?? 'ready'}</Text></Box> : <Box gap={2} height={4} flexShrink={0}><Fox /><Box flexDirection="column" justifyContent="center" flexGrow={1} minWidth={0}><Text bold color="#58a6eb">QUIFOX</Text><Text dimColor wrap="truncate">{safe(currentModel ?? snapshot?.config.model.model ?? '正在连接…')} · {view?.status ?? 'ready'}</Text><Text dimColor wrap="truncate">{safe(view?.title ?? '新的编程会话')}</Text></Box></Box>}
        {!compact && <Box height={1} flexShrink={0}><Text dimColor wrap="truncate-middle">{safe(view?.workspace ?? snapshot?.config.workspace ?? '')}</Text></Box>}
        <Box ref={viewport} flexDirection="column" flexGrow={1} flexShrink={1} minHeight={0} overflow="hidden" marginTop={1} contentOffsetY={panel ? Math.min(scroll, maxScroll) : Math.max(0, maxScroll - scroll)}>
        <Box ref={content} flexDirection="column" flexShrink={0}>
        {picker ? <Box flexDirection="column"><Text bold>{safe(picker.title)}</Text>{picker.choices.slice(Math.max(0, choice - 3), Math.max(0, choice - 3) + Math.max(3, height - 14)).map((item, index) => <Text key={index + Math.max(0, choice - 3)} inverse={index + Math.max(0, choice - 3) === choice} wrap="truncate">{index + Math.max(0, choice - 3) === choice ? '› ' : '  '}{safe(item.label)}</Text>)}<Text dimColor>↑↓ 选择 · Enter 确认 · Esc 返回</Text></Box> : panel ? <Box borderStyle="round" flexDirection="column" paddingX={1}><Text>{safe((observabilityPanel ? observabilityText(observation) : memoryPanel ? `${view?.memory.processing ? 'Memory 正在整理…\n' : ''}${view?.memory.error ? `${view.memory.error}\n` : ''}${view?.memory.content || (view?.memory.enabled ? 'Memory 当前为空。' : 'Memory 已关闭。')}` : panel).slice(0, 6000))}</Text></Box> :
            <Box flexDirection="column" marginTop={1}>{view?.messages.slice(-6).map(entry => <Box key={entry.id} flexDirection="column" marginBottom={1}>
                <Text color={entry.message.role === 'user' ? '#f4cf64' : entry.message.role === 'tool' ? '#9babc0' : '#58a6eb'} bold>{safe(entry.message.role === 'tool' ? entry.message.toolName : entry.message.role)}</Text>
                <Text>{safe((entry.message.role === 'tool' ? toolResultText(entry.message.content) : entry.message.content).slice(-2200) || (entry.message.role === 'assistant' && entry.message.toolCalls?.length ? entry.message.toolCalls.map(toolSummary).join('\n') : ''))}</Text>
            </Box>)}{live && <Box flexDirection="column"><Text>QuiFox</Text><Text>{safe(live.slice(-2200))}</Text></Box>}</Box>}
        </Box></Box>
        {approval && <Box borderStyle="round" flexDirection="column" paddingX={1} flexShrink={0}><Text bold wrap="truncate">需要批准：{safe(approval.call.name)}</Text><Text wrap="truncate-middle">{safe(approval.inspection?.summary ?? toolSummary(approval.call))}</Text><Text dimColor wrap="truncate">/approve · /deny · /trace 查看差异与参数</Text></Box>}
        {!!view?.pendingMessages.length && <Box height={1} flexShrink={0}><Text dimColor>{view.pendingMessages.length} 条待接纳消息</Text></Box>}
        {view?.unavailable && <Box height={1} flexShrink={0}><Text color="yellow" wrap="truncate">只读：{safe(view.unavailable)}</Text></Box>}
        {view?.displayTruncated && !compact && <Box height={1} flexShrink={0}><Text dimColor wrap="truncate">较长内容仅显示预览。</Text></Box>}
        {error && <Box height={1} flexShrink={0}><Text color="red" wrap="truncate">{safe(error)}</Text></Box>}
        {!!suggestions.length && <Box flexDirection="column" flexShrink={0}>{suggestions.slice(suggestionStart, suggestionStart + suggestionCount).map((item, index) => <Box key={item.name}>
            <Box width={2}><Text>{index + suggestionStart === choice ? '›' : ' '}</Text></Box><Box width={Math.min(16, Math.max(8, width - 14))}><Text bold={index + suggestionStart === choice} wrap="truncate">{safe(item.name)}</Text></Box>
            <Box flexGrow={1} minWidth={0}><Text dimColor={index + suggestionStart !== choice} wrap="truncate">{safe(item.description)}</Text></Box>
        </Box>)}{suggestions.length > suggestionCount && <Text dimColor wrap="truncate">{suggestionStart + 1}–{Math.min(suggestions.length, suggestionStart + suggestionCount)} / {suggestions.length}</Text>}</Box>}
        {editor && <Text dimColor wrap="truncate">{safe(editor.label)}</Text>}
        <Box borderStyle="single" borderLeft={false} borderRight={false} borderDimColor paddingX={1} height={3} flexShrink={0}><Text dimColor>› </Text><Text>{start > 0 ? '…' : ''}{beforeCursor}<Text inverse>{characters[cursor]?.replace(/\n/g, '↵') ?? ' '}</Text>{afterCursor}</Text></Box>
    </Box>
}

export function liveText(events: RuntimeEvent[]): string {
    let text = ''
    for (const event of events) {
        if (event.type !== 'agent') continue
        const data = event.data as { type?: string; delta?: string }
        if (data.type === 'model-start' || data.type === 'model-end' || data.type === 'run-end') text = ''
        else if (data.type === 'text-delta') text += data.delta ?? ''
    }
    return text
}

function observabilityText(summary?: ObservabilityView): string {
    const run = summary?.runs.at(-1)
    if (!run) return 'Observability · 暂无运行记录。'
    const pending = run.status === 'running' ? '运行中' : '未收到回执'
    const calls = [...run.models.map(item => ({ time: item.timestampMs, text: `模型 #${item.index} · ${item.finishReason} · ${item.durationMs} ms` })),
        ...run.tools.map(item => ({ time: item.timestampMs, text: `${item.name} · ${item.status} · ${item.durationMs} ms` })),
        ...run.pendingModels.map(item => ({ time: item.timestampMs, text: `模型 #${item.index} · ${pending}` })),
        ...run.pendingTools.map(item => ({ time: item.timestampMs, text: `${item.name} · ${pending}` }))].sort((a, b) => a.time - b.time)
    return `Observability · ${run.runId}\n${run.status} · ${run.status === 'running' ? '进行中' : run.status === 'unknown' ? '终态未知' : `${run.durationMs} ms`}\n模型 ${run.modelCalls} · 工具 ${run.toolCalls} · 工具错误 ${run.toolErrors}\nTokens ${run.usage.totalTokens ?? '未报告'}\n${run.errors.map(item => `${item.phase} · ${item.code}`).join('\n')}\n${calls.slice(-10).map(item => item.text).join('\n')}`
}
