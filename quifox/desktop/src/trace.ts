import type { RuntimeEvent, SessionView } from '@quifox/shared-runtime'

export interface TraceRecord { id: string; type: 'model' | 'tool' | 'task' | 'error' | 'compaction' | 'subagent'; label: string; status: string; timestamp: string; durationMs?: number; callId?: string; input?: unknown; output?: unknown; childId?: string; children?: TraceRecord[] }

/** Pair observed calls/results within their actual run; missing receipts never become success. */
export function traceRecords(view: Pick<SessionView, 'events' | 'status' | 'approvals' | 'toolStates'>): TraceRecord[] {
    const result: TraceRecord[] = [], calls = new Map<string, TraceRecord>()
    const children = new Map<string, { record: TraceRecord; view: Pick<SessionView, 'events' | 'status' | 'approvals' | 'toolStates'> }>()
    const ended = new Set<string>()
    const compactions = new Set<string>()
    let model: TraceRecord | undefined, info: unknown
    for (const event of view.events) {
        if (event.type === 'tool-recovery') {
            const data = event.data as { call?: { id: string; name: string; input: unknown }; operationId?: string; originalRunId?: string; previousStatus: string; result: { status: string; code?: string } }
            if (!data.call) continue
            const key = event.operationId ?? data.operationId ?? `${data.originalRunId ?? 'recovery'}:${data.call.id}`
            let record = calls.get(key)
            if (!record) { record = { id: `recovery:${event.sequence}`, type: 'tool', label: data.call.name, callId: data.call.id, status: data.previousStatus, timestamp: event.timestamp, input: data.call.input }; calls.set(key, record); result.push(record) }
            record.status = data.result.code === 'USER_INTERRUPTED' ? 'not-started' : data.result.code === 'TOOL_RESULT_UNKNOWN' ? 'unknown' : data.result.status
            record.output = data.result
            continue
        }
        if (event.type === 'compaction') {
            const id = (event.data as { id?: string }).id ?? String(event.sequence)
            if (compactions.has(id)) continue
            compactions.add(id)
            result.push({ id: `compact:${id}`, type: 'compaction', label: '上下文压缩', status: 'committed', timestamp: event.timestamp, output: event.data }); continue
        }
        if (event.type === 'subagent' || event.type === 'subagent-event') {
            const data = event.data as { id?: string; childId?: string; title: string; status: SessionView['status']; event?: RuntimeEvent; approvals?: SessionView['approvals']; toolStates?: SessionView['toolStates'] }
            const id = data.childId ?? data.id
            if (!id) continue
            let child = children.get(id)
            if (!child) {
                const record: TraceRecord = { id: `child:${id}`, type: 'subagent', label: data.title, status: data.status, timestamp: event.timestamp, childId: id }
                child = { record, view: { events: [], status: data.status, approvals: [], toolStates: [] } }; children.set(id, child); result.push(record)
            }
            child.record.status = data.status; child.view.status = data.status
            child.view.approvals = data.approvals ?? child.view.approvals; child.view.toolStates = data.toolStates ?? child.view.toolStates
            if (data.event && !child.view.events.some(item => item.sequence === data.event!.sequence)) child.view.events.push(data.event)
            continue
        }
        if (event.type === 'background-task') { const task = event.data as { id: string; status: string }; result.push({ id: `task:${event.sequence}`, type: 'task', label: `后台任务 ${task.id.slice(0, 8)}`, status: task.status, timestamp: event.timestamp, output: task }); continue }
        if (event.type !== 'agent') continue
        const data = event.data as { type: string; step?: number; call?: { id: string; name: string; input: unknown }; run?: { call: { id: string }; result: { status: string } }; result?: unknown; error?: unknown; model?: unknown }
        const run = event.runId ?? 'unknown'
        if (data.type === 'model-info') info = event.data
        if (data.type === 'model-start') { model = { id: `${run}:model:${event.sequence}`, type: 'model', label: (info as { requestKind?: string } | undefined)?.requestKind === 'replay' ? '续跑原工具轮' : '模型请求', status: 'running', timestamp: event.timestamp, input: info }; result.push(model) }
        else if (data.type === 'model-end' && model) { model.status = (event.data as { status?: string }).status ?? 'completed'; model.output = data.result; model.durationMs = Date.parse(event.timestamp) - Date.parse(model.timestamp); model = undefined }
        else if (data.type === 'tool-start' && data.call) {
            const record: TraceRecord = { id: `${run}:tool:${event.sequence}`, type: 'tool', label: data.call.name, status: 'running', callId: data.call.id, input: data.call.input, timestamp: event.timestamp }
            calls.set(event.operationId ?? `${run}:${data.call.id}`, record); result.push(record)
        } else if (data.type === 'tool-result' && data.run) {
            const record = calls.get(event.operationId ?? `${run}:${data.run.call.id}`)
            if (record) { record.status = data.run.result.status; record.output = data.run.result; record.durationMs = Date.parse(event.timestamp) - Date.parse(record.timestamp) }
        } else if (data.type === 'run-end') ended.add(run)
        else if (data.type === 'run-error' || data.type === 'error') result.push({ id: `error:${event.sequence}`, type: 'error', label: '运行错误', status: 'error', timestamp: event.timestamp, output: data.error ?? event.data })
    }
    for (const child of children.values()) child.record.children = traceRecords(child.view)
    for (const record of result) {
        if (record.status !== 'running') continue
        if (record.callId && view.approvals.some(approval => approval.call.id === record.callId)) record.status = 'approval'
        else if (ended.has(record.id.split(':')[0]!) || ['stopped', 'error'].includes(view.status)) record.status = view.toolStates.find(call => call.id === record.callId)?.status === 'not-started' ? 'not-started' : 'unknown'
    }
    return result
}

export function streamingText(events: RuntimeEvent[]): string {
    let text = ''
    for (const event of events) {
        if (event.type !== 'agent') continue
        const data = event.data as { type: string; delta?: string }
        if (['model-start', 'model-end', 'run-end'].includes(data.type)) text = ''
        else if (data.type === 'text-delta') text += data.delta ?? ''
    }
    return text
}
