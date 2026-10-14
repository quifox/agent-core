import { memo, useCallback, useMemo, useState } from 'react'
import type { SessionSummary } from '@quifox/shared-runtime'
import { Icon } from './icons.js'

export interface NavigationLocation {
    panel: 'chat' | 'settings' | 'plugins' | 'workflows'
    sessionId?: string | undefined
    workspace?: string | null | undefined
    pluginId?: string | undefined
    pluginTab?: 'installed' | 'market' | undefined
    observationId?: string | undefined
    observationQuery?: string | undefined
}

export function useNavigationHistory(initial: NavigationLocation = { panel: 'chat' }) {
    const [history, setHistory] = useState({ entries: [initial], index: 0 })
    const navigate = useCallback((patch: Partial<NavigationLocation>): void => {
        setHistory(current => {
            const previous = current.entries[current.index]!, next = { ...previous, ...patch }
            if (Object.keys({ ...previous, ...next }).every(key => previous[key as keyof NavigationLocation] === next[key as keyof NavigationLocation])) return current
            return { entries: [...current.entries.slice(0, current.index + 1), next], index: current.index + 1 }
        })
    }, [])
    const replace = useCallback((patch: Partial<NavigationLocation>): void => {
        setHistory(current => ({ ...current, entries: current.entries.map((entry, index) => index === current.index ? { ...entry, ...patch } : entry) }))
    }, [])
    const back = useCallback((): void => { setHistory(current => current.index > 0 ? { ...current, index: current.index - 1 } : current) }, [])
    const forward = useCallback((): void => { setHistory(current => current.index + 1 < current.entries.length ? { ...current, index: current.index + 1 } : current) }, [])
    return { location: history.entries[history.index]!, navigate, replace, back, forward, canBack: history.index > 0, canForward: history.index + 1 < history.entries.length }
}
export type NavigationHistory = ReturnType<typeof useNavigationHistory>
export function NavigationControls({ navigation, disabled = false }: { navigation: NavigationHistory; disabled?: boolean }) {
    return <nav className="navigation-controls" aria-label="页面导航"><button className="icon-button" aria-label="后退" title="后退" disabled={disabled || !navigation.canBack} onClick={navigation.back}><Icon name="left"/></button><button className="icon-button" aria-label="前进" title="前进" disabled={disabled || !navigation.canForward} onClick={navigation.forward}><Icon name="right"/></button></nav>
}

export const basename = (path: string): string => path.split(/[\\/]/).filter(Boolean).at(-1) || path
export function sessionGroups(sessions: readonly SessionSummary[], query = ''): { path: string; items: { session: SessionSummary; depth: number }[] }[] {
    const identities = new Map(sessions.map(session => [session.id, session])), children = new Map<string, SessionSummary[]>()
    const ordered = [...sessions].sort((a, b) => b.updatedAt.localeCompare(a.updatedAt)), term = query.trim().toLocaleLowerCase()
    const included = new Set<string>()
    for (const session of sessions) {
        if (session.parentId) { const list = children.get(session.parentId) ?? []; list.push(session); children.set(session.parentId, list) }
        if (!term || `${session.title} ${session.name ?? ''} ${session.id} ${session.workspace}`.toLocaleLowerCase().includes(term)) {
            let current: SessionSummary | undefined = session
            while (current && !included.has(current.id)) { included.add(current.id); current = current.parentId ? identities.get(current.parentId) : undefined }
        }
    }
    const groups = new Map<string, { session: SessionSummary; depth: number }[]>(), visited = new Set<string>()
    const add = (session: SessionSummary, depth: number): void => {
        if (visited.has(session.id)) return
        visited.add(session.id)
        if (included.has(session.id)) { const list = groups.get(session.workspace) ?? []; list.push({ session, depth }); groups.set(session.workspace, list) }
        for (const child of children.get(session.id) ?? []) add(child, depth + 1)
    }
    for (const session of ordered) if (!session.parentId || !identities.has(session.parentId)) add(session, 0)
    for (const session of ordered) add(session, 0)
    return [...groups].map(([path, items]) => ({ path, items }))
}
export const SessionNavigation = memo(function SessionNavigation({ sessions, selected, select }: { sessions: SessionSummary[]; selected?: string | undefined; select(id: string): void }) {
    const groups = useMemo(() => sessionGroups(sessions), [sessions])
    return <nav className="session-nav">{groups.map(({ path, items }) => <section className="workspace-group" key={path}><div className="workspace-label" title={path}>▱ {basename(path)}</div>{items.map(({ session, depth }) =>
        <button key={session.id} title={session.title} className={`session-item ${depth ? 'child' : ''} ${session.id === selected ? 'selected' : ''}`} style={{ paddingLeft: 9 + Math.min(depth, 5) * 12 }} onClick={() => select(session.id)}>{depth > 0 && '↳'}<span className={`status-dot ${session.status}`}/><span className="ellipsis">{session.title}</span></button>
    )}</section>)}</nav>
})
