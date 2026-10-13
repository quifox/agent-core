// @vitest-environment jsdom
import { afterEach, expect, it, vi } from 'vitest'
import { cleanup, render, screen } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import type { ObservabilityView, RuntimeCommand, RuntimeEvent, SessionView } from '@quifox/shared-runtime'
import { Observability } from '../src/observability.js'

afterEach(cleanup)
const summary: ObservabilityView = { totalRuns: 1, runs: [{ runId: 'run-one', sourceId: 's', status: 'success', startedAtMs: 0, durationMs: 500,
    modelCalls: 1, modelDurationMs: 100, toolCalls: 1, toolDurationMs: 100, toolErrors: 0, usage: {}, models: [], tools: [], pendingModels: [], pendingTools: [], errors: [], evaluations: [] }],
    recoveries: [], evaluations: [], comparison: [] }
function session(): SessionView {
    const events: RuntimeEvent[] = [
        { type: 'model-start' }, { type: 'model-end', result: { text: '**Actual model output**', toolCalls: [] } },
        { type: 'tool-start', call: { id: 'patch', name: 'apply_patch', input: { path: 'file.txt', oldText: 'old', newText: 'new' } } },
        { type: 'tool-result', run: { call: { id: 'patch' }, result: { status: 'success', content: 'Patched', data: { change: { path: '/synthetic/file.txt', before: 'old\n', after: 'new\n' } } } } }
    ].map((data, index) => ({ version: 1, sessionId: 's', runId: 'run-one', sequence: index + 1, type: 'agent', timestamp: new Date(index * 100).toISOString(), data }))
    return { id: 's', workspace: '/synthetic', title: 'Synthetic', status: 'idle', updatedAt: '', resumeAvailable: false, events, messages: [], pendingMessages: [],
        approvals: [], toolStates: [], backgroundTasks: [], guidance: [], skills: { skills: [], issues: [] }, memory: { enabled: true, processing: false, content: '', summaries: 0 } }
}

it('uses run-scoped events for its ordered ledger and renders actual Markdown and file diffs on expansion', async () => {
    const command = vi.fn(async (input: RuntimeCommand) => input.type === 'observability' ? summary : session()), user = userEvent.setup()
    render(<Observability sessionId="s" command={command}/>)
    await screen.findByText('步骤 1')
    expect(command).toHaveBeenCalledWith({ type: 'snapshot', sessionId: 's', runId: 'run-one', messageLimit: 1, eventLimit: 1000, traceOnly: true })
    expect(screen.queryByText('Actual model output')).toBeNull()
    await user.click(document.querySelector('.ledger-record.model > summary')!)
    expect(screen.getByText('Actual model output').tagName).toBe('STRONG')
    await user.click(document.querySelector('.ledger-record.tool > summary')!)
    expect(screen.getByText(/^\+new/)).toBeDefined(); expect(screen.getByText(/^-old/)).toBeDefined()
})

it('does not display or request the previous session run while the next session summary is pending', async () => {
    const command = vi.fn(async (input: RuntimeCommand) => input.type === 'observability' ? input.sessionId === 's' ? summary : new Promise(() => {}) : session())
    const rendered = render(<Observability sessionId="s" command={command}/>)
    await screen.findByText('步骤 1')
    rendered.rerender(<Observability sessionId="next" command={command}/>)
    expect(screen.queryByText('步骤 1')).toBeNull(); expect(screen.getByRole('status').textContent).toContain('正在读取')
    expect(command).not.toHaveBeenCalledWith(expect.objectContaining({ type: 'snapshot', sessionId: 'next', runId: 'run-one' }))
})
