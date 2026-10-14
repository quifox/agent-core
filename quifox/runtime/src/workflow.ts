import { createHash, randomUUID } from 'node:crypto'
import { tmpdir } from 'node:os'
import { analyzeWorkflowScript, createWorkflowProgram, collectSites, synthesizeAskSchemas, buildAskSpecs, lowerWorkflow, collectSitePhases, InMemoryJournalStore, WorkflowError, validate,
    type PersonaSpec, type AskMessage, type InstanceRef, type RunEvent, type SessionRef, type WorkflowDriver, type JournalStorePort } from '@quifox/workflow-engine'
import { runWorkflowScript } from '@quifox/workflow-engine/runtime'
import { workflowCalls } from './workflow-calls.js'

export interface WorkflowGraph {
    nodes: { id: string; label: string; kind: string }[]
    edges: { from: string; to: string; kind: string }[]
}
export interface WorkflowInspection { ok: boolean; diagnostics: { line: number; column: number; message: string }[]; graph: WorkflowGraph }
export interface WorkflowCallEvent {
    type: 'call-started' | 'call-settled'
    executionId: string; definitionId: string; callId: string; parentCallId?: string; outcome?: 'ok' | 'error'
}

/** Keep the original source and its locations for both checking and instrumentation. */
export function workflowSource(script: string): string {
    if (Buffer.byteLength(script) > 200000) throw new Error('工作流脚本超过 200 KB。')
    return script
}

const inspections = new Map<string, WorkflowInspection>()
export function inspectWorkflow(script: string): WorkflowInspection {
    const key = createHash('sha256').update(script).digest('hex'), cached = inspections.get(key)
    if (cached) return structuredClone(cached)
    const source = workflowSource(script), result = analyzeWorkflowScript(source), calls = workflowCalls(createWorkflowProgram(source))
    const diagnostics = [...result.diagnostics, ...calls.diagnostics]
    const inspection = { ok: result.ok && !calls.diagnostics.length, diagnostics, graph: calls.graph }
    inspections.set(key, inspection)
    if (inspections.size > 32) inspections.delete(inspections.keys().next().value!)
    return structuredClone(inspection)
}

export interface WorkflowRunOptions {
    runId?: string; executionId?: string; journal?: JournalStorePort
    script: string; args: Record<string, unknown>; cwd?: string; signal?: AbortSignal
    ask(persona: PersonaSpec, input: AskMessage, signal: AbortSignal, sessionId: string, inputId: string): Promise<unknown>
    emit?(event: (RunEvent & { executionId: string }) | WorkflowCallEvent): void
    error?(cause: unknown): void
    world?(operation: string, args: unknown[]): Promise<unknown>
    childSpawn?: { argsPrefix: readonly string[] }
}

export async function runWorkflow(options: WorkflowRunOptions): Promise<unknown> {
    const source = workflowSource(options.script), analysis = inspectWorkflow(options.script)
    if (!analysis.ok) throw new Error(analysis.diagnostics.map(diagnostic => `${diagnostic.line}:${diagnostic.column} ${diagnostic.message}`).join('\n'))
    const program = createWorkflowProgram(source), table = collectSites(program), schemas = synthesizeAskSchemas(program, table)
    if (schemas.diagnostics.length) throw new Error(schemas.diagnostics.map(value => value.message).join('\n'))
    const lowered = lowerWorkflow(program, table, workflowCalls(program).bodies)
    const sessions = new Map<string, PersonaSpec>(), controllers = new Map<string, AbortController>(), pending = new Set<Promise<void>>()
    const verdicts = new Map<string, Parameters<WorkflowDriver['respondToSubmit']>[1]>()
    const journal = options.journal ?? new InMemoryJournalStore(), runId = options.runId ?? randomUUID()
    const executionId = options.executionId ?? randomUUID()
    const instancePhases = new Map<string, string>()
    for (const stored of journal.listEvents(runId, { types: 'all', reportItems: 'all' })) {
        if ('instance' in stored.event && 'phaseName' in stored.event && stored.event.phaseName) instancePhases.set(stored.event.instance.siteId + '@' + stored.event.instance.ordinal, stored.event.phaseName)
    }
    const result = await runWorkflowScript({ lowered: `return __host.node("entry", async () => {\n${lowered.code}\n});`, scriptText: source, scriptHash: createHash('sha256').update(source).digest('hex'), args: options.args, cwd: options.cwd ?? tmpdir(), runId, caps: { maxConcurrency: 8 },
        onCall: event => { const { kind: _kind, ...call } = event; options.emit?.({ ...call, executionId }) },
        askSpecs: buildAskSpecs(table, schemas.schemas), sitePhases: collectSitePhases(analyzeWorkflowScript(source).core!), validate: (schema, value) => validate(schema as Parameters<typeof validate>[0], value),
        ...(options.signal ? { signal: options.signal } : {}), ...(options.childSpawn ? { childSpawn: options.childSpawn } : {}),
        makeDriver: sink => {
            const driver: WorkflowDriver = {
                journal, emit: event => {
                    if ('instance' in event) {
                        const key = event.instance.siteId + '@' + event.instance.ordinal
                        if ('phaseName' in event && event.phaseName) instancePhases.set(key, event.phaseName)
                        const phaseName = instancePhases.get(key)
                        if (event.type === 'node-settled' && phaseName) event = { ...event, phaseName }
                    }
                    options.emit?.({ ...event, executionId })
                },
                createActorSession: async (actor, persona): Promise<SessionRef> => { const id = runId + ':' + actor.siteId + ':' + actor.ordinal; sessions.set(id, persona); return { id } },
                startAsk: (session, instance, message) => {
                    const key = `${instance.siteId}@${instance.ordinal}`, controller = new AbortController(); controllers.set(key, controller)
                    const work = (async (): Promise<void> => {
                        let prompt = message, attempt = 0
                        try {
                            for (;;) {
                                controller.signal.throwIfAborted()
                                const value = await options.ask(sessions.get(session.id)!, prompt, controller.signal, session.id, key + ':' + attempt++)
                                if (!message.typed) { sink.askTurnEnded(instance, typeof value === 'string' ? value : JSON.stringify(value)); break }
                                verdicts.delete(key); sink.askSubmitAttempted(instance, value)
                                const verdict = verdicts.get(key)
                                if (!verdict || verdict.kind === 'accept') break
                                prompt = { ...message, instructions: message.instructions + '\nYour previous result failed validation. Correct it using this feedback:\n' + JSON.stringify(verdict) }
                            }
                        } catch (cause) {
                            options.error?.(cause)
                            if (!controller.signal.aborted) sink.askFailed(instance, new WorkflowError('DriverError', '工作流 Agent 执行失败；详情见本地日志。'))
                        }
                    })().finally(() => { controllers.delete(key); verdicts.delete(key); pending.delete(work) })
                    pending.add(work)
                },
                respondToSubmit: (instance: InstanceRef, verdict) => { verdicts.set(`${instance.siteId}@${instance.ordinal}`, verdict) },
                cancelAsk: instance => controllers.get(`${instance.siteId}@${instance.ordinal}`)?.abort(),
                executeWorldRead: async (operation, args) => { if (!options.world) throw new Error('当前宿主没有提供该工作流工具。'); return options.world(operation, args) },
                dispose: () => { for (const controller of controllers.values()) controller.abort() }
            }
            return driver
        } })
    await Promise.allSettled(pending)
    if (result.status === 'completed') return result.artifact
    if (result.status === 'stopped') throw new Error('工作流已停止。')
    throw new Error(result.error.message)
}
