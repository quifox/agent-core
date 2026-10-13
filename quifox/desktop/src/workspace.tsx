import { lazy, Suspense, useEffect, useImperativeHandle, useRef, useState, type Ref } from 'react'
import { flushSync } from 'react-dom'
import { diffLines } from 'diff'
import type { FileChange } from '@quifox/shared-runtime/presentation'
import type { ProjectFile, ProjectListing, RuntimeCommand, SessionSummary, SessionView } from '@quifox/shared-runtime'
import { MarkdownBody, statuses, Trace } from './presentation.js'
import { Icon } from './icons.js'
import { EmptyState, StatusMessage } from './ui.js'
import { nativeViews } from './native-views.js'
import { ReadableValue, stateLabels } from './operation-view.js'

const CodeView = lazy(() => import('./code-view.js').then(module => ({ default: module.CodeView })))
type Tab = { id: string; title: string; workspace: string; kind: 'file'; file: ProjectFile; src?: string } |
    { id: string; title: string; workspace: string; kind: 'diff'; changes: FileChange[] } |
    { id: string; title: string; workspace: string; kind: 'tasks' | 'trace' }
export interface WorkspaceHandle {
    openFile(path: string, workspace?: string, sessionId?: string, signal?: AbortSignal): Promise<{ destination: 'panel'; viewId: string; target: string; kind: string }>
    openDiff(changes: FileChange[], title?: string): void
    openTrace(): void
}
interface Props {
    ref?: Ref<WorkspaceHandle>; root: string; view?: SessionView | undefined; children?: SessionSummary[]
    command(command: RuntimeCommand): Promise<unknown>; openChild?(id: string): void
    close(): void; expanded: boolean; setExpanded(value: boolean): void; visible?: boolean; theme?: string; fontSize?: number
}
const errorOf = (cause: unknown): string => cause instanceof Error ? cause.message : '文件展示失败。'
const filename = (path: string): string => path.replace(/\\/g, '/').split('/').at(-1) || path
const labelPath = (path: string, root: string): string => path.replace(/\\/g, '/').replace(root.replace(/\\/g, '/').replace(/\/$/, '') + '/', '')

