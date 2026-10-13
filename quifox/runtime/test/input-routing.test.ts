import { expect, it, vi } from 'vitest'
import type { InputRoutingReceipt, RuntimeEvent, RuntimeSnapshot, SessionView } from '../src/protocol.js'
import { synthetic } from './synthetic.js'
import { SessionJournal } from '../src/journal.js'

it('creates three passive children from one prefix and preserves their instructions until a mention wakes them', async () => {
    const fixture = await synthetic(() => ({ text: 'child reply' }))
    const observed: RuntimeEvent[] = [], unsubscribe = fixture.runtime.subscribe(event => { observed.push(event) })
    try {
        const parent = await fixture.runtime.command({ type: 'create' }) as SessionView
        const receipt = await fixture.runtime.command({ type: 'submit', sessionId: parent.id, prompt: '/spawn 3 Review the original requirements', messageId: 'synthetic-batch' }) as {
            kind: string; agents: { sessionId: string; taskId: string; name: string; status: string }[]
        }
        expect(receipt.kind).toBe('spawn'); expect(receipt.agents.map(agent => agent.name)).toEqual(['Turing', 'Curie', 'Newton'])
        expect(new Set(receipt.agents.map(agent => agent.taskId)).size).toBe(3)
        expect(receipt.agents.every(agent => agent.status === 'idle')).toBe(true)
        expect(fixture.requests).toHaveLength(0)
        await fixture.runtime.command({ type: 'submit', sessionId: parent.id, prompt: '@Turing inspect the implementation', messageId: 'synthetic-wake' })
        await fixture.runtime.waitForIdle(receipt.agents[0]!.sessionId)
        expect(fixture.requests).toHaveLength(1)
        expect(fixture.requests[0]?.messages.at(-1)?.content).toBe('inspect the implementation')
        expect(fixture.requests[0]?.messages.some(message => message.content.includes('Review the original requirements'))).toBe(true)
        const untouched = await fixture.runtime.command({ type: 'snapshot', sessionId: receipt.agents[1]!.sessionId }) as SessionView
        expect(untouched.status).toBe('idle'); expect(untouched.messages).toHaveLength(0)
        const parentView = await fixture.runtime.command({ type: 'snapshot', sessionId: parent.id }) as SessionView
        expect(parentView.messages).toHaveLength(0)
        expect(parentView.events.some(event => event.type === 'input-routing-admission')).toBe(false)
        expect(observed.some(event => event.type === 'input-routing-admission')).toBe(false)
    } finally { unsubscribe(); await fixture.close() }
})

it('validates every mention before delivery and preserves code, escaped mentions and email addresses', async () => {
    const fixture = await synthetic(() => ({ text: 'done' }))
    try {
        const parent = await fixture.runtime.command({ type: 'create' }) as SessionView
        const created = await fixture.runtime.command({ type: 'submit', sessionId: parent.id, prompt: '/spawn 2' }) as Extract<InputRoutingReceipt, { kind: 'spawn' }>
        await expect(fixture.runtime.command({ type: 'submit', sessionId: parent.id, prompt: '@Turing inspect @Missing search' })).rejects.toThrow('不存在')
        await expect(fixture.runtime.command({ type: 'submit', sessionId: parent.id, prompt: '@Turing @Curie' })).rejects.toThrow('填写消息')
        expect(fixture.requests).toHaveLength(0)
        const body = 'Review `@Curie` and person@Curie.example.\n```text\n@Curie is code\n```\n\\@Curie is escaped.\n\n    @Curie is indented code\n\t@Curie is tab code\n>     @Curie is quoted code\n> \t@Curie is quoted tab code\nNormal text.'
        await fixture.runtime.command({ type: 'submit', sessionId: parent.id, prompt: `@Turing ${body} @Curie Search only` })
        await Promise.all(created.agents.map(agent => fixture.runtime.waitForIdle(agent.sessionId)))
        const children = await Promise.all(created.agents.map(agent => fixture.runtime.command({ type: 'snapshot', sessionId: agent.sessionId }) as Promise<SessionView>))
        expect(children.map(child => child.messages.filter(item => item.message.role === 'user').at(-1)?.message.content)).toEqual([body, 'Search only'])
        expect(fixture.requests).toHaveLength(2)
    } finally { await fixture.close() }
})

