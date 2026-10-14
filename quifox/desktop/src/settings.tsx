import { useCallback, useEffect, useRef, useState, type FormEvent } from 'react'
import type { ModelCatalogView, ResourceView, RuntimeCommand, RuntimeSnapshot, SessionView } from '@quifox/shared-runtime'
import { MarkdownBody } from './presentation.js'
import { SelectMenu } from './select-menu.js'
import { Icon, type IconName } from './icons.js'
import { shortcutKey, shortcutLabel } from './shortcuts.js'
import { Dialog, DialogTitle, Disclosure, EmptyState, FieldHint, HintTooltip, SettingSwitch, StatusMessage } from './ui.js'

type Config = RuntimeSnapshot['config']
type Command = (command: RuntimeCommand) => Promise<unknown>
type Section = 'model' | 'appearance' | 'interaction' | 'permissions' | 'mcp' | 'agents' | 'skills' | 'instructions' | 'memory' | 'context'
const sections: readonly [Section, string, IconName][] = [
    ['model', '模型', 'model'], ['appearance', '外观', 'appearance'], ['interaction', '交互', 'interaction'], ['permissions', '权限', 'shield'],
    ['mcp', 'MCP', 'plugins'], ['agents', '子智能体', 'agents'], ['skills', '技能', 'skills'], ['instructions', '项目指引', 'file'],
    ['memory', '记忆', 'memory'], ['context', '上下文', 'context']
]

export function Settings({ config, view, workspace, workspaceScopeAvailable = true, collapsed = false, save, command }: {
    config: Config; view?: SessionView | undefined; workspace: string; workspaceScopeAvailable?: boolean; collapsed?: boolean; save(patch: unknown): Promise<void>; command: Command
}) {
    const [section, setSection] = useState<Section>('model'), [error, setError] = useState<string>()
    const [resourceState, setResources] = useState<{ workspace: string; view: ResourceView }>()
    const resources = resourceState?.workspace === workspace ? resourceState.view : undefined
    const resourceWorkspace = useRef(workspace); resourceWorkspace.current = workspace
    const loadResources = (): void => {
        void command({ type: 'resources', workspace }).then(value => { if (resourceWorkspace.current === workspace) setResources({ workspace, view: value as ResourceView }) }, cause => { if (resourceWorkspace.current === workspace) setError(cause instanceof Error ? cause.message : '资源读取失败。') })
    }
    useEffect(() => { let active = true; void command({ type: 'resources', workspace }).then(value => { if (active) setResources({ workspace, view: value as ResourceView }) },
        cause => { if (active) setError(cause instanceof Error ? cause.message : '资源读取失败。') }); return () => { active = false } }, [workspace, command])
    const pending = useRef(0), [saving, setSaving] = useState(false)
    const transaction = useCallback(async <T,>(operation: () => Promise<T>): Promise<T> => {
        pending.current += 1; setSaving(true); setError(undefined)
        try { return await operation() } finally { pending.current -= 1; setSaving(pending.current > 0) }
    }, [])
    const commit = async (patch: unknown): Promise<void> => { await transaction(() => save(patch)); loadResources() }
    const invoke: Command = useCallback(request => transaction(() => command(request)), [command, transaction])
    return <section className="settings-page" aria-label="设置">
        {saving && <StatusMessage>正在处理…</StatusMessage>}
        {error && <StatusMessage error>{error}</StatusMessage>}
        <div className="settings-layout" data-collapsed={collapsed}>
            <aside id="settings-navigation" className="settings-navigation" hidden={collapsed} aria-label="设置分类">
                <nav>{sections.map(([id, label, icon]) => {
                    const button = <button key={id} aria-label={label} aria-pressed={section === id} onClick={() => { setSection(id); setError(undefined) }}><span aria-hidden="true"><Icon name={icon}/></span>{!collapsed && <span>{label}</span>}</button>
                    return <HintTooltip key={id} label={label}>{button}</HintTooltip>
                })}</nav>
            </aside>
            <main className="settings-main">
                {resources?.displayTruncated && <StatusMessage>资源较多，当前展示已限制。</StatusMessage>}
                {section === 'model' && <ModelSettings config={config} save={commit} command={command} report={setError}/>}
                {section === 'appearance' && <AppearanceSettings config={config} save={commit} report={setError}/>}
                {section === 'interaction' && <InteractionSettings config={config} save={commit} report={setError}/>}
                {section === 'permissions' && <PermissionSettings config={config} save={commit} report={setError}/>}
                {section === 'mcp' && <McpSettings config={config} view={view} workspace={workspace} workspaceScopeAvailable={workspaceScopeAvailable} command={invoke} save={commit} report={setError}/>}
                {section === 'agents' && <AgentSettings resources={resources}/>}
                {section === 'skills' && <SkillSettings config={config} resources={resources} save={commit} report={setError}/>}
                {section === 'instructions' && <InstructionSettings workspace={workspace} command={invoke}/>}
                {section === 'memory' && <MemorySettings config={config} resources={resources} sessionId={view?.id} command={invoke} save={commit} report={setError}/>}
                {section === 'context' && <ContextSettings config={config} save={commit} report={setError}/>}
            </main>
        </div>
    </section>
}

