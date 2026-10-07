import { MEMBERS, type MemberId } from './shared.js'
import type { ExecutionEvent } from '@quifox/agent-plugin-events'
import type { TeamNotification } from '@quifox/agent-plugin-teams'

interface Pane { conversation: HTMLElement; status: HTMLElement; current: HTMLElement | undefined; model: number; run: number; tools: Map<string, HTMLDetailsElement> }
const panes = new Map<MemberId, Pane>()
const inboxes = new Map<MemberId, { list: HTMLElement; count: HTMLElement; total: number }>()
const mail = new Map<string, { status: HTMLElement }>()
const inputs = new Map<string, HTMLElement>()
const connections = new Set<string>()
const streams: EventSource[] = []
let submitting = false

function element<T extends HTMLElement = HTMLElement>(selector: string): T {
    const found = document.querySelector<T>(selector)
    if (!found) { throw new Error('页面元素不存在。') }
    return found
}
function node<K extends keyof HTMLElementTagNameMap>(tag: K, className: string, text = ''): HTMLElementTagNameMap[K] {
    const result = document.createElement(tag)
    result.className = className
    result.textContent = text
    return result
}
function object(record: unknown): record is Record<string, unknown> { return typeof record === 'object' && record !== null && !Array.isArray(record) }
function label(id: string): string { return MEMBERS.find(member => member.id === id)?.label ?? id }
function selectMember(id: MemberId): void {
    for (const item of document.querySelectorAll<HTMLElement>('[data-member]')) {
        item.classList.toggle('selected', item.dataset.member === id)
    }
}
function timeLabel(at: unknown): string {
    if (typeof at !== 'string') { return '' }
    const value = new Date(at)
    return Number.isNaN(value.getTime()) ? '' : value.toLocaleTimeString('zh-CN', { hour12: false, hour: '2-digit', minute: '2-digit', second: '2-digit' })
}
function updateControls(): void {
    element('#connection').textContent = connections.size === 5 ? '5 个事件源已连接' : `事件源连接中 ${connections.size}/5`
    element('.connection').classList.toggle('connected', connections.size === 5)
    element<HTMLButtonElement>('#start').disabled = submitting || connections.size !== 5
    element<HTMLSelectElement>('#entry').disabled = submitting
}
function render(pane: Pane, change: () => void): void {
    const follow = pane.conversation.scrollHeight - pane.conversation.scrollTop - pane.conversation.clientHeight < 80
    pane.conversation.querySelector('.empty')?.remove()
    change()
    if (follow) { pane.conversation.scrollTop = pane.conversation.scrollHeight }
}
function agentEvent(pane: Pane, event: ExecutionEvent, at: unknown): void {
    render(pane, () => {
        switch (event.type) {
            case 'run-input': {
                const input = object(event.input) && typeof event.input.prompt === 'string' ? event.input.prompt : ''
                const wake = input.includes('因收到新的团队消息而被唤醒')
                pane.run += 1
                const marker = node('div', `run-marker ${wake ? 'wake' : ''}`)
                marker.append(node('strong', '', `Run ${pane.run}`), document.createTextNode(wake ? 'Teams 自动唤醒 · 读取新消息' : '外部调用开始'), node('time', '', timeLabel(at)))
                pane.conversation.append(marker)
                pane.status.textContent = 'running'; pane.status.classList.add('running')
                break
            }
            case 'model-start':
                pane.model += 1
                pane.current = node('div', 'bubble assistant')
                pane.current.append(node('span', 'bubble-label', `Model · ${timeLabel(at)}`))
                pane.conversation.append(pane.current)
                pane.status.textContent = 'running'; pane.status.classList.add('running')
                break
            case 'text-delta': if (pane.current) { pane.current.append(document.createTextNode(event.delta)) }; break
            case 'model-result': {
                if (pane.current) {
                    const heading = pane.current.querySelector('.bubble-label')
                    pane.current.replaceChildren(...(heading ? [heading] : []), document.createTextNode(event.result.text))
                    if (!event.result.text) { pane.current.remove() }
                }
                break
            }
            case 'tool-planned': {
                const detail = node('details', 'tool')
                const input = object(event.call.input) ? event.call.input : {}
                const destination = typeof input.to === 'string' ? label(input.to) : Array.isArray(input.to) ? input.to.map(String).map(label).join('、') : ''
                detail.append(node('summary', '', event.call.name === 'team_send' ? `发送消息 → ${destination}` : event.call.name === 'team_receive' ? '读取团队邮箱' : `调用 ${event.call.name}`), node('pre', '', JSON.stringify(event.call.input, null, 2)))
                pane.tools.set(`${pane.model}/${event.call.id}`, detail)
                pane.conversation.append(detail)
                break
            }
            case 'tool-result': {
                const detail = pane.tools.get(`${pane.model}/${event.run.call.id}`)
                if (detail) {
                    const interrupted = event.run.result.status !== 'success' && event.run.result.code === 'USER_INTERRUPTED'
                    detail.classList.add(event.run.result.status === 'success' ? 'done' : 'failed')
                    detail.querySelector('summary')!.textContent = interrupted ? '已跳过 · 转向新输入' : event.run.result.status !== 'success' ? '工具未完成' : event.run.call.name === 'team_send' ? '消息已投递' : event.run.call.name === 'team_receive' ? (object(event.run.result.data) && event.run.result.data.timedOut ? '暂无新消息' : '已领取团队消息') : '工具已返回'
                    detail.querySelector('pre')!.textContent = event.run.result.content
                }
                break
            }
            case 'run-ending': {
                pane.status.textContent = 'idle'; pane.status.classList.remove('running')
                const returned = node('div', 'run-return')
                returned.append(node('span', '', `Run ${pane.run} 已返回`), node('strong', '', 'idle'), node('time', '', timeLabel(at)))
                pane.conversation.append(returned)
                break
            }
            case 'error': pane.conversation.append(node('div', 'tool failed', `本轮执行未完成（${event.code}）`)); break
            default: break
        }
    })
}
function mailboxEvent(event: TeamNotification, at: unknown): void {
    if (event.type === 'message-posted') {
        const inbox = inboxes.get(event.message.to as MemberId)
        if (!inbox) { throw new Error('邮件收件人不存在。') }
        inbox.list.querySelector('.empty')?.remove()
        const entry = node('article', 'mail-item')
        const route = node('div', 'mail-route')
        const status = node('span', 'mail-state', '已发送')
        route.append(node('span', '', `${label(event.message.from)} → ${label(event.message.to)}`), node('time', 'mail-time', timeLabel(at)), status)
        entry.append(route, node('div', 'mail-content', event.message.content))
        mail.set(event.message.id, { status })
        inbox.list.append(entry)
        inbox.list.scrollTop = inbox.list.scrollHeight
        inbox.count.textContent = `${++inbox.total} 封`
    } else {
        for (const message of event.messages) {
            const entry = mail.get(message.id)
            if (entry) { entry.status.textContent = '已领取'; entry.status.classList.add('received') }
        }
    }
    element('#mail-count').textContent = String(mail.size)
}
function inputEvent(member: MemberId, prompt: string, at: unknown, id: string): void {
    const pane = panes.get(member)
    if (!pane) { return }
    render(pane, () => {
        const bubble = node('div', 'bubble user')
        const heading = node('span', 'bubble-label', `外部 run() · ${timeLabel(at)}`)
        const status = node('span', 'input-state', '已接纳')
        heading.append(status)
        bubble.append(heading, document.createTextNode(prompt))
        pane.conversation.append(bubble)
        inputs.set(id, status)
        pane.status.textContent = 'running'; pane.status.classList.add('running')
    })
}
function dispatch(source: string, raw: unknown): void {
    if (!object(raw) || typeof raw.kind !== 'string') { return }
    if (raw.kind === 'agent' && object(raw.value) && object(raw.value.event) && typeof raw.value.event.type === 'string') {
        const pane = panes.get(source as MemberId)
        if (pane) { agentEvent(pane, raw.value.event as unknown as ExecutionEvent, raw.at) }
    } else if (raw.kind === 'mailbox' && object(raw.event) && (raw.event.type === 'message-posted' || raw.event.type === 'message-received')) {
        mailboxEvent(raw.event as unknown as TeamNotification, raw.at)
    } else if (raw.kind === 'input' && typeof raw.member === 'string' && typeof raw.prompt === 'string' && typeof raw.id === 'string') {
        inputEvent(raw.member as MemberId, raw.prompt, raw.at, raw.id)
        element('#task-status').textContent = `已发送给 ${label(raw.member)}`
    } else if (raw.kind === 'input-result' && typeof raw.id === 'string') {
        const status = inputs.get(raw.id)
        if (status) { status.textContent = raw.ok === true ? '已完成' : '未完成'; status.classList.toggle('failed', raw.ok !== true) }
    } else if (raw.kind === 'history-gap') {
        element('#error').hidden = false; element('#error').textContent = '早期展示事件已超出缓存，请刷新页面。'
    }
}