it('returns persisted identities after partial creation failure and completes retry from the first original prefix', async () => {
    const fixture = await synthetic(() => ({ text: 'done' }))
    const append = SessionJournal.prototype.append
    let creations = 0
    const spy = vi.spyOn(SessionJournal.prototype, 'append').mockImplementation(function (this: SessionJournal, id, record) {
        const state = record.state as { metadata?: { initialInstructions?: string } } | undefined
        if (record.kind === 'state' && state?.metadata?.initialInstructions === 'frozen review' && ++creations === 2) return Promise.reject(new Error('Synthetic child creation failure'))
        return append.call(this, id, record)
    })
    try {
        const parent = await fixture.runtime.command({ type: 'create' }) as SessionView
        const input = { type: 'submit' as const, sessionId: parent.id, prompt: '/spawn 3 frozen review', messageId: 'partial-spawn' }
        const partial = await fixture.runtime.command(input) as Extract<InputRoutingReceipt, { kind: 'spawn' }>
        expect(partial.accepted).toBe(false); expect(partial.agents).toHaveLength(2); expect(partial.errors).toHaveLength(1)
        spy.mockRestore()
        await fixture.runtime.command({ type: 'submit', sessionId: parent.id, prompt: 'later parent input' }); await fixture.runtime.waitForIdle(parent.id)
        await fixture.restart()
        const retry = await fixture.runtime.command(input) as Extract<InputRoutingReceipt, { kind: 'spawn' }>
        expect(retry.accepted).toBe(true); expect(retry.agents).toHaveLength(3)
        expect(partial.agents.every(agent => retry.agents.some(item => item.sessionId === agent.sessionId && item.name === agent.name))).toBe(true)
        await fixture.runtime.command({ type: 'submit', sessionId: parent.id, prompt: `@${retry.agents[1]!.name} inspect` })
        await fixture.runtime.waitForIdle(retry.agents[1]!.sessionId)
        expect(fixture.requests.at(-1)?.messages.filter(message => message.role === 'user').map(message => message.content)).toEqual(['inspect'])
    } finally { spy.mockRestore(); await fixture.close() }
})

it('preserves a batch prefix across zero successful children, later parent input and a restart', async () => {
    const fixture = await synthetic(() => ({ text: 'done' }))
    const append = SessionJournal.prototype.append
    const spy = vi.spyOn(SessionJournal.prototype, 'append').mockImplementation(function (this: SessionJournal, id, record) {
        const state = record.state as { metadata?: { initialInstructions?: string } } | undefined
        if (record.kind === 'state' && state?.metadata?.initialInstructions === 'keep original prefix') return Promise.reject(new Error('Synthetic creation failure'))
        return append.call(this, id, record)
    })
    try {
        const parent = await fixture.runtime.command({ type: 'create' }) as SessionView
        await fixture.runtime.command({ type: 'submit', sessionId: parent.id, prompt: 'original requirements' }); await fixture.runtime.waitForIdle(parent.id)
        const input = { type: 'submit' as const, sessionId: parent.id, prompt: '/spawn 2 keep original prefix', messageId: 'zero-created-prefix' }
        const failed = await fixture.runtime.command(input) as Extract<InputRoutingReceipt, { kind: 'spawn' }>
        expect(failed.accepted).toBe(false); expect(failed.agents).toHaveLength(0)
        spy.mockRestore()
        await fixture.runtime.command({ type: 'submit', sessionId: parent.id, prompt: 'later parent change' }); await fixture.runtime.waitForIdle(parent.id)
        await fixture.restart()
        const retry = await fixture.runtime.command(input) as Extract<InputRoutingReceipt, { kind: 'spawn' }>
        expect(retry.accepted).toBe(true)
        await fixture.runtime.command({ type: 'submit', sessionId: parent.id, prompt: '@Turing inspect' }); await fixture.runtime.waitForIdle(retry.agents[0]!.sessionId)
        expect(fixture.requests.at(-1)?.messages.filter(message => message.role === 'user').map(message => message.content)).toEqual(['original requirements', 'inspect'])
    } finally { spy.mockRestore(); await fixture.close() }
})

