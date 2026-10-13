import { expect, it } from 'vitest'
import { renderToStaticMarkup } from 'react-dom/server'
import type { RuntimeEvent, SessionView } from '@quifox/shared-runtime'
import { traceRecords } from '../src/trace.js'
import { Trace } from '../src/app.js'

it('shows one committed compaction when durable observation receipts are replayed after recovery', () => {
    const events: RuntimeEvent[] = [1, 2].map(sequence => ({ version: 1, sessionId: 'session', sequence, timestamp: '2026-01-01T00:00:00Z', type: 'compaction', data: { id: 'checkpoint', status: 'committed', summary: 'Actual persisted summary' } }))
    const records = traceRecords({ events, status: 'idle', approvals: [], toolStates: [] })
    expect(records).toHaveLength(1); expect(records[0]?.status).toBe('committed')
})

it('does not overwrite a completed tool when the same run reuses its call ID in a later batch', () => {
    const events: RuntimeEvent[] = [
        { type: 'agent', operationId: 'session:batch-one:call', data: { type: 'tool-start', call: { id: 'call', name: 'list_files', input: {} } } },
        { type: 'agent', operationId: 'session:batch-one:call', data: { type: 'tool-result', run: { call: { id: 'call' }, result: { status: 'success', content: 'first effect' } } } },
        { type: 'agent', operationId: 'session:batch-two:call', data: { type: 'tool-start', call: { id: 'call', name: 'list_files', input: {} } } },
        { type: 'tool-recovery', operationId: 'session:batch-two:call', data: { previousStatus: 'not-started', call: { id: 'call', name: 'list_files', input: {} }, result: { status: 'error', code: 'USER_INTERRUPTED' } } }
    ].map((event, index) => ({ version: 1, sessionId: 'session', runId: 'same-run', sequence: index + 1, timestamp: '2026-01-01T00:00:00Z', ...event }))
    const records = traceRecords({ events, status: 'idle', approvals: [], toolStates: [] })
    expect(records).toHaveLength(2)
    expect(records[0]).toMatchObject({ status: 'success', output: { content: 'first effect' } })
    expect(records[1]).toMatchObject({ status: 'not-started', output: { code: 'USER_INTERRUPTED' } })
})

it('pairs actual tool receipts, retains unknown calls after stop and escapes tool text', () => {
    const events: RuntimeEvent[] = [
        { type: 'tool-start', call: { id: 'first', name: 'write_file', input: { content: '<script>synthetic</script>' } } },
        { type: 'tool-result', run: { call: { id: 'first' }, result: { status: 'denied', content: 'User denied' } } },
        { type: 'tool-start', call: { id: 'second', name: 'run_command', input: { command: 'synthetic' } } },
        { type: 'run-end', outcome: { ok: false } }
    ].map((data, index) => ({ version: 1, sessionId: 'session', runId: 'run', sequence: index + 1, timestamp: '2026-01-01T00:00:00Z', type: 'agent', data }))
    const records = traceRecords({ events, status: 'stopped', approvals: [], toolStates: [] })
    expect(records.map(record => record.status)).toEqual(['denied', 'unknown'])
    const html = renderToStaticMarkup(<Trace view={{ events, status: 'stopped', approvals: [], toolStates: [] } as unknown as SessionView}/>)
    expect(html).toContain('已拒绝'); expect(html).toContain('结果未知'); expect(html).toContain('&lt;script&gt;'); expect(html).not.toContain('<script>')
})

it('pairs a durable replan receipt with its original call and explains why it was not executed', () => {
    const events: RuntimeEvent[] = [
        { version: 1, sessionId: 'session', runId: 'original', sequence: 1, timestamp: '2026-01-01T00:00:00Z', type: 'agent', data: { type: 'tool-start', call: { id: 'call', name: 'write_file', input: {} } } },
        { version: 1, sessionId: 'session', sequence: 2, timestamp: '2026-01-01T00:00:01Z', type: 'tool-recovery', data: { originalRunId: 'original', previousStatus: 'not-started', call: { id: 'call', name: 'write_file', input: {} }, result: { status: 'error', code: 'USER_INTERRUPTED', content: 'Tool was not executed before interruption.' } } }
    ]
    const records = traceRecords({ events, status: 'idle', approvals: [], toolStates: [] })
    expect(records).toHaveLength(1); expect(records[0]).toMatchObject({ status: 'not-started', output: { code: 'USER_INTERRUPTED' } })
})

it('shows committed compaction and nested child execution without inventing unstarted receipts', () => {
    const child: RuntimeEvent = { version: 1, sessionId: 'child', runId: 'child-run', sequence: 1, timestamp: '2026-01-01T00:00:00Z', type: 'agent', data: { type: 'tool-start', call: { id: 'unstarted', name: 'write_file', input: {} } } }
    const events: RuntimeEvent[] = [
        { version: 1, sessionId: 'parent', sequence: 1, timestamp: child.timestamp, type: 'subagent-event', data: { childId: 'child', title: 'Review', status: 'stopped', event: child, approvals: [], toolStates: [{ id: 'unstarted', status: 'not-started' }] } },
        { version: 1, sessionId: 'parent', sequence: 2, timestamp: child.timestamp, type: 'compaction', data: { status: 'committed', summary: 'Preserved plan' } }
    ]
    const records = traceRecords({ events, status: 'idle', approvals: [], toolStates: [] })
    expect(records[0]?.children?.[0]?.status).toBe('not-started')
    expect(records[1]).toMatchObject({ type: 'compaction', status: 'committed', output: { summary: 'Preserved plan' } })
    const html = renderToStaticMarkup(<Trace view={{ events, status: 'idle', approvals: [], toolStates: [] } as unknown as SessionView} openChild={() => {}}/>)
    expect(html).toContain('打开子会话'); expect(html).toContain('未执行'); expect(html).toContain('上下文压缩')
})
