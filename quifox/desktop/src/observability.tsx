import { useEffect, useRef, useState, type CSSProperties } from 'react'
import type { ObservabilityView, RuntimeCommand, SessionView } from '@quifox/shared-runtime'
import { toolSummary } from '@quifox/shared-runtime/presentation'
import { Disclosure, EmptyState, StatusMessage } from './ui.js'
import { SelectMenu } from './select-menu.js'
import { Icon } from './icons.js'
import { FileDiff, MarkdownBody, changedFiles, statuses } from './presentation.js'
import type { ToolResult } from '@quifox/agent-core'
import { traceRecords, type TraceRecord } from './trace.js'
import { OperationView, ReadableValue } from './operation-view.js'

type Run = ObservabilityView['runs'][number]
const status: Record<Run['status'], string> = { running: '运行中', unknown: '终态未知', success: '完成', failed: '失败', interrupted: '中断', stopped: '停止' }
const duration = (ms: number): string => ms < 1000 ? `${Math.round(ms)} ms` : `${(ms / 1000).toFixed(2)} s`
const tokens = (value: number | undefined): string => value === undefined ? '未报告' : value.toLocaleString()
const kinds = { model: '模型', tool: '工具', subagent: '子任务', task: '后台任务', error: '异常', compaction: '压缩' }
const contextNames: Record<string, string> = { 'project-guidance': '项目指引', skills: '技能', memory: '记忆', 'agent-role': '智能体角色', 'agent-definitions': '子智能体定义' }

export function Observability({ sessionId, revision, command }: {
    sessionId?: string | undefined; revision?: number | undefined; command(input: RuntimeCommand): Promise<unknown>
}) {
    const [storedView, setView] = useState<{ sessionId: string; value: ObservabilityView }>(), [error, setError] = useState(''), [selected, setSelected] = useState<string>()
    const view = storedView && storedView.sessionId === sessionId ? storedView.value : undefined
    const [tab, setTab] = useState<'trajectory' | 'context' | 'metrics'>('trajectory'), [trace, setTrace] = useState<SessionView>(), [traceError, setTraceError] = useState('')
    const previousRun = useRef<string | undefined>(undefined)
    useEffect(() => { setView(undefined); setSelected(undefined); setTrace(undefined); previousRun.current = undefined }, [sessionId])
    useEffect(() => {
        let active = true; setError('')
        if (sessionId) void command({ type: 'observability', sessionId, action: 'summary' }).then(value => { if (active) setView({ sessionId, value: value as ObservabilityView }) }, cause => { if (active) setError(cause instanceof Error ? cause.message : '观测读取失败。') })
        return () => { active = false }
    }, [sessionId, revision, command])
    const run = view?.runs.find(item => item.runId === selected) ?? view?.runs.at(-1)
    useEffect(() => {
        let active = true
        if (previousRun.current !== run?.runId) { previousRun.current = run?.runId; setTrace(undefined) }
        setTraceError('')
        if (sessionId && run && tab === 'trajectory') void command({ type: 'snapshot', sessionId, runId: run.runId, messageLimit: 1, eventLimit: 1000, traceOnly: true }).then(value => { if (active) setTrace(value as SessionView) }, cause => { if (active) setTraceError(cause instanceof Error ? cause.message : '轨迹读取失败。') })
        return () => { active = false }
    }, [sessionId, run?.runId, revision, tab, command])
    if (!sessionId) return <EmptyState title="选择一个会话查看运行观测"/>
    if (!view && !error) return <StatusMessage>正在读取运行观测…</StatusMessage>
    if (!run) return <div className="observability-page">{error ? <StatusMessage error>{error}</StatusMessage> : <EmptyState title="暂无运行记录" description="发送任务后，执行轨迹会出现在这里。"/>}</div>
    return <div className="observability-page"><div className="observation-heading"><div><h3>运行观测</h3><span className="observation-count">{view!.totalRuns} 次运行</span></div><span className={`state-pill ${run.status}`}><span className="status-dot"/>{status[run.status]}</span></div>
        {error && <StatusMessage error>{error}</StatusMessage>}
        <div className="observation-run"><SelectMenu label="选择运行" searchable value={run.runId} onChange={setSelected} options={view!.runs.map((item, index) => ({ value: item.runId,
            label: `运行 ${view!.totalRuns - view!.runs.length + index + 1} · ${new Date(item.startedAtMs).toLocaleTimeString()} · ${status[item.status]}`,
            description: `${item.variant ?? 'default'} · ${item.runId}` })).reverse()}/><span>{run.status === 'running' ? '运行中' : run.status === 'unknown' ? '耗时未报告' : duration(run.durationMs)}</span></div>
        <nav className="page-tabs observation-tabs" aria-label="观测视图">{[['trajectory', '轨迹'], ['context', '上下文'], ['metrics', '指标与评测']].map(([value, label]) => <button key={value} aria-pressed={tab === value} onClick={() => setTab(value as typeof tab)}>{label}</button>)}</nav>
        {run.status === 'unknown' && <StatusMessage>缺少结束记录，无法确认这次运行的终态。</StatusMessage>}
        {run.incomplete && <StatusMessage>存在归因缺口，调用统计不完整，未加入配置比较。</StatusMessage>}
        {tab === 'trajectory' ? traceError ? <StatusMessage error>{traceError}</StatusMessage> : !trace ? <StatusMessage>正在读取执行轨迹…</StatusMessage> : <Trajectory view={trace} run={run}/> :
            tab === 'context' ? <ContextInspector run={run}/> : <Metrics run={run} view={view!}/>}
        <Disclosure title="运行信息"><dl className="detail-list"><dt>运行 ID</dt><dd><code>{run.runId}</code></dd><dt>模型配置</dt><dd><code>{run.variant ?? 'default'}</code></dd><dt>开始时间</dt><dd>{new Date(run.startedAtMs).toLocaleString()}</dd></dl></Disclosure>
        {view!.displayTruncated && <StatusMessage>较长内容只显示有界预览，统计来自完整记录。</StatusMessage>}
    </div>
}

