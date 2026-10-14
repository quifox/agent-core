import type { AgentRecipient, SessionSummary } from './protocol.js'

export interface InputSuggestion {
    id: string; label: string; description: string; kind: 'agent' | 'skill' | 'command'
    start: number; end: number; text: string
}

/** Human-input completion only; execution stays in the ordinary Host command path. */
export function inputSuggestions(text: string, cursor: number, sources: {
    agents?: readonly AgentRecipient[]
    skills?: readonly { id: string; name: string; description: string }[]
    commands?: readonly { name: string; description: string }[]
}): InputSuggestion[] {
    const agents = agentCompletions(text, cursor, sources.agents ?? [])
    if (agents.length) return agents.map(item => ({ ...item, id: item.agent.taskId, label: `@${item.agent.name}`,
        description: item.agent.taskId.slice(0, 8), kind: 'agent' }))
    const match = /^\s*([/$])([^\s]*)$/.exec(text.slice(0, cursor))
    if (!match) return []
    const trigger = match[1]!, query = key(match[2]!), start = cursor - match[2]!.length - 1
    const commands = trigger === '/' ? (sources.commands ?? []).filter(item => key(item.name.slice(1)).startsWith(query)).map(item => ({
        id: item.name, label: item.name, description: item.description, kind: 'command' as const, start, end: cursor, text: `${item.name} `
    })) : []
    const skills = [...new Map((sources.skills ?? []).map(skill => [skill.name, skill])).values()]
        .filter(skill => (key(skill.name).startsWith(query) || key(skill.id).startsWith(query)) &&
            (trigger !== '/' || !(sources.commands ?? []).some(command => command.name === `/${skill.name}`)))
        .map(skill => ({ id: skill.id, label: `${trigger}${skill.name}`, description: skill.description, kind: 'skill' as const,
            start, end: cursor, text: `$${skill.id} ` }))
    return [...commands, ...skills]
}

export function parseSpawnInput(text: string): { count: number; mode: 'empty' | 'fork'; instructions?: string } | undefined {
    const match = /^\s*\/spawn(?:\s+([\s\S]*))?$/.exec(text)
    if (!match) return undefined
    const arguments_ = match[1]?.trim() ?? '', mode = /^--fork(?:\s|$)/.test(arguments_) ? 'fork' : 'empty'
    const rest = mode === 'fork' ? arguments_.slice(6).trim() : arguments_, first = /^(\S+)(?:\s+([\s\S]*))?$/.exec(rest)
    const numeric = first && /^[+-]?\d+(?:\.\d+)?(?:e[+-]?\d+)?$/i.test(first[1]!)
    const count = numeric ? Number(first![1]) : 1
    if (!Number.isSafeInteger(count) || count < 1 || count > 100) throw new Error('子 Agent 数量须为 1–100 的整数。')
    const instructions = (numeric ? first![2] ?? '' : rest).trim()
    return { count, mode, ...(instructions ? { instructions } : {}) }
}

/** Resolve every descendant in the current conversation tree, regardless of who created it. */
export function agentRecipients(sessions: readonly SessionSummary[], selected: string): AgentRecipient[] {
    const indexed = new Map(sessions.map(session => [session.id, session]))
    const root = (id: string): string => {
        const seen = new Set<string>()
        while (indexed.get(id)?.parentId) {
            if (seen.has(id)) throw new Error('子会话归属出现循环。')
            seen.add(id); id = indexed.get(id)!.parentId!
        }
        return id
    }
    const source = root(selected)
    return sessions.filter(session => session.parentId && session.taskId && root(session.id) === source).map(session => ({
        sessionId: session.id, taskId: session.taskId!, name: session.name ?? `Agent-${session.taskId!.slice(0, 8)}`, status: session.status
    }))
}

const key = (name: string): string => name.normalize('NFKC').toLowerCase()
const mask = (text: string): string => text.replace(/```[\s\S]*?(?:```|$)|~~~[\s\S]*?(?:~~~|$)|`[^`\n]*(?:`|$)|\\@/g, value => ' '.repeat(value.length))
    .replace(/^(?: {4}|\t).*$/gm, value => ' '.repeat(value.length))
    .replace(/^(?:[ \t]{0,3}>[ \t]?)+(?: {4}|\t).*$/gm, value => ' '.repeat(value.length))

/** Caret offsets use the DOM/string UTF-16 convention; terminal clients convert code-point offsets. */
export function agentCompletions(text: string, cursor: number, recipients: readonly AgentRecipient[]): { agent: AgentRecipient; start: number; end: number; text: string }[] {
    const prefix = mask(text.slice(0, cursor)), match = /(?:^|\s)@([\p{L}\p{N}_-]*)$/u.exec(prefix)
    if (!match) return []
    const query = key(match[1]!), start = cursor - match[1]!.length - 1
    return recipients.filter(agent => key(agent.name).startsWith(query) || agent.sessionId.startsWith(query) || agent.taskId.startsWith(query)).map(agent => ({ agent, start, end: cursor, text: `@${agent.name} ` }))
}

/** Parse routing only at the start of human input; quoted code, escapes and email addresses remain text. */
export function parseAgentInput(text: string, recipients: readonly AgentRecipient[]): { agents: AgentRecipient[]; prompt: string }[] | undefined {
    if (!/^\s*@/.test(text)) return undefined
    const masked = mask(text)
    const mentions = [...masked.matchAll(/(^|\s)@([\p{L}\p{N}_-]+)/gu)].map(match => ({ name: match[2]!, start: match.index + match[1]!.length, end: match.index + match[0].length }))
    if (!mentions.length || mentions[0]!.start !== text.search(/\S/)) return undefined
    const resolve = (name: string): AgentRecipient => {
        const exact = recipients.filter(agent => key(agent.name) === key(name) || agent.sessionId === name || agent.taskId === name)
        const found = exact.length ? exact : name.length >= 4 ? recipients.filter(agent => agent.sessionId.startsWith(name) || agent.taskId.startsWith(name)) : []
        if (found.length !== 1) throw new Error(found.length ? `子 Agent 名称或 ID 有歧义：${name}` : `子 Agent 不存在：${name}`)
        return found[0]!
    }
    const groups: { agents: AgentRecipient[]; prompt: string }[] = []
    let agents: AgentRecipient[] = [], end = mentions[0]!.start
    for (const mention of mentions) {
        const prompt = text.slice(end, mention.start).trim()
        if (prompt) { groups.push({ agents, prompt }); agents = [] }
        const agent = resolve(mention.name)
        if (!agents.some(candidate => candidate.sessionId === agent.sessionId)) agents.push(agent)
        end = mention.end
    }
    const prompt = text.slice(end).trim()
    if (!prompt) throw new Error('每组 @ 接收者后需要填写消息。')
    groups.push({ agents, prompt })
    return groups
}
