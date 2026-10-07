import type { AgentRunOutcome, ModelTurnResult } from '@quifox/agent-core'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { Agent, createAgent, defineTool, StreamClosedError, toolSuccess, type AgentPlugin } from '@quifox/agent-core'
import { type ModelEvent, type ModelRequest } from '@quifox/agent-core'
import { ChatModelPlugin } from '@quifox/agent-plugin-model'
import { chatModelOptions, type ScriptedModel as LanguageModel } from '../../../test/support/chat-model.mjs'
import { ChatConversationPlugin, ChatSessionPlugin, copySessionValue, type ChatInput, type ChatSessionPluginOptions } from '@quifox/agent-plugin-session'
import { RunSteeringPlugin } from '@quifox/agent-plugin-steering'
import { TeamsPlugin, type TeamNotification } from '../src/index.js'
import { createResearchTeam } from '../examples/research-team.js'

beforeEach(() => { vi.useFakeTimers() })
afterEach(() => { vi.clearAllTimers(); vi.useRealTimers() })

/** 可控模型记录真实请求；不模拟 Core 的钩子或工具链。 @param turn - 各轮输出。 */
function model(turn: (request: ModelRequest, index: number) => ModelEvent[] | Promise<ModelEvent[]>) {
    const requests: ModelRequest[] = []
    const adapter: LanguageModel = { provider: 'test', modelId: 'test-chat', async *stream(request) {
        requests.push(copySessionValue(request))
        for (const event of await turn(request, requests.length)) { yield event }
    } }
    return { adapter, requests }
}

/** @param text - 普通最终回复。 */
function done(text = '完成'): ModelEvent[] {
    return [{ type: 'text-delta', delta: text }, { type: 'finish', reason: 'stop' }]
}

/** @param id - 本轮调用身份。 @param name - 工具名。 @param input - 实际模型参数。 */
function call(id: string, name: string, input: unknown): ModelEvent[] {
    return [{ type: 'tool-call', call: { id, name, input } }, { type: 'finish', reason: 'tool-calls' }]
}

/** @param teams - 共享团队。 @param name - 独立成员名。 @param adapter - 独立生成配置。 @param plugins - 前置插件。 @param store - 可控 Session 存储。 */
function member(teams: TeamsPlugin, name: string, adapter: LanguageModel,
    plugins: AgentPlugin<ChatInput>[] = [], store?: ChatSessionPluginOptions['store']) {
    const session = new ChatSessionPlugin({ id: name, ownerId: 'test', ...(store ? { store } : {}) })
    const conversation = new ChatConversationPlugin({ session, generation: new ChatModelPlugin({ session, ...chatModelOptions(adapter) }) })
    const agent = createAgent<ChatInput>({ plugins: [conversation, ...plugins, teams] })
    teams.register(name, agent, conversation)
    return { agent, session, conversation }
}

/** 运行转向必须先于会话接纳；Teams 仍保持最后收尾。 */
function steeredMember(teams: TeamsPlugin, name: string, adapter: LanguageModel,
    plugins: AgentPlugin<ChatInput>[] = []) {
    const session = new ChatSessionPlugin({ id: name, ownerId: 'test' })
    const conversation = new ChatConversationPlugin({ session, generation: new ChatModelPlugin({ session, ...chatModelOptions(adapter) }) })
    const agent = createAgent<ChatInput>({ plugins: [new RunSteeringPlugin(), conversation, ...plugins, teams] })
    teams.register(name, agent, conversation)
    return { agent, session, conversation }
}

/** 用事件门闩控制异步边界，不依赖墙钟等待。 */
function gate() {
    let release!: () => void
    const promise = new Promise<void>(resolve => { release = resolve })
    return { promise, release }
}

