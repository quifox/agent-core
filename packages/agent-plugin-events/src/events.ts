import type { AgentErrorCode, AgentErrorPhase, AgentRunOutcome, ModelEvent, ModelTurnResult, ToolCall, ToolRunResult } from '@quifox/agent-core'

export const AGENT_EVENT_TYPE = { RUN_START: 'run-start', STEP_START: 'step-start', MODEL_START: 'model-start', TEXT_DELTA: 'text-delta', REASONING_DELTA: 'reasoning-delta', TOOL_CALL: 'tool-call', MODEL_END: 'model-end', TOOL_START: 'tool-start', TOOL_RESULT: 'tool-result', STEP_END: 'step-end', ERROR: 'error', RUN_END: 'run-end' } as const
export const LIFECYCLE_END_STATUS = { COMPLETED: 'completed', STOPPED: 'stopped', FAILED: 'failed' } as const
export type LifecycleEndStatus = typeof LIFECYCLE_END_STATUS[keyof typeof LIFECYCLE_END_STATUS]

/** 可安全投影到 UI 或传输出口的错误摘要。 */
export interface PublicAgentError {
    code: AgentErrorCode
    phase: AgentErrorPhase
}

/** 本观察插件提供的事件投影，阶段状态不属于 Core。 */
export type AgentEvent = ModelEvent
    | { type: 'run-start' }
    | { type: 'step-start'; step: number }
    | { type: 'model-start'; step: number }
    | { type: 'model-end'; step: number; status: 'completed'; result: ModelTurnResult }
    | { type: 'model-end'; step: number; status: 'failed' | 'stopped' }
    | { type: 'tool-start'; call: ToolCall }
    | { type: 'tool-result'; run: ToolRunResult }
    | { type: 'step-end'; step: number; status: LifecycleEndStatus }
    | { type: 'error'; error: PublicAgentError; secondary: boolean }
    | { type: 'run-end'; outcome: AgentRunOutcome }
