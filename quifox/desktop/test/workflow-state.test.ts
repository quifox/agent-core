import { expect, it } from 'vitest'
import { workflowNodeStates, workflowPhaseState } from '../src/workflow-graph.js'
import type { RuntimeEvent, WorkflowGraph } from '@quifox/shared-runtime'

it('keeps a partially completed phase distinct from a finished run or an active queued step', () => {
    expect(workflowPhaseState(['completed', 'idle'], false)).toBe('partial')
    expect(workflowPhaseState(['completed', 'queued'], false)).toBe('queued')
    expect(workflowPhaseState(['completed', 'idle'], true)).toBe('completed')
    expect(workflowPhaseState(['completed', 'cancelled'], true)).toBe('cancelled')
})
it('keeps cloned sites uncolored when their birth is outside the event window', () => {
    const graph: WorkflowGraph = { phases: [{ id: 'p', label: 'P' }, { id: 'q', label: 'Q' }], nodes: [{ id: 'a', siteId: 'ask#1', label: 'A', kind: 'issue', phase: 'p' }, { id: 'b', siteId: 'ask#1', label: 'A', kind: 'issue', phase: 'q' }], edges: [], phaseEdges: [] }
    const event: RuntimeEvent = { version: 1, sessionId: 's', runId: 'r', sequence: 2000, timestamp: '2026-10-14T00:00:00Z', type: 'workflow', data: { type: 'node-settled', instance: { siteId: 'ask#1', ordinal: 0 }, outcome: 'ok' } }
    expect([...workflowNodeStates(graph, [event]).values()]).toEqual(['idle', 'idle'])
    expect([...workflowNodeStates(graph, [{ ...event, data: { ...event.data as object, phaseName: 'P' } }]).values()]).toEqual(['completed', 'idle'])
})
it('does not let an earlier loop result hide another live instance or color a different phase', () => {
    const graph: WorkflowGraph = { phases: [{ id: 'p', label: 'P' }, { id: 'q', label: 'Q' }], nodes: [{ id: 'a', siteId: 'ask#1', label: 'A', kind: 'issue', phase: 'p' }, { id: 'b', siteId: 'ask#1', label: 'A', kind: 'issue', phase: 'q' }], edges: [], phaseEdges: [] }
    const facts = [
        { type: 'node-dispatched', instance: { siteId: 'ask#1', ordinal: 0 }, phaseName: 'P' },
        { type: 'node-dispatched', instance: { siteId: 'ask#1', ordinal: 1 }, phaseName: 'P' },
        { type: 'node-settled', instance: { siteId: 'ask#1', ordinal: 0 }, outcome: 'ok' }
    ]
    const events = facts.map((data, sequence): RuntimeEvent => ({ version: 1, sessionId: 's', runId: 'r', sequence, timestamp: '2026-10-14T00:00:00Z', type: 'workflow', data }))
    expect(workflowNodeStates(graph, events).get('a')).toBe('running')
    expect(workflowNodeStates(graph, events).get('b')).toBe('idle')
})