it('checks explicit names across the whole tree and suffixes exhausted automatic names', async () => {
    const fixture = await synthetic(input => input.messages.at(-1)?.content === 'request duplicate' ? { calls: [{ id: 'duplicate', name: 'subagent_start', input: { name: 'ｔｕｒｉｎｇ' } }] } : { text: 'done' })
    try {
        const parent = await fixture.runtime.command({ type: 'create' }) as SessionView
        const created = await fixture.runtime.command({ type: 'submit', sessionId: parent.id, prompt: '/spawn 21' }) as Extract<InputRoutingReceipt, { kind: 'spawn' }>
        expect(created.agents).toHaveLength(21); expect(new Set(created.agents.map(agent => agent.name)).size).toBe(21)
        expect(created.agents[20]!.name).toBe('Turing2')
        await fixture.runtime.command({ type: 'submit', sessionId: created.agents[1]!.sessionId, prompt: 'request duplicate' }); await fixture.runtime.waitForIdle(created.agents[1]!.sessionId)
        const child = await fixture.runtime.command({ type: 'snapshot', sessionId: created.agents[1]!.sessionId }) as SessionView
        expect(child.messages.find(item => item.message.role === 'tool')?.message).toMatchObject({ isError: true })
        expect(child.messages.find(item => item.message.role === 'tool')?.message.content).toContain('名称已存在')
        expect((await fixture.runtime.command({ type: 'snapshot' }) as RuntimeSnapshot).sessions).toHaveLength(22)
    } finally { await fixture.close() }
})

it('broadcasts adjacent mentions and assigns separate prompts while keeping the same original prefix', async () => {
    const fixture = await synthetic(() => ({ text: 'done' }))
    try {
        const parent = await fixture.runtime.command({ type: 'create' }) as SessionView
        await fixture.runtime.command({ type: 'submit', sessionId: parent.id, prompt: 'original requirements' }); await fixture.runtime.waitForIdle(parent.id)
        const created = await fixture.runtime.command({ type: 'submit', sessionId: parent.id, prompt: '/spawn 3 reviewer instructions', messageId: 'preserved-reviewers' }) as Extract<InputRoutingReceipt, { kind: 'spawn' }>
        await fixture.runtime.command({ type: 'submit', sessionId: parent.id, prompt: 'later parent change' }); await fixture.runtime.waitForIdle(parent.id)
        const receipt = await fixture.runtime.command({ type: 'submit', sessionId: parent.id, prompt: '@Turing @Curie review lifecycle @Newton search related issues', messageId: 'split-assignments' }) as Extract<InputRoutingReceipt, { kind: 'dispatch' }>
        expect(receipt.deliveries.map(item => [item.agent.name, item.status])).toEqual([['Turing', 'queued'], ['Curie', 'queued'], ['Newton', 'queued']])
        await Promise.all(created.agents.map(agent => fixture.runtime.waitForIdle(agent.sessionId)))
        const children = await Promise.all(created.agents.map(agent => fixture.runtime.command({ type: 'snapshot', sessionId: agent.sessionId }) as Promise<SessionView>))
        expect(children.map(child => child.messages.filter(item => item.message.role === 'user').map(item => item.message.content))).toEqual([
            ['original requirements', 'review lifecycle'], ['original requirements', 'review lifecycle'], ['original requirements', 'search related issues']
        ])
        expect(fixture.requests.slice(2)).toHaveLength(3)
    } finally { await fixture.close() }
})

