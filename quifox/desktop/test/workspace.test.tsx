// @vitest-environment jsdom
import { afterEach, expect, it, vi } from 'vitest'
import { act, cleanup, fireEvent, render, screen } from '@testing-library/react'
import { createRef } from 'react'
import type { ProjectFile, RuntimeCommand, SessionView } from '@quifox/shared-runtime'
import { MediaView, Workspace, type WorkspaceHandle } from '../src/workspace.js'

vi.mock('../src/code-view.js', () => ({ CodeView: ({ content }: { content: string }) => <div aria-label="文件正文">{content}</div> }))
vi.mock('../src/native-views.js', () => ({ nativeViews: { asset: async () => 'asset://synthetic', external: async () => {}, chooseDirectory: async () => '/other' } }))
afterEach(cleanup)

it('rejects a pending file presentation if the user hid the workspace before it could be displayed', async () => {
    const handle = createRef<WorkspaceHandle>()
    let finish!: (file: ProjectFile) => void
    const command = async (input: RuntimeCommand): Promise<unknown> => input.type === 'project' && input.action === 'read' ? new Promise<ProjectFile>(resolve => { finish = resolve }) : { path: '.', entries: [], truncated: false }
    const props = { ref: handle, root: '/synthetic', command, close() {}, expanded: false, setExpanded() {} }
    const mounted = render(<Workspace {...props} visible/>)
    let outcome!: Promise<unknown>
    act(() => { outcome = handle.current!.openFile('image.png').catch(cause => cause as Error) })
    mounted.rerender(<Workspace {...props} visible={false}/>)
    await act(async () => finish({ path: '/synthetic/image.png', relativePath: 'image.png', workspace: '/synthetic', kind: 'image', bytes: 10, truncated: false }))
    expect(await outcome).toBeInstanceOf(Error)
    expect(screen.queryByRole('tab', { name: 'image.png' })).toBeNull()
})

it('keeps multiple file tabs, reselects an existing tab, and closes only the chosen tab', async () => {
    const handle = createRef<WorkspaceHandle>()
    const command = async (input: RuntimeCommand): Promise<unknown> => input.type === 'project' && input.action === 'list' ? { path: '.', entries: [], truncated: false } :
        { path: `/synthetic/${input.type === 'project' ? input.path : ''}`, relativePath: input.type === 'project' ? input.path ?? '' : '', workspace: '/synthetic', kind: 'text', bytes: 10, content: input.type === 'project' ? input.path : '', truncated: false } satisfies ProjectFile
    render(<Workspace ref={handle} root="/synthetic" command={command} close={() => {}} expanded={false} setExpanded={() => {}}/>)
    let receipt!: Awaited<ReturnType<WorkspaceHandle['openFile']>>
    await act(async () => { await handle.current!.openFile('one.ts'); receipt = await handle.current!.openFile('two.ts') })
    expect(receipt.viewId.length).toBeLessThanOrEqual(200)
    expect(screen.getAllByRole('tab')).toHaveLength(2)
    expect(screen.getByRole('tab', { name: 'two.ts' }).getAttribute('aria-selected')).toBe('true')
    await act(async () => { await handle.current!.openFile('one.ts') })
    expect(screen.getAllByRole('tab')).toHaveLength(2)
    expect(screen.getByRole('tab', { name: 'one.ts' }).getAttribute('aria-selected')).toBe('true')
    fireEvent.keyDown(screen.getByRole('tab', { name: 'one.ts' }), { key: 'ArrowRight' })
    expect(screen.getByRole('tab', { name: 'two.ts' }).getAttribute('aria-selected')).toBe('true')
    fireEvent.click(screen.getByRole('button', { name: '关闭 one.ts' }))
    expect(screen.getAllByRole('tab')).toHaveLength(1)
    expect(screen.getByRole('tab', { name: 'two.ts' }).getAttribute('aria-selected')).toBe('true')
})

it('filters nested project files and presents no manual refresh control', async () => {
    const command = vi.fn(async (input: RuntimeCommand): Promise<unknown> => input.type === 'project' && input.action === 'search' ?
        { paths: ['src/nested/match.ts'], truncated: false } : { path: '.', entries: [{ name: 'src', kind: 'directory' }], truncated: false })
    render(<Workspace root="/synthetic" command={command} close={() => {}} expanded={false} setExpanded={() => {}}/>)
    fireEvent.change(screen.getByRole('textbox', { name: '筛选文件' }), { target: { value: 'match' } })
    expect(await screen.findByRole('treeitem', { name: 'src/nested/match.ts' })).toBeDefined()
    expect(screen.queryByRole('button', { name: '刷新文件树' })).toBeNull()
    expect(command).toHaveBeenCalledWith({ type: 'project', action: 'search', workspace: '/synthetic', query: 'match' })
})

