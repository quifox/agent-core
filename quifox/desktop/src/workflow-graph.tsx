import { useMemo, useState } from 'react'
import { ReactFlow, Background, Controls, BaseEdge, MarkerType, Position, getSmoothStepPath, type EdgeProps, type Node, type Edge } from '@xyflow/react'
import dagre from '@dagrejs/dagre'
import type { RuntimeEvent, WorkflowGraph } from '@quifox/shared-runtime'
import '@xyflow/react/dist/style.css'

const edgeLabels: Record<string, string> = { branch: '分支', fork: '并行', join: '汇合', loop: '循环', throw: '异常', 'may-throw': '异常路径', exit: '返回' }
const stateLabels: Record<string, string> = { running: '运行中', completed: '完成', partial: '部分完成', failed: '失败', cancelled: '已取消', queued: '等待', idle: '未执行' }
type Point = { x: number; y: number }
type RoutedEdge = Edge<{ points: Point[]; labelPosition: Point }>
function WorkflowEdge(props: EdgeProps<RoutedEdge>) {
    const points = props.data?.points
    const path = points?.length ? [{ x: props.sourceX, y: props.sourceY }, ...points.slice(1, -1), { x: props.targetX, y: props.targetY }].map((point, index) => `${index ? 'L' : 'M'} ${point.x} ${point.y}`).join(' ') : getSmoothStepPath(props)[0]
    return <BaseEdge id={props.id} path={path} {...props.markerEnd ? { markerEnd: props.markerEnd } : {}} style={props.style} label={props.label} labelX={props.data?.labelPosition.x ?? 0} labelY={props.data?.labelPosition.y ?? 0} labelStyle={props.labelStyle ?? {}} labelBgStyle={props.labelBgStyle ?? {}}/>
}
const edgeTypes = { workflow: WorkflowEdge }

export function workflowPhaseState(states: string[], completedRun: boolean): string {
    for (const state of ['running', 'queued', 'failed', 'cancelled']) if (states.includes(state)) return state
    if (states.length && states.every(state => state === 'completed')) return 'completed'
    if (states.includes('completed')) return completedRun ? 'completed' : 'partial'
    return 'idle'
}

export function workflowNodeStates(graph: WorkflowGraph, events: RuntimeEvent[]) {
    const latestRun = events.filter(event => event.type === 'workflow').at(-1)?.runId
    const instances = new Map<string, { site: string; phase: string; state: string }>()
    for (const event of events) {
        if (event.type !== 'workflow' || event.runId !== latestRun) continue
        const value = event.data as { type?: string; instance?: { siteId: string; ordinal: number }; outcome?: string; phaseName?: string }
        if (value.type === 'checkpoint-failed') { for (const instance of instances.values()) if (instance.state === 'queued' || instance.state === 'running') instance.state = 'failed'; continue }
        if (!value.instance) continue
        const state = value.type === 'node-queued' ? 'queued' : value.type === 'node-dispatched' || value.type === 'node-executing' || value.type === 'node-repairing' ? 'running' :
            value.type === 'node-settled' ? value.outcome === 'ok' ? 'completed' : value.outcome === 'cancelled' ? 'cancelled' : 'failed' : undefined
        const key = value.instance.siteId + '@' + value.instance.ordinal
        if (state) instances.set(key, { site: value.instance.siteId, phase: value.phaseName ?? instances.get(key)?.phase ?? '', state })
    }
    return new Map(graph.nodes.map(node => {
        const phase = graph.phases.find(phase => phase.id === node.phase)?.label
        const uniquePhase = new Set(graph.nodes.filter(candidate => candidate.siteId === node.siteId).map(candidate => candidate.phase)).size <= 1
        const states = [...instances.values()].filter(instance => instance.site === node.siteId && (instance.phase ? instance.phase === phase : uniquePhase)).map(instance => instance.state)
        return [node.id, states.length ? workflowPhaseState(states, false) : 'idle']
    }))
}