it('四个普通成员保留原入口和独立模型、提示词、工具；Context 可取得共享团队和原 Agent', async () => {
    const sources = Array.from({ length: 4 }, (_, index) => model(() => done(`成员${index}`)))
    const extra: AgentPlugin<ChatInput> = { id: 'research-tools', hooks: { onInitialize: async ctx => {
        ctx.tools.register(defineTool({ name: 'research_lookup', description: '资料查询', inputSchema: (await import('zod')).z.object({}),
            policy: { sideEffect: 'none', approval: 'none' }, execute: async () => toolSuccess('资料') }))
    } } }
    let discovered: TeamsPlugin | undefined
    const inspect: AgentPlugin<ChatInput> = { id: 'inspect', hooks: { onRunStart: async ctx => {
        discovered = ctx.plugins.find((plugin): plugin is TeamsPlugin => plugin instanceof TeamsPlugin)
        return { action: 'continue' }
    } } }
    const names = ['研究员', '核验员', '撰稿人', '协调者']
    const team = createResearchTeam(names.map((name, index) => ({ name, prompt: `专属身份${index}`, model: chatModelOptions(sources[index]!.adapter),
        plugins: index === 0 ? [extra, inspect] : [] })))
    for (const [index, name] of names.entries()) {
        const agent = team.agents.get(name)!
        expect(agent.run).toBe(Agent.prototype.run)
        expect(agent.stream).toBe(Agent.prototype.stream)
        expect(team.teams.getMember(name)).toBe(agent)
        if (index === 1) { for await (const event of agent.stream({ prompt: name })) { expect(event.type).toBeTruthy() } }
        else { expect((await agent.run({ prompt: name }).then(expectModelResult)).text).toBe(`成员${index}`) }
        const request = sources[index]!.requests[0]!
        expect(request.messages.some(message => message.role === 'system' && message.content === `专属身份${index}`)).toBe(true)
        expect(request.messages.some(message => message.role === 'system' && message.content.includes(`你是团队成员 ${name}`))).toBe(true)
        expect(request.tools.map(tool => tool.name)).toEqual(index === 0 ? ['research_lookup', 'team_send', 'team_receive'] : ['team_send', 'team_receive'])
    }
    expect(discovered).toBe(team.teams)
    await vi.advanceTimersByTimeAsync(5)
    expect(vi.getTimerCount()).toBe(0)
})

it('发送工具立即投递并唤醒多个空闲成员，接收工具读取真实发送者且不跨会话写入', async () => {
    const teams = new TeamsPlugin()
    const source = model((_request, index) => index === 1 ? call('send', 'team_send', { to: ['B', 'C', 'B'], content: '请研究' }) : done('已分派'))
    const workerB = model((_request, index) => index === 1 ? call('receive-b', 'team_receive', { timeoutMs: 0 }) : done('B完成'))
    const workerC = model((_request, index) => index === 1 ? call('receive-c', 'team_receive', {}) : done('C完成'))
    const a = member(teams, 'A', source.adapter)
    const b = member(teams, 'B', workerB.adapter)
    const c = member(teams, 'C', workerC.adapter)
    expect((await a.agent.run({ prompt: '开始' }).then(expectModelResult)).text).toBe('已分派')
    await vi.advanceTimersByTimeAsync(5)
    for (const worker of [b, c]) {
        const receipt = worker.session.messages.find(message => message.role === 'tool' && message.toolName === 'team_receive')!
        const messages = JSON.parse(receipt.content) as { from: string; to: string; content: string }[]
        expect(messages).toHaveLength(1)
        expect(messages[0]).toMatchObject({ from: 'A', content: '请研究' })
    }
    expect(b.session.messages.some(message => message.role === 'user' && message.content === '开始')).toBe(false)
    expect(workerB.requests).toHaveLength(2)
    expect(workerC.requests).toHaveLength(2)
    expect(teams.getStatus('B')).toEqual({ state: 'idle', unread: 0 })
    expect(vi.getTimerCount()).toBe(0)
})

