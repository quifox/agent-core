import { expect, it } from 'vitest'
import { workflowCallsView } from '../src/workflow-state.js'
import type { RuntimeEvent, WorkflowGraph } from '@quifox/shared-runtime'

const graph: WorkflowGraph = { nodes: [{ id: 'entry', label: 'Entry', kind: 'function' }, { id: 'a', label: 'A', kind: 'function' }, { id: 'b', label: 'B', kind: 'function' }], edges: [{ from: 'entry', to: 'a', kind: 'call' }, { from: 'a', to: 'b', kind: 'call' }] }
function events(facts: object[]): RuntimeEvent[] {
    return facts.map((data, sequence) => ({ version: 1, sessionId: 's', runId: 'r', sequence, timestamp: '2026-10-14T00:00:00Z', type: 'workflow', data: { executionId: 'current', ...data } }))
}
it('keeps a parent and parallel sibling live after only one child returns', () => {
    const view = workflowCallsView(graph, events([
        { type: 'call-started', callId: '1', definitionId: 'a' },
        { type: 'call-started', callId: '2', parentCallId: '1', definitionId: 'b' },
        { type: 'call-started', callId: '3', parentCallId: '1', definitionId: 'b' },
        { type: 'call-settled', callId: '2', parentCallId: '1', definitionId: 'b', outcome: 'ok' }
    ]))
    expect(view.nodes.find(node => node.id === 'a')).toMatchObject({ state: 'running', count: 1 })
    expect(view.nodes.find(node => node.id === 'b')).toMatchObject({ state: 'running', count: 2 })
    expect(view.instances.map(instance => instance.state)).toEqual(['running', 'completed', 'running'])
    expect(view.edges.find(edge => edge.from === 'a' && edge.to === 'b')).toMatchObject({ observed: true, state: 'running' })
    expect(view.nodes.find(node => node.id === 'entry')).toMatchObject({ state: 'idle', count: 0 })
})
it('adds a dynamically dispatched call and resets facts at the next execution', () => {
    const first = events([{ type: 'call-started', definitionId: 'entry', callId: '1' }, { type: 'call-settled', definitionId: 'a', callId: '2', parentCallId: '1', outcome: 'ok' }])
    expect(workflowCallsView({ ...graph, edges: [] }, first).edges).toContainEqual(expect.objectContaining({ from: 'entry', to: 'a', observed: true }))
    const next = events([{ type: 'call-started', definitionId: 'entry', callId: '1', executionId: 'next' }])
    expect(workflowCallsView(graph, [...first, ...next]).nodes.find(node => node.id === 'a')).toMatchObject({ state: 'idle', count: 0 })
})
it('closes outstanding calls on stop without claiming their work completed', () => {
    const view = workflowCallsView(graph, events([{ type: 'call-started', definitionId: 'entry', callId: '1' }, { type: 'run-settled', status: 'stopped' }]))
    expect(view.instances[0]?.state).toBe('cancelled')
})
it('marks abandoned calls as interrupted when the workflow finishes successfully', () => {
    const view = workflowCallsView(graph, events([{ type: 'call-started', definitionId: 'b', callId: '1' }, { type: 'run-settled', status: 'completed' }]))
    expect(view.instances[0]?.state).toBe('cancelled')
})
it('ignores a late checkpoint failure from a previous execution', () => {
    const view = workflowCallsView(graph, events([
        { type: 'run-started' },
        { type: 'call-started', definitionId: 'entry', callId: '1' },
        { type: 'checkpoint-failed', executionId: 'previous' }
    ]))
    expect(view.instances[0]?.state).toBe('running')
})