export function Workspace({ ref, root, view, children = [], command, openChild, close, expanded, setExpanded, visible = true, theme = 'system', fontSize = 16 }: Props) {
    const [tabs, setTabs] = useState<Tab[]>([]), [activeId, setActiveId] = useState<string>(), [treeOpen, setTreeOpen] = useState(true)
    const [error, setError] = useState<string>(), [opening, setOpening] = useState(0), [browseRoot, setBrowseRoot] = useState<string>()
    const mounted = useRef(true)
    const visibleRef = useRef(visible); visibleRef.current = visible
    const tabList = useRef<HTMLDivElement>(null)
    const fileIds = useRef(new Map<string, string>())
    const latestRoot = useRef(root); latestRoot.current = root
    useEffect(() => { mounted.current = true; return () => { mounted.current = false } }, [])
    const active = tabs.find(tab => tab.id === activeId)
    const browserRoot = browseRoot ?? active?.workspace ?? root
    useEffect(() => { if (activeId && !tabs.some(tab => tab.id === activeId)) setActiveId(tabs.at(-1)?.id) }, [activeId, tabs])
    useEffect(() => { tabList.current?.querySelector<HTMLElement>('[aria-selected="true"]')?.scrollIntoView?.({ block: 'nearest', inline: 'nearest' }) }, [activeId, visible])
    useEffect(() => { setBrowseRoot(undefined) }, [root])
    const chooseDirectory = async (): Promise<void> => {
        const selected = await nativeViews.chooseDirectory(browserRoot)
        if (selected && mounted.current) { setBrowseRoot(selected); setTreeOpen(true) }
    }
    const add = (tab: Tab): void => {
        setTabs(current => current.some(item => item.id === tab.id) ? current.map(item => item.id === tab.id ? tab : item) : [...current, tab])
        setActiveId(tab.id)
    }
    const openFile: WorkspaceHandle['openFile'] = async (path, workspace = root, sessionId, signal) => {
        const explicitSignal = !!signal, initialRoot = root
        signal?.throwIfAborted(); setOpening(value => value + 1); setError(undefined)
        try {
            const result = await command({ type: 'project', action: 'read', workspace, path, ...(sessionId ? { sessionId } : {}) }) as ProjectFile
            if (!explicitSignal && workspace === initialRoot && latestRoot.current !== initialRoot) throw new DOMException('工作目录已切换。', 'AbortError')
            if (!['text', 'binary', 'image', 'video'].includes(result.kind) || !result.path || !result.workspace) throw new Error('文件回执无效。')
            const src = result.kind === 'image' || result.kind === 'video' ? await nativeViews.asset(result.path) : undefined
            signal?.throwIfAborted()
            if (!mounted.current || !visibleRef.current) throw new Error('展示面板已关闭或收起，视图未确认展示。')
            const identity = `${result.workspace}:${result.path}`, id = fileIds.current.get(identity) ?? crypto.randomUUID()
            fileIds.current.set(identity, id)
            flushSync(() => add({ id, kind: 'file', title: filename(result.relativePath), workspace: result.workspace, file: result, ...(src ? { src } : {}) }))
            return { destination: 'panel', viewId: id, target: path, kind: result.kind }
        } catch (cause) { if (mounted.current && !signal?.aborted && !(cause instanceof DOMException && cause.name === 'AbortError')) setError(errorOf(cause)); throw cause }
        finally { if (mounted.current) setOpening(value => value - 1) }
    }
    const openDiff: WorkspaceHandle['openDiff'] = (changes, title = '最近一轮变更') => {
        const identity = title === '最近一轮变更' ? title : JSON.stringify([title, changes.map(change => change.path)])
        add({ id: `diff:${view?.id ?? root}:${identity}`, kind: 'diff', title, workspace: root, changes })
    }
    useImperativeHandle(ref, () => ({ openFile, openDiff, openTrace: () => add({ id: `trace:${view?.id}`, title: '执行详情', kind: 'trace', workspace: root }) }))
    useEffect(() => {
        setTabs(current => current.filter(tab => !['tasks', 'trace'].includes(tab.kind) || tab.id.endsWith(`:${view?.id}`)).map(tab => tab.kind === 'diff' && tab.id === `diff:${view?.id ?? root}:最近一轮变更` ? { ...tab, changes: view?.changes ?? [] } : tab))
    }, [view?.changes, view?.id, root])
    const closeTab = (id: string): void => {
        const tab = tabs.find(tab => tab.id === id)
        if (tab?.kind === 'file') fileIds.current.delete(`${tab.workspace}:${tab.file.path}`)
        const index = tabs.findIndex(tab => tab.id === id), rest = tabs.filter(tab => tab.id !== id)
        setTabs(rest)
        if (activeId === id) setActiveId(rest[Math.min(index, rest.length - 1)]?.id)
    }
    const report = (operation: Promise<unknown>): void => { void operation.catch(cause => { if (!(cause instanceof DOMException && cause.name === 'AbortError')) setError(errorOf(cause)) }) }
    const keys = (event: React.KeyboardEvent): void => {
        if (!(event.metaKey || event.ctrlKey) || event.key.toLowerCase() !== 'w' || !activeId) return
        event.preventDefault(); closeTab(activeId)
    }
    return <section className="desktop-workspace" aria-label="工作区" onKeyDown={keys}>
        <header className="workspace-tabs" data-tauri-drag-region>
            {!tabs.length && <span className="workspace-empty-title">工作区</span>}
            <div ref={tabList} className="workspace-tab-list" role="tablist" aria-label="打开的视图">{tabs.map(tab => <div className="workspace-tab-wrap" key={tab.id} data-active={tab.id === activeId}>
                <button role="tab" tabIndex={tab.id === activeId ? 0 : -1} aria-label={tab.title} aria-selected={tab.id === activeId} aria-controls="workspace-active-view" title={tab.kind === 'file' ? tab.file.path : tab.kind === 'diff' ? tab.changes.map(change => change.path).join('\n') || tab.title : tab.title} onClick={() => setActiveId(tab.id)} onKeyDown={event => {
                    if (!['ArrowLeft', 'ArrowRight', 'Home', 'End'].includes(event.key)) return
                    event.preventDefault()
                    const index = tabs.indexOf(tab), next = event.key === 'Home' ? 0 : event.key === 'End' ? tabs.length - 1 : (index + (event.key === 'ArrowLeft' ? -1 : 1) + tabs.length) % tabs.length
                    setActiveId(tabs[next]!.id); (event.currentTarget.closest('[role="tablist"]')?.querySelectorAll<HTMLButtonElement>('[role="tab"]')[next])?.focus()
                }}>
                    <FileIcon path={tab.title} kind={tab.kind === 'file' ? tab.file.kind : tab.kind}/><span className="ellipsis">{tab.title}</span>
                </button><button className="tab-close" aria-label={`关闭 ${tab.title}`} onClick={() => closeTab(tab.id)}><Icon name="close"/></button>
            </div>)}</div>
            <div className="workspace-window-actions">
                <button className="icon-button" title={expanded ? '还原工作区' : '放大工作区'} aria-label={expanded ? '还原工作区' : '放大工作区'} onClick={() => setExpanded(!expanded)}><Icon name={expanded ? 'restore' : 'expand'}/></button>
                <button className="icon-button" title="收起工作区" aria-label="收起工作区" onClick={close}><Icon name="navigation"/></button>
            </div>
        </header>
        <div className="workspace-toolbar">
            <div className="workspace-breadcrumb" title={active?.kind === 'file' ? active.file.path : browserRoot}>
                <Icon name="folder"/><span className="breadcrumb-root">{filename(active?.workspace ?? browserRoot)}</span>
                {active?.kind === 'file' && active.file.relativePath.split('/').map((part, index) => <span key={index}><span className="breadcrumb-divider">›</span>{part}</span>)}
                {active?.kind !== 'file' && <span>{active?.title ?? '项目文件'}</span>}
            </div>
            <div className="workspace-tools">
                {view && <button className="icon-button" title="查看最近一轮变更" aria-label="查看最近一轮变更" onClick={() => openDiff(view.changes ?? [])}><Icon name="changes"/></button>}
                {view && <button className="icon-button" title="子任务" aria-label="查看子任务" onClick={() => add({ id: `tasks:${view.id}`, kind: 'tasks', title: '子任务', workspace: root })}><Icon name="agents"/></button>}
                <button className="icon-button" title={treeOpen ? '隐藏文件树' : '显示文件树'} aria-label={treeOpen ? '隐藏文件树' : '显示文件树'} aria-pressed={treeOpen} onClick={() => setTreeOpen(value => !value)}><Icon name="folder"/></button>
                {active?.kind === 'file' && <details className="external-menu"><summary><Icon name="external"/>打开<Icon name="down"/></summary><div role="menu">
                    <button role="menuitem" onClick={event => { event.currentTarget.closest('details')!.open = false; report(nativeViews.external(active.file.path, 'editor')) }}>在 VS Code 中打开</button>
                    <button role="menuitem" onClick={event => { event.currentTarget.closest('details')!.open = false; report(nativeViews.external(active.file.path)) }}>在默认应用中打开</button>
                    <button role="menuitem" onClick={event => { event.currentTarget.closest('details')!.open = false; report(nativeViews.external(active.file.path, 'reveal')) }}>在文件管理器中显示</button>
                </div></details>}
            </div>
        </div>
        {error && <StatusMessage error>{error}<button className="icon-button" aria-label="关闭工作区错误" onClick={() => setError(undefined)}><Icon name="close"/></button></StatusMessage>}
        {opening > 0 && <div className="workspace-loading" role="status">正在打开文件…</div>}
        <div className="workspace-body">
            <div id="workspace-active-view" role="tabpanel" className="workspace-view" aria-label={active?.title ?? '项目文件'}>
                {!visible ? null : active?.kind === 'file' ? <FileView key={active.id} tab={active} theme={theme} fontSize={fontSize} openFile={path => report(openFile(path, active.workspace))}/> :
                    active?.kind === 'diff' ? <DiffView changes={active.changes} workspace={active.workspace} title={active.title} theme={theme} fontSize={fontSize} openFile={path => report(openFile(path, active.workspace))}/> :
                        active?.kind === 'trace' ? <Trace view={view} openChild={openChild}/> :
                            active?.kind === 'tasks' ? <div className="workspace-task-list">{children.map(child => <div className="task-item" key={child.id}><button className="task-open" onClick={() => openChild?.(child.id)}><strong>{child.name ?? child.title}</strong><span className={`task-state ${child.status}`}><i/>{stateLabels[child.status] ?? statuses[child.status]}</span></button>{child.status === 'running' && <button aria-label={`停止 ${child.name ?? child.title}`} onClick={() => report(command({ type: 'stop', sessionId: child.id }))}><Icon name="pause"/></button>}</div>)}{view?.backgroundTasks.map((task, index) => <details className="task-item background-task" key={task.id}><summary><strong>后台任务 {index + 1}</strong><span className={`task-state ${task.status}`}><i/>{task.cancelRequested && task.status === 'running' ? '正在停止' : stateLabels[task.status]}</span></summary><ReadableValue value={task.result ?? task.error ?? (task.cancelRequested ? '已请求停止，正在等待实际操作收尾。' : '任务尚未返回结果。')}/></details>)}{!children.length && !view?.backgroundTasks.length && <EmptyState title="暂无子任务"/>}</div> :
                                <EmptyState title="打开文件，查看工作成果" description="从文件树选择文件，或点击对话中的文件与修改。"/>}
            </div>
            {treeOpen && visible && <FileTree key={browserRoot} root={browserRoot} command={command} selected={active?.kind === 'file' && active.workspace === browserRoot ? active.file.relativePath : undefined} openFile={path => report(openFile(path, browserRoot))} chooseDirectory={() => report(chooseDirectory())}/>}
        </div>
    </section>
}