it('双向通信不等待被唤醒成员完成；原成员可在接收工具中等到回信', async () => {
    const teams = new TeamsPlugin()
    const source = model((_request, index) => index === 1 ? call('ask', 'team_send', { to: 'B', content: '核验资料' }) :
        index === 2 ? call('wait', 'team_receive', {}) : done('汇总完成'))
    const worker = model((_request, index) => index === 1 ? call('read', 'team_receive', { timeoutMs: 0 }) :
        index === 2 ? call('reply', 'team_send', { to: 'A', content: '核验通过' }) : done('已回信'))
    const a = member(teams, 'A', source.adapter)
    member(teams, 'B', worker.adapter)
    const running = a.agent.run({ prompt: '核验任务' }).then(expectModelResult)
    await vi.advanceTimersByTimeAsync(5)
    expect((await running).text).toBe('汇总完成')
    expect(a.session.messages.find(message => message.role === 'tool' && message.toolName === 'team_receive')?.content).toContain('核验通过')
    expect(source.requests).toHaveLength(3)
    expect(worker.requests).toHaveLength(3)
    expect(vi.getTimerCount()).toBe(0)
})

it('A 分派后先结束；B 延迟完成并回信后，空闲 A 被第二次自动唤醒', async () => {
    const teams = new TeamsPlugin()
    const entered = gate()
    const finish = gate()
    const source = model((_request, index) => index === 1 ? call('assign', 'team_send', { to: 'B', content: '完成计算后回信' }) :
        index === 2 ? done('任务已分派') : index === 3 ? call('read-result', 'team_receive', { timeoutMs: 0 }) : done('已收到计算结果'))
    const worker = model((_request, index) => index === 1 ? call('read-task', 'team_receive', { timeoutMs: 0 }) :
        index === 2 ? call('calculate', 'calculate', {}) : index === 3 ? call('reply', 'team_send', { to: 'A', content: '计算完成：42' }) : done('已回信'))
    const a = member(teams, 'A', source.adapter)
    const tools: AgentPlugin<ChatInput> = { id: 'calculate-tool', hooks: { onInitialize: async ctx => {
        const { z } = await import('zod')
        ctx.tools.register(defineTool({ name: 'calculate', description: '长计算', inputSchema: z.object({}),
            policy: { sideEffect: 'none', approval: 'none' }, execute: async () => { entered.release(); await finish.promise; return toolSuccess('42') } }))
    } } }
    member(teams, 'B', worker.adapter, [tools])
    expect((await a.agent.run({ prompt: '开始任务' }).then(expectModelResult)).text).toBe('任务已分派')
    await vi.advanceTimersByTimeAsync(1)
    await entered.promise
    expect(source.requests).toHaveLength(2)
    expect(teams.getStatus('A').state).toBe('idle')
    finish.release()
    await vi.advanceTimersByTimeAsync(10)
    expect(source.requests).toHaveLength(4)
    expect(source.requests[3]!.messages.some(message => message.role === 'tool' && message.content.includes('计算完成：42'))).toBe(true)
    expect(teams.getStatus('A')).toEqual({ state: 'idle', unread: 0 })
    expect(teams.getStatus('B')).toEqual({ state: 'idle', unread: 0 })
})

it('团队成员执行工具时连续外部 run，两条输入合入同一下一轮且只执行当前工具', async () => {
    const teams = new TeamsPlugin()
    const entered = gate()
    const finish = gate()
    const executed: string[] = []
    const source = model((_request, index) => index === 1 ? call('read-task', 'team_receive', { timeoutMs: 0 }) :
        index === 2 ? [{ type: 'tool-call', call: { id: 'a', name: 'work', input: { id: 'a' } } },
            { type: 'tool-call', call: { id: 'b', name: 'work', input: { id: 'b' } } },
            { type: 'tool-call', call: { id: 'c', name: 'work', input: { id: 'c' } } },
            { type: 'finish', reason: 'tool-calls' }] : done('两条新消息已处理'))
    const tools: AgentPlugin<ChatInput> = { id: 'work-tools', hooks: { onInitialize: async ctx => {
        const { z } = await import('zod')
        ctx.tools.register(defineTool({ name: 'work', description: '工作', inputSchema: z.object({ id: z.string() }),
            policy: { sideEffect: 'external', approval: 'none' }, execute: async input => {
                executed.push(input.id)
                if (input.id === 'a') { entered.release(); await finish.promise }
                return toolSuccess(`${input.id}完成`)
            } }))
    } } }
    const c = steeredMember(teams, 'C', source.adapter, [tools])
    member(teams, 'A', model(() => done()).adapter)
    teams.send('A', 'C', '后台任务')
    await vi.advanceTimersByTimeAsync(1)
    await entered.promise
    const first = c.agent.run({ prompt: '补充要求一' }).then(expectModelResult)
    const second = c.agent.run({ prompt: '补充要求二' }).then(expectModelResult)
    finish.release()
    await vi.advanceTimersByTimeAsync(10)
    const [firstResult, secondResult] = await Promise.all([first, second])
    expect(firstResult).toBe(secondResult)
    expect(firstResult.text).toBe('两条新消息已处理')
    expect(executed).toEqual(['a'])
    expect(source.requests).toHaveLength(3)
    expect(source.requests[2]!.messages.slice(-2).map(message => message.content)).toEqual(['补充要求一', '补充要求二'])
    expect(teams.getStatus('C')).toEqual({ state: 'idle', unread: 0 })
})

