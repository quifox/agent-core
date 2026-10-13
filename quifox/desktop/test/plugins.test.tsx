// @vitest-environment jsdom
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { cleanup, render, screen } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { Plugins } from '../src/plugins.js'
import { NavigationControls, useNavigationHistory } from '../src/navigation.js'
import type { ComponentProps } from 'react'

function PluginPage(props: Omit<ComponentProps<typeof Plugins>, 'navigation'>) {
    const navigation = useNavigationHistory({ panel: 'plugins' })
    return <><NavigationControls navigation={navigation}/><Plugins {...props} navigation={navigation}/></>
}

afterEach(cleanup)
beforeEach(() => Object.defineProperties(HTMLDialogElement.prototype, { showModal: { configurable: true, value() { this.open = true } }, close: { configurable: true, value() { this.open = false } } }))
const plugin = (id: string, enabled = true) => ({ id, name: id, description: `${id} description`, source: 'builtin' as const, enabled, globalEnabled: enabled })

it.each(['external', 'constructor', '__proto__'])('opens a custom monitor and generic metadata for an unknown %s surface', async kind => {
    const command = vi.fn(async (input: { type: string }) => input.type === 'plugins' ? {
        scope: 'session', plugins: [{ id: 'model' }], marketplace: [], installed: [
            { ...plugin('Observability'), surface: { kind: 'observability', title: 'Observability' } },
            { ...plugin('unknown'), surface: { kind, title: 'External' } }
        ]
    } : input.type === 'snapshot' ? { events: [], status: 'idle', approvals: [], toolStates: [] } : {
        totalRuns: 1, runs: [{ runId: 'run-one', sourceId: 's', status: 'success', durationMs: 250, startedAtMs: 0, modelCalls: 1, modelDurationMs: 200,
            toolCalls: 0, toolErrors: 0, toolDurationMs: 0, usage: {}, models: [], tools: [], pendingModels: [], pendingTools: [], errors: [], evaluations: [],
            composition: { plugins: [{ id: 'model' }], tools: [{ name: 'read_file', description: 'Read a file' }], systemMessages: [{ content: 'SYSTEM_PREFIX' }], context: [{ key: 'guidance', content: 'CONTEXT_BODY' }] } }],
        recoveries: [], evaluations: [], comparison: []
    })
    const user = userEvent.setup()
    render(<PluginPage sessionId="another-chat" sessions={[{ id: 's', title: '被观察的会话', workspace: '/synthetic/project', updatedAt: '2026-10-13', status: 'idle', resumeAvailable: false }]} command={command}/>)
    await user.click(await screen.findByRole('button', { name: '查看Observability' }))
    await screen.findByRole('heading', { name: '选择观察会话' })
    expect(screen.queryByRole('heading', { name: '运行观测' })).toBeNull()
    await user.click(screen.getByRole('button', { name: '观察被观察的会话' }))
    await screen.findByRole('heading', { name: '运行观测' })
    expect(screen.queryByText('SYSTEM_PREFIX')).toBeNull()
    await user.click(screen.getByRole('button', { name: '上下文' }))
    await user.click(screen.getByRole('button', { name: '系统消息 1' })); expect(screen.getByText('SYSTEM_PREFIX')).toBeDefined()
    expect(command).toHaveBeenCalledWith({ type: 'observability', action: 'summary', sessionId: 's' })
    expect(screen.queryByRole('button', { name: '我的插件' })).toBeNull()
    expect(screen.queryByRole('button', { name: '返回会话列表' })).toBeNull()
    await user.click(screen.getByRole('button', { name: '后退' }))
    expect(screen.getByRole('heading', { name: '选择观察会话' })).toBeDefined()
    await user.click(screen.getByRole('button', { name: '后退' }))
    await user.click(screen.getByRole('button', { name: '查看unknown' }))
    expect(screen.getByRole('dialog')).toBeDefined(); expect(screen.getByText('unknown description', { selector: '.plugin-info-body > div' })).toBeDefined()
    expect(screen.queryByRole('heading', { name: '运行观测' })).toBeNull()
})

it('shows loading and failed plugin reads distinctly with an explicit retry', async () => {
    const command = vi.fn().mockRejectedValueOnce(new Error('Synthetic read failure')).mockResolvedValue({ scope: 'configuration', plugins: [], installed: [], marketplace: [] })
    const user = userEvent.setup()
    render(<PluginPage command={command}/>)
    expect(screen.getByRole('status').textContent).toContain('读取')
    await screen.findByRole('alert'); await user.click(screen.getByRole('button', { name: '重试' }))
    await screen.findByRole('region', { name: '没有已安装的插件' })
    expect(command).toHaveBeenCalledTimes(2)
})

it('refreshes configured plugins without closing selected details when configuration changes', async () => {
    let installed = [plugin('model'), plugin('memory')]
    const command = vi.fn(async () => ({ scope: 'configuration', plugins: [], installed, marketplace: [] }))
    const user = userEvent.setup()
    const rendered = render(<PluginPage configurationRevision="first" command={command}/>)
    await user.click(await screen.findByRole('button', { name: '查看memory' }))
    installed = [plugin('model'), plugin('mcp'), plugin('memory', false)]
    rendered.rerender(<PluginPage configurationRevision="second" command={command}/>)
    await screen.findByRole('button', { name: '查看mcp', hidden: true })
    expect(screen.getByRole('dialog')).toBeDefined(); expect(screen.getByText('已停用')).toBeDefined()
    expect(command).toHaveBeenCalledTimes(2)
})

it('separates installed activation filters from marketplace installation filters and always provides all', async () => {
    const installed = [plugin('enabled'), plugin('disabled', false)]
    const command = vi.fn(async () => ({ scope: 'configuration', plugins: [], installed, marketplace: installed.map(item => ({ ...item, installed: true })) }))
    const user = userEvent.setup()
    render(<PluginPage command={command}/>)
    await user.click(await screen.findByRole('button', { name: '禁用' }))
    expect(screen.queryByRole('button', { name: '查看enabled' })).toBeNull(); expect(screen.getByRole('button', { name: '查看disabled' })).toBeDefined()
    await user.click(screen.getByRole('button', { name: '全部' })); expect(screen.getByRole('button', { name: '查看enabled' })).toBeDefined()
    await user.click(screen.getByRole('button', { name: '插件市场' }))
    expect(screen.getByRole('button', { name: '全部插件' })).toBeDefined(); expect(screen.getByRole('button', { name: '已安装插件' })).toBeDefined()
    expect(screen.queryByRole('switch')).toBeNull()
})

it('writes plugin activation through the shared scope command and reports rejected writes', async () => {
    const command = vi.fn(async (input: { type: string }) => { if (input.type === 'plugin-set-enabled') throw new Error('Running task prevents update'); return { scope: 'configuration', plugins: [], installed: [plugin('memory')], marketplace: [] } })
    const user = userEvent.setup()
    render(<PluginPage workspace="/synthetic" command={command}/>)
    await user.click(await screen.findByRole('switch', { name: '启用memory' }))
    expect(command).toHaveBeenCalledWith({ type: 'plugin-set-enabled', pluginId: 'memory', enabled: false, scope: 'global', workspace: '/synthetic' })
    await screen.findByRole('alert'); expect(screen.getByRole('switch').getAttribute('aria-checked')).toBe('true')
})