const effortChoices = ['none', 'low', 'medium', 'high', 'xhigh', 'max'] as const
const sameOrigin = (left: string, right: string): boolean => { try { return new URL(left).origin === new URL(right).origin } catch { return false } }

function ModelSettings({ config, save, command, report }: { config: Config; save(patch: unknown): Promise<void>; command: Command; report(error: string): void }) {
    const [selected, setSelected] = useState('default'), [adding, setAdding] = useState(false), [editing, setEditing] = useState(false), [busy, setBusy] = useState(false)
    const [editError, setEditError] = useState('')
    const [id, setId] = useState(''), [label, setLabel] = useState(''), [key, setKey] = useState('')
    const profile = selected === 'default' ? config.model : config.models.find(model => model.id === selected)
    const [provider, setProvider] = useState(profile?.provider ?? ''), [model, setModel] = useState(profile?.model ?? ''), [baseUrl, setBaseUrl] = useState(profile?.baseUrl ?? '')
    const [context, setContext] = useState(String(profile?.contextWindow ?? '')), [output, setOutput] = useState(String(profile?.maxOutputTokens ?? 16384))
    const [efforts, setEfforts] = useState<readonly string[]>(profile?.reasoningSource === 'configuration' ? profile.reasoningEfforts ?? [] : [])
    const [manual, setManual] = useState(profile?.reasoningSource === 'configuration'), [custom, setCustom] = useState(false)
    const [catalog, setCatalog] = useState<ModelCatalogView>(), [catalogError, setCatalogError] = useState('')
    const [catalogProvider, setCatalogProvider] = useState(provider)
    useEffect(() => {
        let active = true; setCatalogError('')
        const load = (): void => { void command({ type: 'model-catalog', ...(provider ? { provider } : {}) }).then(value => { if (active) { setCatalog(value as ModelCatalogView); setCatalogProvider(provider); setCatalogError('') } }, cause => { if (active) setCatalogError(cause instanceof Error ? cause.message : '模型目录读取失败。') }) }
        load(); const timer = setInterval(load, 1_800_000)
        return () => { active = false; clearInterval(timer) }
    }, [provider, command])
    const known = !custom && !!catalog?.providers.some(item => item.id === provider)
    const models = catalogProvider === provider ? catalog?.models ?? [] : []
    const choose = (next: string): void => {
        const current = next === 'default' ? config.model : config.models.find(model => model.id === next)
        setSelected(next); setAdding(false); setEditing(true); setEditError(''); setId(next); setKey(''); setLabel(next === 'default' ? '' : config.models.find(model => model.id === next)?.label ?? '')
        setProvider(current?.provider ?? ''); setModel(current?.model ?? ''); setBaseUrl(current?.baseUrl ?? ''); setContext(String(current?.contextWindow ?? '')); setOutput(String(current?.maxOutputTokens ?? 16384))
        setEfforts(current?.reasoningSource === 'configuration' ? current.reasoningEfforts ?? [] : []); setManual(current?.reasoningSource === 'configuration'); setCustom(false)
    }
    const submit = async (event: FormEvent): Promise<void> => {
        event.preventDefault(); setBusy(true)
        try {
            const fields = { provider, model, ...(adding || baseUrl !== profile?.baseUrl ? { baseUrl } : {}), maxOutputTokens: Number(output), contextWindow: context ? Number(context) : null,
                reasoningEfforts: manual ? efforts : null, ...((provider !== profile?.provider || model !== profile?.model || (profile?.reasoningEffort && (!manual || !efforts.includes(profile.reasoningEffort)))) ? { reasoningEffort: null } : {}), ...(key ? { apiKey: key } : {}) }
            await save(selected === 'default' && !adding ? { model: fields } : { models: [...config.models.filter(item => item.id !== id).map(item => ({ id: item.id })), { ...fields, id, ...(label ? { label } : {}) }] })
            setKey(''); if (adding) setSelected(id); setAdding(false); setEditing(false)
        } catch (cause) { const message = cause instanceof Error ? cause.message : '模型配置未保存。'; setEditError(message); report(message) } finally { setBusy(false) }
    }
    const closeEditor = (): void => { if (!busy) { setEditing(false); setKey(''); setEditError('') } }
    return <div className="settings-form">
        <div className="settings-section-heading"><div><h3>模型</h3></div>
            <button type="button" onClick={event => { event.currentTarget.focus(); setAdding(true); setEditing(true); setEditError(''); setId(''); setLabel(''); setProvider(''); setModel(''); setBaseUrl(''); setKey(''); setContext(''); setOutput('16384'); setCustom(false); setManual(false); setEfforts([]) }}>＋ 添加</button></div>
        <div className="model-profile-list" aria-label="已配置模型">{[{ ...config.model, id: 'default', label: '默认连接' }, ...config.models].map(item => <button type="button" key={item.id} aria-haspopup="dialog" aria-label={`编辑${item.label ?? item.id}`} onClick={event => { event.currentTarget.focus(); choose(item.id) }}><Icon name="model"/><span><strong>{item.label ?? item.id}</strong><span>{item.provider} · {item.model}</span></span><span className="model-key-state">{item.hasApiKey ? '已配置' : '缺少密钥'}</span></button>)}</div>
        {editing && <Dialog label="model-editor-heading" close={closeEditor}><form className="modal model-editor" onSubmit={event => { void submit(event) }}><div className="modal-heading"><DialogTitle id="model-editor-heading">{adding ? '新增模型连接' : '编辑模型连接'}</DialogTitle><button type="button" className="icon-button" aria-label="关闭模型编辑" disabled={busy} onClick={closeEditor}><Icon name="close"/></button></div><div className="settings-form model-editor-content">{editError && <StatusMessage error>{editError}</StatusMessage>}<fieldset disabled={busy}>
        {(adding || selected !== 'default') && <div className="field-row"><label>配置名称<input required value={id} disabled={!adding} onChange={event => setId(event.target.value)} placeholder="review-model"/></label><label>显示名称<input value={label} onChange={event => setLabel(event.target.value)}/></label></div>}
        <div className="field-row"><div className="field-control"><span>供应商</span><SelectMenu label="供应商" searchable value={known ? provider : 'custom'}
            options={[...(catalog?.providers ?? []).map(item => ({ value: item.id, label: item.name })), { value: 'custom', label: '自定义 Chat' }]} onChange={value => {
                if (value === 'custom') { setCustom(true); setProvider('custom-chat'); setManual(false); setEfforts([]); return }
                setCustom(false); setProvider(value); setBaseUrl(catalog?.providers.find(item => item.id === value)?.baseUrl ?? ''); setModel(''); setContext(''); setManual(false); setEfforts([])
            }}/></div>{!known && <label>Provider<input required value={provider} onChange={event => { setProvider(event.target.value); setManual(false); setEfforts([]) }} placeholder="custom-chat"/></label>}</div>
        {known ? <div className="field-control"><span>模型</span><SelectMenu label="模型目录" searchable value={model}
            options={[...models.map(item => ({ value: item.id, label: item.name === item.id ? item.id : `${item.name} · ${item.id}` })), ...(!models.some(item => item.id === model) && model ? [{ value: model, label: `${model} · 当前配置` }] : [])]}
            onChange={value => { setModel(value); setContext(''); setManual(false); setEfforts([]) }}/></div> : <label>模型名称<input required value={model} onChange={event => { setModel(event.target.value); setContext(''); setManual(false); setEfforts([]) }}/></label>}
        {catalogError && <StatusMessage error>{catalogError}</StatusMessage>}
        <label>Base URL<input type="url" required value={baseUrl} onChange={event => setBaseUrl(event.target.value)}/></label>
        <label>API Key<input type="password" autoComplete="off" value={key} onChange={event => setKey(event.target.value)}
            placeholder={profile?.hasApiKey && !adding && sameOrigin(baseUrl, profile.baseUrl) ? '已配置；留空保留密钥' : '输入新连接的密钥'}/></label>
        <div className="field-row"><label>Context 容量<input type="number" min="1" value={context} onChange={event => setContext(event.target.value)} placeholder="由模型资料确定"/></label>
            <label>最大输出 Tokens<input type="number" min="1" value={output} required onChange={event => setOutput(event.target.value)}/></label></div>
        <div className="settings-section-heading compact"><h3>思考能力</h3><HintTooltip label="目录没有提供档位时才需要手动声明。none 表示关闭思考。"><button type="button" className="help-button" aria-label="思考能力说明">?</button></HintTooltip></div>
        <SettingSwitch label="手动配置能力" checked={manual} onCheckedChange={setManual}/>
        {manual ? <div className="effort-options">{effortChoices.map(value => <label className="check-label" key={value}><input type="checkbox" checked={efforts.includes(value)}
            onChange={event => setEfforts(previous => event.target.checked ? [...previous, value] : previous.filter(item => item !== value))}/>{value}</label>)}</div>
            : <FieldHint>{profile?.reasoning === false && provider === profile.provider && model === profile.model ? '该模型不支持思考。' : (models.find(item => item.id === model)?.reasoningEfforts ?? profile?.reasoningEfforts)?.length ? `支持：${(models.find(item => item.id === model)?.reasoningEfforts ?? profile?.reasoningEfforts)?.join(' / ')}` : '目录接口未提供思考档位；如需设置，请手动配置。'}</FieldHint>}
        </fieldset></div><div className="modal-actions"><button type="button" disabled={busy} onClick={closeEditor}>取消</button><button className="primary" disabled={busy || !model.trim()}>{busy ? '保存中…' : '保存设置'}</button></div></form></Dialog>}
    </div>
}