function FileIcon({ path, kind }: { path: string; kind: string }) {
    const ext = path.split('.').at(-1)?.toLowerCase()
    if (kind === 'diff') return <Icon name="changes"/>
    if (['png', 'jpg', 'jpeg', 'gif', 'webp', 'svg', 'avif', 'bmp'].includes(ext ?? '')) return <Icon name="image"/>
    if (['mp4', 'webm', 'mov', 'm4v', 'ogv'].includes(ext ?? '')) return <Icon name="video"/>
    if (kind === 'image' || kind === 'video') return <Icon name={kind}/>
    if (['ts', 'tsx', 'js', 'jsx', 'json', 'rs', 'py', 'css', 'html'].includes(ext ?? '')) return <span className="file-type-icon" aria-hidden="true">{ext?.slice(0, 2).toUpperCase()}</span>
    return <Icon name="file"/>
}

function FileView({ tab, theme, fontSize, openFile }: { tab: Extract<Tab, { kind: 'file' }>; theme: string; fontSize: number; openFile(path: string): void }) {
    const [markdown, setMarkdown] = useState(true), [find, setFind] = useState(0), [wrap, setWrap] = useState(false)
    const { file } = tab
    const isMarkdown = /\.(md|mdx|markdown)$/i.test(file.path)
    return <>
        {file.truncated && <StatusMessage>文件较大，仅展示前 1 MB；外部应用可打开完整内容。</StatusMessage>}
        {file.kind === 'image' || file.kind === 'video' ? <MediaView kind={file.kind} src={tab.src!} title={tab.title}/> : file.kind === 'binary' ?
            <EmptyState title="二进制文件" description="可使用右上角“打开”在默认应用中查看。"/> :
            <><div className="file-view-toolbar">{isMarkdown && <button aria-pressed={markdown} onClick={() => setMarkdown(value => !value)}>{markdown ? '查看源码' : '阅读预览'}</button>}<span className="file-size">{file.bytes.toLocaleString()} 字节 · 只读</span>
                {(!isMarkdown || !markdown) && <><button className="icon-button" aria-label="查找文件内容" title="查找 · ⌘/Ctrl F" onClick={() => setFind(value => value + 1)}><Icon name="search"/></button><button className="icon-button" aria-label="自动换行" title="自动换行" aria-pressed={wrap} onClick={() => setWrap(value => !value)}><Icon name="wrap"/></button></>}
            </div>{isMarkdown && markdown ? <div className="file-markdown"><MarkdownBody content={file.content ?? ''} openFile={openFile}/></div> :
                <Suspense fallback={<StatusMessage>正在加载阅读器…</StatusMessage>}><CodeView content={file.content ?? ''} path={file.path} theme={theme} fontSize={fontSize} find={find} wrap={wrap}/></Suspense>}</>}
    </>
}

