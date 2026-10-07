import { z } from 'zod'
import { defineTool, toolSuccess, type Agent, type AgentContext, type AgentHooks, type AgentPlugin, type AgentRunOutcome, type ModelTurnResult } from '@quifox/agent-core'
import type { ChatInput, Conversation } from '@quifox/agent-plugin-session'

const timeoutSchema = z.number().int().min(0).max(2_147_483_647)

/** 团队内部消息；身份不进入 Core，也不代表一次任务执行。 */
export interface TeamMessage {
    id: string
    from: string
    to: string
    content: string
}

/** 超时只表示没有收到消息，不表示其他成员已完成。 */
export interface TeamReceiveResult {
    messages: TeamMessage[]
    timedOut: boolean
}

/** 中心邮箱的投递与领取事实；UI 不通过 receive 读取业务信箱。 */
export type TeamNotification =
    | { type: 'message-posted'; message: TeamMessage }
    | { type: 'message-received'; member: string; messages: TeamMessage[] }

/** @param event - 当时发生的邮箱事实，传输出口自行编码快照。 */
export type TeamListener = (event: TeamNotification) => void | Promise<void>

/** 读取调度状态，不公开会话历史或 Core 的私有锁。 */
export interface TeamMemberStatus {
    state: 'idle' | 'running'
    unread: number
    wakeError?: string
}

interface Waiter {
    resolve(result: TeamReceiveResult): void
    timer: ReturnType<typeof setTimeout>
}

interface Wake {
    input: ChatInput
    version: number
    outcome?: AgentRunOutcome
}

interface Member {
    name: string
    agent: Agent<ChatInput>
    conversation: Conversation
    inbox: TeamMessage[]
    waiters: Set<Waiter>
    version: number
    coveredVersion: number
    initializing: boolean
    run: AgentRunOutcome | undefined
    timer: ReturnType<typeof setTimeout> | undefined
    wake: Wake | undefined
    wakeError: string | undefined
}

interface Run {
    endingCalls: number
}

/** 共享成员引用、信箱和唤醒调度；成员始终使用原来的 Agent 入口。 */
export class TeamsPlugin implements AgentPlugin<ChatInput> {
    id = 'teams'
    readonly hooks: AgentHooks<ChatInput>
    private readonly members = new Map<string, Member>()
    private readonly runs = new WeakMap<AgentRunOutcome, Run>()
    private initialized = false
    private sequence = 0
    private readonly listeners = new Set<TeamListener>()
    private notificationFailure: unknown

    /** 构造共享团队；所有成员须在首次运行前显式登记。 */
    constructor() {
        const send = defineTool({
            name: 'team_send',
            description: '向一个或多个团队成员发送消息。立即返回投递回执，不等待对方执行完成；发信身份由当前成员确定。',
            inputSchema: z.object({
                to: z.union([z.string().min(1), z.array(z.string().min(1)).min(1)]),
                content: z.string().min(1)
            }).strict(),
            policy: { sideEffect: 'external', approval: 'none' },
            execute: async (input, ctx) => {
                const messages = this.send(this.current(ctx).name, input.to, input.content)
                return toolSuccess('消息已投递；这不代表对方任务已完成。', { messages })
            }
        })
        const receive = defineTool({
            name: 'team_receive',
            description: '读取自己的全部未读团队消息。没有消息时默认等待十秒；timeoutMs=0 立即检查。超时不取消其他成员，可稍后再次接收。',
            inputSchema: z.object({ timeoutMs: timeoutSchema.default(10_000) }).strict(),
            policy: { sideEffect: 'none', approval: 'none' },
            execute: async (input, ctx) => {
                const result = await this.receive(this.current(ctx).name, input.timeoutMs)
                return toolSuccess(result.timedOut ? '等待超时，暂无新消息。' : JSON.stringify(result.messages), result)
            }
        })
        this.hooks = {
            onInitialize: async ctx => {
                this.assertEndOrder(ctx)
                const member = this.current(ctx)
                this.initialized = true
                member.initializing = true
                ctx.tools.register(send)
                ctx.tools.register(receive)
                member.conversation.addSystemPrompt([
                    `你是团队成员 ${member.name}。团队成员：${[...this.members.keys()].join('、')}。`,
                    '使用 team_send 定向发送任务、问题或结果，使用 team_receive 读取自己的未读消息。',
                    '投递回执不代表任务完成；需要结果时主动接收消息。你可以与任何成员协作，团队没有固定汇报中心。',
                    '收到新消息唤醒提示时，先读取信箱，再按自己的职责处理。无需更多工作时可以自然结束。'
                ].join('\n'))
            },
            onRunStart: async (ctx, input, outcome) => {
                const member = this.current(ctx)
                this.begin(member, outcome)
                if (member.wake?.input === input) {
                    member.wake.outcome = outcome
                    member.coveredVersion = member.wake.version
                }
                return { action: 'continue' }
            },
            onRunEnd: async (ctx, outcome) => {
                const member = this.current(ctx)
                const run = this.runs.get(outcome)
                if (!run) {
                    if (member.initializing) {
                        member.initializing = false
                        this.schedule(member)
                    }
                    return
                }
                run.endingCalls += 1
                // 同一对象可以重复插入；只在它本轮最后一个位置安排收尾检查。
                if (run.endingCalls < ctx.plugins.filter(plugin => plugin === this).length) { return }
                this.end(member, outcome)
            }
        }
    }