it('从撰稿人入口启动四成员协作，协调、研究、核验均由普通成员和消息工具完成', async () => {
    const writer = model((_request, index) => index === 1 ? call('start', 'team_send', { to: '协调者', content: '安排海洋研究与核验' }) :
        index === 2 ? call('collect', 'team_receive', {}) : done('海洋研究报告：资料已研究并核验'))
    const coordinator = model((_request, index) => index === 1 ? call('read-goal', 'team_receive', { timeoutMs: 0 }) :
        index === 2 ? call('assign', 'team_send', { to: '研究员', content: '研究后交核验员，最终向撰稿人汇报' }) : done('已协调'))
    const researcher = model((_request, index) => index === 1 ? call('read-task', 'team_receive', { timeoutMs: 0 }) :
        index === 2 ? call('submit-evidence', 'team_send', { to: '核验员', content: '海洋资料与研究依据' }) : done('研究完成'))
    const reviewer = model((_request, index) => index === 1 ? call('read-evidence', 'team_receive', { timeoutMs: 0 }) :
        index === 2 ? call('verified', 'team_send', { to: '撰稿人', content: '海洋资料已核验，可用于报告' }) : done('核验完成'))
    const sources = [writer, coordinator, researcher, reviewer]
    const names = ['撰稿人', '协调者', '研究员', '核验员']
    const team = createResearchTeam(names.map((name, index) => ({ name, prompt: `你负责${name}的工作。`, model: chatModelOptions(sources[index]!.adapter) })))
    const running = team.agents.get('撰稿人')!.run({ prompt: '完成海洋研究报告' }).then(expectModelResult)
    await vi.advanceTimersByTimeAsync(10)
    expect((await running).text).toBe('海洋研究报告：资料已研究并核验')
    for (const [index, name] of names.entries()) {
        expect(sources[index]!.requests).toHaveLength(3)
        expect(team.teams.getStatus(name)).toEqual({ state: 'idle', unread: 0 })
    }
    expect(writer.requests[2]!.messages.at(-1)?.content).toContain('海洋资料已核验')
    expect(vi.getTimerCount()).toBe(0)
})

it('运行中与收尾间隙消息合并一次唤醒，当前 Run 自然结束而不注入调用', async () => {
    const teams = new TeamsPlugin()
    const entered = gate()
    const finish = gate()
    const source = model(async (_request, index) => {
        if (index === 1) { entered.release(); await finish.promise; return done('当前任务完成') }
        return index === 2 ? call('read', 'team_receive', { timeoutMs: 0 }) : done('处理新消息')
    })
    const a = member(teams, 'A', source.adapter)
    member(teams, 'B', model(() => done()).adapter)
    const original = a.agent.run({ prompt: '当前任务' }).then(expectModelResult)
    await entered.promise
    teams.send('B', 'A', '第一条')
    teams.send('B', 'A', '第二条')
    await vi.advanceTimersByTimeAsync(5)
    expect(source.requests).toHaveLength(1)
    finish.release()
    const result = await original
    expect(result.toolCalls).toEqual([])
    expect(result.text).toBe('当前任务完成')
    expect(teams.getStatus('A').state).toBe('running')
    teams.send('B', 'A', '收尾间隙消息')
    await vi.advanceTimersByTimeAsync(5)
    expect(source.requests).toHaveLength(3)
    const receipt = a.session.messages.find(message => message.role === 'tool' && message.toolName === 'team_receive')!
    expect(JSON.parse(receipt.content)).toHaveLength(3)
    expect(teams.getStatus('A')).toEqual({ state: 'idle', unread: 0 })
})

