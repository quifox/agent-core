import type { AgentContext, AgentHooks, AgentPlugin, AgentRunOutcome, ContinueOrStop } from '@quifox/agent-core'
import { INTERRUPT_MODE, InterruptPlugin } from '@quifox/agent-plugin-interrupt'
import { getConversation, type ChatInput } from '@quifox/agent-plugin-session'

const LEADER = Symbol('leader')
type Admission = typeof LEADER | AgentRunOutcome

interface Deferred<Value> {
    promise: Promise<Value>
    resolve(value: Value): void
}

interface RunEntry {
    input: ChatInput
    outcome: AgentRunOutcome
    admission: Deferred<Admission>
    interruptReady: Deferred<void>
    accepting: boolean
    extraPrompts: string[]
    joined: RunEntry[]
}

/** 同一 Agent 的新输入接纳、合批与协作停止策略。 */
export class RunSteeringPlugin implements AgentPlugin<ChatInput> {
    id = 'run-steering'
    readonly hooks: AgentHooks<ChatInput>
    private readonly runs: RunEntry[] = []
    private readonly interrupt = new InterruptPlugin({ mode: INTERRUPT_MODE.TERMINATE })
    private readonly tail: AgentPlugin<ChatInput>

    constructor() {
        const interrupt = this.interrupt.hooks as AgentHooks<ChatInput>
        const tail: AgentPlugin<ChatInput> = {
            id: 'run-steering-tail',
            after: 'teams',
            hooks: {
                onRegister: async plugins => {
                    const index = plugins.indexOf(tail)
                    if (index < 0) { throw new Error('RunSteeringPlugin 收尾对象已从候选数组移除。') }
                    plugins.splice(index, 1)
                    plugins.push(tail)
                },
                onRunEnd: [...handlers(interrupt.onRunEnd), async (_ctx, outcome) => { this.finish(outcome) }]
            }
        }
        this.tail = tail
        this.hooks = {
            onRegister: async plugins => {
                if (plugins.filter(plugin => plugin === this).length !== 1) {
                    throw new Error('同一 RunSteeringPlugin 实例只能注册一次。')
                }
                plugins.push(this.tail)
            },
            onInitialize: async ctx => {
                if (ctx.plugins[0] !== this) { throw new Error('RunSteeringPlugin 必须放在插件数组首位。') }
                if (ctx.plugins.at(-1) !== this.tail) { throw new Error('RunSteeringPlugin 收尾对象必须位于插件数组末尾。') }
            },
            onRunStart: [
                async (_ctx, input, outcome) => this.admit(input, outcome),
                ...handlers(interrupt.onRunStart),
                async (_ctx, _input, outcome) => this.markInterruptReady(outcome)
            ],
            beforeModel: [async ctx => this.inject(ctx), ...handlers(interrupt.beforeModel)],
            ...(interrupt.beforeStep === undefined ? {} : { beforeStep: interrupt.beforeStep }),
            ...(interrupt.afterModel === undefined ? {} : { afterModel: interrupt.afterModel }),
            ...(interrupt.beforeTool === undefined ? {} : { beforeTool: interrupt.beforeTool }),
            ...(interrupt.afterTool === undefined ? {} : { afterTool: interrupt.afterTool }),
            ...(interrupt.afterStep === undefined ? {} : { afterStep: interrupt.afterStep }),
            ...(interrupt.onError === undefined ? {} : { onError: interrupt.onError })
        }
    }

    /** @param input - 本次原始输入。 @param outcome - 本次调用身份。 */
    private async admit(input: ChatInput, outcome: AgentRunOutcome): Promise<ContinueOrStop> {
        const entry = createEntry(input, outcome)
        const head = this.runs[0]
        if (!head) {
            this.runs.push(entry)
            return { action: 'continue' }
        }
        if ('resume' in input) { throw new Error('活动运行期间不能并发恢复。') }
        if (head.accepting) {
            this.join(head, entry)
            const admission = await entry.admission.promise
            return admission === LEADER ? { action: 'continue' } : this.joined(admission)
        }
        this.runs.push(entry)
        await head.interruptReady.promise
        this.interrupt.requestStop()
        const admission = await entry.admission.promise
        return admission === LEADER ? { action: 'continue' } : this.joined(admission)
    }

