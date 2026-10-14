import type { RuntimeEvent, WorkflowGraph } from '@quifox/shared-runtime'

export type CallState = 'idle' | 'running' | 'completed' | 'failed' | 'cancelled'
export interface CallInstance { id: string; definitionId: string; parentId?: string; state: CallState }
function aggregate(states: CallState[]): CallState {
    for (const state of ['running', 'failed', 'cancelled'] as const) if (states.includes(state)) return state
    return states.length ? 'completed' : 'idle'
}

/** Fold observations by execution and call identity, never by a global current phase. */
export function workflowCallsView(graph: WorkflowGraph, events: RuntimeEvent[]) {
    const workflowEvents = events.filter(event => event.type === 'workflow'), runId = workflowEvents.at(-1)?.runId
    const current = workflowEvents.filter(event => event.runId === runId)
    const executionId = [...current].reverse().map(event => event.data as { type?: string; executionId?: string })
        .find(value => value.executionId && (value.type === 'run-started' || value.type === 'call-started'))?.executionId
        ?? [...current].reverse().map(event => (event.data as { executionId?: string }).executionId).find(Boolean)
    const instances = new Map<string, CallInstance>()
    for (const event of current) {
        const value = event.data as { type?: string; executionId?: string; definitionId?: string; callId?: string; parentCallId?: string; outcome?: string; status?: string }
        if (value.executionId === executionId && (value.type === 'run-settled' || value.type === 'checkpoint-failed')) {
            for (const call of instances.values()) if (call.state === 'running') call.state = 'cancelled'
        }
        if (value.executionId !== executionId || !value.callId || !value.definitionId || !['call-started', 'call-settled'].includes(value.type ?? '')) continue
        instances.set(value.callId, { id: value.callId, definitionId: value.definitionId, ...value.parentCallId ? { parentId: value.parentCallId } : {},
            state: value.type === 'call-started' ? 'running' : value.outcome === 'ok' ? 'completed' : 'failed' })
    }
    const calls = [...instances.values()]
    const nodes = graph.nodes.map(node => { const own = calls.filter(call => call.definitionId === node.id); return { ...node, count: own.length, state: aggregate(own.map(call => call.state)) } })
    const observed = new Map<string, { from: string; to: string; states: CallState[] }>()
    for (const call of calls) {
        const parent = call.parentId ? instances.get(call.parentId) : undefined
        if (!parent) continue
        const key = parent.definitionId + ':' + call.definitionId
        const relation = observed.get(key) ?? { from: parent.definitionId, to: call.definitionId, states: [] }
        relation.states.push(call.state); observed.set(key, relation)
    }
    const edges = graph.edges.map(edge => {
        const actual = observed.get(edge.from + ':' + edge.to)
        return { ...edge, observed: !!actual, state: actual ? aggregate(actual.states) : 'idle' as CallState }
    })
    for (const actual of observed.values()) if (!edges.some(edge => edge.from === actual.from && edge.to === actual.to)) edges.push({ from: actual.from, to: actual.to, kind: 'dynamic', observed: true, state: aggregate(actual.states) })
    return { nodes, edges, instances: calls }
}