function AppearanceSettings({ config, save, report }: { config: Config; save(patch: unknown): Promise<void>; report(error: string): void }) {
    const [theme, setTheme] = useState(config.preferences.theme), [scale, setScale] = useState(config.preferences.uiScale), [fontSize, setFontSize] = useState(config.preferences.fontSize), [busy, setBusy] = useState(false)
    useEffect(() => { setScale(config.preferences.uiScale) }, [config.preferences.uiScale])
    const [bindings, setBindings] = useState(config.preferences.shortcuts), [recording, setRecording] = useState<keyof typeof bindings>()
    const bindingNames = { newSession: '新建会话', zoomIn: '放大界面', zoomOut: '缩小界面', zoomReset: '恢复缩放' }
    const submit = async (event: FormEvent) => { event.preventDefault(); setBusy(true); try { await save({ preferences: { theme, uiScale: scale, fontSize, shortcuts: bindings } }) } catch (cause) { report(String(cause)) } finally { setBusy(false) } }
    return <form className="settings-form" onSubmit={event => { void submit(event) }}><fieldset disabled={busy}><h3>外观</h3>
        <div className="settings-row"><span>主题</span><div className="theme-options" role="group" aria-label="主题">{[['light', '明亮'], ['dark', '暗色'], ['system', '跟随系统']].map(([value, label]) => <button type="button" key={value} aria-pressed={theme === value} onClick={() => setTheme(value as typeof theme)}><span className={`theme-preview ${value}`}><i/><i/><i/></span>{label}</button>)}</div></div>
        <div className="field-control"><span>字体大小</span><SelectMenu label="字体大小" value={String(fontSize)} options={[14,15,16,17,18,19,20,21,22].map(value => ({ value: String(value), label: `${value} px` }))} onChange={value => setFontSize(Number(value))}/></div>
        <div className="field-control"><span>界面缩放</span><SelectMenu label="界面缩放" value={String(scale)} options={[.8,.9,1,1.1,1.2,1.3,1.4].map(value => ({ value: String(value), label: `${Math.round(value * 100)}%` }))} onChange={value => setScale(Number(value))}/></div>
        <h4 className="form-section-title">快捷键</h4><div className="shortcut-list">{Object.entries(bindingNames).map(([key, label]) => <div className="settings-row" key={key}><span>{label}</span><button type="button" aria-label={`修改${label}快捷键`} className="shortcut-binding" onClick={() => setRecording(key as keyof typeof bindings)} onKeyDown={event => {
            if (recording !== key) return
            if (event.key === 'Escape') { event.preventDefault(); event.stopPropagation(); setRecording(undefined); return }
            const binding = shortcutKey(event)
            if (!binding) return
            event.preventDefault(); event.stopPropagation()
            if (Object.entries(bindings).some(([other, value]) => other !== key && value === binding)) { report('这个快捷键已用于其他操作。'); return }
            setBindings(previous => ({ ...previous, [key]: binding })); setRecording(undefined)
        }}>{recording === key ? '按下快捷键…' : shortcutLabel(bindings[key as keyof typeof bindings])}</button></div>)}</div>
        <div className="form-actions"><button className="primary">保存外观</button></div></fieldset></form>
}

