import { afterEach, expect, it } from 'vitest'
import { chatModelOptions, type ScriptedModel as LanguageModel } from '../../../test/support/chat-model.mjs'
import { createDemoServer } from '../src/server.js'
import { DEFAULT_TASK, type MemberId } from '../src/shared.js'

const applications: ReturnType<typeof createDemoServer>[] = []
afterEach(async () => {
    for (const app of applications.splice(0)) {
        await new Promise<void>(resolve => { app.server.once('close', resolve); app.close() })
    }
})

function finalModel(id: MemberId): LanguageModel {
    return { provider: 'fixture', modelId: id, async *stream() {
        yield { type: 'text-delta', delta: `${id} 已完成当前输入。` }
        yield { type: 'finish', reason: 'stop' }
    } }
}

function collaborationModels(): Record<MemberId, LanguageModel> {
    let aTurn = 0
    let bTurn = 0
    const A: LanguageModel = { provider: 'fixture', modelId: 'A', async *stream() {
        aTurn += 1
        if (aTurn === 1) {
            yield { type: 'tool-call', call: { id: 'A-send', name: 'team_send', input: { to: 'B', content: '请归纳工作坊资料。' } } }
            yield { type: 'finish', reason: 'tool-calls' }
            return
        }
        yield { type: 'text-delta', delta: 'A 已完成分派。' }
        yield { type: 'finish', reason: 'stop' }
    } }
    const B: LanguageModel = { provider: 'fixture', modelId: 'B', async *stream() {
        bTurn += 1
        if (bTurn === 1) {
            yield { type: 'tool-call', call: { id: 'B-receive', name: 'team_receive', input: { timeoutMs: 0 } } }
            yield { type: 'finish', reason: 'tool-calls' }
            return
        }
        yield { type: 'text-delta', delta: 'B 已领取任务。' }
        yield { type: 'finish', reason: 'stop' }
    } }
    return { A, B, C: finalModel('C'), D: finalModel('D') }
}

async function application(models: Record<MemberId, LanguageModel> = { A: finalModel('A'), B: finalModel('B'), C: finalModel('C'), D: finalModel('D') }) {
    const app = createDemoServer({ modelId: 'fixture', models: {
        A: chatModelOptions(models.A), B: chatModelOptions(models.B),
        C: chatModelOptions(models.C), D: chatModelOptions(models.D)
    } })
    applications.push(app)
    await new Promise<void>(resolve => { app.server.listen(0, '127.0.0.1', resolve) })
    const address = app.server.address()
    if (!address || typeof address === 'string') { throw new Error('没有本地地址。') }
    return `http://127.0.0.1:${address.port}`
}

async function readUntil(reader: ReadableStreamDefaultReader<Uint8Array>, condition: (text: string) => boolean): Promise<string> {
    const decoder = new TextDecoder()
    let text = ''
    const reading = (async () => {
        while (!condition(text)) {
            const next = await reader.read()
            if (next.done) { break }
            text += decoder.decode(next.value, { stream: true })
        }
        return text
    })()
    return Promise.race([reading, new Promise<never>((_, reject) => { setTimeout(() => { reject(new Error('等待 SSE 超时。')) }, 3000) })])
}

it('任意成员 run 立即接纳，并通过邮箱 SSE 发布输入与本轮结果', async () => {
    const origin = await application()
    const controller = new AbortController()
    const response = await fetch(`${origin}/events/mailbox`, { signal: controller.signal })
    const reader = response.body!.getReader()
    try {
        const posted = await fetch(`${origin}/api/runs`, { method: 'POST', headers: { 'Content-Type': 'application/json', Origin: origin }, body: JSON.stringify({ prompt: DEFAULT_TASK, member: 'C' }) })
        expect(posted.status).toBe(202)
        const accepted = await posted.json() as { id: string }
        const text = await readUntil(reader, value => value.includes('"kind":"input-result"'))
        expect(text).toContain(`"id":"${accepted.id}"`)
        expect(text).toContain('"member":"C"')
        expect(text).toContain('"ok":true')
        expect(text).toMatch(/"at":"\d{4}-\d{2}-\d{2}T/)
    } finally { controller.abort(); await reader.cancel().catch(() => {}) }
})

it('共享 TeamsPlugin 通过 SSE 展示真实投递、发送时间与领取状态', async () => {
    const origin = await application(collaborationModels())
    const controller = new AbortController()
    const response = await fetch(`${origin}/events/mailbox`, { signal: controller.signal })
    const reader = response.body!.getReader()
    try {
        await fetch(`${origin}/api/runs`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ prompt: DEFAULT_TASK, member: 'A' }) })
        const text = await readUntil(reader, value => value.includes('message-received'))
        expect(text).toContain('message-posted')
        expect(text).toContain('message-received')
        expect(text).toContain('"from":"A"')
        expect(text).toContain('"to":"B"')
        expect(text).toContain('请归纳工作坊资料')
        expect(text).toMatch(/"at":"\d{4}-\d{2}-\d{2}T/)
    } finally { controller.abort(); await reader.cancel().catch(() => {}) }
})

it('同一成员运行中再次 run 仍被接纳，由 Steering 合并到后续轮次', async () => {
    let release = () => {}
    const held = new Promise<void>(resolve => { release = resolve })
    const A: LanguageModel = { provider: 'fixture', modelId: 'held', async *stream() { await held; yield { type: 'finish', reason: 'stop' } } }
    const origin = await application({ A, B: finalModel('B'), C: finalModel('C'), D: finalModel('D') })
    try {
        const first = await fetch(`${origin}/api/runs`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ prompt: '第一条', member: 'A' }) })
        const second = await fetch(`${origin}/api/runs`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ prompt: '第二条', member: 'A' }) })
        expect(first.status).toBe(202)
        expect(second.status).toBe(202)
    } finally { release() }
})

it('只暴露新的 run 入口与四个成员事件源', async () => {
    const origin = await application()
    expect((await fetch(`${origin}/api/runs`, { method: 'POST', headers: { 'Content-Type': 'application/json', Origin: 'https://other.invalid' }, body: '{}' })).status).toBe(403)
    expect((await fetch(`${origin}/api/runs`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ prompt: '任务', member: 'missing' }) })).status).toBe(400)
    expect((await fetch(`${origin}/api/tasks`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{}' })).status).toBe(404)
    expect((await fetch(`${origin}/events/missing`)).status).toBe(404)
    expect((await fetch(`${origin}/task.js`)).status).toBe(404)
    const config = await (await fetch(`${origin}/api/config`)).json() as { members: { id: string }[]; states: Record<string, string> }
    expect(config.members.map(member => member.id)).toEqual(['A', 'B', 'C', 'D'])
    expect(config.states).toEqual({ A: 'idle', B: 'idle', C: 'idle', D: 'idle' })
})