it('真实 Session 异步保存结束后才唤醒；下一事件回合不越过未完成的收尾', async () => {
    const teams = new TeamsPlugin()
    const saving = gate()
    const saved = gate()
    let block = true
    const source = model((_request, index) => index === 2 ? call('read', 'team_receive', { timeoutMs: 0 }) : done())
    const a = member(teams, 'A', source.adapter, [], { save: async snapshot => {
        if (!snapshot.pendingInput && block) { block = false; saving.release(); await saved.promise }
    } })
    member(teams, 'B', model(() => done()).adapter)
    const original = a.agent.run({ prompt: '任务' }).then(expectModelResult)
    await saving.promise
    teams.send('B', 'A', '保存期间到达')
    await vi.advanceTimersByTimeAsync(50)
    expect(source.requests).toHaveLength(1)
    saved.release()
    await original
    await vi.advanceTimersByTimeAsync(5)
    expect(source.requests).toHaveLength(3)
    expect(teams.getStatus('A')).toEqual({ state: 'idle', unread: 0 })
})

it('外部直接启动新 Run 后，旧收尾检查不能将新 Run 标为空闲或重复启动', async () => {
    const teams = new TeamsPlugin()
    const entered = gate()
    const finish = gate()
    const source = model(async (_request, index) => {
        if (index === 2) { entered.release(); await finish.promise }
        return index === 3 ? call('read', 'team_receive', { timeoutMs: 0 }) : done()
    })
    const a = member(teams, 'A', source.adapter)
    member(teams, 'B', model(() => done()).adapter)
    await a.agent.run({ prompt: '第一轮' }).then(expectModelResult)
    const second = a.agent.run({ prompt: '外部第二轮' }).then(expectModelResult)
    await entered.promise
    teams.send('B', 'A', '新消息')
    await vi.advanceTimersByTimeAsync(5)
    expect(source.requests).toHaveLength(2)
    expect(teams.getStatus('A').state).toBe('running')
    finish.release()
    await second
    await vi.advanceTimersByTimeAsync(5)
    expect(source.requests).toHaveLength(4)
    expect(teams.getStatus('A')).toEqual({ state: 'idle', unread: 0 })
})

it('外部首次初始化窗口由成员插件接纳状态保护，未获入口的唤醒保留消息并等外部收尾', async () => {
    const teams = new TeamsPlugin()
    const entered = gate()
    const initialized = gate()
    const source = model((_request, index) => index === 2 ? call('read', 'team_receive', { timeoutMs: 0 }) : done())
    const session = new ChatSessionPlugin({ id: 'A', ownerId: 'test' })
    const conversation = new ChatConversationPlugin({ session, generation: new ChatModelPlugin({ session, ...chatModelOptions(source.adapter) }) })
    const slow: AgentPlugin<ChatInput> = { id: 'slow-init', hooks: { onInitialize: async () => {
        entered.release(); await initialized.promise
    } } }
    const a = createAgent<ChatInput>({ plugins: [slow, conversation, teams] })
    teams.register('A', a, conversation)
    member(teams, 'B', model(() => done()).adapter)
    const original = a.run({ prompt: '外部首次运行' }).then(expectModelResult)
    await entered.promise
    teams.send('B', 'A', '初始化时到达')
    await vi.advanceTimersByTimeAsync(5)
    expect(source.requests).toHaveLength(0)
    expect(teams.getStatus('A').unread).toBe(1)
    initialized.release()
    await original
    await vi.advanceTimersByTimeAsync(5)
    expect(source.requests).toHaveLength(3)
    expect(teams.getStatus('A')).toEqual({ state: 'idle', unread: 0 })
})