for (const member of MEMBERS) {
    const card = node('article', `agent-card ${member.color}`)
    card.dataset.member = member.id
    const heading = node('header', 'agent-heading')
    const title = node('div', '')
    title.append(node('h3', '', member.label), node('small', '', member.responsibility))
    const status = node('span', 'agent-status', 'idle')
    heading.append(node('span', 'avatar', member.id), title, status)
    const conversation = node('div', 'conversation')
    conversation.setAttribute('aria-label', `${member.label}的执行流`)
    conversation.append(node('p', 'empty', '等待外部 run() 或团队消息。'))
    card.append(heading, conversation)
    element('#agents').append(card)
    panes.set(member.id, { conversation, status, current: undefined, model: 0, run: 0, tools: new Map() })

    const inbox = node('article', `inbox ${member.color}`)
    inbox.setAttribute('aria-label', `${member.label}的团队消息`)
    const inboxHeading = node('header', 'inbox-heading')
    const count = node('span', 'inbox-count', '0 封')
    inboxHeading.append(node('span', 'avatar', member.id), node('h3', '', `${member.label} 消息`), count)
    const list = node('div', 'mail-list')
    list.append(node('p', 'empty', '暂无团队消息'))
    inbox.append(inboxHeading, list)
    element('#mailboxes').append(inbox)
    inboxes.set(member.id, { list, count, total: 0 })
}

