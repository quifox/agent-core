import { createContext, useContext, useEffect, useRef, useState, type ReactNode } from 'react'
import type { RuntimeCommand, SessionView, WorkflowDocument, WorkflowInspection, WorkflowDeployment } from '@quifox/shared-runtime'
import { WorkflowGraphView } from './workflow-graph.js'
import { Dialog, DialogTitle, EmptyState, StatusMessage } from './ui.js'
import { ChatRuntime } from './chat-runtime.js'
import { Conversation, MarkdownBody } from './presentation.js'
import { Icon } from './icons.js'
import { ApprovalCards, QueuedMessages } from './conversation-controls.js'

type Command = (command: RuntimeCommand) => Promise<unknown>
const WorkflowContext = createContext<{ command: Command; open(script: string): void } | undefined>(undefined)
export const WorkflowProvider = WorkflowContext.Provider

export function WorkflowCard({ script }: { script: string }) {
    const context = useContext(WorkflowContext), [inspection, setInspection] = useState<WorkflowInspection>(), [error, setError] = useState('')
    useEffect(() => {
        let active = true; setInspection(undefined); setError('')
        const timer = setTimeout(() => { if (context) void context.command({ type: 'workflows', action: 'inspect', script }).then(value => { if (active) setInspection(value as WorkflowInspection) }, () => { if (active) setError('工作流检查失败，请确认插件已启用。') }) }, 200)
        return () => { active = false; clearTimeout(timer) }
    }, [context?.command, script])
    return <section className="workflow-card"><header><strong>TypeScript 工作流</strong><button className="primary" disabled={!inspection?.ok} onClick={() => context?.open(script)}><Icon name="play"/>运行</button></header>
        {error ? <StatusMessage error>{error}</StatusMessage> : !inspection ? <StatusMessage>分析工作流…</StatusMessage> : !inspection.ok ? <WorkflowDiagnostics inspection={inspection}/> : <WorkflowGraphView graph={inspection.graph}/>}
        <details><summary>查看脚本</summary><pre><code>{script}</code></pre></details></section>
}
export function WorkflowDiagnostics({ inspection }: { inspection: WorkflowInspection }) {
    return <ul className="workflow-diagnostics" aria-label="工作流诊断">{inspection.diagnostics.map((diagnostic, index) => <li key={index}>第 {diagnostic.line} 行：{diagnostic.message}</li>)}</ul>
}
export function WorkflowMenu({ command, revision, choose }: { command: Command; revision: number; choose(document: WorkflowDocument): void }) {
    const [items, setItems] = useState<{ name: string }[]>(), [error, setError] = useState('')
    const [importing, setImporting] = useState(false), [templates, setTemplates] = useState<WorkflowDocument[]>([])
    useEffect(() => { let active = true; void command({ type: 'workflows', action: 'list' }).then(value => { if (active) setItems(value as { name: string }[]) }, () => { if (active) setError('无法读取工作流列表。') }); return () => { active = false } }, [command, revision])
    useEffect(() => { let active = true; void command({ type: 'workflows', action: 'templates' }).then(value => { if (active) setTemplates(value as WorkflowDocument[]) }, () => {}); return () => { active = false } }, [command])
    return <nav className="workflow-menu" aria-label="已保存工作流"><button onClick={() => setImporting(true)}><Icon name="plus"/>从文件导入</button>{error ? <StatusMessage error>{error}</StatusMessage> : !items ? <StatusMessage>读取工作流…</StatusMessage> : !items.length ? <EmptyState title="暂无保存的工作流" description="选择模板开始，或导入 TypeScript 文件。"/> : items.map(item => <button key={item.name} onClick={() => { void command({ type: 'workflows', action: 'read', name: item.name }).then(value => choose(value as WorkflowDocument), () => setError('无法打开工作流。')) }}><Icon name="plugins"/><span>{item.name}</span></button>)}
        {!!templates.length && <><div className="nav-title">推荐模板</div>{templates.map(document => <button key={document.name} onClick={() => { void command({ type: 'workflows', action: 'save', name: document.name, script: document.script }).then(value => choose(value as WorkflowDocument), () => setError('模板保存失败。')) }}>{document.name === 'safe-retry' ? '检索与安全重试' : '并行检索与汇合'}</button>)}</>}
        {importing && <WorkflowImport command={command} close={() => setImporting(false)} choose={document => { setImporting(false); choose(document) }}/>}</nav>
}
function WorkflowImport({ command, close, choose }: { command: Command; close(): void; choose(document: WorkflowDocument): void }) {
    const [script, setScript] = useState(''), [name, setName] = useState(''), [inspection, setInspection] = useState<WorkflowInspection>(), [error, setError] = useState(''), [busy, setBusy] = useState(false)
    return <Dialog label="workflow-import-title" close={close}><div className="dialog-heading"><DialogTitle id="workflow-import-title">导入 TypeScript 工作流</DialogTitle></div><form onSubmit={event => { event.preventDefault(); setBusy(true); void command({ type: 'workflows', action: 'save', name, script }).then(value => choose(value as WorkflowDocument), () => setError('保存失败，请检查名称与文件。')).finally(() => setBusy(false)) }}>
        <div className="workflow-import-fields"><label>工作流文件<input type="file" accept=".ts" aria-label="工作流文件" onChange={event => {
            const file = event.target.files?.[0]; setInspection(undefined)
            if (!file) return
            if (file.size > 200000) { setError('文件超过 200 KB。'); return }
            setName(file.name.replace(/\.ts$/, '').replace(/[^A-Za-z0-9_-]/g, '-').slice(0, 64)); setError('')
            void file.text().then(async script => { setScript(script); setInspection(await command({ type: 'workflows', action: 'inspect', script }) as WorkflowInspection) }).catch(() => setError('无法检查文件。'))
        }}/></label><label>保存名称<input aria-label="保存名称" value={name} onChange={event => setName(event.target.value)}/></label>{error && <StatusMessage error>{error}</StatusMessage>}{inspection && (!inspection.ok ? <WorkflowDiagnostics inspection={inspection}/> : <WorkflowGraphView graph={inspection.graph}/>)}</div><div className="dialog-actions"><button type="button" onClick={close}>取消</button><button className="primary" disabled={busy || !inspection?.ok || !/^[A-Za-z0-9_-]{1,64}$/.test(name)}>保存并打开</button></div></form></Dialog>
}
export function WorkflowLayout({ active, view, command, children }: { active: boolean; view?: SessionView | undefined; command: Command; children: ReactNode }) {
    return active ? <div className="workflow-layout">{view?.workflow ? <div className="workflow-canvas"><div className="workflow-page-heading"><strong>{view.workflow.name}</strong><WorkflowDeploy key={view.workspace + ':' + view.workflow.name} name={view.workflow.name} workspace={view.workspace} command={command}/></div><WorkflowGraphView graph={view.workflow.graph} events={view.events} status={view.status}/></div> : <EmptyState title="选择一个工作流" description="左侧选择保存的脚本，开始多轮测试。"/>}<div className="workflow-conversation">{children}</div></div> : <>{children}</>
}
function WorkflowDeploy({ name, workspace, command }: { name: string; workspace: string; command: Command }) {
    const [deployment, setDeployment] = useState<WorkflowDeployment>(), [existing, setExisting] = useState(false), [open, setOpen] = useState(false), [busy, setBusy] = useState(false), [error, setError] = useState('')
    useEffect(() => {
        let active = true; setOpen(false); setDeployment(undefined); setExisting(false)
        void command({ type: 'workflows', action: 'deployments' }).then(value => { if (active) setExisting((value as Omit<WorkflowDeployment, 'token'>[]).some(item => item.name === name && item.workspace === workspace)) }, () => { if (active) setError('无法读取 API 服务。') })
        return () => { active = false }
    }, [command, name, workspace])
    return <><button disabled={busy} onClick={() => {
        setBusy(true); setError('')
        void command({ type: 'workflows', action: 'deploy', name, workspace }).then(value => { setDeployment(value as WorkflowDeployment); setExisting(true); setOpen(true) }, () => setError('API 启动失败。')).finally(() => setBusy(false))
    }}>{existing ? '管理本地 API' : '部署为本地 API'}</button>{error && <StatusMessage error>{error}</StatusMessage>}{open && deployment && <Dialog label="workflow-api-title" close={() => setOpen(false)}><div className="dialog-heading"><DialogTitle id="workflow-api-title">工作流本地 API</DialogTitle></div><div className="workflow-import-fields"><label>接口地址<input readOnly value={deployment.url}/></label><label>Bearer Token<input readOnly type="password" value={deployment.token}/></label><button onClick={() => { void navigator.clipboard.writeText(deployment.token).catch(() => setError('复制失败。')) }}>复制 Token</button><StatusMessage>POST /runs 接收 question 和可选 sessionId；GET /runs/:id 查看结果。同一 sessionId 支持追问。当前服务固定使用部署时的脚本，修改脚本后请停止并重新部署。服务仅监听本机，随 Host 关闭。</StatusMessage></div><div className="dialog-actions"><button disabled={busy} onClick={() => {
        setBusy(true); void command({ type: 'workflows', action: 'undeploy', deploymentId: deployment.id }).then(() => { setOpen(false); setExisting(false); setDeployment(undefined) }, () => setError('停止 API 失败。')).finally(() => setBusy(false))
    }}>停止 API</button><button onClick={() => setOpen(false)}>关闭</button></div></Dialog>}</>
}