export function MediaView({ kind, src, title }: { kind: 'image' | 'video'; src: string; title: string }) {
    const [scale, setScale] = useState<number>(), [expanded, setExpanded] = useState(false), [error, setError] = useState(false)
    const video = useRef<HTMLVideoElement>(null), image = useRef<HTMLImageElement>(null), region = useRef<HTMLDivElement>(null)
    useEffect(() => { setError(false) }, [src])
    const zoom = (difference: number): void => {
        const fitted = image.current?.naturalWidth ? image.current.clientWidth / image.current.naturalWidth : 1
        setScale(value => Math.max(.01, Math.min(5, (value ?? fitted) + difference)))
    }
    useEffect(() => {
        const element = video.current
        return () => { if (element) { element.pause(); element.removeAttribute('src'); element.load() } }
    }, [src])
    useEffect(() => {
        const onKey = (event: KeyboardEvent): void => {
            if (event.key === 'Escape') { event.preventDefault(); event.stopPropagation(); setExpanded(false); region.current?.focus(); return }
            if (event.key === 'Tab') {
                const controls = region.current?.querySelectorAll<HTMLElement>('button, video'), first = controls?.[0], last = controls?.[controls.length - 1]
                if (event.shiftKey && (document.activeElement === first || document.activeElement === region.current)) { event.preventDefault(); last?.focus() }
                else if (!event.shiftKey && document.activeElement === last) { event.preventDefault(); first?.focus() }
            }
        }
        if (expanded) { region.current?.focus(); window.addEventListener('keydown', onKey, true) }
        return () => window.removeEventListener('keydown', onKey, true)
    }, [expanded])
    return <div ref={region} tabIndex={-1} className="media-view" role={expanded ? 'dialog' : undefined} aria-modal={expanded ? true : undefined} data-expanded={expanded} aria-label={`${title}预览`}>
        <div className="media-toolbar">{kind === 'image' && <><button aria-label="缩小图片" onClick={() => zoom(-.25)}>−</button><button onClick={() => setScale(undefined)}>{scale === undefined ? '适合窗口' : `${Math.round(scale * 100)}%`}</button><button aria-label="放大图片" onClick={() => zoom(.25)}>+</button><button onClick={() => setScale(1)}>原始尺寸</button></>}
            <button className="icon-button" title={expanded ? '还原预览' : '展开预览'} aria-label={expanded ? '还原预览' : '展开预览'} onClick={() => setExpanded(value => !value)}><Icon name={expanded ? 'restore' : 'expand'}/></button>
        </div>
        {error ? <EmptyState title={kind === 'image' ? '图片无法加载' : '视频无法播放'} description="文件可能损坏或编码不受当前系统支持，可在外部应用中打开。"/> :
            <div className="media-canvas">{kind === 'image' ? <img ref={image} alt={title} src={src} title="双击展开或还原图片" onDoubleClick={() => setExpanded(value => !value)} onError={() => setError(true)} style={scale === undefined ? undefined : { maxWidth: 'none', maxHeight: 'none', width: `calc(var(--image-width, 100%) * ${scale})` }} onLoad={event => { event.currentTarget.style.setProperty('--image-width', `${event.currentTarget.naturalWidth}px`) }}/> :
                <video ref={video} src={src} controls preload="metadata" onError={() => setError(true)} aria-label={title}/>}</div>}
    </div>
}

