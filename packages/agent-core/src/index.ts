export { Tool, Hook, toolsFrom, hooksFrom } from './decorators.js'
export { Agent, createAgent } from './agent.js'
export type { AgentOptions } from './agent.js'
export type { AgentPlugin } from './plugins.js'

export {
    AGENT_ERROR_CODE,
    AGENT_ERROR_PHASE,
    AgentError
} from './errors.js'
export type { AgentErrorCode, AgentErrorPhase } from './errors.js'

export { StreamClosedError } from './context.js'
export type { AgentContext, AgentPluginRef, AgentRunOutcome } from './context.js'
export type { AgentEvent } from './events.js'

export {
    MESSAGE_ROLE,
    MODEL_EVENT_TYPE,
    MODEL_FINISH_REASON
} from './model.js'
export type {
    AgentMessage,
    ModelEvent,
    ModelFinishReason,
    ModelReasoning,
    ModelRequest,
    ModelSettings,
    ModelTurnResult,
    ModelUsage,
    ToolCall
} from './model.js'

export type {
    AgentHooks,
    BeforeToolDecision,
    ContinueOrStop,
    HookOrHooks,
    HookOutput
} from './hooks.js'

export {
    createToolSet,
    defineTool,
    TOOL_APPROVAL,
    TOOL_RESULT_STATUS,
    TOOL_SIDE_EFFECT,
    toolDenied,
    toolError,
    toolSuccess,
    ToolRegistry
} from './tools.js'
export type {
    AgentTool,
    AgentToolDefinition,
    AgentToolSet,
    ToolApproval,
    ToolPolicy,
    ToolResult,
    ToolResultStatus,
    ToolRunResult,
    ToolSideEffect
} from './tools.js'
