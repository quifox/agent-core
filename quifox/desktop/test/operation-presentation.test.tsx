// @vitest-environment jsdom
import { expect, it, vi } from 'vitest'
import { fireEvent, render, screen } from '@testing-library/react'
import type { SessionView } from '@quifox/shared-runtime'
import { displaySession } from '../../runtime/src/display-projection.js'
import { Conversation } from '../src/presentation.js'

it('uses Host operation mappings for long-ID approval and actual file receipt presentation', async () => {
    const call = { id: 'long-external-id'.repeat(30), name: 'write_file', input: { path: 'file.txt', content: 'new' } }
    const operation = `session:batch:${call.id}`
    const view: SessionView = { id: 'session', title: 'Task', workspace: '/synthetic', status: 'running', updatedAt: '2026-01-01', resumeAvailable: false,
        messages: [{ id: 'batch', origin: 'assistant', operations: [{ callId: call.id, operationId: operation }], message: { role: 'assistant', content: '', toolCalls: [call] } }], events: [],
        pendingMessages: [], backgroundTasks: [], toolStates: [], guidance: [], skills: { skills: [], issues: [] }, memory: { enabled: false, processing: false, content: '', summaries: 0 },
        approvals: [{ id: 'approval', sessionId: 'session', operationId: operation, call }] }
    const openChanges = vi.fn()
    const app = render(<Conversation view={displaySession(view)} openFile={vi.fn()} openChanges={openChanges}/>)
    try {
        expect(screen.getByText('待批准')).toBeDefined(); expect(screen.queryByText('结果未知')).toBeNull()
        view.status = 'idle'; view.approvals = []
        view.messages.push({ id: 'receipt', origin: 'tool', message: { role: 'tool', toolCallId: call.id, toolName: call.name, content: 'actual file receipt', isError: false } })
        view.events = [{ version: 1, sessionId: view.id, operationId: operation, sequence: 1, timestamp: '2026-01-01T00:00:00Z', type: 'agent',
            data: { type: 'tool-result', run: { call, result: { status: 'success', content: 'actual file receipt', data: { change: { path: '/synthetic/file.txt', before: 'old', after: 'new' } } } } } }]
        app.rerender(<Conversation view={displaySession(view)} openFile={vi.fn()} openChanges={openChanges}/>)
        expect(screen.getByText('完成')).toBeDefined()
        const card = app.container.querySelector('.tool-card') as HTMLDetailsElement
        card.open = true; fireEvent(card, new Event('toggle'))
        const link = await screen.findByRole('button', { name: /file.txt.*查看差异/ })
        fireEvent.click(link)
        expect(openChanges).toHaveBeenCalledWith([{ path: '/synthetic/file.txt', before: 'old', after: 'new' }], '修改 · file.txt')
    } finally { app.unmount() }
})