it('同一批消息被忽略时不无限唤醒，后续新消息仍可唤醒', async () => {
    const teams = new TeamsPlugin()
    const source = model(() => done('暂不接收'))
    member(teams, 'A', source.adapter)
    member(teams, 'B', model(() => done()).adapter)
    teams.send('B', 'A', '第一批')
    await vi.advanceTimersByTimeAsync(50)
    expect(source.requests).toHaveLength(1)
    expect(teams.getStatus('A').unread).toBe(1)
    teams.send('B', 'A', '第二批')
    await vi.advanceTimersByTimeAsync(50)
    expect(source.requests).toHaveLength(2)
    expect((await teams.receive('A', 0)).messages.map(message => message.content)).toEqual(['第一批', '第二批'])
    expect(vi.getTimerCount()).toBe(0)
})

it('接收默认十秒超时；投递提前结束等待且清理计时器，多个接收者不重复交付', async () => {
    const teams = new TeamsPlugin()
    member(teams, 'A', model(() => done()).adapter)
    member(teams, 'B', model(() => done()).adapter)
    let completed = false
    const first = teams.receive('A').then(result => { completed = true; return result })
    await vi.advanceTimersByTimeAsync(9999)
    expect(completed).toBe(false)
    await vi.advanceTimersByTimeAsync(1)
    expect(await first).toEqual({ messages: [], timedOut: true })
    const waiting = teams.receive('A')
    const other = teams.receive('A', 20)
    teams.send('B', 'A', '仅交付一次')
    expect((await waiting).messages).toHaveLength(1)
    await vi.advanceTimersByTimeAsync(20)
    expect(await other).toEqual({ messages: [], timedOut: true })
    expect(await teams.receive('A', 0)).toEqual({ messages: [], timedOut: true })
    expect(vi.getTimerCount()).toBe(0)
})

it('主动停止保留消息且不立即复活；后续新投递允许继续', async () => {
    const teams = new TeamsPlugin()
    let stop = true
    const stopper: AgentPlugin<ChatInput> = { id: 'stopper', hooks: { beforeModel: async () => {
        if (stop) { stop = false; teams.send('B', 'A', '停止前消息'); return { action: 'stop', reason: '用户停止', value: { kind: 'test-stop', reason: '用户停止' } } }
        return { action: 'continue' }
    } } }
    const source = model((_request, index) => index === 1 ? call('read', 'team_receive', { timeoutMs: 0 }) : done())
    const a = member(teams, 'A', source.adapter, [stopper])
    member(teams, 'B', model(() => done()).adapter)
    expect(await a.agent.run({ prompt: '停止' })).toMatchObject({ ok: true, value: { kind: 'test-stop' } })
    await vi.advanceTimersByTimeAsync(50)
    expect(source.requests).toHaveLength(0)
    expect(teams.getStatus('A').unread).toBe(1)
    teams.send('B', 'A', '继续的新消息')
    await vi.advanceTimersByTimeAsync(5)
    expect(source.requests).toHaveLength(2)
    expect(teams.getStatus('A')).toEqual({ state: 'idle', unread: 0 })
})

it('消费者提前关闭 stream 保留信箱，不自动重新启动', async () => {
    const teams = new TeamsPlugin()
    const source = model(() => done())
    const a = member(teams, 'A', source.adapter)
    member(teams, 'B', model(() => done()).adapter)
    const stream = a.agent.stream({ prompt: '外部 stream' })
    while (true) {
        const next = await stream.next()
        if (next.done || next.value.type === 'text-delta') { break }
    }
    teams.send('B', 'A', '退出前消息')
    const outcome = await stream.return({ ok: false, error: new StreamClosedError(), errors: [] })
    expect(outcome.value).toMatchObject({ ok: false })
    await vi.advanceTimersByTimeAsync(50)
    expect(source.requests).toHaveLength(1)
    expect(teams.getStatus('A')).toEqual({ state: 'idle', unread: 1 })
})

