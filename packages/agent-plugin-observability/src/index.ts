import { StreamClosedError, type AgentContext, type AgentHooks, type AgentPlugin, type AgentRunOutcome, type ModelFinishReason, type ModelTurnResult, type ModelUsage, type ToolRunResult } from '@quifox/agent-core'

export interface ContextContribution {
    key: string
    content: string
    truncated?: boolean
}

export interface ObservabilityComposition {
    plugins: { id: string; name?: string }[]
    tools: { name: string; description: string }[]
    systemMessages: { content: string; truncated?: boolean }[]
    context: ContextContribution[]
    totalTools?: number
    truncated?: boolean
}

export type RunStatus = 'success' | 'failed' | 'interrupted' | 'stopped'

export type ObservabilityEvent =
    | { type: 'run-start'; sourceId: string; runId: string; timestampMs: number; variant?: string }
    | { type: 'model-start'; sourceId: string; runId: string; timestampMs: number; index: number }
    | { type: 'model'; sourceId: string; runId: string; timestampMs: number; index: number; durationMs: number; usage: ModelUsage; finishReason: ModelFinishReason }
    | { type: 'tool-start'; sourceId: string; runId: string; timestampMs: number; index: number; callId: string; name: string }
    | { type: 'tool'; sourceId: string; runId: string; timestampMs: number; index: number; durationMs: number; callId: string; name: string; status: string; code?: string }
    | { type: 'error'; sourceId: string; runId: string; timestampMs: number; code: string; phase: string }
    | { type: 'composition'; sourceId: string; runId: string; timestampMs: number; modelIndex: number; composition: ObservabilityComposition }
    | { type: 'run-end'; sourceId: string; runId: string; timestampMs: number; durationMs: number; status: RunStatus; finishReason?: string; interruptReason?: string }
    | { type: 'recovery'; sourceId: string; timestampMs: number; mode: 'continue' | 'replan'; runId?: string }
    | { type: 'evaluation'; sourceId: string; timestampMs: number; evaluator: string; runId?: string; score?: number; passed?: boolean; note?: string }

export interface EvaluationInput {
    evaluator: string
    runId?: string
    score?: number
    passed?: boolean
    note?: string
}

export interface ObservabilityPluginOptions<Ctx extends AgentContext = AgentContext> {
    sourceId: string
    now?: () => number
    runId?: () => string | undefined
    variant?: () => string | undefined
    composition?: (ctx: Ctx) => ObservabilityComposition | undefined
    publish?(event: ObservabilityEvent): void | Promise<void>
}

interface ActiveRun {
    id: string
    startedAt: number
    outcome: AgentRunOutcome
    modelIndex: number
    modelStartedAt?: number
    toolIndex: number
    toolStartedAt: Map<string, { time: number; index: number }>
    lastModel?: ModelTurnResult
}
interface ContextRuns { runs: Map<AgentRunOutcome, ActiveRun>; ambiguous: boolean }

/** Observe an Agent through ordinary Hooks; it never owns execution or storage. */
export class ObservabilityPlugin<Input = unknown, Ctx extends AgentContext = AgentContext> implements AgentPlugin<Input, Ctx> {
    readonly id = 'observability'
    readonly name = 'Observability'
    readonly description = 'Run metrics, evaluation and request composition'
    readonly ui = { kind: 'observability', title: 'Observability' } as const
    readonly hooks: AgentHooks<Input, Ctx>
    private sequence = 0
    private readonly contexts = new WeakMap<Ctx, ContextRuns>()
    private readonly activeRuns = new Set<ActiveRun>()
    private failure: unknown
    private lastComposition: ObservabilityComposition | undefined