function InteractionSettings({ config, save, report }: { config: Config; save(patch: unknown): Promise<void>; report(error: string): void }) {
    const [mode, setMode] = useState(config.preferences.inputMode), [effort, setEffort] = useState(config.preferences.reasoningEffort ?? 'high'), [busy, setBusy] = useState(false)
    const submit = async (event: FormEvent) => { event.preventDefault(); setBusy(true); try { await save({ preferences: { inputMode: mode, reasoningEffort: effort } }) } catch (cause) { report(String(cause)) } finally { setBusy(false) } }
    return <form className="settings-form" onSubmit={event => { void submit(event) }}><fieldset disabled={busy}><h3>交互</h3>
        <label>运行中发送的新消息<select value={mode} onChange={event => setMode(event.target.value as typeof mode)}><option value="queue">当前轮结束后排队</option><option value="steer">下一完整请求边界引导</option></select></label>
        <div className="field-control"><span>全局思考偏好</span><SelectMenu label="全局思考偏好" value={effort} options={effortChoices.map(value => ({ value, label: value }))} onChange={value => setEffort(value as typeof effort)}/></div>
        <div className="form-actions"><button className="primary">保存交互设置</button></div></fieldset></form>
}

function PermissionSettings({ config, save, report }: { config: Config; save(patch: unknown): Promise<void>; report(error: string): void }) {
    const [approval, setApproval] = useState(config.approval), [busy, setBusy] = useState(false)
    const submit = async (event: FormEvent) => { event.preventDefault(); setBusy(true); try { await save({ approval }) } catch (cause) { report(String(cause)) } finally { setBusy(false) } }
    return <form className="settings-form" onSubmit={event => { void submit(event) }}><fieldset disabled={busy}><div className="settings-section-heading"><h3>工具权限</h3><HintTooltip label="完全访问跳过工具批准询问，Agent 的工具和路径限制仍然生效。"><button type="button" className="help-button" aria-label="权限说明">?</button></HintTooltip></div>
        <div className="field-control"><span>新会话默认权限</span><SelectMenu label="新会话默认权限" value={approval} options={[{ value: 'ask', label: '逐次询问' }, { value: 'allow', label: '完全访问' }]} onChange={value => setApproval(value as typeof approval)}/></div>
        <div className="form-actions"><button className="primary">保存权限</button></div></fieldset></form>
}