it('keeps names and input identities through restart and retries without duplicating creation or execution', async () => {
    const fixture = await synthetic(() => ({ text: 'done' }))
    try {
        const parent = await fixture.runtime.command({ type: 'create' }) as SessionView
        const input = { type: 'submit' as const, sessionId: parent.id, prompt: '/spawn 2 frozen instructions', messageId: 'persistent-spawn' }
        const [first, second] = await Promise.all([fixture.runtime.command(input), fixture.runtime.command(input)]) as Extract<InputRoutingReceipt, { kind: 'spawn' }>[]
        expect(second!.agents).toEqual(first!.agents)
        await fixture.restart()
        const retry = await fixture.runtime.command(input) as Extract<InputRoutingReceipt, { kind: 'spawn' }>
        expect(retry.agents).toEqual(first!.agents)
        const message = { type: 'submit' as const, sessionId: parent.id, prompt: '@Turing @Curie inspect', messageId: 'persistent-dispatch' }
        await Promise.all([fixture.runtime.command(message), fixture.runtime.command(message)])
        await Promise.all(first!.agents.map(agent => fixture.runtime.waitForIdle(agent.sessionId)))
        await fixture.restart(); await fixture.runtime.command(message)
        await Promise.all(first!.agents.map(agent => fixture.runtime.waitForIdle(agent.sessionId)))
        expect(fixture.requests).toHaveLength(2)
        expect((await fixture.runtime.command({ type: 'snapshot' }) as RuntimeSnapshot).sessions).toHaveLength(3)
    } finally { await fixture.close() }
})

it('routes to model-created children and descendants using the actual names returned by the creation tool', async () => {
    const fixture = await synthetic(input => input.messages.at(-1)?.content === 'create named children' ? { calls: [
        { id: 'named', name: 'subagent_start', input: { name: 'Auditor' } }, { id: 'automatic', name: 'subagent_start', input: {} }
    ] } : input.messages.at(-1)?.content === 'create a descendant' ? { calls: [{ id: 'nested', name: 'subagent_start', input: { name: 'Nested' } }] } : { text: 'done' })
    try {
        const parent = await fixture.runtime.command({ type: 'create' }) as SessionView
        await fixture.runtime.command({ type: 'submit', sessionId: parent.id, prompt: 'create named children' }); await fixture.runtime.waitForIdle(parent.id)
        const view = await fixture.runtime.command({ type: 'snapshot', sessionId: parent.id }) as SessionView
        const receipts = view.messages.filter(item => item.message.role === 'tool' && item.message.toolName === 'subagent_start').map(item => JSON.parse(item.message.content) as { name: string; taskId: string })
        expect(receipts.map(item => item.name)).toEqual(['Auditor', 'Turing'])
        const auditor = (await fixture.runtime.command({ type: 'snapshot' }) as RuntimeSnapshot).sessions.find(item => item.name === 'Auditor')!
        await fixture.runtime.command({ type: 'submit', sessionId: parent.id, prompt: '@Auditor create a descendant' }); await fixture.runtime.waitForIdle(auditor.id)
        const nested = (await fixture.runtime.command({ type: 'snapshot' }) as RuntimeSnapshot).sessions.find(item => item.name === 'Nested')!
        const routing = await fixture.runtime.command({ type: 'submit', sessionId: parent.id, prompt: '@Nested @Turing inspect the source' }) as Extract<InputRoutingReceipt, { kind: 'dispatch' }>
        expect(routing.accepted).toBe(true); expect(routing.deliveries.map(item => item.agent.name)).toEqual(['Nested', 'Turing'])
        await fixture.runtime.waitForIdle(nested.id)
        expect((await fixture.runtime.command({ type: 'snapshot', sessionId: nested.id }) as SessionView).messages.at(-1)?.message.content).toBe('done')
    } finally { await fixture.close() }
})