it('首次 run-start 后立即关闭会释放初始化状态，后续消息仍可唤醒', async () => {
    const teams = new TeamsPlugin()
    const source = model(() => done('暂不读取'))
    const a = member(teams, 'A', source.adapter)
    member(teams, 'B', model(() => done()).adapter)
    const stream = a.agent.stream({ prompt: '只初始化' })
    expect((await stream.next()).value).toEqual({ type: 'run-start' })
    await stream.return({ ok: false, error: new StreamClosedError(), errors: [] })
    expect(teams.getStatus('A')).toEqual({ state: 'idle', unread: 0 })
    teams.send('B', 'A', '关闭后消息')
    await vi.advanceTimersByTimeAsync(5)
    expect(source.requests).toHaveLength(1)
    expect(teams.getStatus('A')).toEqual({ state: 'idle', unread: 1 })
})

it('自动唤醒在 Teams 前被停止时不循环重启同一批消息', async () => {
    const teams = new TeamsPlugin()
    let direct = true
    let wakeAttempts = 0
    const stopWake: AgentPlugin<ChatInput> = { id: 'stop-wake', hooks: { onRunStart: async (_ctx, input) => {
        if (direct) { direct = false; return { action: 'continue' } }
        if ('prompt' in input && input.prompt.includes('因收到新的团队消息')) { wakeAttempts += 1; return { action: 'stop', value: { kind: 'blocked-wake' } } }
        return { action: 'continue' }
    } } }
    const source = model(() => done())
    member(teams, 'A', source.adapter, [stopWake])
    member(teams, 'B', model(() => done()).adapter)
    await teams.getMember('A')!.run({ prompt: '初始化' }).then(expectModelResult)
    await vi.runOnlyPendingTimersAsync()
    teams.send('B', 'A', '待处理消息')
    await vi.runOnlyPendingTimersAsync()
    await Promise.resolve()
    expect(wakeAttempts).toBe(1)
    expect(teams.getStatus('A')).toEqual({ state: 'idle', unread: 1 })
    expect(vi.getTimerCount()).toBe(0)
})

it('后台失败被接纳且不自动重试，信箱保留；新消息可触发后续尝试', async () => {
    const teams = new TeamsPlugin()
    const source = model((_request, index) => {
        if (index === 1) { throw new Error('private provider failure') }
        return index === 2 ? call('read', 'team_receive', { timeoutMs: 0 }) : done()
    })
    member(teams, 'A', source.adapter)
    member(teams, 'B', model(() => done()).adapter)
    teams.send('B', 'A', '失败前消息')
    await vi.advanceTimersByTimeAsync(50)
    expect(source.requests).toHaveLength(1)
    expect(teams.getStatus('A')).toMatchObject({ state: 'idle', unread: 1, wakeError: '成员唤醒未完成；尚未领取的消息仍保留。' })
    teams.send('B', 'A', '后续新消息')
    await vi.advanceTimersByTimeAsync(5)
    expect(source.requests).toHaveLength(3)
    expect(teams.getStatus('A')).toEqual({ state: 'idle', unread: 0 })
})

it('收件人校验先于投递，消息按顺序领取；超时范围拒绝无效计时器', async () => {
    const teams = new TeamsPlugin()
    member(teams, 'A', model(() => done()).adapter)
    member(teams, 'B', model(() => done()).adapter)
    expect(() => teams.send('A', ['B', 'missing'], '消息')).toThrow('团队成员不存在')
    expect(teams.getStatus('B').unread).toBe(0)
    teams.send('A', 'B', '第一条')
    teams.send('A', 'B', '第二条')
    const result = await teams.receive('B', 0)
    expect(result.messages.map(message => message.content)).toEqual(['第一条', '第二条'])
    await vi.advanceTimersByTimeAsync(5)
    await expect(teams.receive('B', -1)).rejects.toThrow()
    await expect(teams.receive('B', 2_147_483_648)).rejects.toThrow()
    expect(vi.getTimerCount()).toBe(0)
})

it('错误收尾顺序在模型调用前失败；不自动重排插件', async () => {
    const teams = new TeamsPlugin()
    const source = model(() => done())
    const session = new ChatSessionPlugin({ id: 'A', ownerId: 'test' })
    const conversation = new ChatConversationPlugin({ session, generation: new ChatModelPlugin({ session, ...chatModelOptions(source.adapter) }) })
    const agent = createAgent<ChatInput>({ plugins: [teams, conversation] })
    teams.register('A', agent, conversation)
    await expect(agent.run({ prompt: '任务' }).then(expectModelResult)).rejects.toThrow()
    expect(source.requests).toHaveLength(0)
    await vi.advanceTimersByTimeAsync(5)
    expect(vi.getTimerCount()).toBe(0)
})