function McpSettings({ config, view, workspace, workspaceScopeAvailable, command, save, report }: { config: Config; view?: SessionView | undefined; workspace: string; workspaceScopeAvailable: boolean; command: Command; save(patch: unknown): Promise<void>; report(error: string): void }) {
    type Servers = { id: string; transport: string; enabled: boolean; globalEnabled?: boolean; status: string; toolCount: number; source: 'global' | 'project' }[]
    const identity = JSON.stringify([workspace, view?.id]), currentIdentity = useRef(identity); currentIdentity.current = identity
    const latestRequest = useRef(0)
    const [serverState, setServers] = useState<{ identity: string; value: Servers }>()
    const servers = serverState?.identity === identity ? serverState.value : undefined
    const [requestedScope, setScope] = useState<'global' | 'workspace'>('workspace'), [query, setQuery] = useState('')
    const scope = workspaceScopeAvailable ? requestedScope : 'global'
    const [editing, setEditing] = useState(false), [id, setId] = useState(''), [transport, setTransport] = useState<'stdio' | 'http'>('stdio')
    const [program, setProgram] = useState(''), [args, setArgs] = useState(''), [url, setUrl] = useState(''), [secrets, setSecrets] = useState(''), [busy, setBusy] = useState(false)
    const reload = async (): Promise<void> => {
        if (currentIdentity.current !== identity) return
        const revision = ++latestRequest.current
        try {
            const value = await command({ type: 'mcp', action: 'status', workspace, ...(view ? { sessionId: view.id } : {}) }) as Servers
            if (currentIdentity.current === identity && latestRequest.current === revision) setServers({ identity, value })
        } catch (cause) { if (currentIdentity.current === identity && latestRequest.current === revision) throw cause }
    }
    useEffect(() => { void reload().catch(() => report('MCP 状态读取失败。')); return () => { latestRequest.current += 1 } }, [config.mcp, view?.id, workspace])
    const act = async (operation: Promise<unknown>): Promise<boolean> => { setBusy(true); try { await operation; await reload(); return true } catch (cause) { await reload().catch(() => {}); report(cause instanceof Error ? cause.message : 'MCP 操作失败。'); return false } finally { setBusy(false) } }
    const toggle = async (serverId: string, enabled: boolean) => {
        await act(command({ type: 'mcp-set-enabled', serverId, scope, workspace, enabled }))
    }
    const add = async (event: FormEvent) => {
        event.preventDefault()
        try {
            const credentials: unknown = secrets ? JSON.parse(secrets) : undefined
            const server = transport === 'stdio' ? { id, transport, command: program, args: args ? JSON.parse(args) as unknown : [], ...(credentials ? { env: credentials } : {}) }
                : { id, transport, url, ...(credentials ? { headers: credentials } : {}) }
            if (await act(save({ mcp: [...config.mcp.filter(item => item.id !== id).map(item => ({ id: item.id })), server] }))) { setSecrets(''); setEditing(false) }
        } catch { report('MCP 参数或认证配置不是有效 JSON。') }
    }
    const matches = servers?.filter(server => server.id.toLowerCase().includes(query.toLowerCase()))
    return <div className="settings-form"><div className="settings-section-heading"><div><h3>MCP</h3></div><button onClick={() => setEditing(value => !value)}>{editing ? '取消' : '＋ 添加 MCP'}</button></div>
        {!!servers?.length && <div className="field-row"><div className="field-control"><span>启停作用域</span><SelectMenu label="MCP 启停作用域" value={scope} onChange={value => setScope(value as typeof requestedScope)} options={[...workspaceScopeAvailable ? [{ value: 'workspace', label: '当前工作目录' }] : [], { value: 'global', label: '全局' }]}/></div>
            <label>筛选 MCP<input type="search" value={query} onChange={event => setQuery(event.target.value)} placeholder="服务名称"/></label></div>}
        {!servers ? <StatusMessage>正在读取 MCP…</StatusMessage> : !servers.length ? <EmptyState title="尚未配置 MCP" description="添加 stdio 或 HTTP 服务后，它会出现在这里。" action={<button onClick={() => setEditing(true)}>添加 MCP</button>}/>
            : !matches?.length ? <EmptyState title="没有匹配的 MCP"/> : <div className="resource-list">{matches.map(server => <article className="resource-row" key={server.id}><div className="resource-row-main"><strong>{server.id}</strong>
                <div className="resource-meta">{server.transport.toUpperCase()} · {server.source === 'global' ? '全局连接' : '项目连接'} · {server.status} · {server.toolCount} 个工具</div>{server.status === 'error' && <FieldHint>连接失败；请检查服务配置和运行状态，然后重试。</FieldHint>}</div>
                <div className="resource-row-actions"><SettingSwitch label={`启用 ${server.id}`} labelHidden checked={scope === 'global' ? server.globalEnabled ?? false : server.enabled} disabled={busy || (scope === 'global' && server.globalEnabled === undefined)} onCheckedChange={value => { void toggle(server.id, value) }}/>
                    <button disabled={busy || server.status === 'untrusted' || server.status === 'disabled'} onClick={() => { void act(command({ type: 'mcp', action: 'connect', workspace, serverId: server.id, ...(view ? { sessionId: view.id } : {}) })) }}>连接 / 重试</button></div>
                {server.source === 'global' ? <button disabled={busy} onClick={() => { void act(save({ mcp: config.mcp.filter(item => item.id !== server.id).map(item => ({ id: item.id })) })) }}>移除全局配置</button> : <button disabled>来自项目配置文件</button>}
            </article>)}</div>}
        {servers?.some(server => server.status === 'untrusted') && <StatusMessage>当前目录包含尚未授权的 MCP 配置。</StatusMessage>}
        {servers?.some(server => server.status === 'untrusted') && <button disabled={busy} onClick={() => { void act(save({ trustedProjects: [...new Set([...config.trustedProjects, workspace])] })) }}>允许此目录的 MCP 配置</button>}
        {editing && <form className="editor-card" onSubmit={event => { void add(event) }}><h4>全局连接</h4><div className="field-row"><label>名称<input value={id} required onChange={event => setId(event.target.value)} placeholder="docs"/></label>
            <label>传输<select value={transport} onChange={event => setTransport(event.target.value as typeof transport)}><option value="stdio">stdio</option><option value="http">HTTP</option></select></label></div>
            {transport === 'stdio' ? <><label>启动程序<input value={program} required onChange={event => setProgram(event.target.value)} placeholder="npx"/></label><label>参数（JSON 数组）<input value={args} onChange={event => setArgs(event.target.value)} placeholder={'["-y", "server-package"]'}/></label></> :
                <label>Server URL<input type="url" value={url} required onChange={event => setUrl(event.target.value)}/></label>}
            <label>{transport === 'stdio' ? '环境变量' : '认证请求头'}（JSON，可选）<input type="password" autoComplete="off" value={secrets} onChange={event => setSecrets(event.target.value)}/></label>
            <div className="form-actions"><button className="primary" disabled={busy}>保存 MCP</button></div></form>}
    </div>
}

