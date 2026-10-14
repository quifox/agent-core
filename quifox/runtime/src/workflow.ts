import ts from 'typescript'
import { createHash, randomUUID } from 'node:crypto'
import { tmpdir } from 'node:os'
import { analyzeWorkflowScript, projectControlFlow, createWorkflowProgram, collectSites, synthesizeAskSchemas, buildAskSpecs, lowerWorkflow, collectSitePhases, InMemoryJournalStore, WorkflowError, validate,
    type PersonaSpec, type AskMessage, type InstanceRef, type RunEvent, type SessionRef, type WorkflowDriver, type JournalStorePort } from '@quifox/workflow-engine'
import { runWorkflowScript } from '@quifox/workflow-engine/runtime'

export interface WorkflowGraph {
    phases: { id: string; label: string; alongside?: string[] }[]
    nodes: { id: string; label: string; kind: string; phase: string; siteId?: string }[]
    edges: { from: string; to: string; kind: string }[]
    phaseEdges: { from: string; to: string; kind: string }[]
}
export interface WorkflowInspection { ok: boolean; diagnostics: { line: number; column: number; message: string }[]; graph: WorkflowGraph }

/** Labels are normal JSDoc; execution and graph analysis consume the same normalized script. */
export function workflowSource(script: string): string {
    if (Buffer.byteLength(script) > 200000) throw new Error('工作流脚本超过 200 KB。')
    const source = ts.createSourceFile('workflow.ts', script, ts.ScriptTarget.ES2022, true)
    const inserts: { position: number; text: string }[] = []
    const visit = (node: ts.Node): void => {
        if (ts.isFunctionDeclaration(node) || ts.isMethodDeclaration(node) || ts.isArrowFunction(node) || ts.isFunctionExpression(node)) {
            const tag = ts.getJSDocTags(node).find(tag => tag.tagName.text === 'phase')
            const label = typeof tag?.comment === 'string' ? tag.comment.trim() : undefined
            if (label && node.body && ts.isBlock(node.body)) inserts.push({ position: node.body.getStart(source) + 1, text: `phase(${JSON.stringify(label)});` })
        }
        ts.forEachChild(node, visit)
    }
    visit(source)
    for (const insert of inserts.sort((a, b) => b.position - a.position)) script = script.slice(0, insert.position) + insert.text + script.slice(insert.position)
    return script
}

const inspections = new Map<string, WorkflowInspection>()
export function inspectWorkflow(script: string): WorkflowInspection {
    const key = createHash('sha256').update(script).digest('hex'), cached = inspections.get(key)
    if (cached) return structuredClone(cached)
    const result = analyzeWorkflowScript(workflowSource(script))
    const flow = result.core ? projectControlFlow(result.core, { suspendAtAwait: true }) : result.flow, steps = new Map(result.causality?.steps.map(step => [step.id, step]) ?? [])
    const phases = (flow?.phases ?? []).map(phase => ({ id: phase.id, label: phase.name ?? '主流程', ...(phase.alongside ? { alongside: phase.alongside } : {}) }))
    for (const node of flow?.nodes ?? []) if (!phases.some(phase => phase.id === node.phase)) phases.push({ id: node.phase, label: '主流程' })
    let edges: WorkflowGraph['edges'] = flow?.edges ?? []
    for (const phase of phases) {
        const nodes = (flow?.nodes ?? []).filter(node => node.phase === phase.id && node.site)
        if (nodes.length < 2 || nodes.some(node => steps.get(node.site!)?.certainty !== 'always')) continue
        const regions = new Set(nodes.map(node => steps.get(node.site!)?.region))
        if (regions.size !== 1) continue
        const dependencies = (result.causality?.edges ?? []).flatMap(edge => {
            const from = nodes.find(node => node.site === edge.from), to = nodes.find(node => node.site === edge.to)
            return from && to ? [{ from: from.id, to: to.id, kind: 'next' }] : []
        })
        const roots = nodes.filter(node => !dependencies.some(edge => edge.to === node.id)), leaves = nodes.filter(node => !dependencies.some(edge => edge.from === node.id))
        if (roots.length < 2 || !leaves.length) continue
        const ids = new Set(nodes.map(node => node.id))
        const incoming = edges.filter(edge => !ids.has(edge.from) && ids.has(edge.to)), outgoing = edges.filter(edge => ids.has(edge.from) && !ids.has(edge.to))
        edges = [...edges.filter(edge => !ids.has(edge.from) && !ids.has(edge.to)), ...dependencies,
            ...incoming.flatMap(edge => roots.map(node => ({ from: edge.from, to: node.id, kind: 'fork' }))),
            ...outgoing.flatMap(edge => leaves.map(node => ({ from: node.id, to: edge.to, kind: leaves.length > 1 ? 'join' : edge.kind })))]
    }
    const inspection = { ok: result.ok, diagnostics: result.diagnostics,
        graph: { phases,
            nodes: (flow?.nodes ?? []).map(node => ({ id: node.id, kind: node.kind, phase: node.phase, label: node.site ? steps.get(node.site)?.label ?? '操作' : flow?.phases?.find(phase => phase.id === node.phase)?.name ?? '阶段', ...(node.site ? { siteId: node.site } : {}) })),
            edges, phaseEdges: flow?.phaseEdges ?? [] } }
    inspections.set(key, inspection)
    if (inspections.size > 32) inspections.delete(inspections.keys().next().value!)
    return structuredClone(inspection)
}

export interface WorkflowRunOptions {
    runId?: string; journal?: JournalStorePort
    script: string; args: Record<string, unknown>; cwd?: string; signal?: AbortSignal
    ask(persona: PersonaSpec, input: AskMessage, signal: AbortSignal, sessionId: string, inputId: string): Promise<unknown>
    emit?(event: RunEvent): void
    error?(cause: unknown): void
    world?(operation: string, args: unknown[]): Promise<unknown>
    childSpawn?: { argsPrefix: readonly string[] }
}

export async function runWorkflow(options: WorkflowRunOptions): Promise<unknown> {
    const source = workflowSource(options.script), analysis = inspectWorkflow(options.script)
    if (!analysis.ok) throw new Error(analysis.diagnostics.map(diagnostic => `${diagnostic.line}:${diagnostic.column} ${diagnostic.message}`).join('\n'))
    const program = createWorkflowProgram(source), table = collectSites(program), schemas = synthesizeAskSchemas(program, table)
    if (schemas.diagnostics.length) throw new Error(schemas.diagnostics.map(value => value.message).join('\n'))
    const lowered = lowerWorkflow(program, table)
    const sessions = new Map<string, PersonaSpec>(), controllers = new Map<string, AbortController>(), pending = new Set<Promise<void>>()
    const verdicts = new Map<string, Parameters<WorkflowDriver['respondToSubmit']>[1]>()
    const journal = options.journal ?? new InMemoryJournalStore(), runId = options.runId ?? randomUUID()
    const instancePhases = new Map<string, string>()
    for (const stored of journal.listEvents(runId, { types: 'all', reportItems: 'all' })) {
        if ('instance' in stored.event && 'phaseName' in stored.event && stored.event.phaseName) instancePhases.set(stored.event.instance.siteId + '@' + stored.event.instance.ordinal, stored.event.phaseName)
    }
    const result = await runWorkflowScript({ lowered: lowered.code, scriptText: source, scriptHash: createHash('sha256').update(source).digest('hex'), args: options.args, cwd: options.cwd ?? tmpdir(), runId, caps: { maxConcurrency: 8 },
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
                    options.emit?.(event)
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