/** The same Host Session and assistant-ui adapter power inline workflow testing. */
export function WorkflowDock({ script, command, close, openFile }: { script: string; command: Command; close(): void; openFile(path: string): void }) {
    const [view, setView] = useState<SessionView>(), [draft, setDraft] = useState(''), [name, setName] = useState('knowledge'), [error, setError] = useState(''), [busy, setBusy] = useState(false)
    const admission = useRef<{ prompt: string; id: string } | undefined>(undefined)
    useEffect(() => {
        let active = true, timer: ReturnType<typeof setInterval> | undefined
        void command({ type: 'create', title: '工作流测试', workflow: { name: 'inline', script } }).then(value => {
            const session = value as SessionView
            if (!active) return
            setView(session); timer = setInterval(() => { void command({ type: 'snapshot', sessionId: session.id, eventLimit: 1000, traceOnly: true }).then(value => { if (active) setView(value as SessionView) }, () => { if (active) setError('无法刷新工作流会话。') }) }, 300)
        }, () => { if (active) setError('无法创建工作流会话。') })
        return () => { active = false; if (timer) clearInterval(timer) }
    }, [script, command])
    const send = async (): Promise<void> => {
        if (!view || !draft.trim() || busy) return
        const prompt = draft; setBusy(true)
        if (admission.current?.prompt !== prompt) admission.current = { prompt, id: crypto.randomUUID() }
        try { await command({ type: 'submit', sessionId: view.id, prompt, messageId: admission.current.id }); admission.current = undefined; setDraft(current => current === prompt ? '' : current) }
        catch { setError('消息未接纳，请重试。') } finally { setBusy(false) }
    }
    const failed = (): void => setError('操作未完成，请查看本地日志。')
    const paused = view?.status !== 'running' && view?.resumeAvailable
    return <aside className="workflow-dock" aria-label="工作流测试"><header><strong>工作流测试</strong><button className="icon-button" aria-label="关闭工作流测试" onClick={close}><Icon name="close"/></button></header>
        {error && <StatusMessage error>{error}</StatusMessage>}
        {view?.workflow && <WorkflowGraphView graph={view.workflow.graph} events={view.events} status={view.status}/>}
        <div className="workflow-save"><input aria-label="工作流名称" value={name} onChange={event => setName(event.target.value)}/><button disabled={busy} onClick={() => { setBusy(true); void command({ type: 'workflows', action: 'save', name, script }).then(() => setError(''), () => setError('保存失败，请检查名称与脚本。')).finally(() => setBusy(false)) }}>保存</button></div>
        <ChatRuntime view={view} live={view?.liveText ?? ''} onSubmit={send} onCancel={async () => { if (view) await command({ type: 'stop', sessionId: view.id }) }}>
            <div className="workflow-dock-transcript">{view && <Conversation view={view} openFile={openFile}/>}<MarkdownBody content={view?.liveText ?? ''} openFile={openFile}/>{view?.pendingMessages.filter(message => message.mode === 'steer' || message.status === 'staged').map(message => <article className="message user" key={message.id}><div className="message-body"><MarkdownBody content={message.prompt}/></div></article>)}</div>
            {view && <><ApprovalCards view={view} command={command} error={failed}/><QueuedMessages view={view} command={command} error={failed}/></>}
            <form className="composer" onSubmit={event => { event.preventDefault(); void send() }}><textarea aria-label="工作流测试输入" placeholder="输入问题，或继续追问…" value={draft} onChange={event => setDraft(event.target.value)} onKeyDown={event => { if (event.key === 'Enter' && !event.shiftKey && !event.nativeEvent.isComposing) { event.preventDefault(); void send() } }}/><div className="composer-actions"><span>{view?.status === 'running' ? '执行中' : '多轮测试'}</span><button className="send-button" type={(view?.status === 'running' || paused) && !draft.trim() ? 'button' : 'submit'} aria-label={!draft.trim() && paused ? '恢复工作流' : view?.status === 'running' && !draft.trim() ? '暂停工作流' : '发送工作流输入'} disabled={!view || busy} onClick={() => { if (!view || draft.trim()) return; if (paused) void command({ type: 'resume', sessionId: view.id, mode: 'replan' }).catch(failed); else if (view.status === 'running') void command({ type: 'stop', sessionId: view.id }).catch(failed) }}>{!draft.trim() && paused ? <Icon name="play"/> : view?.status === 'running' && !draft.trim() ? <Icon name="pause"/> : '↑'}</button></div></form>
        </ChatRuntime>
    </aside>
}
