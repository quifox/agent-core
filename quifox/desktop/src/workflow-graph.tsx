import { useMemo, useState } from 'react'
import { ReactFlow, Background, Controls, BaseEdge, Handle, MarkerType, Position, getSmoothStepPath, type EdgeProps, type NodeProps, type Node, type Edge } from '@xyflow/react'
import dagre from '@dagrejs/dagre'
import type { RuntimeEvent, SessionSummary, WorkflowGraph } from '@quifox/shared-runtime'
import { workflowCallsView, type CallState } from './workflow-state.js'
import { Icon } from './icons.js'
import '@xyflow/react/dist/style.css'

const labels: Record<CallState, string> = { idle: '尚未调用', running: '运行中', completed: '完成', failed: '失败', cancelled: '已中断' }
const colors: Record<CallState, string> = { idle: '#778592', running: '#d5a23e', completed: '#55af85', failed: '#df7878', cancelled: '#ab8d55' }
const relations: Record<string, string> = { call: '调用', conditional: '条件调用', loop: '循环调用', callback: '回调', dynamic: '实际调用' }
type Point = { x: number; y: number }
type RoutedEdge = Edge<{ points: Point[]; labelPosition: Point }>
function WorkflowEdge(props: EdgeProps<RoutedEdge>) {
    const points = props.data?.points
    const [smooth, labelX, labelY] = getSmoothStepPath({ ...props, offset: 48, borderRadius: 8 }), loop = props.source === props.target
    const path = !loop && points?.length ? [{ x: props.sourceX, y: props.sourceY }, ...points.slice(1, -1), { x: props.targetX, y: props.targetY }].map((point, index) => `${index ? 'L' : 'M'} ${point.x} ${point.y}`).join(' ') : smooth
    return <BaseEdge id={props.id} path={path} {...props.markerEnd ? { markerEnd: props.markerEnd } : {}} style={props.style} label={props.label} labelX={loop ? labelX : props.data?.labelPosition.x ?? labelX} labelY={loop ? labelY : props.data?.labelPosition.y ?? labelY} labelStyle={props.labelStyle ?? {}} labelBgStyle={props.labelBgStyle ?? {}}/>
}
const edgeTypes = { workflow: WorkflowEdge }
type CallNode = Node<{ label: string; state: CallState; count: number; instance: boolean; open(): void }, 'call'>
function WorkflowNode({ data }: NodeProps<CallNode>) {
    return <><Handle type="target" position={Position.Left}/><button className={`workflow-node nodrag nopan ${data.state}`} onClick={data.open} aria-label={`${data.label}，${labels[data.state]}，${data.count} 次调用`}><span className="workflow-node-state"><span aria-hidden="true">● </span>{labels[data.state]}</span><strong title={data.label}>{data.label}</strong><small>{data.instance ? '实际调用实例' : data.count ? `${data.count} 次调用 · 查看详情` : '方法节点'}</small></button><Handle type="source" position={Position.Right}/><Handle id="loop" type="target" position={Position.Right} style={{ top: '75%' }}/></>
}
const nodeTypes = { call: WorkflowNode }