function DiffView({ changes, workspace, title, theme, fontSize, openFile }: { changes: FileChange[]; workspace: string; title: string; theme: string; fontSize: number; openFile(path: string): void }) {
    const [selected, setSelected] = useState(0), [sideBySide, setSideBySide] = useState(true), [fold, setFold] = useState(true), [query, setQuery] = useState('')
    const shown = changes.filter(change => labelPath(change.path, workspace).toLowerCase().includes(query.toLowerCase())), change = shown[Math.min(selected, shown.length - 1)]
    const counts = changes.reduce((value, change) => {
        const parts = diffLines(change.before ?? '', change.after ?? '', { timeout: 50, maxEditLength: 5000 })
        if (!parts || change.truncated) value.partial = true
        for (const part of parts ?? []) { if (part.added) value.add += part.count ?? 0; if (part.removed) value.remove += part.count ?? 0 }
        return value
    }, { add: 0, remove: 0, partial: false })
    return <div className="workspace-diff">
        <div className="diff-toolbar"><span className="diff-scope">{title}<span className="diff-count add">+{counts.add}</span><span className="diff-count remove">−{counts.remove}</span>{counts.partial && <span title="源内容截断或差异计算超出预算">部分预览</span>}</span>
            <div><button aria-pressed={sideBySide} onClick={() => setSideBySide(value => !value)}>{sideBySide ? '左右对比' : '统一对比'}</button><button aria-label="折叠未修改内容" title="折叠未修改内容" aria-pressed={fold} onClick={() => setFold(value => !value)}><Icon name="collapse"/></button></div>
        </div>
        {changes.length > 0 && <div className="diff-file-nav"><input aria-label="筛选变更文件" placeholder="筛选变更文件…" value={query} onChange={event => { setQuery(event.target.value); setSelected(0) }}/><select aria-label="变更文件" value={change?.path ?? ''} onChange={event => setSelected(shown.findIndex(change => change.path === event.target.value))}>{shown.map(change => <option key={change.path} value={change.path}>{labelPath(change.path, workspace)}</option>)}</select>{change && <button className="icon-button" aria-label="打开变更后的文件" title="打开变更后的文件" disabled={change.after === null} onClick={() => openFile(change.path)}><Icon name="external"/></button>}</div>}
        {change ? <><div className="diff-file-caption"><FileIcon path={change.path} kind="text"/><span title={change.path}>{labelPath(change.path, workspace)}</span>{change.truncated && <span>内容截断</span>}</div><Suspense fallback={<StatusMessage>正在加载差异…</StatusMessage>}><CodeView key={change.path} content={change.after ?? ''} before={change.before ?? ''} path={change.path} theme={theme} fontSize={fontSize} sideBySide={sideBySide} fold={fold}/></Suspense></> : <EmptyState title={changes.length ? '没有匹配的变更文件' : '这一轮没有文件修改'}/>}
    </div>
}