    constructor(private readonly options: ObservabilityPluginOptions<Ctx>) {
        if (!options.sourceId.trim()) throw new Error('Observability sourceId must not be empty.')
        this.hooks = {
            onRunStart: async (ctx, _input, outcome) => {
                const group = this.contexts.get(ctx) ?? { runs: new Map<AgentRunOutcome, ActiveRun>(), ambiguous: false }
                if (group.runs.has(outcome)) return { action: 'continue' }
                const timestampMs = this.now()
                const runId = this.read(() => options.runId?.()) ?? `${options.sourceId}:${++this.sequence}`
                const run = { id: runId, startedAt: timestampMs, outcome, modelIndex: 0, toolIndex: 0, toolStartedAt: new Map() } satisfies ActiveRun
                group.runs.set(outcome, run); this.contexts.set(ctx, group); this.activeRuns.add(run)
                this.emit({ type: 'run-start', sourceId: options.sourceId, runId, timestampMs, ...this.variant() })
                if (group.runs.size > 1) {
                    group.ambiguous = true; this.failure = new Error('Overlapping runs share one Context; per-call observation is incomplete.')
                    for (const active of group.runs.values()) this.emit({ type: 'error', sourceId: options.sourceId, runId: active.id, timestampMs, code: 'OBSERVATION_CONTEXT_OVERLAP', phase: 'observability' })
                }
                return { action: 'continue' }
            },
            beforeModel: async ctx => {
                const run = this.run(ctx)
                if (!run) return { action: 'continue' }
                run.modelStartedAt = this.now()
                run.modelIndex += 1
                this.emit({ type: 'model-start', sourceId: options.sourceId, runId: run.id, timestampMs: run.modelStartedAt, index: run.modelIndex })
                const composition = this.read(() => options.composition?.(ctx))
                if (composition) {
                    this.lastComposition = composition
                    this.emit({ type: 'composition', sourceId: options.sourceId, runId: run.id, timestampMs: run.modelStartedAt,
                        modelIndex: run.modelIndex, composition })
                }
                return { action: 'continue' }
            },
            afterModel: async (ctx, result) => {
                const run = this.run(ctx), timestampMs = this.now()
                if (!run) return { action: 'continue' }
                const started = run.modelStartedAt ?? timestampMs
                delete run.modelStartedAt
                run.lastModel = result
                this.emit({ type: 'model', sourceId: options.sourceId, runId: run.id, timestampMs, index: run.modelIndex,
                    durationMs: Math.max(0, timestampMs - started), usage: { ...result.usage }, finishReason: result.finishReason })
                return { action: 'continue' }
            },
            beforeTool: async (ctx, call) => {
                const run = this.run(ctx)
                if (!run) return { action: 'continue' }
                run.toolIndex += 1
                const time = this.now()
                run.toolStartedAt.set(call.id, { time, index: run.toolIndex })
                this.emit({ type: 'tool-start', sourceId: options.sourceId, runId: run.id, timestampMs: time, index: run.toolIndex, callId: call.id, name: call.name })
                return { action: 'continue' }
            },
            afterTool: async (ctx, tool) => {
                const run = this.run(ctx)
                if (run) this.observeTool(run, tool)
                return { action: 'continue' }
            },
            onError: async (ctx, error, outcome) => {
                const run = this.contexts.get(ctx)?.runs.get(outcome)
                if (run) this.emit({ type: 'error', sourceId: options.sourceId, runId: run.id, timestampMs: this.now(), code: error.code, phase: error.phase })
            },
            onRunEnd: async (ctx, outcome) => {
                const group = this.contexts.get(ctx), run = group?.runs.get(outcome)
                if (!run) return
                const timestampMs = this.now()
                const value = outcome.ok ? outcome.value as { kind?: string; reason?: string } | undefined : undefined
                const status: RunStatus = outcome.ok ? value?.kind === 'interrupt' ? 'interrupted' : 'success'
                    : outcome.error instanceof StreamClosedError ? 'stopped' : 'failed'
                this.emit({ type: 'run-end', sourceId: options.sourceId, runId: run.id, timestampMs,
                    durationMs: Math.max(0, timestampMs - run.startedAt), status,
                    ...(run.lastModel?.finishReason ? { finishReason: run.lastModel.finishReason } : {}),
                    ...(value?.kind === 'interrupt' && value.reason ? { interruptReason: value.reason } : {}) })
                group!.runs.delete(outcome); this.activeRuns.delete(run)
                if (!group!.runs.size) this.contexts.delete(ctx)
            }
        }
    }

    get publishError(): unknown { return this.failure }
    get composition(): ObservabilityComposition | undefined { return this.lastComposition ? structuredClone(this.lastComposition) : undefined }