function ContextInspector({ run }: { run: Run }) {
    const composition = run.composition
    if (!composition) return <EmptyState title="暂无请求上下文"/>
    return <section className="context-inspector">
        {composition.truncated && <StatusMessage>观测只保存有界预览，运行时仍使用完整请求。</StatusMessage>}
        <h4>系统消息</h4>{!composition.systemMessages.length ? <div className="context-empty">当前请求没有独立系统消息</div> : composition.systemMessages.map((item, index) => <Disclosure title={`系统消息 ${index + 1}`} key={index}><ContentPreview {...item}/></Disclosure>)}
        <h4>上下文来源 <span>{composition.context.length}</span></h4>{composition.context.map((item, index) => <Disclosure title={contextNames[item.key] ?? item.key} key={index}><ContentPreview content={item.content} truncated={item.truncated}/></Disclosure>)}
        <h4>工具与插件</h4><Disclosure title={`最终工具目录（${composition.totalTools ?? composition.tools.length}）`}><div className="composition-list">{composition.tools.map((item, index) => <Disclosure title={item.name} key={index}><div>{item.description}</div></Disclosure>)}</div></Disclosure>
        <Disclosure title={`插件顺序（${composition.plugins.length}）`}><ol className="assembly-list">{composition.plugins.map((item, index) => <li key={index}><span>{String(index + 1).padStart(2, '0')}</span><code>{item.id}</code></li>)}</ol></Disclosure>
    </section>
}

function Metrics({ run, view }: { run: Run; view: ObservabilityView }) {
    return <section className="observation-metrics"><div className="metric-grid"><Metric label="模型调用" value={String(run.modelCalls)}/><Metric label="工具调用" value={String(run.toolCalls)}/><Metric label="模型耗时" value={duration(run.modelDurationMs)}/><Metric label="工具耗时" value={duration(run.toolDurationMs)}/></div>
        <dl className="usage-summary"><div><dt>输入 Tokens</dt><dd>{tokens(run.usage.inputTokens)}</dd></div><div><dt>输出 Tokens</dt><dd>{tokens(run.usage.outputTokens)}</dd></div><div><dt>总 Tokens</dt><dd>{tokens(run.usage.totalTokens)}</dd></div><div><dt>工具错误</dt><dd>{run.toolErrors}</dd></div></dl>
        {!!run.errors.length && <Disclosure title={`错误（${run.errors.length}）`} defaultOpen>{run.errors.map((item, index) => <StatusMessage error key={index}>{item.phase} · {item.code}</StatusMessage>)}</Disclosure>}
        <Disclosure title={`本轮评测（${run.evaluations.length}）`}>{!run.evaluations.length ? <EmptyState title="暂无显式评测"/> : run.evaluations.map((item, index) => <div className="evaluation-record" key={index}><strong>{item.evaluator}</strong><span>{item.passed === undefined ? '未判定' : item.passed ? '通过' : '未通过'}{item.score === undefined ? '' : ` · ${item.score}`}</span>{item.note && <div>{item.note}</div>}</div>)}</Disclosure>
        {!!view.recoveries.length && <Disclosure title="恢复记录">{view.recoveries.map((item, index) => <div key={index} className="resource-row">{item.mode} · {new Date(item.timestampMs).toLocaleString()}</div>)}</Disclosure>}
        {!!view.comparison.length && <Disclosure title="模型 / 配置比较"><div className="table-scroll"><table className="metrics-table"><thead><tr><th>配置</th><th>运行</th><th>成功率</th><th>平均耗时</th><th>平均 Tokens</th><th>评测分</th></tr></thead><tbody>{view.comparison.map(item => <tr key={item.variant}><td>{item.variant}</td><td>{item.runs}</td><td>{Math.round(item.successRate * 100)}%</td><td>{duration(item.averageDurationMs)}</td><td>{item.averageTotalTokens === undefined ? '未报告' : Math.round(item.averageTotalTokens)}</td><td>{item.evaluationScore?.toFixed(2) ?? '未评测'}</td></tr>)}</tbody></table></div></Disclosure>}
    </section>
}

