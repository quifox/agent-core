import { memo, useMemo, useState } from 'react'
import Markdown from 'react-markdown'
import remarkGfm from 'remark-gfm'
import { createTwoFilesPatch } from 'diff'
import { toolSummary, type FileChange } from '@quifox/shared-runtime/presentation'
import type { SessionView, TranscriptMessage } from '@quifox/shared-runtime'
import type { ToolCall, ToolResult } from '@quifox/agent-core'
import { traceRecords, type TraceRecord } from './trace.js'
import fox from './assets/fox.svg'
import { EmptyState, StatusMessage } from './ui.js'
import { Icon } from './icons.js'
import { OperationView, ReadableValue } from './operation-view.js'

export const statuses: Record<string, string> = { idle: '就绪', running: '执行中', stopped: '已停止', error: '失败', success: '完成', completed: '完成', failed: '失败', denied: '已拒绝', approval: '待批准', unknown: '结果未知', 'not-started': '未执行', cancelled: '已取消', committed: '已提交' }

export const MarkdownBody = memo(function MarkdownBody({ content, openFile }: { content: string; openFile?: ((path: string) => void) | undefined }) {
    return <div className="markdown"><Markdown remarkPlugins={[remarkGfm]} skipHtml components={{
        a: ({ href, children }) => <a href={href} target="_blank" rel="noopener noreferrer" onClick={event => {
            if (href && !/^[a-z][a-z0-9+.-]*:/i.test(href) && !href.startsWith('#') && openFile) { event.preventDefault(); openFile(href.split('#')[0]!) }
        }}>{children}</a>,
        img: ({ src, alt }) => <span className="image-reference">图片：{src && !/^[a-z][a-z0-9+.-]*:/i.test(src) && openFile ? <button className="quiet" onClick={() => openFile(src)}>{alt || '点击查看'}</button> : <a href={src} target="_blank" rel="noopener noreferrer">{alt || '点击查看'}</a>}</span>
    }}>{content}</Markdown></div>
})

export function FileDiff({ change, workspace }: { change: FileChange; workspace?: string | undefined }) {
    const [expanded, setExpanded] = useState(false)
    const root = workspace?.replace(/\\/g, '/').replace(/\/$/, ''), path = change.path.replace(/\\/g, '/')
    const label = root && path.startsWith(`${root}/`) ? path.slice(root.length + 1) : path
    const patch = useMemo(() => {
        const text = createTwoFilesPatch(change.before === null ? '/dev/null' : label, change.after === null ? '/dev/null' : label,
            change.before ?? '', change.after ?? '', '', '', { context: expanded ? 20 : 3, timeout: 50, maxEditLength: 5000 })
        return text ?? '差异过大，无法在预览预算内计算；可查看原始文件内容。'
    }, [change, expanded, label])
    const lines = patch.split('\n'), limit = expanded ? 2000 : 300
    return <div className="file-diff"><div className="diff-caption"><code>{label}</code>{change.truncated && <span>源内容或结果已截断</span>}</div>
        {change.before === change.after ? <StatusMessage>{change.truncated ? '差异位于预览范围之外，请打开文件查看。' : '内容未改变。'}</StatusMessage> : <pre>{lines.slice(0, limit).map((line, index) => <span key={index} className={line.startsWith('+') && !line.startsWith('+++') ? 'diff-add' : line.startsWith('-') && !line.startsWith('---') ? 'diff-delete' : line.startsWith('@@') ? 'diff-hunk' : ''}>{line}{'\n'}</span>)}</pre>}
        {(lines.length > limit || !expanded) && <button className="quiet" onClick={() => setExpanded(value => !value)}>{expanded ? '收起上下文' : '展开更多上下文'}{lines.length > limit ? ` · 显示前 ${limit} 行` : ''}</button>}
    </div>
}

export function changedFiles(result?: ToolResult): FileChange[] {
    const data = result?.data as { change?: FileChange; changes?: FileChange[] } | undefined
    return [...data?.changes ?? [], ...data?.change ? [data.change] : []].filter(value => value && typeof value.path === 'string' && (typeof value.before === 'string' || value.before === null) && (typeof value.after === 'string' || value.after === null))
}

function ToolCard({ call, result, status, workspace, openChanges }: { call: ToolCall; result?: ToolResult | undefined; status: string; workspace: string; openChanges?: ((changes: FileChange[], title?: string) => void) | undefined }) {
    const [open, setOpen] = useState(false), changes = changedFiles(result)
    return <details className={`tool-card ${status}`} onToggle={event => setOpen(event.currentTarget.open)}><summary><span className="tool-icon">›</span><span>{toolSummary(call)}</span><span className="tool-status">{statuses[status] ?? status}</span></summary>
        {open && <div className="tool-detail">{changes.map(change => <button key={change.path} className="tool-file-link" onClick={() => openChanges?.([change], `修改 · ${change.path.split('/').at(-1)}`)}>{change.path.replace(workspace + '/', '')}<span>查看差异 ↗</span></button>)}<OperationView call={call} result={result}/></div>}
    </details>
}