    recordRecovery(mode: 'continue' | 'replan', runId = this.onlyRunId()): void {
        this.emit({ type: 'recovery', sourceId: this.options.sourceId, timestampMs: this.now(), mode, ...(runId ? { runId } : {}) })
    }

    recordEvaluation(input: EvaluationInput): void {
        if (!input.evaluator.trim()) throw new Error('Evaluator name must not be empty.')
        const runId = input.runId ?? this.onlyRunId()
        this.emit({ type: 'evaluation', sourceId: this.options.sourceId, timestampMs: this.now(), evaluator: input.evaluator,
            ...(runId ? { runId } : {}),
            ...(input.score === undefined ? {} : { score: input.score }),
            ...(input.passed === undefined ? {} : { passed: input.passed }),
            ...(input.note === undefined ? {} : { note: input.note }) })
    }

    private observeTool(run: ActiveRun, tool: ToolRunResult): void {
        const timestampMs = this.now()
        const started = run.toolStartedAt.get(tool.call.id)
        run.toolStartedAt.delete(tool.call.id)
        this.emit({ type: 'tool', sourceId: this.options.sourceId, runId: run.id, timestampMs, index: started?.index ?? ++run.toolIndex,
            durationMs: Math.max(0, timestampMs - (started?.time ?? timestampMs)), callId: tool.call.id, name: tool.call.name, status: tool.result.status,
            ...(tool.result.code ? { code: tool.result.code } : {}) })
    }

    private run(ctx: Ctx): ActiveRun | undefined {
        const group = this.contexts.get(ctx)
        return group && !group.ambiguous && group.runs.size === 1 ? group.runs.values().next().value : undefined
    }
    private onlyRunId(): string | undefined { return this.activeRuns.size === 1 ? this.activeRuns.values().next().value?.id : undefined }

    private read<T>(operation: () => T): T | undefined {
        try { return operation() } catch (error) { this.failure = error; return undefined }
    }
    private now(): number { return this.read(() => this.options.now?.()) ?? Date.now() }
    private variant(): { variant?: string } {
        const value = this.read(() => this.options.variant?.())
        return value ? { variant: value } : {}
    }

    private emit(event: ObservabilityEvent): void {
        try {
            const pending = this.options.publish?.(event)
            if (pending) void Promise.resolve(pending).catch(error => { this.failure = error })
        } catch (error) { this.failure = error }
    }
}

export interface RunMetrics {
    sourceId: string
    runId: string
    variant?: string
    startedAtMs: number
    endedAtMs?: number
    durationMs: number
    status: RunStatus | 'running' | 'unknown'
    modelCalls: number
    modelDurationMs: number
    toolCalls: number
    toolErrors: number
    toolDurationMs: number
    usage: ModelUsage
    finishReason?: string
    interruptReason?: string
    incomplete?: boolean
    errors: { code: string; phase: string }[]
    models: Extract<ObservabilityEvent, { type: 'model' }>[]
    tools: Extract<ObservabilityEvent, { type: 'tool' }>[]
    pendingModels: Extract<ObservabilityEvent, { type: 'model-start' }>[]
    pendingTools: Extract<ObservabilityEvent, { type: 'tool-start' }>[]
    evaluations: Extract<ObservabilityEvent, { type: 'evaluation' }>[]
    composition?: ObservabilityComposition
}

export interface ObservabilitySummary {
    runs: RunMetrics[]
    recoveries: Extract<ObservabilityEvent, { type: 'recovery' }>[]
    evaluations: Extract<ObservabilityEvent, { type: 'evaluation' }>[]
}

