// @vitest-environment jsdom
import { afterEach, expect, it, vi } from 'vitest'
import { act, cleanup, render, screen } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import type { RuntimeCommand, SessionSummary } from '@quifox/shared-runtime'
import { ObservationSessions } from '../src/observation-sessions.js'
import { NavigationControls, useNavigationHistory } from '../src/navigation.js'
import type { ComponentProps } from 'react'

function ObservationPage(props: Omit<ComponentProps<typeof ObservationSessions>, 'navigation'>) {
    const navigation = useNavigationHistory({ panel: 'plugins', pluginId: 'observability' })
    return <><NavigationControls navigation={navigation}/><ObservationSessions {...props} navigation={navigation}/></>
}

afterEach(cleanup)
const session = (id: string, title: string, workspace = '/synthetic/project', parentId?: string): SessionSummary => ({ id, title, workspace, ...(parentId ? { parentId } : {}), updatedAt: '2026-10-13T00:00:00Z', status: 'idle', resumeAvailable: false })
const empty = { totalRuns: 0, runs: [], recoveries: [], evaluations: [], comparison: [] }

it('filters directory groups and nested tasks, preserves the query and restores focus when returning', async () => {
    const user = userEvent.setup(), command = vi.fn(async () => empty)
    render(<ObservationPage sessions={[session('p', '父会话'), session('c', '审查任务', undefined, 'p'), session('g', '网络搜索', undefined, 'c'), session('o', '其他工作', '/synthetic/other')]} command={command}/>)
    expect(command).not.toHaveBeenCalled()
    expect(screen.getByText('project')).toBeDefined()
    expect(screen.queryByText('/synthetic/project')).toBeNull()
    expect(screen.getByTitle('/synthetic/project')).toBeDefined()
    await user.type(screen.getByRole('textbox', { name: '筛选观察会话' }), '网络')
    expect(screen.queryByRole('button', { name: '观察其他工作' })).toBeNull()
    expect(screen.getByRole('button', { name: '观察父会话' })).toBeDefined()
    await user.click(screen.getByRole('button', { name: '观察网络搜索' }))
    await screen.findByRole('region', { name: '暂无运行记录' })
    expect(command).toHaveBeenCalledWith({ type: 'observability', action: 'summary', sessionId: 'g' })
    await user.click(screen.getByRole('button', { name: '后退' }))
    expect(screen.getByRole('textbox', { name: '筛选观察会话' })).toHaveProperty('value', '网络')
    await expect.poll(() => document.activeElement).toBe(screen.getByRole('button', { name: '观察网络搜索' }))
    await user.click(screen.getByRole('button', { name: '前进' }))
    await screen.findByRole('region', { name: '暂无运行记录' })
    expect(screen.getByText('网络搜索')).toBeDefined()
})

it('refreshes only the chosen target and ignores a late response from a previous target', async () => {
    const user = userEvent.setup(), sessions = [session('a', '会话 A'), session('b', '会话 B')]
    let reject!: (cause: Error) => void
    const pending = new Promise((_accept, fail) => { reject = fail })
    const command = vi.fn(async (input: RuntimeCommand) => input.type === 'observability' && input.sessionId === 'a' ? pending : empty)
    const rendered = render(<ObservationPage sessions={sessions} revision={1} command={command}/>)
    await user.click(screen.getByRole('button', { name: '观察会话 A' }))
    await screen.findByRole('status')
    await user.click(screen.getByRole('button', { name: '后退' }))
    await user.click(screen.getByRole('button', { name: '观察会话 B' }))
    await screen.findByRole('region', { name: '暂无运行记录' })
    await act(async () => { reject(new Error('Synthetic stale target failure')) })
    expect(screen.getByText('会话 B')).toBeDefined(); expect(screen.queryByRole('alert')).toBeNull()
    rendered.rerender(<ObservationPage sessions={sessions} revision={2} command={command}/>)
    await expect.poll(() => command.mock.calls.filter(([input]) => input.type === 'observability' && input.sessionId === 'b').length).toBe(2)
    expect(command.mock.calls.every(([input]) => input.type === 'observability')).toBe(true)
})