export const Conversation = memo(function Conversation({ view, openFile, openChanges }: { view: SessionView; openFile(path: string): void; openChanges?: ((changes: FileChange[], title?: string) => void) | undefined }) {
    const data = useMemo(() => {
        const operationResults = new Map<string, ToolResult>(), receipts = new Map<string, TranscriptMessage>(), pending = new Map<string, string>()
        const orphanTools = new Set<string>()
        for (const event of view.events) {
            const value = event.data as { type?: string; run?: { result?: ToolResult } }
            if (event.operationId && event.type === 'agent' && value?.type === 'tool-result' && value.run?.result) operationResults.set(event.operationId, value.run.result)
        }
        for (const entry of view.messages) {
            if (entry.message.role === 'assistant') for (const call of entry.message.toolCalls ?? []) pending.set(call.id, entry.operations?.find(operation => operation.callId === call.id)?.operationId ?? `${view.id}:${entry.id}:${call.id}`)
            else if (entry.message.role === 'tool') {
                const operation = pending.get(entry.message.toolCallId)
                if (operation) receipts.set(operation, entry); else orphanTools.add(entry.id)
            }
        }
        return { operationResults, receipts, orphanTools }
    }, [view.id, view.messages, view.events])
    let previousRole = ''
    return <div className="messages">{view.messages.map(entry => {
        const message = entry.message
        if (message.role === 'tool') return data.orphanTools.has(entry.id) ? <details key={entry.id} className="tool-card"><summary>{toolSummary({ name: message.toolName, input: {} })}<span className="tool-status">{message.isError ? '失败' : '完成'}</span></summary><ReadableValue value={message.content}/></details> : null
        const continuation = message.role === 'assistant' && previousRole === 'assistant'
        previousRole = message.role
        return <article className={`message ${message.role}`} key={entry.id}>
            {message.role === 'assistant' && !continuation && <div className="message-label"><img src={fox} alt=""/>QuiFox</div>}
            {message.role === 'user' && entry.origin !== 'human' && <div className="message-label">{entry.origin === 'other-agent' ? '其他 Agent' : '上下文'}</div>}
            <div className="message-body">{message.role === 'assistant' && message.reasoning && <details className="reasoning"><summary>思考过程</summary><div>{message.reasoning}</div></details>}
                <MarkdownBody content={message.content} openFile={openFile}/>
                {message.role === 'assistant' && message.toolCalls?.map(call => {
                    const operation = entry.operations?.find(operation => operation.callId === call.id)?.operationId ?? `${view.id}:${entry.id}:${call.id}`, receipt = data.receipts.get(operation)?.message
                    const result = data.operationResults.get(operation) ?? (receipt?.role === 'tool' ? { status: receipt.isError ? 'error' as const : 'success' as const, content: receipt.content } : undefined)
                    return <ToolCard key={operation} call={call} result={result} workspace={view.workspace} openChanges={openChanges} status={view.approvals.some(approval => approval.operationId === operation) ? 'approval' : result?.status ?? (view.status === 'running' ? 'running' : 'unknown')}/>
                })}
            </div>
        </article>
    })}{view.status !== 'running' && !!view.changes?.length && openChanges && <div className="turn-changes"><Icon name="changes"/><span>本轮修改 {view.changes.length} 个文件</span><button onClick={() => openChanges(view.changes!)}>查看变更</button></div>}</div>
})

export function Trace({ view, openChild }: { view?: SessionView | undefined; openChild?: ((id: string) => void) | undefined }) {
    const records = view ? traceRecords(view) : []
    return <div className="trace-list">{records.map(record => <TraceRow key={record.id} record={record} openChild={openChild}/>)}{!records.length && <EmptyState title="操作开始后显示详情"/>}</div>
}

function TraceRow({ record, openChild }: { record: TraceRecord; openChild?: ((id: string) => void) | undefined }) {
    return <details className={`trace-record ${record.type}`}><summary><span>{record.type === 'tool' ? toolSummary({ name: record.label, input: record.input }) : record.label}</span><span className="tool-status">{statuses[record.status] ?? record.status}</span></summary>
        <div className="trace-meta">{new Date(record.timestamp).toLocaleTimeString()}{record.durationMs === undefined ? '' : ` · ${(record.durationMs / 1000).toFixed(2)} s`}</div>
        {record.type === 'tool' ? <OperationView call={{ name: record.label, input: record.input }} result={record.output as ToolResult | undefined}/> : <>{record.input !== undefined && <ReadableValue value={record.input}/>}<ReadableValue value={record.output}/></>}
        {record.children && <>{record.childId && openChild && <button onClick={() => openChild(record.childId!)}>打开子会话 ↗</button>}<div className="trace-children">{record.children.map(child => <TraceRow key={child.id} record={child} openChild={openChild}/>)}</div></>}
    </details>
}