async function initialize(): Promise<void> {
    const response = await fetch('/api/config')
    if (!response.ok) { throw new Error('无法加载服务端配置。') }
    const config: unknown = await response.json()
    if (!object(config) || typeof config.task !== 'string' || typeof config.model !== 'string') { throw new Error('服务端配置格式不正确。') }
    element<HTMLTextAreaElement>('#prompt').value = config.task
    element('#model').textContent = config.model
    selectMember(element<HTMLSelectElement>('#entry').value as MemberId)
    if (object(config.states)) {
        for (const member of MEMBERS) {
            const state = config.states[member.id]
            if (state === 'running' || state === 'idle') { panes.get(member.id)!.status.textContent = state }
        }
    }
    for (const source of [...MEMBERS.map(member => member.id), 'mailbox']) {
        const stream = new EventSource(`/events/${source}`)
        streams.push(stream)
        stream.onopen = () => { connections.add(source); updateControls() }
        stream.onerror = () => { connections.delete(source); updateControls() }
        stream.onmessage = message => { try { dispatch(source, JSON.parse(message.data) as unknown) } catch { element('#error').hidden = false; element('#error').textContent = '展示事件未能解析。' } }
    }
    updateControls()
}

element<HTMLFormElement>('#task-form').addEventListener('submit', event => {
    event.preventDefault()
    element('#error').hidden = true
    submitting = true; updateControls()
    const member = element<HTMLSelectElement>('#entry').value
    void fetch('/api/runs', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ prompt: element<HTMLTextAreaElement>('#prompt').value, member }) })
        .then(async response => { if (!response.ok) { const value: unknown = await response.json(); throw new Error(object(value) && typeof value.error === 'string' ? value.error : '消息未能发送。') } })
        .catch(error => { element('#error').hidden = false; element('#error').textContent = error instanceof Error ? error.message : '消息未能发送。' })
        .finally(() => { submitting = false; updateControls() })
})
element<HTMLSelectElement>('#entry').addEventListener('change', event => {
    selectMember((event.currentTarget as HTMLSelectElement).value as MemberId)
})
window.addEventListener('pagehide', () => { for (const stream of streams) { stream.close() } })
void initialize().catch(error => { element('#error').hidden = false; element('#error').textContent = error instanceof Error ? error.message : '连接失败。' })