/** Fold persisted facts without needing a live Agent. */
export function foldObservability(events: readonly ObservabilityEvent[]): ObservabilitySummary {
    const runs = new Map<string, RunMetrics>()
    const recoveries: ObservabilitySummary['recoveries'] = []
    const evaluations: ObservabilitySummary['evaluations'] = []
    for (const event of events) {
        if (event.type === 'run-start') {
            runs.set(event.runId, { sourceId: event.sourceId, runId: event.runId, ...(event.variant ? { variant: event.variant } : {}),
                startedAtMs: event.timestampMs, durationMs: 0, status: 'running', modelCalls: 0, modelDurationMs: 0,
                toolCalls: 0, toolErrors: 0, toolDurationMs: 0, usage: {}, errors: [], models: [], tools: [], pendingModels: [], pendingTools: [], evaluations: [] })
            continue
        }
        if (event.type === 'recovery') { recoveries.push(event); continue }
        if (event.type === 'evaluation') {
            evaluations.push(event)
            if (event.runId) runs.get(event.runId)?.evaluations.push(event)
            continue
        }
        const run = runs.get(event.runId)
        if (!run) continue
        if (event.type === 'model-start') {
            run.pendingModels.push(event); run.modelCalls += 1; run.usage = {}
        } else if (event.type === 'tool-start') {
            run.pendingTools.push(event); run.toolCalls += 1
        } else if (event.type === 'model') {
            if (!run.pendingModels.some(item => item.index === event.index)) run.modelCalls += 1
            run.pendingModels = run.pendingModels.filter(item => item.index !== event.index)
            run.models.push(event); run.modelDurationMs += event.durationMs
            run.usage = run.pendingModels.length ? {} : sumUsage(run.models.map(item => item.usage)); run.finishReason = event.finishReason
        } else if (event.type === 'tool') {
            if (!run.pendingTools.some(item => item.index === event.index && item.callId === event.callId)) run.toolCalls += 1
            run.pendingTools = run.pendingTools.filter(item => item.index !== event.index || item.callId !== event.callId)
            run.tools.push(event); run.toolDurationMs += event.durationMs
            if (event.status === 'error') run.toolErrors += 1
        } else if (event.type === 'error') {
            run.errors.push({ code: event.code, phase: event.phase })
            if (event.code === 'OBSERVATION_CONTEXT_OVERLAP') { run.incomplete = true; run.usage = {} }
        }
        else if (event.type === 'composition') run.composition = event.composition
        else if (event.type === 'run-end') {
            run.endedAtMs = event.timestampMs; run.durationMs = event.durationMs; run.status = event.status
            if (event.finishReason) run.finishReason = event.finishReason
            if (event.interruptReason) run.interruptReason = event.interruptReason
        }
    }
    return { runs: [...runs.values()], recoveries, evaluations }
}

function sumUsage(values: readonly ModelUsage[]): ModelUsage {
    const output: ModelUsage = {}
    for (const key of ['inputTokens', 'outputTokens', 'totalTokens', 'cachedInputTokens', 'reasoningTokens'] as const) {
        if (values.length && values.every(value => value[key] !== undefined)) output[key] = values.reduce((sum, value) => sum + value[key]!, 0)
    }
    return output
}

export interface VariantComparison {
    variant: string
    runs: number
    successRate: number
    averageDurationMs: number
    averageModelCalls: number
    averageToolCalls: number
    averageTotalTokens?: number
    evaluationScore?: number
    evaluationPassRate?: number
}

export function compareObservabilityRuns(runs: readonly RunMetrics[]): VariantComparison[] {
    const groups = new Map<string, RunMetrics[]>()
    for (const run of runs) {
        if (run.status === 'running' || run.status === 'unknown' || run.incomplete) continue
        const variant = run.variant ?? 'default'
        groups.set(variant, [...groups.get(variant) ?? [], run])
    }
    return [...groups].map(([variant, values]) => {
        const evaluations = values.flatMap(run => run.evaluations)
        const scored = evaluations.flatMap(item => item.score === undefined ? [] : [item.score])
        const passed = evaluations.flatMap(item => item.passed === undefined ? [] : [item.passed])
        const totalTokens = values.flatMap(run => run.usage.totalTokens === undefined ? [] : [run.usage.totalTokens])
        const average = (items: readonly number[]): number => items.length ? items.reduce((sum, value) => sum + value, 0) / items.length : 0
        return { variant, runs: values.length,
            successRate: values.filter(run => run.status === 'success').length / values.length,
            averageDurationMs: average(values.map(run => run.durationMs)),
            averageModelCalls: average(values.map(run => run.modelCalls)),
            averageToolCalls: average(values.map(run => run.toolCalls)),
            ...(totalTokens.length === values.length ? { averageTotalTokens: average(totalTokens) } : {}),
            ...(scored.length ? { evaluationScore: average(scored) } : {}),
            ...(passed.length ? { evaluationPassRate: passed.filter(Boolean).length / passed.length } : {}) }
    })
}