/** Read-only mixed phase/step view. All edges are projected from the analyzed control flow. */
export function WorkflowGraphView({ graph, events = [] }: { graph: WorkflowGraph; events?: RuntimeEvent[] | undefined }) {
    const [expanded, setExpanded] = useState<Set<string>>(new Set())
    const states = useMemo(() => workflowNodeStates(graph, events), [graph, events])
    const latestRun = events.filter(event => event.type === 'workflow').at(-1)?.runId
    const storageFailed = events.some(event => event.type === 'workflow' && event.runId === latestRun && (event.data as { type?: string }).type === 'checkpoint-failed')
    const completedRun = events.filter(event => event.type === 'workflow').some(event => (event.data as { type?: string; status?: string }).type === 'run-settled' && (event.data as { status?: string }).status === 'completed' && event.runId === events.filter(event => event.type === 'workflow').at(-1)?.runId)
    const projection = useMemo(() => {
        const layout = new dagre.graphlib.Graph({ multigraph: true }).setGraph({ rankdir: 'TB', ranksep: 52, nodesep: 64, edgesep: 28 }).setDefaultEdgeLabel(() => ({}))
        const phaseNodes = new Map(graph.phases.map(phase => [phase.id, graph.nodes.filter(node => node.phase === phase.id)]))
        const mapped = (id: string): string => { const node = graph.nodes.find(node => node.id === id); return node && !expanded.has(node.phase) ? 'phase:' + node.phase : id }
        const nodes: Node[] = graph.phases.flatMap(phase => {
            const steps = phaseNodes.get(phase.id) ?? []
            const list = expanded.has(phase.id) ? steps.map(step => ({ id: step.id, label: step.label, kind: step.kind, state: states.get(step.id) ?? 'idle', phase: phase.id })) : [{ id: 'phase:' + phase.id, label: phase.label, kind: 'phase', state: workflowPhaseState(steps.filter(step => step.kind === 'issue').map(step => states.get(step.id) ?? 'idle'), completedRun), phase: phase.id }]
            return list.map(node => {
                const mark = node.kind === 'mark', width = mark ? 180 : 224, height = mark ? 38 : 104
                layout.setNode(node.id, { width, height })
                return { id: node.id, className: mark ? 'workflow-phase-marker' : 'workflow-state-' + node.state, position: { x: 0, y: 0 }, sourcePosition: Position.Bottom, targetPosition: Position.Top,
                    data: { phase: node.phase, state: mark ? workflowPhaseState(steps.filter(step => step.kind === 'issue').map(step => states.get(step.id) ?? 'idle'), completedRun) : node.state, label: mark ? <span>阶段 · {node.label}</span> : <div className={`workflow-node ${node.state}`} title={node.label}><span className="workflow-node-state">{stateLabels[node.state]}{node.kind === 'issue' ? ' · Agent' : ''}</span><strong>{node.label}</strong>{!expanded.has(phase.id) && <small>{steps.filter(step => step.kind === 'issue').length} 个操作 · 点击展开</small>}</div> }, style: { width, height } }
            })
        })
        const boundaries = new Set(graph.edges.flatMap(edge => [edge.from, edge.to]).filter(id => !graph.nodes.some(node => node.id === id)))
        for (const id of boundaries) {
            layout.setNode(id, { width: 96, height: 44 })
            nodes.push({ id, position: { x: 0, y: 0 }, sourcePosition: Position.Bottom, targetPosition: Position.Top, data: { label: id === 'entry' ? '开始' : id === 'sink' ? '结束' : '连接' }, style: { width: 96, height: 44, borderRadius: 24 } })
        }
        const edgeIds = new Set<string>()
        const routes = new Map<string, string>()
        const edges: Edge[] = graph.edges.flatMap((edge, index) => {
            const source = mapped(edge.from), target = mapped(edge.to), signature = source + ':' + target + ':' + edge.kind
            if (source === target && edge.kind !== 'loop' || edgeIds.has(signature)) return []
            const label = edge.kind === 'fork' && graph.edges.filter(candidate => candidate.from === edge.from && candidate.kind === 'fork').length < 2 ? '调用' : edgeLabels[edge.kind]
            edgeIds.add(signature); layout.setEdge(source, target, { width: label ? 36 : 0, height: label ? 16 : 0 }, String(index)); routes.set(signature, String(index))
            const targetState = nodes.find(node => node.id === target)?.data.state, sourceState = nodes.find(node => node.id === source)?.data.state
            const incoming = new Set(graph.edges.filter(candidate => mapped(candidate.to) === target && mapped(candidate.from) !== target).map(candidate => mapped(candidate.from)))
            const active = targetState === 'running' && incoming.size <= 1 && edge.kind !== 'loop', completed = sourceState === 'completed' && targetState === 'completed' && incoming.size <= 1 && edge.kind !== 'loop'
            const color = active ? '#e1ac48' : completed ? '#55af85' : edge.kind === 'branch' ? '#9d84c6' : edge.kind === 'loop' ? '#ab8d55' : '#647887'
            return [{ id: signature, source, target, label, type: 'workflow', animated: active,
                markerEnd: { type: MarkerType.ArrowClosed, color }, style: { stroke: color, strokeWidth: active ? 2.6 : 1.6, opacity: active || completed ? 1 : .65, strokeDasharray: active || completed ? undefined : '6 5' },
                labelStyle: { fill: 'var(--text)' }, labelBgStyle: { fill: 'var(--surface)' } }]
        })
        dagre.layout(layout)
        return { nodes: nodes.map(node => { const point = layout.node(node.id); return { ...node, position: { x: point.x - point.width / 2, y: point.y - point.height / 2 } } }), edges: edges.map(edge => {
            const route = layout.edge({ v: edge.source, w: edge.target, name: routes.get(edge.id)! })
            return { ...edge, data: { points: route.points, labelPosition: { x: route.x, y: route.y } } }
        }) }
    }, [graph, expanded, states, completedRun])
    return <section className="workflow-graph" aria-label="工作流图"><div className="workflow-graph-toolbar"><span>{storageFailed ? '检查点保存失败 · 详情见本地日志' : '执行路径'}</span><button className="quiet" onClick={() => setExpanded(expanded.size ? new Set() : new Set(graph.phases.map(phase => phase.id)))}>{expanded.size ? '收起步骤' : '展开步骤'}</button></div>
        <ReactFlow key={[...expanded].join(',')} nodes={projection.nodes} edges={projection.edges} edgeTypes={edgeTypes} fitView fitViewOptions={{ padding: .15 }} minZoom={.15} maxZoom={2} nodesDraggable={false} nodesConnectable={false} elementsSelectable={false} panOnDrag zoomOnScroll zoomOnPinch zoomOnDoubleClick
            ariaLabelConfig={{ 'controls.zoomIn.ariaLabel': '放大工作流图', 'controls.zoomOut.ariaLabel': '缩小工作流图', 'controls.fitView.ariaLabel': '适合工作流视图' }}
            onNodeClick={(_event, node) => { if (typeof node.data.phase !== 'string') return; setExpanded(current => { const next = new Set(current); const phase = String(node.data.phase); if (next.has(phase)) next.delete(phase); else next.add(phase); return next }) }} colorMode="system" aria-label="只读工作流节点与分支"><Background gap={24} size={1}/><Controls showInteractive={false}/></ReactFlow>
        <div className="workflow-legend"><span>● 运行中</span><span>● 完成</span><span>● 未执行</span><span>分支 / 并行 / 循环按实际代码生成</span></div>
    </section>
}
