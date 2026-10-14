export function shortcutKey(event: Pick<KeyboardEvent, 'key' | 'metaKey' | 'ctrlKey' | 'altKey'>): string | undefined {
    if ((!event.metaKey && !event.ctrlKey) || event.altKey) return undefined
    const key = event.key === '+' ? '=' : event.key.toLowerCase()
    return /^[a-z0-9=-]$/.test(key) ? `mod+${key}` : undefined
}

export function shortcutLabel(binding: string): string {
    const key = binding.slice(4)
    return `⌘/Ctrl ${key === '=' ? '+' : key.toUpperCase()}`
}
