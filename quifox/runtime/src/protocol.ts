import type { AgentMessage } from '@quifox/agent-core'
import type { MemoryOrigin } from '@quifox/agent-plugin-memory'
import type { SkillCatalog } from '@quifox/agent-plugin-project-context'
import type { ApprovalRequest } from './permissions.js'
import { reasoningEffortSchema, type publicConfig } from './config.js'
import { z } from 'zod'
import type { BackgroundTaskSnapshot } from '@quifox/agent-plugin-tasks'
import type { FileChange } from './tool-presentation.js'
import type { ObservabilitySummary, VariantComparison } from '@quifox/agent-plugin-observability'
import type { PresentationReceipt } from '@quifox/agent-plugin-presentation'

export interface ProjectListing { path: string; entries: { name: string; kind: 'directory' | 'symlink' | 'file' }[]; truncated: boolean }
export interface ProjectFile { workspace: string; path: string; relativePath: string; bytes: number; kind: 'text' | 'binary' | 'image' | 'video'; content?: string | undefined; truncated: boolean }
export interface PresentationRequest { id: string; sessionId: string; operationId: string; workspace: string; target: string }
export type PresentationReply = { ok: true; receipt: PresentationReceipt } | { ok: false; error: string }

export interface SessionMetadata {
    id: string; ownerId: string; title: string; workspace: string; createdAt: string; updatedAt: string; revision: number
    parentId?: string; taskId?: string; generateMemory: boolean; creationIdentity?: string
    name?: string; initialInstructions?: string
    modelId?: string; reasoningEffort?: z.infer<typeof reasoningEffortSchema>
    agentName?: string; toolScopes?: string[][]; toolDenylist?: string[]; approvalMode?: 'ask' | 'allow' | 'deny'
}
export interface TranscriptMessage { id: string; message: AgentMessage; origin: MemoryOrigin; operations?: { callId: string; operationId: string }[] }
export interface RuntimeEvent { version: 1; sessionId: string; runId?: string; operationId?: string; sequence: number; timestamp: string; type: string; data: unknown }
export interface SessionSummary { id: string; title: string; workspace: string; parentId?: string; taskId?: string; name?: string; status: 'idle' | 'running' | 'stopped' | 'error'; updatedAt: string; resumeAvailable: boolean; unavailable?: string }
export interface AgentRecipient { sessionId: string; taskId: string; name: string; status: SessionSummary['status'] }
export type InputRoutingReceipt = { kind: 'spawn'; accepted: boolean; agents: AgentRecipient[]; errors: string[] } |
    { kind: 'dispatch'; accepted: boolean; deliveries: { agent: AgentRecipient; status: 'queued' | 'error'; error?: string }[] }