    /** 关闭本轮输入窗口，并把已合批消息交给唯一 Conversation owner。 */
    private inject(ctx: AgentContext): ContinueOrStop {
        const head = this.runs[0]
        if (!head) { throw new Error('运行转向队列没有当前调用。') }
        if (head.accepting) {
            head.accepting = false
            if (head.extraPrompts.length) {
                getConversation(ctx).conversation.appendUserMessages(head.extraPrompts)
            }
        }
        return { action: 'continue' }
    }

    /** 内部 Interrupt 已绑定队首后才允许并发调用请求停止。 */
    private markInterruptReady(outcome: AgentRunOutcome): ContinueOrStop {
        const head = this.runs[0]
        if (head?.outcome !== outcome) { throw new Error('运行转向队首与活动调用不一致。') }
        head.interruptReady.resolve()
        return { action: 'continue' }
    }

    /** 私有收尾对象位于最后一个 onRunEnd 位置，此处可以直接交接。 */
    private finish(outcome: AgentRunOutcome): void {
        const head = this.runs[0]
        if (head?.outcome !== outcome) { return }
        this.handoff(head, outcome)
    }

    /** @param head - 已结束的物理运行。 @param outcome - 其最终结果。 */
    private handoff(head: RunEntry, outcome: AgentRunOutcome): void {
        if (this.runs[0] !== head) { return }
        this.runs.shift()
        const joined = head.joined.splice(0)
        if (!head.accepting) { for (const entry of joined) { entry.admission.resolve(outcome) } }
        const waiting = [...(head.accepting ? joined : []), ...this.runs.splice(0)]
        if (!waiting.length) { return }
        const leader = waiting.shift()!
        for (const entry of waiting) { this.join(leader, entry) }
        this.runs.push(leader)
        leader.admission.resolve(LEADER)
    }

    /** @param leader - 共享一次物理运行的首个调用。 @param entry - 仅贡献消息并共享结果的调用。 */
    private join(leader: RunEntry, entry: RunEntry): void {
        if ('resume' in entry.input) { throw new Error('恢复输入不能加入消息批次。') }
        leader.extraPrompts.push(entry.input.prompt)
        leader.joined.push(entry)
    }

    /** @param outcome - 物理运行的最终结果。 */
    private joined(outcome: AgentRunOutcome): ContinueOrStop {
        if (!outcome.ok) { throw outcome.error }
        return { action: 'stop', value: outcome.value }
    }
}

/** 创建一次等待值。 */
function deferred<Value>(): Deferred<Value> {
    let resolve!: (value: Value) => void
    const promise = new Promise<Value>(accept => { resolve = accept })
    return { promise, resolve }
}

/** @param input - 原输入。 @param outcome - 独立调用结果对象。 */
function createEntry(input: ChatInput, outcome: AgentRunOutcome): RunEntry {
    return {
        input, outcome, admission: deferred<Admission>(), interruptReady: deferred<void>(),
        accepting: 'prompt' in input, extraPrompts: [], joined: []
    }
}

/** @param value - 单个或多个 Hook。 */
function handlers<Handler>(value: Handler | Handler[] | undefined): Handler[] {
    return value === undefined ? [] : Array.isArray(value) ? value : [value]
}

/** 创建默认运行转向插件。 */
export function createRunSteeringPlugin(): RunSteeringPlugin { return new RunSteeringPlugin() }
export { MessageInboxPlugin } from './inbox.js'
export type { InboxMessage, MessageInboxSnapshot, MessageSubmission } from './inbox.js'
