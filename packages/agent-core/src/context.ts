import { AgentError } from './errors.js'
import type { ToolRegistry } from './tools.js'

/** 运行期可发现的真实插件对象公共形状。 */
export interface AgentPluginRef {
    readonly id: string
    readonly name?: string
    readonly description?: string
    readonly after?: string
}

/** 一个 Agent 长期保留的可变协作对象；业务字段由插件拥有。 */
export interface AgentContext {
    tools: ToolRegistry
    readonly plugins: readonly AgentPluginRef[]
}

/** 每次调用独立的结果对象；产物与具体停止含义由插件定义。 */
export type AgentRunOutcome =
    | { ok: true; value?: unknown; errors: AgentError[] }
    | { ok: false; error: AgentError; errors: AgentError[] }

/** 原地更新，保留插件接纳时绑定的对象身份。 @param outcome - 本次调用。 @param value - 不透明产物。 @internal */
export function succeed(outcome: AgentRunOutcome, value: unknown): void {
    Object.assign(outcome, { ok: true, value })
    Reflect.deleteProperty(outcome, 'error')
}

/** @param outcome - 本次调用。 @param error - 原始错误。 @internal */
export function fail(outcome: AgentRunOutcome, error: AgentError): void {
    Object.assign(outcome, { ok: false, error })
    Reflect.deleteProperty(outcome, 'value')
}

/** 消费者关闭事件流而未取得执行结束值；不是某种业务暂停策略。 */
export class StreamClosedError extends AgentError {
    /** 创建事件输送关闭事实。 */
    constructor() {
        super({ code: 'ABORTED', phase: 'run', message: '执行流提前关闭。' })
        this.name = 'StreamClosedError'
    }
}