it('同一 Teams 对象重复插入仍只初始化一次，最后一次收尾后安排一次唤醒', async () => {
    const teams = new TeamsPlugin()
    const source = model(() => done('不读取'))
    const session = new ChatSessionPlugin({ id: 'A', ownerId: 'test' })
    const conversation = new ChatConversationPlugin({ session, generation: new ChatModelPlugin({ session, ...chatModelOptions(source.adapter) }) })
    const agent = createAgent<ChatInput>({ plugins: [conversation, teams, teams] })
    teams.register('A', agent, conversation)
    member(teams, 'B', model(() => done()).adapter)
    teams.send('B', 'A', '消息')
    await vi.advanceTimersByTimeAsync(50)
    expect(source.requests).toHaveLength(1)
    expect(source.requests[0]!.tools.map(tool => tool.name)).toEqual(['team_send', 'team_receive'])
    expect(teams.getStatus('A')).toEqual({ state: 'idle', unread: 1 })
    expect(vi.getTimerCount()).toBe(0)
})

it('成员登记保持原引用，一一对应并在首次运行后固定', async () => {
    const teams = new TeamsPlugin()
    const a = member(teams, 'A', model(() => done()).adapter)
    expect(teams.getMember('A')).toBe(a.agent)
    expect(teams.getMember('missing')).toBeUndefined()
    expect(() => teams.register('A', a.agent, a.conversation)).toThrow('名称')
    expect(() => teams.register('B', a.agent, a.conversation)).toThrow('独立')
    await a.agent.run({ prompt: '任务' }).then(expectModelResult)
    expect(() => teams.register('B', a.agent, a.conversation)).toThrow('成员集合')
    await vi.advanceTimersByTimeAsync(5)
})

it('Teams 在原投递/领取位置通知中心邮箱，订阅展示不会消耗未读消息', async () => {
    const teams = new TeamsPlugin()
    member(teams, 'A', model(() => done()).adapter)
    member(teams, 'B', model(() => done()).adapter)
    const events: TeamNotification[] = []
    const unsubscribe = teams.subscribe(event => { events.push(copySessionValue(event)) })
    const posted = teams.send('A', 'B', '中心邮箱消息')
    expect(teams.getStatus('B').unread).toBe(1)
    expect(events).toEqual([{ type: 'message-posted', message: posted[0] }])
    const received = await teams.receive('B', 0)
    expect(events[1]).toEqual({ type: 'message-received', member: 'B', messages: received.messages })
    expect(received.messages[0]!.id).toBe(posted[0]!.id)
    unsubscribe()
    teams.send('A', 'B', '取消订阅之后')
    await teams.receive('B', 0)
    expect(events).toHaveLength(2)
    await vi.advanceTimersByTimeAsync(5)
})

it('邮箱观察者失败不回滚真实投递，不阻塞等待接收，也不产生后台拒绝', async () => {
    const teams = new TeamsPlugin()
    member(teams, 'A', model(() => done()).adapter)
    member(teams, 'B', model(() => done()).adapter)
    const failure = new Error('notification sink failed')
    teams.subscribe(() => { throw failure })
    teams.subscribe(() => Promise.reject(failure))
    const events: TeamNotification[] = []
    teams.subscribe(event => { events.push(event) })
    const waiting = teams.receive('B')
    teams.send('A', 'B', '消息仍送达')
    expect((await waiting).messages[0]!.content).toBe('消息仍送达')
    await Promise.resolve()
    expect(teams.notificationError).toBe(failure)
    expect(events.map(event => event.type)).toEqual(['message-posted', 'message-received'])
    expect(vi.getTimerCount()).toBe(0)
})

/** 仅供测试消费标准 Outcome；不包装模型结果。 */
function expectModelResult(outcome: AgentRunOutcome): ModelTurnResult {
    if (!outcome.ok) { throw outcome.error }
    return outcome.value as ModelTurnResult
}