export interface SessionView extends SessionSummary {
    modelId?: string; reasoningEffort?: z.infer<typeof reasoningEffortSchema>; reasoningEffortOverride?: z.infer<typeof reasoningEffortSchema>; models?: RuntimeSnapshot['config']['models']
    configSources?: string[]; preferences?: RuntimeSnapshot['config']['preferences']; approvalMode?: 'ask' | 'allow' | 'deny'
    defaultModel?: RuntimeSnapshot['config']['model']; untrustedMcp?: string[]
    totalMessages?: number; totalEvents?: number; liveText?: string; changes?: FileChange[]; displayTruncated?: boolean
    eventSequence?: number
    agents?: { agents: { name: string; description: string; model?: string | undefined; effort?: z.infer<typeof reasoningEffortSchema> | undefined; permissionMode?: 'default' | 'plan' | 'dontAsk' | undefined; source: string; tools?: string[] | undefined; disallowedTools?: string[] | undefined }[]; issues: { source: string; message: string }[] }
    messages: TranscriptMessage[]; events: RuntimeEvent[]; approvals: ApprovalRequest[]; pendingMessages: { id: string; prompt: string; mode: 'steer' | 'queue'; status?: 'pending' | 'staged' }[]
    skills: SkillCatalog; guidance: { root: string; path: string }[]
    memory: { enabled: boolean; processing: boolean; content: string; summaries: number; error?: string }
    backgroundTasks: BackgroundTaskSnapshot[]
    toolStates: { id: string; status: 'not-started' | 'started' | 'completed' }[]
}
export interface RuntimeSnapshot { configurationRevision: string; config: ReturnType<typeof publicConfig>; sessions: SessionSummary[] }
export interface ResourceView {
    config: RuntimeSnapshot['config']
    workspace: string; skills: SkillCatalog; skillsEnabled: boolean; guidance: SessionView['guidance']; agents: NonNullable<SessionView['agents']>
    memory: SessionView['memory']; configSources: string[]; disabledSkills?: string[]; displayTruncated?: boolean
}
export interface PluginView {
    scope: 'session' | 'configuration'
    plugins: { id: string; name?: string; description?: string; components?: string[]; surface?: { kind: string; title: string } }[]
    installed: { id: string; name: string; description: string; source: 'builtin' | 'mcp'; enabled: boolean; globalEnabled: boolean; surface?: { kind: string; title: string } }[]
    marketplace: { id: string; name: string; description: string; installed: boolean; source: 'builtin' }[]
}
export interface ObservabilityView extends ObservabilitySummary { comparison: VariantComparison[]; totalRuns: number; displayTruncated?: boolean }
export interface ModelCatalogView {
    providers: { id: string; name: string; baseUrl: string }[]
    models: { id: string; name: string; contextWindow?: number; maxInputTokens?: number; maxOutputTokens?: number; reasoning?: boolean; reasoningEfforts?: z.infer<typeof reasoningEffortSchema>[]; reasoningSource?: string }[]
    source: 'models.dev'
    cached: boolean
}
export type RuntimeCommand =
    | { type: 'snapshot'; sessionId?: string; runId?: string; messageLimit?: number; eventLimit?: number; traceOnly?: boolean }
    | { type: 'plugin-set-enabled'; pluginId: string; scope: 'global' | 'workspace'; workspace?: string; enabled: boolean }
    | { type: 'plugin-install'; pluginId: string; action: 'install' | 'remove'; scope: 'global' | 'workspace'; workspace?: string }
    | { type: 'memory-file'; sessionId?: string }
    | { type: 'project'; sessionId?: string; workspace?: string; action: 'list' | 'read' | 'search'; path?: string; query?: string }
    | { type: 'presentation-reply'; requestId: string; reply: PresentationReply }
    | { type: 'create'; sessionId?: string; workspace?: string | null; title?: string; modelId?: string; reasoningEffort?: z.infer<typeof reasoningEffortSchema>; agent?: string; approvalMode?: 'ask' | 'allow' }
    | { type: 'agents'; workspace?: string }
    | { type: 'resources'; workspace?: string | null }
    | { type: 'instructions'; action: 'read' | 'save-global'; workspace?: string; content?: string }
    | { type: 'plugins'; sessionId?: string; workspace?: string }
    | { type: 'observability'; sessionId: string; action: 'summary' | 'evaluate'; runId?: string; evaluator?: string; score?: number; passed?: boolean; note?: string }
    | { type: 'session-config'; sessionId: string; modelId?: string; reasoningEffort?: z.infer<typeof reasoningEffortSchema> | null; approvalMode?: 'ask' | 'allow' }
    | { type: 'submit'; sessionId: string; prompt: string; mode?: 'steer' | 'queue'; messageId?: string }
    | { type: 'inbox'; sessionId: string; action: 'cancel' | 'steer'; messageId: string }
    | { type: 'stop'; sessionId: string; waitForExit?: boolean; timeoutMs?: number }
    | { type: 'resume'; sessionId: string; mode: 'continue' | 'replan' }
    | { type: 'approve'; sessionId: string; approvalId: string; approved: boolean }
    | { type: 'config'; patch: unknown }
    | { type: 'refresh-models' }
    | { type: 'model-catalog'; provider?: string; refresh?: boolean }
    | { type: 'memory'; sessionId: string }
    | { type: 'mcp'; action: 'status' | 'connect'; sessionId?: string; workspace?: string; serverId?: string }
    | { type: 'mcp-set-enabled'; serverId: string; scope: 'global' | 'workspace'; workspace?: string; enabled: boolean }
    | { type: 'close' }
export interface CommandEnvelope { id: string; command: RuntimeCommand }
export type EngineFrame = { kind: 'response'; id: string; ok: true; value: unknown } | { kind: 'response'; id: string; ok: false; error: string } |
    { kind: 'event'; event: RuntimeEvent } | { kind: 'ready'; protocol: 1 } | { kind: 'fatal'; error: string } |
    { kind: 'presentation'; request: PresentationRequest } | { kind: 'presentation-cancel'; requestId: string }

