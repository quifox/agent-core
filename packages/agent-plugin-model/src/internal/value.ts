/** Copy the JSON request data; cancellation signals are handled separately. */
export function copyModelValue<T>(value: T): T {
    return JSON.parse(JSON.stringify(value)) as T
}

/** Compare structured calls without making object property order significant. */
export function modelValueIdentity(value: unknown): string {
    return JSON.stringify(value, (_key, item: unknown) => {
        if (!item || typeof item !== 'object' || Array.isArray(item)) { return item }
        return Object.fromEntries(Object.entries(item).sort(([left], [right]) => left.localeCompare(right)))
    })
}
