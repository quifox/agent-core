import { createRoot } from 'react-dom/client'
import type { EngineFrame, RuntimeEvent, RuntimeSnapshot, SessionView, WorkflowDocument, WorkflowDeployment } from '@quifox/shared-runtime'
import { defaultShortcuts } from '@quifox/shared-runtime/preferences'
import { DesktopEngine } from '../src/engine.js'
import { App } from '../src/app.js'
import '../src/tokens.css'
import '../src/styles.css'
import '../src/workspace.css'

// Synthetic protocol fixture: production App and Engine, without native I/O or model requests.
const config: RuntimeSnapshot['config'] = { version: 1, workspace: '/synthetic/project',
    model: { provider: 'synthetic', model: 'test-chat', baseUrl: 'https://synthetic.invalid', maxOutputTokens: 16384, contextWindow: 100000, hasApiKey: true, providerOptions: undefined },
    models: [], preferences: { theme: 'dark', fontSize: 18, uiScale: 1, inputMode: 'queue', shortcuts: defaultShortcuts },
    installedPlugins: ['observability', 'skills'], plugins: {}, trustedProjects: [], compaction: { safetyTokens: 10240 },
    memory: { enabled: false, generate: false, extractionFormat: 'text' }, skills: { disabled: [] }, approval: 'allow', mcp: [] }
const session: SessionView = { id: 'session', title: '界面验收', workspace: '/synthetic/project', status: 'idle', resumeAvailable: false,
    updatedAt: '2026-10-13T00:00:00Z', messages: [], events: [], pendingMessages: [], approvals: [], toolStates: [], backgroundTasks: [],
    guidance: [], skills: { skills: [], issues: [] }, memory: { enabled: false, processing: false, content: '', summaries: 0 } }
const snapshot: RuntimeSnapshot = { configurationRevision: 'synthetic', config, sessions: [session] }
let workflowDocument: WorkflowDocument | undefined, workflowSession: SessionView | undefined
let workflowDeployment: WorkflowDeployment | undefined
let receive: (frame: EngineFrame) => void, sequence = 0, holding = false
const held: string[] = []
function event(type: string, data: unknown) {
    session.eventSequence = ++sequence
    receive({ kind: 'event', event: { version: 1, sessionId: session.id, sequence, timestamp: new Date().toISOString(), type, data } })
}
const engine = new DesktopEngine({ start: async callback => { receive = callback; callback({ kind: 'ready', protocol: 1 }) },
    write: async ({ id, command }) => {
        let value: unknown = { accepted: true }
        if (command.type === 'snapshot') {
            if (command.sessionId && holding) { held.push(id); return }
            value = command.sessionId ? command.sessionId === workflowSession?.id ? workflowSession : session : snapshot
        } else if (command.type === 'create') {
            if (command.workflow) {
                workflowSession = { ...structuredClone(session), id: 'workflow-session', title: command.workflow.name, workflowName: command.workflow.name,
                    messages: [], workflow: { name: command.workflow.name, graph: workflowDocument!.inspection.graph } }
                snapshot.sessions = [session, workflowSession]; value = workflowSession
            } else value = session
        }
        else if (command.type === 'workflows') {
            if (command.action === 'list') value = workflowDocument ? [{ name: workflowDocument.name }] : []
            else if (command.action === 'templates') value = []
            else if (command.action === 'inspect') value = workflowDocument?.inspection
            else if (command.action === 'read' || command.action === 'save') value = workflowDocument
            else if (command.action === 'deploy') value = workflowDeployment ??= { id: 'b'.repeat(64), name: command.name!, workspace: command.workspace ?? session.workspace, url: 'http://127.0.0.1:12345', token: 'synthetic-token' }
            else if (command.action === 'deployments') value = workflowDeployment ? [{ ...workflowDeployment, token: undefined }] : []
            else if (command.action === 'undeploy') { workflowDeployment = undefined }
        }
        else if (command.type === 'config') {
            const preferences = (command.patch as { preferences?: Partial<typeof config.preferences> }).preferences
            Object.assign(config.preferences, preferences); snapshot.configurationRevision = `synthetic-${++sequence}`; value = config
        } else if (command.type === 'resources') value = { workspace: command.workspace, config, skillsEnabled: true,
            skills: session.skills, agents: { agents: [], issues: [] }, guidance: [], configSources: [], memory: session.memory }
        else if (command.type === 'plugins') value = { scope: 'configuration', plugins: [], marketplace: [], installed: [
            { id: 'observability', name: '运行观察', description: '查看会话执行轨迹、上下文和指标', enabled: true, globalEnabled: true, source: 'builtin', surface: { kind: 'observability', title: '运行观察' } },
            { id: 'skills', name: '技能', description: '管理可用技能', enabled: true, globalEnabled: true, source: 'builtin' } ] }
        else if (command.type === 'submit') {
            if (command.sessionId === workflowSession?.id) {
                workflowSession.messages.push({ id: crypto.randomUUID(), origin: 'human', message: { role: 'user', content: command.prompt } },
                    { id: crypto.randomUUID(), origin: 'assistant', message: { role: 'assistant', content: '**有来源的测试回答**' } })
            } else session.pendingMessages.push({ id: command.messageId ?? crypto.randomUUID(), prompt: command.prompt, mode: 'queue', status: 'pending' })
        } else if (command.type === 'inbox') {
            const index = session.pendingMessages.findIndex(message => message.id === command.messageId)
            if (command.action === 'cancel') session.pendingMessages.splice(index, 1)
            else for (const item of session.pendingMessages.slice(0, index + 1)) item.mode = 'steer'
        } else if (command.type === 'stop') { session.status = 'stopped'; session.resumeAvailable = true }
        else if (command.type === 'resume') { session.status = 'running'; session.resumeAvailable = false }
        else if (command.type === 'mcp') value = []
        else if (command.type === 'memory-file') value = { path: '/synthetic/project/memory.md', content: '', exists: false }
        else if (command.type === 'model-catalog') value = { providers: [], models: [], source: 'synthetic', cached: true }
        else if (command.type === 'observability') value = { totalRuns: 1, runs: [{ runId: 'run-one', sourceId: session.id, status: 'success', startedAtMs: 0,
            durationMs: 8000, modelCalls: 1, toolCalls: 24, toolErrors: 0, modelDurationMs: 100, toolDurationMs: 7000, usage: {}, errors: [], evaluations: [] }], comparison: [], recoveries: [] }
        receive({ kind: 'response', id, ok: true, value: structuredClone(value) })
    } })