const sessionId = z.string().regex(/^[A-Za-z0-9_-]{1,96}$/)
export const runtimeCommandSchema = z.discriminatedUnion('type', [
    z.object({ type: z.literal('snapshot'), sessionId: sessionId.optional(), runId: z.string().min(1).max(256).optional(), messageLimit: z.number().int().min(1).max(5000).optional(), eventLimit: z.number().int().min(1).max(10000).optional(), traceOnly: z.boolean().optional() }).strict(),
    z.object({ type: z.literal('project'), sessionId: sessionId.optional(), workspace: z.string().min(1).optional(), action: z.enum(['list', 'read', 'search']), path: z.string().optional(), query: z.string().max(200).optional() }).strict(),
    z.object({ type: z.literal('presentation-reply'), requestId: z.string().min(1).max(200), reply: z.discriminatedUnion('ok', [
        z.object({ ok: z.literal(true), receipt: z.discriminatedUnion('destination', [
            z.object({ destination: z.literal('panel'), viewId: z.string().min(1).max(200), target: z.string().min(1).max(4096), kind: z.string().min(1).max(64) }).strict(),
            z.object({ destination: z.literal('external'), target: z.string().min(1).max(4096) }).strict()
        ]) }).strict(), z.object({ ok: z.literal(false), error: z.string().min(1).max(2000) }).strict()
    ]) }).strict(),
    z.object({ type: z.literal('create'), sessionId: z.uuid().optional(), workspace: z.string().min(1).nullable().optional(), title: z.string().max(300).optional(), modelId: z.string().min(1).optional(), reasoningEffort: reasoningEffortSchema.optional(), agent: z.string().min(1).optional(), approvalMode: z.enum(['ask', 'allow']).optional() }).strict(),
    z.object({ type: z.literal('agents'), workspace: z.string().min(1).optional() }).strict(),
    z.object({ type: z.literal('resources'), workspace: z.string().min(1).nullable().optional() }).strict(),
    z.object({ type: z.literal('instructions'), action: z.enum(['read', 'save-global']), workspace: z.string().min(1).optional(), content: z.string().max(1_000_000).optional() }).strict(),
    z.object({ type: z.literal('plugins'), sessionId: sessionId.optional(), workspace: z.string().min(1).optional() }).strict(),
    z.object({ type: z.literal('observability'), sessionId, action: z.enum(['summary', 'evaluate']), runId: z.string().min(1).optional(),
        evaluator: z.string().min(1).max(120).optional(), score: z.number().finite().optional(), passed: z.boolean().optional(), note: z.string().max(2000).optional() }).strict(),
    z.object({ type: z.literal('session-config'), sessionId, modelId: z.string().min(1).optional(), reasoningEffort: reasoningEffortSchema.nullable().optional(), approvalMode: z.enum(['ask', 'allow']).optional() }).strict(),
    z.object({ type: z.literal('submit'), sessionId, prompt: z.string().refine(value => !!value.trim(), 'Message must not be empty.'), mode: z.enum(['steer', 'queue']).optional(), messageId: z.string().min(1).max(200).optional() }).strict(),
    z.object({ type: z.literal('inbox'), sessionId, action: z.enum(['cancel', 'steer']), messageId: z.string().min(1).max(200) }).strict(),
    z.object({ type: z.literal('stop'), sessionId, waitForExit: z.boolean().optional(), timeoutMs: z.number().int().min(0).max(300_000).optional() }).strict(), z.object({ type: z.literal('resume'), sessionId, mode: z.enum(['continue', 'replan']) }).strict(),
    z.object({ type: z.literal('approve'), sessionId, approvalId: z.string().min(1), approved: z.boolean() }).strict(),
    z.object({ type: z.literal('config'), patch: z.unknown() }).strict(), z.object({ type: z.literal('refresh-models') }).strict(),
    z.object({ type: z.literal('model-catalog'), provider: z.string().min(1).max(100).optional(), refresh: z.boolean().optional() }).strict(),
    z.object({ type: z.literal('memory'), sessionId }).strict(), z.object({ type: z.literal('close') }).strict()
    , z.object({ type: z.literal('mcp'), action: z.enum(['status', 'connect']), sessionId: sessionId.optional(), workspace: z.string().min(1).optional(), serverId: z.string().optional() }).strict()
    , z.object({ type: z.literal('mcp-set-enabled'), serverId: z.string().regex(/^[A-Za-z0-9_-]{1,20}$/), scope: z.enum(['global', 'workspace']), workspace: z.string().min(1).optional(), enabled: z.boolean() }).strict()
    , z.object({ type: z.literal('plugin-set-enabled'), pluginId: z.string().min(1).max(96), scope: z.enum(['global', 'workspace']), workspace: z.string().min(1).optional(), enabled: z.boolean() }).strict()
    , z.object({ type: z.literal('plugin-install'), pluginId: z.string().min(1).max(96), action: z.enum(['install', 'remove']), scope: z.enum(['global', 'workspace']), workspace: z.string().min(1).optional() }).strict()
    , z.object({ type: z.literal('memory-file'), sessionId: sessionId.optional() }).strict()
])
export const commandEnvelopeSchema = z.object({ id: z.string().min(1).max(200), command: runtimeCommandSchema }).strict()