function AgentSettings({ resources }: { resources?: ResourceView | undefined }) {
    const [query, setQuery] = useState('')
    if (!resources) return <StatusMessage>正在读取 Agent 定义…</StatusMessage>
    const matches = resources.agents.agents.filter(agent => `${agent.name} ${agent.description}`.toLowerCase().includes(query.toLowerCase()))
    return <div className="settings-form"><div className="settings-section-heading"><h3>子智能体</h3><HintTooltip label="在用户 agents 或项目 .quifox/agents 目录添加 Markdown 定义，可配置名称、模型和工具范围。"><button type="button" className="help-button" aria-label="子智能体配置说明">?</button></HintTooltip></div>{!!resources.agents.agents.length && <div className="resource-toolbar"><input aria-label="筛选子智能体" type="search" placeholder="搜索名称或描述" value={query} onChange={event => setQuery(event.target.value)}/></div>}{!resources.agents.agents.length ? <EmptyState title="尚未配置子智能体" description="通过 Markdown 定义复用专业角色、模型和工具范围。"/> : !matches.length ? <EmptyState title="没有匹配的子智能体"/> :
        <div className="resource-list">{matches.map(agent => <article className="resource-row" key={agent.name}><Icon name="agents"/><div className="resource-row-main"><strong>{agent.name}</strong><div>{agent.description}</div>
            <div className="resource-meta">{agent.model ?? '继承模型'} · {agent.permissionMode === 'plan' ? '只读工具' : agent.permissionMode === 'dontAsk' ? '拒绝需批准操作' : '默认权限'}</div><Disclosure title="定义位置"><code>{agent.source}</code></Disclosure></div></article>)}</div>}
        {resources.agents.issues.map(issue => <StatusMessage error key={issue.source}>{issue.source}：{issue.message}</StatusMessage>)}</div>
}

