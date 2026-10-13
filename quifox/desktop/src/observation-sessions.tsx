import { useEffect, useMemo, useRef } from 'react'
import type { RuntimeCommand, SessionSummary } from '@quifox/shared-runtime'
import { Observability } from './observability.js'
import { basename, sessionGroups, type NavigationHistory } from './navigation.js'
import { statuses } from './presentation.js'
import { Icon } from './icons.js'
import { EmptyState, StatusMessage } from './ui.js'

const emptySessions: SessionSummary[] = []
export function ObservationSessions({ navigation, sessions = emptySessions, revision, command }: { navigation: NavigationHistory; sessions?: SessionSummary[] | undefined; revision?: number | undefined; command(input: RuntimeCommand): Promise<unknown> }) {
    const target = navigation.location.observationId, query = navigation.location.observationQuery ?? ''
    const list = useRef<HTMLDivElement>(null), restore = useRef<string | undefined>(undefined)
    const groups = useMemo(() => sessionGroups(sessions, query), [sessions, query])
    const selected = sessions.find(session => session.id === target)
    const open = (id: string): void => { restore.current = id; navigation.navigate({ observationId: id }) }
    useEffect(() => {
        if (target) { restore.current = target; return }
        if (!restore.current) return
        const frame = requestAnimationFrame(() => { for (const button of list.current?.querySelectorAll<HTMLButtonElement>('button[data-session]') ?? []) if (button.dataset.session === restore.current) button.focus() })
        return () => cancelAnimationFrame(frame)
    }, [target])
    if (target) return <div className="observation-browser"><div className="observation-target"><strong title={selected?.workspace}>{selected?.title ?? '会话不可用'}</strong></div>
        {!selected ? <EmptyState title="此会话已不可用" description="返回列表选择其他会话。"/> : <>{selected.unavailable && <StatusMessage>{selected.unavailable} · 仅查看已保存记录。</StatusMessage>}<Observability key={target} sessionId={target} revision={revision} command={command}/></>}
    </div>
    const duplicates = new Set(sessions.filter((session, index) => sessions.findIndex(item => item.title === session.title) !== index).map(session => session.title))
    return <div className="observation-browser observation-session-list" ref={list}><div className="observation-list-heading"><h2>选择观察会话</h2>{sessions.length > 0 && <div className="search-control"><Icon name="search"/><input aria-label="筛选观察会话" placeholder="搜索会话、子任务或目录" value={query} onChange={event => navigation.replace({ observationQuery: event.target.value })}/></div>}</div>
        {!sessions.length ? <EmptyState title="还没有会话" description="创建会话并执行任务后，可在这里查看运行记录。"/> : !groups.length ? <EmptyState title="没有匹配的会话"/> : groups.map(({ path, items }) => <section className="observation-session-group" aria-label={path} key={path}><div className="observation-project" title={path}><Icon name="folder"/><strong>{basename(path)}</strong></div>{items.map(({ session, depth }) => <button key={session.id} data-session={session.id} className="observation-session-row" aria-label={`观察${session.title}${duplicates.has(session.title) ? ` · ${session.id.slice(0, 8)}` : ''}`} onClick={() => open(session.id)}>
            <span className="observation-session-title" style={{ paddingLeft: Math.min(depth, 5) * 16 }}>{depth > 0 && <span aria-hidden="true">↳</span>}<span className={`status-dot ${session.status}`}/><strong>{session.title}</strong>{duplicates.has(session.title) && <code>{session.id.slice(0, 8)}</code>}</span><span className="observation-session-meta"><span>{session.unavailable ? '只读' : statuses[session.status]}</span><time dateTime={session.updatedAt}>{new Date(session.updatedAt).toLocaleString()}</time><Icon name="right"/></span>
        </button>)}</section>)}
    </div>
}