    /** @param name - 团队内唯一名称。 @param agent - 原 Agent 引用。 @param conversation - 该成员独立的会话组合。 */
    register(name: string, agent: Agent<ChatInput>, conversation: Conversation): void {
        if (this.initialized) { throw new Error('团队开始运行后不能改变成员集合。') }
        if (!name.trim() || this.members.has(name)) { throw new Error('团队成员名称必须非空且唯一。') }
        if ([...this.members.values()].some(member => member.agent === agent || member.conversation === conversation)) {
            throw new Error('每名团队成员必须使用独立的 Agent 和会话组合。')
        }
        this.members.set(name, { name, agent, conversation, inbox: [], waiters: new Set(), version: 0,
            coveredVersion: 0, initializing: false, run: undefined, timer: undefined, wake: undefined, wakeError: undefined })
    }

    /** 返回登记的原对象。 @param name - 成员名称。 */
    getMember(name: string): Agent<ChatInput> | undefined { return this.members.get(name)?.agent }

    /** @param listener - 中心邮箱观察者。 @returns 取消订阅函数。 */
    subscribe(listener: TeamListener): () => void {
        this.listeners.add(listener)
        return () => { this.listeners.delete(listener) }
    }

    /** 最近一次观察者错误，不影响投递、领取或唤醒。 */
    get notificationError(): unknown { return this.notificationFailure }

    /** @param name - 成员名称。 */
    getStatus(name: string): TeamMemberStatus {
        const member = this.member(name)
        return { state: member.initializing || member.run || member.wake ? 'running' : 'idle',
            unread: member.inbox.length, ...(member.wakeError ? { wakeError: member.wakeError } : {}) }
    }

    /** 不等待对方任务。 @param from - 调用方明确选择的发送者，工具入口使用当前身份。 @param to - 收件人。 @param content - 消息内容。 */
    send(from: string, to: string | string[], content: string): TeamMessage[] {
        this.member(from)
        if (!content.length) { throw new Error('团队消息内容不能为空。') }
        const recipients = [...new Set(typeof to === 'string' ? [to] : to)].map(name => this.member(name))
        if (!recipients.length) { throw new Error('团队消息需要至少一个收件人。') }
        return recipients.map(member => {
            const message = { id: `message-${++this.sequence}`, from, to: member.name, content }
            member.version = this.sequence
            member.inbox.push(message)
            this.notify({ type: 'message-posted', message })
            const waiter = member.waiters.values().next().value
            if (waiter) {
                member.waiters.delete(waiter)
                clearTimeout(waiter.timer)
                waiter.resolve({ messages: this.take(member), timedOut: false })
            }
            this.schedule(member)
            return message
        })
    }

    /** 接纳后转移消息所有权。 @param name - 成员名称。 @param timeoutMs - 默认十秒，零表示立即检查。 */
    async receive(name: string, timeoutMs = 10_000): Promise<TeamReceiveResult> {
        const member = this.member(name)
        timeoutSchema.parse(timeoutMs)
        if (member.inbox.length) { return { messages: this.take(member), timedOut: false } }
        if (timeoutMs === 0) { return { messages: [], timedOut: true } }
        return new Promise(resolve => {
            const waiter: Waiter = { resolve, timer: setTimeout(() => {
                member.waiters.delete(waiter)
                resolve({ messages: [], timedOut: true })
            }, timeoutMs) }
            member.waiters.add(waiter)
        })
    }

    /** @param name - 已登记成员名称。 */
    private member(name: string): Member {
        const member = this.members.get(name)
        if (!member) { throw new Error(`团队成员不存在：${name}`) }
        return member
    }