function SkillSettings({ config, resources, save, report }: { config: Config; resources?: ResourceView | undefined; save(patch: unknown): Promise<void>; report(error: string): void }) {
    const [busy, setBusy] = useState(false), [query, setQuery] = useState('')
    if (!resources) return <StatusMessage>正在读取 Skills…</StatusMessage>
    const disabled = new Set(config.skills.disabled)
    const toggle = async (id: string, enabled: boolean) => {
        const next = new Set(config.skills.disabled); if (enabled) next.delete(id); else next.add(id)
        setBusy(true)
        try { await save({ skills: { disabled: [...next] } }) } catch (cause) { report(cause instanceof Error ? cause.message : 'Skill 设置未保存。') } finally { setBusy(false) }
    }
    const matches = resources.skills.skills.filter(skill => `${skill.name} ${skill.description}`.toLowerCase().includes(query.toLowerCase()))
    return <div className="settings-form"><h3>技能</h3>{!!resources.skills.skills.length && <div className="resource-toolbar"><input aria-label="筛选技能" type="search" placeholder="搜索名称或描述" value={query} onChange={event => setQuery(event.target.value)}/></div>}{!resources.skills.skills.length ? <EmptyState title="没有发现技能"/> : !matches.length ? <EmptyState title="没有匹配的技能"/> :
        <div className="resource-list">{matches.map(skill => <article className="resource-row" key={skill.id}><Icon name="skills"/><div className="resource-row-main"><h4>{skill.name}</h4><div>{skill.description}</div><Disclosure title="技能位置"><code>{skill.id}</code></Disclosure></div>
            <SettingSwitch label={`启用 ${skill.name}`} labelHidden checked={!disabled.has(skill.id)} disabled={busy} onCheckedChange={value => { void toggle(skill.id, value) }}/></article>)}</div>}
        {resources.skills.issues.map((issue, index) => <StatusMessage error key={index}>{issue.directory}：{issue.message}</StatusMessage>)}</div>
}

function InstructionSettings({ workspace, command }: { workspace: string; command: Command }) {
    const [data, setData] = useState<{ globalPath: string; globalContent: string; sources: { scope: string; path: string; displayPath: string; content: string }[] }>()
    const [content, setContent] = useState(''), [busy, setBusy] = useState(false), [error, setError] = useState('')
    const load = useCallback(async () => await command({ type: 'instructions', action: 'read', workspace }) as NonNullable<typeof data>, [command, workspace])
    useEffect(() => { let active = true; setData(undefined); setError(''); void load().then(next => { if (active) { setData(next); setContent(next.globalContent) } }, cause => { if (active) setError(cause instanceof Error ? cause.message : 'Instructions 读取失败。') }); return () => { active = false } }, [load])
    const save = async () => { setBusy(true); setError(''); try { await command({ type: 'instructions', action: 'save-global', workspace, content }); const next = await load(); setData(next); setContent(next.globalContent) } catch (cause) { setError(cause instanceof Error ? cause.message : '保存失败。') } finally { setBusy(false) } }
    if (!data && !error) return <StatusMessage>正在读取 Instructions…</StatusMessage>
    return <div className="settings-form"><h3>项目指引</h3>{error && <StatusMessage error>{error}</StatusMessage>}
        <label>全局 AGENTS.md<textarea className="instruction-editor" value={content} onChange={event => setContent(event.target.value)} placeholder="# 全局开发指引"/></label>
        <div className="resource-meta">{data?.globalPath}</div><div className="form-actions"><button className="primary" disabled={busy} onClick={() => { void save() }}>{busy ? '保存中…' : '保存全局指引'}</button></div>
        <h3>当前生效来源</h3>{!data?.sources.length ? <EmptyState title="没有生效的项目指引"/> : <div className="resource-list">{data.sources.map(source =>
            <Disclosure key={`${source.scope}/${source.path}`} title={source.scope === 'global-guidance' ? '全局 AGENTS.md' : source.displayPath}><pre className="instruction-preview">{source.content}</pre></Disclosure>)}</div>}</div>
}

