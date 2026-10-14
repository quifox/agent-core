import type { EngineFrame, RuntimeEvent, SessionView } from './protocol.js'
import { createHash } from 'node:crypto'

const identities = new Set(['id', 'sessionId', 'runId', 'parentId', 'taskId', 'operationId', 'operations', 'callId', 'role', 'origin', 'type', 'status', 'name', 'toolName', 'toolCallId', 'code', 'path', 'timestamp'])
const opaqueIdentities = new Set(['id', 'sessionId', 'runId', 'parentId', 'taskId', 'operationId', 'callId', 'toolCallId'])
interface Projection<T> { value: T; truncated: boolean; bytes: number }

/** Display-only copies; durable state and model receipts always retain their original values. */
export function displayValue<T>(input: T, characters = 65_536): Projection<T> {
    let remaining = characters, protectedCharacters = 16_384, nodes = 5000, cuts = 0
    const visit = (value: unknown, depth: number, key = ''): unknown => {
        if (--nodes < 0) { cuts += 1; return '[预览已截断]' }
        if (typeof value === 'string') {
            if (opaqueIdentities.has(key)) {
                const identity = value.length > 256 ? `sha256:${createHash('sha256').update(value).digest('hex')}` : value
                if (identity !== value) cuts += 1
                remaining -= Math.min(Math.max(0, remaining), identity.length)
                return identity
            }
            const protectedField = identities.has(key) && remaining <= 0
            const limit = Math.max(0, Math.min(identities.has(key) ? 1024 : 16_384, protectedField ? protectedCharacters : remaining))
            if (protectedField) protectedCharacters -= Math.min(value.length, limit)
            else remaining -= Math.min(value.length, limit)
            if (value.length <= limit) return value
            cuts += 1
            return value.slice(0, limit) + (['before', 'after'].includes(key) ? '' : '\n… [预览已截断]')
        }
        if (!value || typeof value !== 'object') return value
        if (depth > 12) { cuts += 1; return '[预览已截断]' }
        if (Array.isArray(value)) {
            if (value.length > 100) cuts += 1
            return value.slice(0, 100).map(item => visit(item, depth + 1))
        }
        const before = cuts, fields = Object.entries(value)
        const ordered = [...fields.filter(([name]) => identities.has(name)), ...fields.filter(([name]) => !identities.has(name))]
        if (ordered.length > 100) cuts += 1
        const result = Object.fromEntries(ordered.slice(0, 100).filter(([name]) => {
            if (name.length > 200) { cuts += 1; return false }
            remaining -= name.length
            return true
        }).map(([name, item]) => [name, visit(item, depth + 1, name)]))
        if (cuts !== before) {
            result.displayTruncated = true
            if ('before' in result && 'after' in result && 'path' in result) result.truncated = true
        }
        return result
    }
    const value = visit(input, 0) as T
    return { value, truncated: cuts > 0, bytes: Buffer.byteLength(JSON.stringify(value) ?? 'null') }
}

const eventCache = new WeakMap<RuntimeEvent, Projection<RuntimeEvent>>()
export function displayEvent(event: RuntimeEvent): Projection<RuntimeEvent> {
    let projected = eventCache.get(event)
    if (!projected) { projected = displayValue(event); eventCache.set(event, projected) }
    return projected
}

/** Keep the latest complete identities in a byte-bounded display window. */
export function displayWindow<T>(values: readonly T[], bytes: number, project = displayValue<T>): { values: T[]; truncated: boolean } {
    const result: T[] = []
    let remaining = bytes, truncated = false
    for (let index = values.length - 1; index >= 0; index -= 1) {
        const item = project(values[index]!)
        if (item.bytes > remaining) { truncated = true; break }
        result.push(item.value); remaining -= item.bytes; truncated ||= item.truncated
    }
    return { values: result.reverse(), truncated }
}

export function displaySession(view: SessionView): SessionView {
    const contentFields = ['messages', 'events', 'changes', 'backgroundTasks', 'pendingMessages', 'approvals', 'memory', 'skills', 'agents', 'guidance', 'toolStates', 'models', 'defaultModel', 'configSources', 'liveText'] as const
    const metadata = displayValue(Object.fromEntries(Object.entries(view).filter(([name]) => !contentFields.some(field => field === name))) as Omit<SessionView, typeof contentFields[number]>)
    const messages = displayWindow(view.messages, 3_000_000), events = displayWindow(view.events, 3_000_000, displayEvent)
    const changes = displayWindow(view.changes ?? [], 1_500_000), tasks = displayWindow(view.backgroundTasks, 500_000)
    const pending = displayWindow(view.pendingMessages, 300_000), approvals = displayWindow(view.approvals, 1_500_000)
    const memory = displayValue(view.memory), skills = displayValue(view.skills), agents = displayValue(view.agents), guidance = displayValue(view.guidance)
    const toolStates = displayWindow(view.toolStates, 300_000), models = displayValue(view.models), defaultModel = displayValue(view.defaultModel)
    const sources = displayValue(view.configSources), live = displayValue(view.liveText)
    const truncated = view.displayTruncated || [metadata, messages, events, changes, tasks, pending, approvals, memory, skills, agents, guidance, toolStates, models, defaultModel, sources, live].some(item => item.truncated)
    return { ...metadata.value, messages: messages.values, events: events.values, changes: changes.values, backgroundTasks: tasks.values,
        pendingMessages: pending.values, approvals: approvals.values, memory: memory.value, skills: skills.value, guidance: guidance.value,
        toolStates: toolStates.values, ...(agents.value ? { agents: agents.value } : {}), ...(models.value ? { models: models.value } : {}),
        ...(defaultModel.value ? { defaultModel: defaultModel.value } : {}), ...(sources.value ? { configSources: sources.value } : {}),
        ...(live.value ? { liveText: live.value } : {}), ...(truncated ? { displayTruncated: true } : {}) }
}

export function displayFrame(frame: EngineFrame): EngineFrame {
    if (frame.kind === 'event') return { ...frame, event: displayEvent(frame.event).value }
    if (frame.kind === 'response' && frame.ok && frame.value && typeof frame.value === 'object' &&
        'id' in frame.value && 'messages' in frame.value && 'events' in frame.value && Array.isArray(frame.value.messages) && Array.isArray(frame.value.events)) {
        return { ...frame, value: displaySession(frame.value as SessionView) }
    }
    return frame
}
