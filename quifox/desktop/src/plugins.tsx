import { useEffect, useId, useState, type ComponentType } from 'react'
import type { PluginView, RuntimeCommand, SessionSummary } from '@quifox/shared-runtime'
import { ObservationSessions } from './observation-sessions.js'
import { Dialog, DialogTitle } from './ui.js'
import { SelectMenu } from './select-menu.js'
import { Icon } from './icons.js'
import { Disclosure, EmptyState, SettingSwitch, StatusMessage } from './ui.js'
import type { NavigationHistory } from './navigation.js'

interface SurfaceProps { navigation: NavigationHistory; sessionId?: string | undefined; sessions?: SessionSummary[] | undefined; revision?: number | undefined; command(input: RuntimeCommand): Promise<unknown> }
const surfaces: Record<string, ComponentType<SurfaceProps>> = { observability: ObservationSessions }

export function Plugins({ navigation, sessionId, sessions, revision, configurationRevision, workspace, workspaceScopeAvailable = true, command }: SurfaceProps & { configurationRevision?: string | undefined; workspace?: string | undefined; workspaceScopeAvailable?: boolean }) {
    const [view, setView] = useState<PluginView>(), [error, setError] = useState(''), [reload, setReload] = useState(0)
    const chosenId = navigation.location.pluginId, tab = navigation.location.pluginTab ?? 'installed'
    const setChosenId = (pluginId: string | undefined): void => navigation.navigate({ pluginId, observationId: undefined })
    const setTab = (pluginTab: 'installed' | 'market'): void => navigation.navigate({ pluginTab, pluginId: undefined, observationId: undefined })
    const [query, setQuery] = useState('')
    const [filter, setFilter] = useState<'all' | 'enabled' | 'disabled'>('all'), [marketFilter, setMarketFilter] = useState<'all' | 'installed'>('all')
    const [requestedScope, setScope] = useState<'global' | 'workspace'>('global'), [busy, setBusy] = useState(false)
    const scope = workspaceScopeAvailable ? requestedScope : 'global'
    const scopes = [{ value: 'global', label: '全局' }, ...workspaceScopeAvailable ? [{ value: 'workspace', label: '当前工作目录' }] : []]
    const dialogId = useId()
    useEffect(() => {
        let active = true; setError('')
        void command({ type: 'plugins', ...(sessionId ? { sessionId } : workspace ? { workspace } : {}) }).then(value => { if (active) setView(value as PluginView) }, cause => { if (active) setError(cause instanceof Error ? cause.message : '插件读取失败。') })
        return () => { active = false }
    }, [sessionId, workspace, configurationRevision, command, reload])
    const selected = view?.installed.find(plugin => plugin.id === chosenId)
    const info = selected ?? view?.marketplace.find(plugin => plugin.id === chosenId)
    const Surface = selected?.surface && Object.hasOwn(surfaces, selected.surface.kind) ? surfaces[selected.surface.kind] : undefined
    const toggle = async (pluginId: string, enabled: boolean): Promise<void> => {
        setBusy(true); setError('')
        try { await command({ type: 'plugin-set-enabled', pluginId, enabled, scope, ...(workspace ? { workspace } : {}) }); setReload(value => value + 1) }
        catch (cause) { setError(cause instanceof Error ? cause.message : '插件设置失败。') }
        finally { setBusy(false) }
    }
    const install = async (pluginId: string, action: 'install' | 'remove'): Promise<void> => {
        setBusy(true); setError('')
        try { await command({ type: 'plugin-install', pluginId, action, scope, ...(workspace ? { workspace } : {}) }); setChosenId(undefined); setReload(value => value + 1) }
        catch (cause) { setError(cause instanceof Error ? cause.message : '插件配置未保存。') }
        finally { setBusy(false) }
    }
    if (!view) return error ? <section className="resource-page"><StatusMessage error>{error}</StatusMessage><button onClick={() => setReload(value => value + 1)}>重试</button></section> : <StatusMessage>正在读取插件…</StatusMessage>
    if (selected && Surface) return <section className="plugin-surface-page">{!selected.enabled && <div className="plugin-surface-state"><span className="state-pill">已停用</span></div>}
        <Surface sessions={sessions} revision={revision} command={command} navigation={navigation}/></section>
    const matches = (plugin: { name: string; id: string; description: string }): boolean => `${plugin.name} ${plugin.id} ${plugin.description}`.toLocaleLowerCase().includes(query.toLocaleLowerCase())
    const installed = view.installed.filter(plugin => matches(plugin) && (filter === 'all' || plugin.enabled === (filter === 'enabled')))
    const market = view.marketplace.filter(plugin => matches(plugin) && (marketFilter === 'all' || plugin.installed))
    return <section className="plugins-page" aria-label="插件">
        <div className="plugins-toolbar"><nav className="page-tabs" aria-label="插件页面"><button aria-pressed={tab === 'installed'} onClick={() => setTab('installed')}>我的插件 <span>{view.installed.length}</span></button><button aria-pressed={tab === 'market'} onClick={() => setTab('market')}>插件市场</button></nav>
            <div className="search-control"><Icon name="search"/><input aria-label="筛选插件" placeholder="搜索插件" value={query} onChange={event => setQuery(event.target.value)}/></div></div>
        {error && <StatusMessage error>{error}</StatusMessage>}
        <div className="plugins-content">{tab === 'market' ? <><nav className="filter-tabs" aria-label="市场筛选"><button aria-pressed={marketFilter === 'all'} onClick={() => setMarketFilter('all')}>全部插件</button><button aria-pressed={marketFilter === 'installed'} onClick={() => setMarketFilter('installed')}>已安装插件</button></nav><div className="plugin-cards">{market.map(plugin => <article className="plugin-card" key={plugin.id}><button className="plugin-card-open" aria-label={`查看${plugin.name}`} onClick={() => setChosenId(plugin.id)}><span className="plugin-card-icon"><Icon name="plugins"/></span><strong>{plugin.name}</strong><span className="plugin-card-description">{plugin.description}</span></button><div className="plugin-card-footer"><span className="plugin-source">内置目录</span><span className="state-pill">{plugin.installed ? '已安装' : '未安装'}</span></div></article>)}</div>{!market.length && <EmptyState title="没有匹配的插件"/>}</> : <>
            <div className="plugin-scope"><nav className="filter-tabs" aria-label="我的插件筛选">{[['all', '全部'], ['enabled', '启用'], ['disabled', '禁用']].map(([value, label]) => <button key={value} aria-pressed={filter === value} onClick={() => setFilter(value as typeof filter)}>{label}</button>)}</nav><SelectMenu label="插件启停作用域" value={scope} onChange={value => setScope(value as typeof requestedScope)} options={scopes}/></div>
            {!installed.length ? <EmptyState title={query ? '没有匹配的插件' : '没有已安装的插件'}/> : <div className="plugin-cards">{installed.map(plugin => <article className="plugin-card" key={plugin.id}>
                <button className="plugin-card-open" aria-label={`查看${plugin.name}`} onClick={() => setChosenId(plugin.id)}><span className="plugin-card-icon"><Icon name={plugin.source === 'mcp' ? 'plugins' : plugin.id === 'observability' ? 'context' : plugin.id === 'memory' ? 'memory' : plugin.id === 'subagents' ? 'agents' : plugin.id === 'skills' ? 'skills' : 'plugins'}/></span><strong>{plugin.name}</strong><span className="plugin-card-description">{plugin.description}</span></button>
                <div className="plugin-card-footer"><span className="plugin-source">{plugin.source === 'mcp' ? 'MCP 连接' : '内置插件'}</span><SettingSwitch label={`启用${plugin.name}`} labelHidden checked={scope === 'global' ? plugin.globalEnabled : plugin.enabled} disabled={busy} onCheckedChange={enabled => { void toggle(plugin.id, enabled) }}/></div>
            </article>)}</div>}
            {view.scope === 'session' && <Disclosure title={`实际装配（${view.plugins.length}）`}><ol className="assembly-list">{view.plugins.map((plugin, index) => <li key={`${plugin.id}-${index}`}><span>{String(index + 1).padStart(2, '0')}</span><code>{plugin.id}</code></li>)}</ol></Disclosure>}
        </>}</div>
        {info && !Surface && <Dialog label={dialogId} close={navigation.back}><section className="modal plugin-info"><div className="modal-heading"><DialogTitle id={dialogId}>{info.name}</DialogTitle><button aria-label="关闭插件详情" onClick={navigation.back}><Icon name="close"/></button></div><div className="plugin-info-body"><div>{info.description}</div><dl className="detail-list"><dt>标识</dt><dd><code>{info.id}</code></dd><dt>状态</dt><dd>{selected ? selected.enabled ? '已启用' : '已停用' : '未安装'}</dd><dt>来源</dt><dd>{info.source === 'mcp' ? 'MCP 连接' : '内置插件'}</dd></dl>{selected?.surface && <StatusMessage>此插件的自定义视图尚未安装。</StatusMessage>}{info.source === 'builtin' && <div className="form-actions"><SelectMenu label="安装作用域" value={scope} onChange={value => setScope(value as typeof requestedScope)} options={scopes}/><button disabled={busy} onClick={() => { void install(info.id, selected ? 'remove' : 'install') }}>{selected ? '卸载插件' : '安装插件'}</button></div>}{error && <StatusMessage error>{error}</StatusMessage>}</div></section></Dialog>}
    </section>
}