const fixture = {
    workflowState() {
        if (!workflowSession || !workflowDocument) throw new Error('Select a workflow first.')
        workflowSession.status = 'running'
        const nodes = workflowDocument.inspection.graph.nodes
        workflowSession.events = nodes.slice(0, 3).flatMap((node, index) => {
            const birth = { type: 'call-started', definitionId: node.id, callId: 'call:' + index, executionId: 'fixture', ...index ? { parentCallId: 'call:0' } : {} }
            return (index === 1 ? [birth, { ...birth, type: 'call-settled', outcome: 'ok' }] : [birth]).map(data => ({ version: 1 as const, sessionId: workflowSession!.id, runId: 'workflow-run', sequence: ++sequence, timestamp: new Date().toISOString(), type: 'workflow', data }))
        })
        for (const event of workflowSession.events) receive({ kind: 'event', event })
    },
    workflow(document: WorkflowDocument, inline = false) {
        workflowDocument = document; config.installedPlugins.push('workflows'); snapshot.configurationRevision = 'workflow'
        if (inline) session.messages = [{ id: 'workflow-code', origin: 'assistant', message: { role: 'assistant', content: '\u0060\u0060\u0060dynamic-workflow\n' + document.script + '\n\u0060\u0060\u0060' } }]
        event('configuration', {})
    },
    running() { session.status = 'running'; event('session', {}) },
    stream() { holding = true; event('agent', { type: 'text-delta', delta: '流式回复持续可见' }); event('agent', { type: 'model-end' }) },
    commit() {
        session.messages = [{ id: 'reply', origin: 'assistant', message: { role: 'assistant', content: '流式回复持续可见', reasoning: '先思考再回复' } }]
        session.eventSequence = sequence; session.liveText = ''; holding = false
        for (const id of held.splice(0)) receive({ kind: 'response', id, ok: true, value: structuredClone(session) })
        event('session', {})
    },
    approval() { session.approvals = [{ id: 'approval', sessionId: session.id, operationId: 'operation', call: { id: 'call', name: 'run_command', input: { command: 'printf "hello"' } } }]; event('session', {}) },
    trace() {
        session.events = Array.from({ length: 24 }, (_, index): RuntimeEvent => ({ version: 1, sessionId: session.id, sequence: index + 1,
            runId: 'run-one', timestamp: new Date(index * 200).toISOString(), type: 'agent', data: { type: 'tool-start', call: { id: `c${index}`, name: 'run_command', input: { command: `printf '步骤 ${index + 1}\\n'` } } } }))
        event('session', {})
    }
}
declare global { interface Window { uiFixture: typeof fixture } }
window.uiFixture = fixture
createRoot(document.getElementById('root')!).render(<App engine={engine}/>)
