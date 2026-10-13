import type { RuntimeEvent } from '@quifox/shared-runtime'

const states: Record<string, string> = { running: '运行中', completed: '已完成', stopped: '已停止', cancelled: '已打断', failed: '失败', success: '已完成', error: '失败' }
const excluded = /^(?:id|sessionId|parentId|taskId|callId|toolCallId|operationId|runId|apiKey|password|headers|env|token)$/i
function readable(value: unknown, depth = 0): string {
    if (value === undefined || value === null || depth > 6) return ''
    if (typeof value === 'string') {
        if (/^\s*(?:\[|\{)/.test(value)) { try { return readable(JSON.parse(value), depth + 1) } catch { /* Actual non-JSON output is preserved. */ } }
        return states[value] ?? value
    }
    if (Array.isArray(value)) return value.slice(0, 50).map(item => readable(item, depth + 1)).join('\n')
    if (typeof value === 'object') return Object.entries(value).filter(([key]) => !excluded.test(key)).map(([key, item]) => `${key}: ${readable(item, depth + 1)}`).join('\n')
    return String(value)
}
export function toolResultText(content: string): string { return readable(content) }
export function traceText(events: RuntimeEvent[]): string {
    return events.slice(-20).map(event => {
        const data = event.data as { type?: string; call?: { name: string; input: unknown }; run?: { call: { name: string }; result: unknown } }
        if (event.type === 'agent' && data.type === 'text-delta') return ''
        if (data.type === 'tool-start' && data.call) return `${data.call.name}\n${readable(data.call.input)}`
        if (data.type === 'tool-result' && data.run) return `${data.run.call.name} · 执行结果\n${readable(data.run.result)}`
        return `${event.type} · ${data.type ?? ''}\n${readable(event.data)}`
    }).filter(Boolean).join('\n\n') || '暂无运行轨迹。'
}