function FileTree({ root, command, selected, openFile, chooseDirectory }: { root: string; command(command: RuntimeCommand): Promise<unknown>; selected?: string | undefined; openFile(path: string): void; chooseDirectory(): void }) {
    const [listings, setListings] = useState<Record<string, ProjectListing>>({}), [expanded, setExpanded] = useState<Set<string>>(new Set(['.']))
    const [query, setQuery] = useState(''), [error, setError] = useState<string>(), [loading, setLoading] = useState<Set<string>>(new Set())
    const alive = useRef(true), requests = useRef(new Set<string>())
    const [search, setSearch] = useState<{ paths: string[]; truncated: boolean }>(), [searching, setSearching] = useState(false), [searchRevision, setSearchRevision] = useState(0)
    useEffect(() => { alive.current = true; return () => { alive.current = false } }, [])
    const load = async (path: string): Promise<void> => {
        if (requests.current.has(path)) return
        requests.current.add(path); setLoading(current => new Set(current).add(path))
        try {
            const list = await command({ type: 'project', action: 'list', workspace: root, path }) as ProjectListing
            if (!Array.isArray(list.entries)) throw new Error('目录回执无效。')
            if (alive.current) { setListings(current => ({ ...current, [path]: list })); setError(undefined) }
        } catch (cause) { if (alive.current) setError(errorOf(cause)) }
        finally { requests.current.delete(path); if (alive.current) setLoading(current => { const next = new Set(current); next.delete(path); return next }) }
    }
    useEffect(() => { if (root) void load('.') }, [root])
    useEffect(() => {
        const refresh = (): void => {
            if (!root || document.visibilityState === 'hidden') return
            if (query.trim()) setSearchRevision(value => value + 1)
            else for (const path of expanded) void load(path)
        }
        const timer = setInterval(refresh, 5000)
        window.addEventListener('focus', refresh)
        return () => { clearInterval(timer); window.removeEventListener('focus', refresh) }
    }, [root, expanded, query])
    useEffect(() => {
        let active = true
        setSearch(undefined)
        if (!query.trim()) { setSearching(false); return }
        setSearching(true)
        const timer = setTimeout(() => {
            void command({ type: 'project', action: 'search', workspace: root, query }).then(value => {
                if (active) { setSearch(value as NonNullable<typeof search>); setError(undefined) }
            }, cause => { if (active) setError(errorOf(cause)) }).finally(() => { if (active) setSearching(false) })
        }, 150)
        return () => { active = false; clearTimeout(timer) }
    }, [query, root, searchRevision])
    const toggle = (path: string): void => {
        setExpanded(current => { const next = new Set(current); if (next.has(path)) next.delete(path); else next.add(path); return next })
        if (!listings[path]) void load(path)
    }
    const rows = (path: string, level: number): React.ReactNode => listings[path]?.entries.map(item => {
        const target = path === '.' ? item.name : `${path}/${item.name}`, directory = item.kind === 'directory'
        const match = !query || target.toLowerCase().includes(query.toLowerCase())
        return <div key={target}>{(match || directory) && <button role="treeitem" aria-level={level + 1} aria-expanded={directory ? expanded.has(target) : undefined} aria-selected={!directory && selected === target} className="tree-item" style={{ paddingLeft: 10 + level * 15 }} title={target} onClick={() => directory ? toggle(target) : openFile(target)}>
            {directory ? <><Icon name={expanded.has(target) ? 'down' : 'chevron'}/><Icon name="folder"/></> : <><span className="tree-spacer"/><FileIcon path={item.name} kind="text"/></>}<span className="ellipsis">{item.name}</span>{loading.has(target) && <span>…</span>}
        </button>}{directory && expanded.has(target) && rows(target, level + 1)}</div>
    })
    return <aside className="workspace-file-tree" aria-label="文件树"><div className="tree-toolbar"><label><Icon name="search"/><input aria-label="筛选文件" placeholder="筛选文件…" value={query} onChange={event => setQuery(event.target.value)}/></label></div>
        <button className="tree-root" aria-label="选择浏览目录" title={`选择浏览目录 · ${root}`} onClick={chooseDirectory}><Icon name="folder"/><span className="ellipsis">{filename(root)}</span><Icon name="down"/></button>{error && <StatusMessage error>{error}</StatusMessage>}
        {query.trim() ? <div role="tree" aria-label="匹配的文件">{searching && <StatusMessage>搜索目录…</StatusMessage>}{search?.paths.map(path => <button className="tree-item" role="treeitem" key={path} title={path} aria-selected={path === selected} onClick={() => openFile(path)}><FileIcon path={path} kind="text"/><span className="ellipsis">{path}</span></button>)}{search && !search.paths.length && <EmptyState title="没有匹配的文件"/>}{search?.truncated && <StatusMessage>显示部分搜索结果，请缩小范围。</StatusMessage>}</div> :
            <div role="tree" aria-label="工作目录文件">{rows('.', 0)}{loading.has('.') && <StatusMessage>读取目录…</StatusMessage>}{listings['.'] && !listings['.'].entries.length && <EmptyState title="目录为空"/>}</div>}
        {Object.values(listings).some(list => list.truncated) && <StatusMessage>部分目录超过 1000 项。</StatusMessage>}
    </aside>
}