function MemorySettings({ config, resources, sessionId, command, save, report }: { config: Config; resources?: ResourceView | undefined; sessionId?: string | undefined; command: Command; save(patch: unknown): Promise<void>; report(error: string): void }) {
    const [busy, setBusy] = useState(false)
    const [file, setFile] = useState<{ path: string; content: string; exists: boolean }>(), [fileError, setFileError] = useState('')
    useEffect(() => { let active = true; setFile(undefined); setFileError(''); void command({ type: 'memory-file', ...(sessionId ? { sessionId } : {}) }).then(value => { if (active) setFile(value as NonNullable<typeof file>) }, cause => { if (active) setFileError(cause instanceof Error ? cause.message : '记忆文件读取失败。') }); return () => { active = false } }, [command, sessionId])
    const { enabled, generate } = config.memory
    const commit = async (nextEnabled = enabled, nextGenerate = generate) => {
        setBusy(true); try { await save({ memory: { enabled: nextEnabled, generate: nextGenerate } }) } catch (cause) { report(cause instanceof Error ? cause.message : 'Memory 设置未保存。') } finally { setBusy(false) }
    }
    return <div className="settings-form"><h3>记忆</h3><SettingSwitch label="向 Agent 提供记忆" checked={enabled} disabled={busy} onCheckedChange={value => { void commit(value, generate) }}/>
        <SettingSwitch label="后台生成记忆" checked={generate} disabled={busy || !enabled} onCheckedChange={value => { void commit(enabled, value) }}/>
        {resources?.memory.error && <StatusMessage error>{resources.memory.error}</StatusMessage>}
        <div className="memory-file"><div className="memory-file-heading"><Icon name="file"/><strong>memory.md</strong><span>{resources ? `${resources.memory.summaries} 份会话摘要` : '读取中…'}</span></div>
            {fileError ? <StatusMessage error>{fileError}</StatusMessage> : !file ? <StatusMessage>正在读取文件…</StatusMessage> : file.content ? <div className="memory-preview"><MarkdownBody content={file.content}/></div> : <EmptyState title={file.exists ? '记忆文件为空' : '记忆文件尚未生成'}/>}
            {file && <Disclosure title="文件位置"><code>{file.path}</code></Disclosure>}</div></div>
}

function ContextSettings({ config, save, report }: { config: Config; save(patch: unknown): Promise<void>; report(error: string): void }) {
    const [compact, setCompact] = useState(String(config.compaction.compactTokens ?? '')), [context, setContext] = useState(String(config.compaction.context ?? '')), [safety, setSafety] = useState(String(config.compaction.safetyTokens)), [busy, setBusy] = useState(false)
    const submit = async (event: FormEvent) => { event.preventDefault(); setBusy(true); try { await save({ compaction: { context: context ? Number(context) : null, compactTokens: compact ? Number(compact) : null, safetyTokens: Number(safety) } }) } catch (cause) { report(String(cause)) } finally { setBusy(false) } }
    return <form className="settings-form" onSubmit={event => { void submit(event) }}><fieldset disabled={busy}><div className="settings-section-heading"><h3>上下文</h3><HintTooltip label="上下文取模型容量、输入容量和自定义上限的最小值。自动压缩预算为上下文减去最大输出和安全余量，再与压缩阈值取最小值。推荐安全余量 10K–20K Tokens。"><button type="button" className="help-button" aria-label="上下文预算说明">?</button></HintTooltip></div>
        <label>上下文上限<input type="number" min="1" value={context} onChange={event => setContext(event.target.value)} placeholder="使用模型容量"/></label>
        <label>压缩阈值<input type="number" min="1" value={compact} onChange={event => setCompact(event.target.value)} placeholder="自动预算"/></label>
        <label>安全余量<input type="number" min="0" value={safety} required onChange={event => setSafety(event.target.value)}/></label>
        <div className="form-actions"><button className="primary">保存上下文设置</button></div></fieldset></form>
}
