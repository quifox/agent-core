type Json = null | boolean | number | string | Json[] | { [key: string]: Json }
type Path = (string | number)[]
type MessagePart = { range: [number, number] } | { message: Json }
type Change = { op: 'set'; path: Path; value: Json } | { op: 'delete'; path: Path } | { op: 'splice'; path: Path; start: number; deleteCount: number; items: Json[] }
    | { op: 'pending-input'; path: Path; original: MessagePart[]; prepared: MessagePart[] }
const object = (value: Json): value is { [key: string]: Json } => value !== null && typeof value === 'object' && !Array.isArray(value)

function equal(left: Json, right: Json): boolean {
    if (left === right) return true
    if (Array.isArray(left) && Array.isArray(right)) return left.length === right.length && left.every((item, index) => equal(item, right[index]!))
    if (object(left) && object(right)) { const keys = Object.keys(left); return keys.length === Object.keys(right).length && keys.every(key => Object.hasOwn(right, key) && equal(left[key]!, right[key]!)) }
    return false
}

/** Journal-local JSON deltas preserve append-only message evidence without repeating full state. */
export function stateChanges(previous: unknown, current: unknown): Change[] {
    const changes: Change[] = []
    const history = historyMessages(previous)
    const references = new Map<string, number[]>()
    for (const [index, message] of history.entries()) { const key = JSON.stringify(message), indices = references.get(key) ?? []; indices.push(index); references.set(key, indices) }
    const parts = (messages: Json[]): MessagePart[] => {
        const result: MessagePart[] = []
        let preceding = -1
        for (const message of messages) {
            const candidates = references.get(JSON.stringify(message)), index = candidates?.find(index => index > preceding) ?? candidates?.[0]
            if (index === undefined) { result.push({ message }); preceding = -1; continue }
            const last = result.at(-1)
            if (last && 'range' in last && last.range[0] + last.range[1] === index) last.range[1] += 1
            else result.push({ range: [index, 1] })
            preceding = index
        }
        return result
    }
    const visit = (before: Json, after: Json, path: Path): void => {
        if (before === after) return
        if (Array.isArray(before) && Array.isArray(after)) {
            let start = 0
            while (start < before.length && start < after.length && equal(before[start]!, after[start]!)) start += 1
            if (start !== before.length || start !== after.length) changes.push({ op: 'splice', path, start, deleteCount: before.length - start, items: after.slice(start) })
        } else if (object(before) && object(after)) {
            for (const key of Object.keys(before)) if (!Object.hasOwn(after, key)) changes.push({ op: 'delete', path: [...path, key] })
            for (const key of Object.keys(after)) {
                const target = [...path, key], value = after[key]!
                if (!Object.hasOwn(before, key) && target.join('.') === 'session.pendingInput' && object(value) && Array.isArray(value.original) && Array.isArray(value.prepared)) {
                    changes.push({ op: 'pending-input', path: target, original: parts(value.original), prepared: parts(value.prepared) })
                } else if (!Object.hasOwn(before, key)) changes.push({ op: 'set', path: target, value })
                else visit(before[key]!, after[key]!, [...path, key])
            }
        } else changes.push({ op: 'set', path, value: after })
    }
    visit(previous as Json, current as Json, [])
    return changes
}

function revise(value: Json, path: Path, change: (value: Json) => Json, deletion = false): Json {
    if (!path.length) { if (deletion) throw new Error('Cannot delete the state root.'); return change(value) }
    const [key, ...rest] = path
    if (Array.isArray(value)) {
        if (typeof key !== 'number' || !Number.isSafeInteger(key) || key < 0 || key >= value.length || deletion) throw new Error('Invalid state array path.')
        const next = [...value]; next[key] = revise(value[key]!, rest, change); return next
    }
    if (!object(value) || typeof key !== 'string') throw new Error('Invalid state object path.')
    const next = { ...value }
    if (!rest.length) {
        if (deletion) { if (!Object.hasOwn(value, key)) throw new Error('Missing state field.'); delete next[key] }
        else Object.defineProperty(next, key, { value: change(value[key] ?? null), enumerable: true, writable: true, configurable: true })
    } else {
        if (!Object.hasOwn(value, key)) throw new Error('Missing state ancestor.')
        Object.defineProperty(next, key, { value: revise(value[key]!, rest, change, deletion), enumerable: true, writable: true, configurable: true })
    }
    return next
}

/** Copy only changed paths: historical snapshots share immutable prefixes, never mutate one another. */
export function applyStateChanges(previous: unknown, input: unknown): unknown {
    if (!Array.isArray(input)) throw new Error('Invalid state delta.')
    let value = previous as Json
    for (const item of input) {
        if (!item || typeof item !== 'object' || !Array.isArray(item.path) || !item.path.every((key: unknown) => typeof key === 'string' || typeof key === 'number')) throw new Error('Invalid state delta path.')
        const operation = item as Change
        if (operation.op === 'set' && Object.hasOwn(operation, 'value')) value = revise(value, operation.path, () => operation.value)
        else if (operation.op === 'pending-input') {
            if (operation.path.length !== 2 || operation.path[0] !== 'session' || operation.path[1] !== 'pendingInput') throw new Error('Invalid pending input path.')
            const messages = historyMessages(previous)
            const expand = (parts: MessagePart[]): Json[] => {
                if (!Array.isArray(parts)) throw new Error('Invalid pending input references.')
                return parts.flatMap(part => {
                    if (part && Object.hasOwn(part, 'message')) return [(part as { message: Json }).message]
                    if (!part || !('range' in part) || !Array.isArray(part.range)) throw new Error('Invalid message reference.')
                    const [start, count] = part.range
                    if (part.range.length !== 2 || !Number.isSafeInteger(start) || !Number.isSafeInteger(count) || start < 0 || count < 1 || start + count > messages.length) throw new Error('Message reference is outside its base state.')
                    return messages.slice(start, start + count)
                })
            }
            value = revise(value, operation.path, () => ({ original: expand(operation.original), prepared: expand(operation.prepared) }))
        }
        else if (operation.op === 'delete') value = revise(value, operation.path, () => null, true)
        else if (operation.op === 'splice') value = revise(value, operation.path, array => {
            if (!Array.isArray(array) || !Array.isArray(operation.items) || !Number.isSafeInteger(operation.start) || !Number.isSafeInteger(operation.deleteCount) || operation.start < 0 || operation.start > array.length || operation.deleteCount < 0 || operation.deleteCount > array.length - operation.start) throw new Error('Invalid state delta splice.')
            return [...array.slice(0, operation.start), ...operation.items, ...array.slice(operation.start + operation.deleteCount)]
        })
        else throw new Error('Unknown state delta operation.')
    }
    return value
}

export function stateRevision(value: unknown): unknown { return (value as { metadata?: { revision?: unknown } } | undefined)?.metadata?.revision }

function historyMessages(value: unknown): Json[] {
    const history = (value as { session?: { history?: { message: Json }[] } } | undefined)?.session?.history
    return Array.isArray(history) ? history.map(entry => entry.message) : []
}