it('rejects changing the recipients of an already admitted human input identity', async () => {
    const fixture = await synthetic(() => ({ text: 'done' }))
    try {
        const parent = await fixture.runtime.command({ type: 'create' }) as SessionView
        const created = await fixture.runtime.command({ type: 'submit', sessionId: parent.id, prompt: '/spawn 2', messageId: 'create-pair' }) as { agents: { sessionId: string }[] }
        await fixture.runtime.command({ type: 'submit', sessionId: parent.id, prompt: '@Turing first assignment', messageId: 'same-input' })
        await fixture.runtime.waitForIdle(created.agents[0]!.sessionId)
        await expect(fixture.runtime.command({ type: 'submit', sessionId: parent.id, prompt: '@Curie changed assignment', messageId: 'same-input' })).rejects.toThrow('身份')
        expect(fixture.requests).toHaveLength(1)
    } finally { await fixture.close() }
})

it('rejects ordinary reuse while a routing identity is still being persisted', async () => {
    const fixture = await synthetic(() => ({ text: 'done' }))
    const append = SessionJournal.prototype.append
    let unblock!: () => void, began!: () => void
    const blocked = new Promise<void>(resolve => { unblock = resolve }), started = new Promise<void>(resolve => { began = resolve })
    let routed: Promise<unknown> | undefined
    const spy = vi.spyOn(SessionJournal.prototype, 'append').mockImplementation(async function (this: SessionJournal, id, record) {
        if (record.kind === 'event' && (record.event as { type?: string } | undefined)?.type === 'input-routing-admission') { began(); await blocked }
        return append.call(this, id, record)
    })
    try {
        const parent = await fixture.runtime.command({ type: 'create' }) as SessionView
        routed = fixture.runtime.command({ type: 'submit', sessionId: parent.id, prompt: '/spawn 1', messageId: 'in-flight-routing' })
        await started
        await expect(fixture.runtime.command({ type: 'submit', sessionId: parent.id, prompt: 'ordinary changed input', messageId: 'in-flight-routing' })).rejects.toThrow('身份')
        unblock(); await routed
        expect(fixture.requests).toHaveLength(0)
    } finally { unblock(); await routed?.catch(() => {}); spy.mockRestore(); await fixture.close() }
})

it('reserves a queued ordinary identity before the parent applies it to model history', async () => {
    let unblock!: () => void
    const blocked = new Promise<void>(resolve => { unblock = resolve })
    const fixture = await synthetic(async request => { if (request.messages.at(-1)?.content === 'blocked') await blocked; return { text: 'done' } })
    try {
        const parent = await fixture.runtime.command({ type: 'create' }) as SessionView
        await fixture.runtime.command({ type: 'submit', sessionId: parent.id, prompt: 'blocked' })
        await expect.poll(() => fixture.requests.length).toBe(1)
        await fixture.runtime.command({ type: 'submit', sessionId: parent.id, prompt: 'queued ordinary input', messageId: 'reserved-queue' })
        await expect(fixture.runtime.command({ type: 'submit', sessionId: parent.id, prompt: '/spawn 1', messageId: 'reserved-queue' })).rejects.toThrow('身份')
        expect((await fixture.runtime.command({ type: 'snapshot' }) as RuntimeSnapshot).sessions).toHaveLength(1)
        unblock(); await fixture.runtime.waitForIdle(parent.id)
        expect(fixture.requests.map(request => request.messages.at(-1)?.content)).toEqual(['blocked', 'queued ordinary input'])
    } finally { unblock(); await fixture.close() }
})