function Trajectory({ view, run }: { view: SessionView; run: Run }) {
    const records = traceRecords(view), [focused, setFocused] = useState<string>()
    const origin = run.startedAtMs, start = (record: TraceRecord): number => Math.max(0, Date.parse(record.timestamp) - origin)
    const end = Math.max(1, ...records.map(record => start(record) + (record.durationMs ?? 0)))
    const steps: { model?: TraceRecord; records: TraceRecord[] }[] = []
    for (const record of records.slice(-100)) {
        if (record.type === 'model' || !steps.length) steps.push({ ...(record.type === 'model' ? { model: record } : {}), records: [] })
        steps.at(-1)!.records.push(record)
    }
    if (!records.length) return <EmptyState title="这次运行暂无详细事件"/>
    return <section className="trajectory-inspector"><div className="timing-overview"><div className="timing-caption"><span>执行时间线</span><span>{duration(end)}</span></div><div className="timing-legend">{[...new Set(records.map(record => record.type))].map(kind => <span key={kind} className={kind}><i/>{kinds[kind]}</span>)}</div><div className="timing-tracks">{records.slice(-100).map(record => <button key={record.id} title={`${record.label} · ${record.durationMs === undefined ? '未结束' : duration(record.durationMs)}`} aria-label={`定位${record.label}`} onClick={() => setFocused(record.id)} style={{ '--start': `${start(record) / end * 100}%`, '--span': `${(record.durationMs ?? 0) / end * 100}%` } as CSSProperties}><span className={`timing-bar ${record.type}${record.durationMs === undefined ? ' pending' : ''}`}/></button>)}</div></div>
        <div className="event-ledger">{steps.map((step, index) => <section className="ledger-step" key={step.records[0]!.id}><div className="ledger-step-heading"><span>步骤 {index + 1}</span><span>{new Date(step.records[0]!.timestamp).toLocaleTimeString()}</span></div>{step.records.map(record => <LedgerRow key={record.id} record={record} workspace={view.workspace} focused={record.id === focused}/>)}</section>)}</div>
        {view.displayTruncated && <StatusMessage>较长事件内容只显示预览。</StatusMessage>}
        {records.length > 100 && <StatusMessage>显示最近 100 条事件。</StatusMessage>}
    </section>
}

function LedgerRow({ record, focused = false, workspace }: { record: TraceRecord; focused?: boolean; workspace?: string | undefined }) {
    const [open, setOpen] = useState(false), element = useRef<HTMLDetailsElement>(null)
    useEffect(() => { if (focused) { setOpen(true); element.current?.scrollIntoView({ block: 'nearest' }) } }, [focused])
    const title = record.type === 'tool' ? toolSummary({ name: record.label, input: record.input }) : record.label
    const output = record.output as { text?: string; content?: string } | undefined
    const changes = record.type === 'tool' ? changedFiles(record.output as ToolResult | undefined) : []
    return <details ref={element} className={`ledger-record ${record.type}`} open={open} onToggle={event => setOpen(event.currentTarget.open)}><summary><span className="ledger-icon"><Icon name={record.type === 'model' ? 'model' : record.type === 'subagent' ? 'agents' : record.type === 'tool' ? 'file' : 'context'}/></span><span className="ledger-title">{title}</span>{['success', 'completed', 'committed'].includes(record.status) ? <span className="ledger-status complete" role="img" aria-label="调用已完成" title="调用已取得最终回执"><Icon name="check"/></span> : <span className={`ledger-status ${record.status}`}>{statuses[record.status] ?? record.status}</span>}<time>{record.durationMs === undefined ? '—' : duration(record.durationMs)}</time><Icon name="down"/></summary>
        {open && <div className="ledger-content">{record.type === 'tool' ? <OperationView call={{ name: record.label, input: record.input }} result={record.output as ToolResult | undefined}/> : <>{record.input !== undefined && <Disclosure title={record.type === 'model' ? '请求内容' : '输入内容'}><ReadableValue value={record.input}/></Disclosure>}{output?.text || output?.content ? <MarkdownBody content={output.text ?? output.content!}/> : record.output !== undefined ? <ReadableValue value={record.output}/> : <StatusMessage>还没有最终回执。</StatusMessage>}</>}
            {changes.map(change => <FileDiff key={change.path} change={change} workspace={workspace}/>)}
            {!!record.children?.length && record.children.map(child => <LedgerRow key={child.id} record={child} workspace={workspace}/>)}
            </div>}
    </details>
}

function Metric({ label, value }: { label: string; value: string }) { return <div className="metric"><span>{label}</span><strong>{value}</strong></div> }
function ContentPreview({ content, truncated }: { content: string; truncated?: boolean | undefined }) {
    return <><pre className="instruction-preview">{content}</pre>{truncated && <StatusMessage>内容只显示预览。</StatusMessage>}</>
}