it('keeps separate Diff tabs for files that share a basename', async () => {
    const handle = createRef<WorkspaceHandle>()
    render(<Workspace ref={handle} root="/synthetic" command={async () => ({ entries: [], path: '.', truncated: false })} close={() => {}} expanded={false} setExpanded={() => {}}/>)
    await act(async () => {
        handle.current!.openDiff([{ path: 'src/index.ts', before: 'old', after: 'new' }], '修改 · index.ts')
        handle.current!.openDiff([{ path: 'test/index.ts', before: 'one', after: 'two' }], '修改 · index.ts')
    })
    expect(screen.getAllByRole('tab', { name: '修改 · index.ts' })).toHaveLength(2)
})

it('chooses a browsing directory without creating a conversation', async () => {
    const command = vi.fn(async (input: RuntimeCommand): Promise<unknown> => ({ path: '.', entries: [{ name: input.type === 'project' && input.workspace === '/other' ? 'other.txt' : 'initial.txt', kind: 'file' }], truncated: false }))
    render(<Workspace root="/synthetic" command={command} close={() => {}} expanded={false} setExpanded={() => {}}/>)
    await screen.findByRole('treeitem', { name: 'initial.txt' })
    fireEvent.click(screen.getByRole('button', { name: '选择浏览目录' }))
    expect(await screen.findByRole('treeitem', { name: 'other.txt' })).toBeDefined()
    expect(command.mock.calls.map(([input]) => input.type)).not.toContain('create')
})

it('selects a remaining file when changing conversations removes the active trace tab', async () => {
    const handle = createRef<WorkspaceHandle>()
    const view: SessionView = { id: 'one', title: 'Task', workspace: '/synthetic', status: 'idle', updatedAt: '2026-01-01', resumeAvailable: false,
        messages: [], events: [], pendingMessages: [], approvals: [], toolStates: [], backgroundTasks: [], guidance: [], skills: { skills: [], issues: [] },
        memory: { enabled: false, processing: false, content: '', summaries: 0 } }
    const command = async (input: RuntimeCommand): Promise<unknown> => input.type === 'project' && input.action === 'list' ? { path: '.', entries: [], truncated: false } :
        { path: '/synthetic/one.ts', relativePath: 'one.ts', workspace: '/synthetic', kind: 'text', bytes: 4, content: 'file', truncated: false } satisfies ProjectFile
    const app = render(<Workspace ref={handle} root="/synthetic" view={view} command={command} close={() => {}} expanded={false} setExpanded={() => {}}/>)
    await act(async () => { await handle.current!.openFile('one.ts'); handle.current!.openTrace() })
    expect(screen.getByRole('tab', { name: '执行详情' }).getAttribute('aria-selected')).toBe('true')
    app.rerender(<Workspace ref={handle} root="/synthetic" view={{ ...view, id: 'two' }} command={command} close={() => {}} expanded={false} setExpanded={() => {}}/>)
    expect(screen.queryByRole('tab', { name: '执行详情' })).toBeNull()
    expect(screen.getByRole('tab', { name: 'one.ts' }).getAttribute('aria-selected')).toBe('true')
    expect(await screen.findByLabelText('文件正文')).toHaveProperty('textContent', 'file')
})

it('expands images with a restore action and releases video playback when its tab disappears', () => {
    const image = render(<MediaView kind="image" src="asset://synthetic" title="image.png"/>)
    const outerShortcut = vi.fn()
    fireEvent.click(screen.getByRole('button', { name: '展开预览' }))
    expect(screen.getByLabelText('image.png预览').getAttribute('data-expanded')).toBe('true')
    window.addEventListener('keydown', outerShortcut)
    try {
        fireEvent.keyDown(screen.getByLabelText('image.png预览'), { key: 'Escape' })
        expect(outerShortcut).not.toHaveBeenCalled()
        expect(screen.getByLabelText('image.png预览').getAttribute('data-expanded')).toBe('false')
    } finally { window.removeEventListener('keydown', outerShortcut) }
    fireEvent.click(screen.getByRole('button', { name: '展开预览' }))
    fireEvent.click(screen.getByRole('button', { name: '还原预览' }))
    expect(screen.getByLabelText('image.png预览').getAttribute('data-expanded')).toBe('false')
    image.unmount()
    const pause = vi.spyOn(HTMLMediaElement.prototype, 'pause').mockImplementation(() => {})
    const load = vi.spyOn(HTMLMediaElement.prototype, 'load').mockImplementation(() => {})
    try {
        const video = render(<MediaView kind="video" src="asset://video" title="video.mp4"/>)
        const element = screen.getByLabelText('video.mp4') as HTMLVideoElement
        expect(element.controls).toBe(true)
        video.unmount()
        expect(pause).toHaveBeenCalledTimes(1); expect(load).toHaveBeenCalledTimes(1)
        expect(element.getAttribute('src')).toBeNull()
    } finally { pause.mockRestore(); load.mockRestore() }
})