it('retries only unaccepted deliveries after a partial persistence failure', async () => {
    const fixture = await synthetic(() => ({ text: 'done' }))
    const append = SessionJournal.prototype.append
    let spy: ReturnType<typeof vi.spyOn> | undefined
    try {
        const parent = await fixture.runtime.command({ type: 'create' }) as SessionView
        const created = await fixture.runtime.command({ type: 'submit', sessionId: parent.id, prompt: '/spawn 2' }) as Extract<InputRoutingReceipt, { kind: 'spawn' }>
        const rejected = created.agents[1]!.sessionId
        spy = vi.spyOn(SessionJournal.prototype, 'append').mockImplementation(function (this: SessionJournal, id, record) {
            if (id === rejected && record.kind === 'state') return Promise.reject(new Error('Synthetic child admission failure'))
            return append.call(this, id, record)
        })
        const input = { type: 'submit' as const, sessionId: parent.id, prompt: '@Turing @Curie inspect', messageId: 'partial-delivery' }
        const partial = await fixture.runtime.command(input) as Extract<InputRoutingReceipt, { kind: 'dispatch' }>
        expect(partial.accepted).toBe(false); expect(partial.deliveries.map(item => item.status)).toEqual(['queued', 'error'])
        await fixture.runtime.waitForIdle(created.agents[0]!.sessionId)
        spy.mockRestore(); await fixture.restart()
        const retried = await fixture.runtime.command(input) as Extract<InputRoutingReceipt, { kind: 'dispatch' }>
        expect(retried.accepted).toBe(true)
        await Promise.all(created.agents.map(agent => fixture.runtime.waitForIdle(agent.sessionId)))
        expect(fixture.requests).toHaveLength(2)
    } finally { spy?.mockRestore(); await fixture.close() }
})

it('queues mentions during a running child and requires recovery before admitting a new message after failure', async () => {
    let unblock!: () => void
    const blocked = new Promise<void>(resolve => { unblock = resolve })
    let failed = false
    const fixture = await synthetic(async input => {
        const prompt = input.messages.at(-1)?.content
        if (prompt === 'first') await blocked
        if (prompt === 'fail' && !failed) { failed = true; return { status: 400 } }
        return { text: 'done' }
    })
    try {
        const parent = await fixture.runtime.command({ type: 'create' }) as SessionView
        const created = await fixture.runtime.command({ type: 'submit', sessionId: parent.id, prompt: '/spawn 1' }) as Extract<InputRoutingReceipt, { kind: 'spawn' }>
        const child = created.agents[0]!.sessionId
        await fixture.runtime.command({ type: 'submit', sessionId: parent.id, prompt: '@Turing first' })
        await expect.poll(() => fixture.requests.length).toBe(1)
        await fixture.runtime.command({ type: 'submit', sessionId: parent.id, prompt: '@Turing second' })
        expect(fixture.requests).toHaveLength(1)
        unblock(); await fixture.runtime.waitForIdle(child)
        expect(fixture.requests.map(request => request.messages.at(-1)?.content)).toEqual(['first', 'second'])
        await fixture.runtime.command({ type: 'submit', sessionId: parent.id, prompt: '@Turing fail' }); await fixture.runtime.waitForIdle(child)
        const receipt = await fixture.runtime.command({ type: 'submit', sessionId: parent.id, prompt: '@Turing after recovery', messageId: 'recover-first' }) as Extract<InputRoutingReceipt, { kind: 'dispatch' }>
        expect(receipt.accepted).toBe(false); expect(receipt.deliveries[0]?.status).toBe('error')
        expect(fixture.requests).toHaveLength(3)
        await fixture.runtime.command({ type: 'resume', sessionId: child, mode: 'continue' }); await fixture.runtime.waitForIdle(child)
        const retry = await fixture.runtime.command({ type: 'submit', sessionId: parent.id, prompt: '@Turing after recovery', messageId: 'recover-first' }) as Extract<InputRoutingReceipt, { kind: 'dispatch' }>
        expect(retry.accepted).toBe(true); await fixture.runtime.waitForIdle(child)
        expect(fixture.requests.at(-1)?.messages.at(-1)?.content).toBe('after recovery')
    } finally { unblock(); await fixture.close() }
})