    /** @param member - 原业务信箱的唯一 owner。 */
    private take(member: Member): TeamMessage[] {
        const messages = member.inbox.splice(0)
        this.notify({ type: 'message-received', member: member.name, messages })
        return messages
    }

    /** @param event - 已完成的投递或领取，不受观察者失败回滚。 */
    private notify(event: TeamNotification): void {
        for (const listener of this.listeners) {
            try {
                const pending = listener(event)
                if (pending) { void Promise.resolve(pending).catch(error => { this.notificationFailure = error }) }
            } catch (error) { this.notificationFailure = error }
        }
    }

    /** @param ctx - 保留真实插件对象的当前 Context。 */
    private current(ctx: AgentContext): Member {
        const matches = [...this.members.values()].filter(member => ctx.plugins.includes(member.conversation))
        if (matches.length !== 1) { throw new Error('当前 Agent 必须对应一个已登记的独立团队会话。') }
        return matches[0]!
    }

    /** @param ctx - 本次最终插件数组；仅核验，不重排。 */
    private assertEndOrder(ctx: AgentContext): void {
        const plugins = ctx.plugins as readonly AgentPlugin<ChatInput>[]
        for (let index = plugins.length - 1; index >= 0; index -= 1) {
            const plugin = plugins[index]!
            const end = plugin.hooks?.onRunEnd
            if (end && (!Array.isArray(end) || end.length)) {
                if (plugin === this) { return }
                if (plugin.after === this.id) { continue }
                throw new Error('Teams 必须放在最后一个拥有异步收尾状态的插件位置。')
            }
        }
    }

    /** @param member - 当前成员。 @param outcome - 本次运行独立的标记。 */
    private begin(member: Member, outcome: AgentRunOutcome): void {
        const handingOff = member.run !== undefined && member.timer !== undefined
        if (member.run && member.run !== outcome && !handingOff) { throw new Error('团队成员正在运行。') }
        if (member.timer !== undefined) { clearTimeout(member.timer); member.timer = undefined }
        member.initializing = false
        member.run = outcome
        member.wakeError = undefined
        if (!this.runs.has(outcome)) { this.runs.set(outcome, { endingCalls: 0 }) }
    }

    /** @param member - 当前成员。 @param outcome - 即将退出的运行及收尾事实。 */
    private end(member: Member, outcome: AgentRunOutcome): void {
        if (member.run && member.run !== outcome) { return }
        member.initializing = false
        member.run = outcome
        const value = outcome.ok ? outcome.value as ModelTurnResult | undefined : undefined
        const incomplete = value?.finishReason !== 'stop'
        if (!outcome.ok || incomplete || outcome.errors.length) {
            member.coveredVersion = member.version
        }
        if (member.timer !== undefined) { clearTimeout(member.timer) }
        member.timer = setTimeout(() => {
            member.timer = undefined
            if (member.run !== outcome) { return }
            member.run = undefined
            this.schedule(member)
        }, 0)
    }

    /** 合并检查；不轮询私有 active。 @param member - 收件成员。 */
    private schedule(member: Member): void {
        if (member.initializing || member.run || member.wake || member.timer !== undefined || !member.inbox.length || member.version <= member.coveredVersion) { return }
        member.timer = setTimeout(() => {
            member.timer = undefined
            if (member.initializing || member.run || member.wake || !member.inbox.length || member.version <= member.coveredVersion) { return }
            const wake: Wake = { input: { prompt: `你是团队成员 ${member.name}，因收到新的团队消息而被唤醒。请先调用 team_receive 读取未读消息，再按自己的职责处理；需要协作或汇报时使用 team_send。` },
                version: member.version }
            member.wake = wake
            // 发送工具不 await 对方；两条分支都接纳后台 Promise 的终态。
            void member.agent.run(wake.input).then(outcome => {
                if (!outcome.ok) {
                    if (member.wake === wake) { member.wake = undefined }
                    member.wakeError = '成员唤醒未完成；尚未领取的消息仍保留。'
                    return
                }
                if (member.wake === wake) { member.wake = undefined }
                if (wake.outcome !== outcome) {
                    return
                }
                this.schedule(member)
            }, () => {
                if (member.wake === wake) { member.wake = undefined }
                member.wakeError = '成员唤醒未完成；尚未领取的消息仍保留。'
                // 未进入运行的调用可能遇到外部初始化窗口；等待外部收尾或新投递，不异常重试。
            })
        }, 0)
    }
}