/** Definitions stay stable; actual invocations can be inspected as a separate call tree. */
export function WorkflowGraphView({ graph, events = [], status }: { graph: WorkflowGraph; events?: RuntimeEvent[] | undefined; status?: SessionSummary['status'] | undefined }) {
    const [mode, setMode] = useState<'definitions' | 'instances'>('definitions'), [selected, setSelected] = useState<string>()
    const facts = useMemo(() => workflowCallsView(graph, events, status), [graph, events, status])
    const displayed = useMemo(() => {
        if (mode === 'definitions') return { nodes: facts.nodes, edges: facts.edges }
        return { nodes: facts.instances.map((call, index) => ({ id: call.id, label: (graph.nodes.find(node => node.id === call.definitionId)?.label ?? '节点') + ` · ${index + 1}`, kind: 'instance', state: call.state, count: 1 })),
            edges: facts.instances.flatMap(call => call.parentId && facts.instances.some(parent => parent.id === call.parentId) ? [{ from: call.parentId, to: call.id, kind: 'call', observed: true, state: call.state }] : []) }
    }, [facts, graph, mode])
    const projection = useMemo(() => {
        const layout = new dagre.graphlib.Graph({ multigraph: true }).setGraph({ rankdir: 'LR', ranksep: 80, nodesep: 36, edgesep: 32, marginx: 24, marginy: 24 }).setDefaultEdgeLabel(() => ({}))
        for (const node of displayed.nodes) layout.setNode(node.id, { width: 196, height: 96 })
        displayed.edges.forEach((edge, index) => layout.setEdge(edge.from, edge.to, { width: 74, height: 20 }, String(index)))
        dagre.layout(layout)
        const nodes: CallNode[] = displayed.nodes.map(node => {
            const point = layout.node(node.id)
            return { id: node.id, type: 'call', position: { x: point.x - 98, y: point.y - 48 }, className: 'workflow-state-' + node.state,
                style: { width: 196, height: 96 },
                data: { label: node.label, state: node.state, count: node.count, instance: mode === 'instances', open: () => setSelected(node.id) } }
        })
        const edges: Edge[] = displayed.edges.map((edge, index) => {
            const color = edge.observed ? colors[edge.state] : edge.kind === 'conditional' ? '#9d84c6' : colors.idle
            const route = layout.edge({ v: edge.from, w: edge.to, name: String(index) })
            return { id: String(index), source: edge.from, target: edge.to, label: relations[edge.kind] ?? '调用', type: 'workflow', className: edge.observed ? 'workflow-edge-observed' : 'workflow-edge-static',
                ...edge.from === edge.to ? { targetHandle: 'loop' } : {},
                markerEnd: { type: MarkerType.ArrowClosed, color }, style: { stroke: color, strokeWidth: edge.observed ? 2.2 : 1.4, opacity: edge.observed ? 1 : .65, ...!edge.observed ? { strokeDasharray: '6 5' } : {} },
                labelStyle: { fill: 'var(--muted)' }, labelBgStyle: { fill: 'var(--panel)' }, data: { points: route.points, labelPosition: { x: route.x, y: route.y } } }
        })
        return { nodes, edges }
    }, [displayed, mode])
    const selectedDefinition = mode === 'definitions' ? selected : facts.instances.find(call => call.id === selected)?.definitionId
    const selectedNode = graph.nodes.find(node => node.id === selectedDefinition), calls = facts.instances.filter(call => call.definitionId === selectedDefinition)
    return <section className="workflow-graph" aria-label="工作流图">
        <div className="workflow-graph-toolbar"><div className="workflow-view-switch" role="group" aria-label="工作流视图"><button aria-pressed={mode === 'definitions'} onClick={() => { setMode('definitions'); setSelected(undefined) }}>调用关系</button><button aria-pressed={mode === 'instances'} disabled={!facts.instances.length} onClick={() => { setMode('instances'); setSelected(undefined) }}>调用实例</button></div><span>{facts.instances.length ? `${facts.instances.length} 次调用` : `${graph.nodes.length} 个节点`}</span></div>
        <ReactFlow key={mode} nodes={projection.nodes} edges={projection.edges} nodeTypes={nodeTypes} edgeTypes={edgeTypes} fitView fitViewOptions={{ padding: .08, maxZoom: 1 }} minZoom={.1} maxZoom={2} nodesDraggable={false} nodesConnectable={false} nodesFocusable={false} elementsSelectable={false} panOnDrag zoomOnScroll zoomOnPinch zoomOnDoubleClick deleteKeyCode={null}
            ariaLabelConfig={{ 'controls.zoomIn.ariaLabel': '放大工作流图', 'controls.zoomOut.ariaLabel': '缩小工作流图', 'controls.fitView.ariaLabel': '适合工作流视图' }}
            colorMode="system" aria-label="只读工作流调用图"><Background gap={24} size={1}/><Controls showInteractive={false}/></ReactFlow>
        {selectedNode && <div className="workflow-call-details" aria-label="节点调用详情"><header><strong>{selectedNode.label}</strong><button className="icon-button" aria-label="关闭节点详情" onClick={() => setSelected(undefined)}><Icon name="close"/></button></header>{calls.length ? <ul>{calls.slice(-50).map((call, index) => <li key={call.id}><span>调用 {index + 1}</span><span style={{ color: colors[call.state] }}>{labels[call.state]}</span><span>{call.parentId ? '来自 ' + (graph.nodes.find(node => node.id === facts.instances.find(parent => parent.id === call.parentId)?.definitionId)?.label ?? '父调用') : '入口调用'}</span></li>)}</ul> : <div className="workflow-no-calls">本轮尚无此方法的调用记录。</div>}</div>}
        <div className="workflow-legend"><span>● 运行中</span><span>● 完成</span><span>虚线：静态调用关系</span><span>实线：实际调用</span></div>
    </section>
}
