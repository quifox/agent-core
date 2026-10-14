import { expect, it } from 'vitest'
import { inspectWorkflow, runWorkflow } from '../src/workflow.js'
import { synthetic } from './synthetic.js'
import type { SessionView } from '../src/protocol.js'
import { readdir, readFile } from 'node:fs/promises'
import { join } from 'node:path'
import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { workflowJournal } from '../src/workflow-journal.js'
import { request as httpRequest } from 'node:http'

it('lowers shorthand input properties and preserves locally shadowed input names', async () => {
    expect(await runWorkflow({ script: 'return { args };', args: { question: 'input' }, ask: async () => 'unused' })).toEqual({ args: { question: 'input' } })
    expect(await runWorkflow({ script: 'const args = "local"; return { args };', args: { question: 'input' }, ask: async () => 'unused' })).toEqual({ args: 'local' })
})

it('shows annotated function calls rather than inventing an execution-order graph', () => {
    const inspection = inspectWorkflow('/** @node Route */\nasync function route(){ if(args.question) return await search(); return "empty"; }\n/** @node Search */\nasync function search(){ return await agent("Search").ask("query"); }\nreturn await route();')
    expect(inspection.ok).toBe(true)
    const route = inspection.graph.nodes.find(node => node.label === 'Route')!
    const search = inspection.graph.nodes.find(node => node.label === 'Search')!
    expect(route).toBeDefined()
    expect(search).toBeDefined()
    expect(inspection.graph.edges).toEqual(expect.arrayContaining([
        expect.objectContaining({ from: 'entry', to: route.id }),
        expect.objectContaining({ from: route.id, to: search.id, kind: 'conditional' })
    ]))
    expect(inspection.graph.edges.some(edge => edge.from === search.id && edge.to === route.id)).toBe(false)
})

it('keeps conditional calls separate from execution order and includes synchronous nodes', () => {
    const script = '/** @phase First */\nasync function first(){ return await agent("First").ask("question"); }\n/** @phase Second */\nasync function second(){ return await agent("Second").ask("question"); }\nconst value = await first(); if(value === "skip") return "skipped"; return await second();'
    const graph = inspectWorkflow(script).graph, first = graph.nodes.find(node => node.label === 'First')!
    const starts = graph.edges.filter(edge => edge.from === 'entry')
    expect(starts).toHaveLength(2)
    expect(starts.some(edge => edge.to === first.id)).toBe(true)
    expect(graph.edges.some(edge => edge.from === first.id)).toBe(false)
})

it('tracks nested parallel and repeated calls with independent parent instances', async () => {
    const script = '/** @node Parent */\nasync function parent(){return await Promise.all([child("a"), child("b")]);}\n/** @node Child */\nasync function child(value:string){return await agent(value).ask(value);}\nreturn await parent();'
    const events: unknown[] = []
    expect(await runWorkflow({ script, args: {}, emit: event => { events.push(event) }, ask: async (_persona, message) => message.instructions })).toEqual(['a', 'b'])
    const calls = events.filter((event): event is {type:string; callId:string; parentCallId?:string; definitionId:string} => typeof event === 'object' && event !== null && 'type' in event && event.type === 'call-started')
    const graph = inspectWorkflow(script).graph, parent = graph.nodes.find(node => node.label === 'Parent')!, child = graph.nodes.find(node => node.label === 'Child')!
    const children = calls.filter(call => call.definitionId === child.id), parentCall = calls.find(call => call.definitionId === parent.id)!
    expect(children).toHaveLength(2)
    expect(new Set(children.map(call => call.callId)).size).toBe(2)
    expect(children.every(call => call.parentCallId === parentCall.callId)).toBe(true)
    expect(events.filter(event => typeof event === 'object' && event !== null && 'type' in event && event.type === 'call-settled')).toHaveLength(4)
})

it('preserves each parallel parent after await and traces its synchronous child', async () => {
    const script = '/** @node Parent */\nasync function parent(name:string){const value=await agent(name).ask(name);return leaf(value);}\n/** @node Leaf */\nfunction leaf(value:string){return value.toUpperCase();}\nreturn await Promise.all(["a","b"].map(parent));'
    const events: { type?: string; callId?: string; parentCallId?: string; definitionId?: string }[] = []
    expect(await runWorkflow({ script, args: {}, emit: event => { events.push(event) }, ask: async (_persona, message) => message.instructions })).toEqual(['A', 'B'])
    const graph = inspectWorkflow(script).graph, parent = graph.nodes.find(node => node.label === 'Parent')!, leaf = graph.nodes.find(node => node.label === 'Leaf')!
    expect(graph.edges).toContainEqual({ from: 'entry', to: parent.id, kind: 'callback' })
    const parents = events.filter(event => event.type === 'call-started' && event.definitionId === parent.id)
    const leaves = events.filter(event => event.type === 'call-started' && event.definitionId === leaf.id)
    expect(new Set(leaves.map(event => event.parentCallId))).toEqual(new Set(parents.map(event => event.callId)))
})

it('keeps method receivers, arguments and synchronous promise identity intact', async () => {
    const script = '/** @node Identity */\nfunction identity(p:Promise<string>){return p;}\nconst object={value:4,\n/** @node Value */\nread(delta:number){return this.value+delta+arguments[0];}};\nconst p=Promise.resolve("same"); if(identity(p)!==p) throw new Error("identity changed"); return {value:object.read(3), result:await p};'
    expect(await runWorkflow({ script, args: {}, ask: async () => 'unused' })).toEqual({ value: 10, result: 'same' })
    expect(inspectWorkflow('/** @node */\nfunction named(){return "done";} return named();').ok).toBe(true)
    expect(inspectWorkflow('function unlabelled(){return "done";} return unlabelled();').ok).toBe(false)
})

it('does not choose a static target for dynamic dispatch and observes the actual target', async () => {
    const script = '/** @node A */\nfunction a(){return "a";}\n/** @node B */\nfunction b(){return "b";}\nconst targets=[a,b]; return targets[Number(args.index)]!();'
    const graph = inspectWorkflow(script).graph
    expect(graph.edges).toEqual([])
    const calls: string[] = []
    expect(await runWorkflow({ script, args: { index: 1 }, ask: async () => 'unused', emit: event => { if (event.type === 'call-started') calls.push(event.definitionId) } })).toBe('b')
    expect(calls).toEqual(['entry', graph.nodes.find(node => node.label === 'B')!.id])
})

it('derives a method-labelled branch graph and runs only the selected path with the supplied input', async () => {
    const script = `
/** @phase 意图识别 */
async function identify() {
    if (args.question === "known") return "rule";
    return await agent("识别").ask<string>(String(args.question));
}
/** @phase 回答 */
async function answer(intent: string) { return await agent("回答").ask<string>(intent); }
return await answer(await identify());`
    const inspected = inspectWorkflow(script)
    expect(inspected.ok).toBe(true)
    expect(inspected.graph.nodes.map(node => node.label)).toEqual(expect.arrayContaining(['意图识别', '回答']))
    const calls: string[] = []
    const value = await runWorkflow({ script, args: { question: 'known' }, ask: async (_persona, input) => { calls.push(input.instructions); return 'answer:' + input.instructions } })
    expect(value).toBe('answer:rule')
    expect(calls).toEqual(['rule'])
})

it('saves and reloads scripts, uses real Host Agents and keeps only outer I/O across workflow turns', async () => {
    const fixture = await synthetic(() => ({ text: '**evidence-based answer**' }))
    const script = '/** @phase Retrieval */\nasync function retrieve(){ return await agent("Research", {plugins:["ragflow"]}).ask<string>(JSON.stringify(args)); }\nreturn await retrieve();'
    try {
        await fixture.runtime.command({ type: 'workflows', action: 'save', name: 'knowledge', script })
        expect(await fixture.runtime.command({ type: 'workflows', action: 'list' })).toEqual([{ name: 'knowledge' }])
        const session = await fixture.runtime.command({ type: 'create', workflow: { name: 'knowledge', script } }) as SessionView
        await fixture.runtime.command({ type: 'submit', sessionId: session.id, prompt: 'first question' }); await fixture.runtime.waitForIdle(session.id)
        const first = await fixture.runtime.command({ type: 'snapshot', sessionId: session.id }) as SessionView
        const logs = first.status === 'error' ? await readdir(join(fixture.root, 'logs')).then(files => Promise.all(files.map(file => readFile(join(fixture.root, 'logs', file), 'utf8')))).catch(() => []) : []
        if (logs.length) throw new Error(logs.join('\n'))
        expect(first.status).toBe('idle')
        expect(first.messages.map(message => message.message.content)).toEqual(['first question', '**evidence-based answer**'])
        expect(fixture.requests).toHaveLength(1)
        expect(fixture.requests[0]!.messages.at(-1)!.content).toContain('first question')
        expect(JSON.stringify(fixture.requests[0]!.messages)).not.toContain('taskId is undefined')
        expect(fixture.requests[0]!.tools.map(tool => tool.function.name)).toContain('knowledge_retrieve')
        expect(fixture.requests[0]!.tools.map(tool => tool.function.name)).not.toContain('workflow_run')
        await fixture.runtime.command({ type: 'submit', sessionId: session.id, prompt: 'follow-up' }); await fixture.runtime.waitForIdle(session.id)
        expect(fixture.requests).toHaveLength(2)
        expect(fixture.requests[1]!.messages.filter(message => message.role === 'user')).toHaveLength(1)
        expect(fixture.requests[1]!.messages.at(-1)!.content).toContain('evidence-based answer')
        expect(await readdir(join(fixture.root, 'workflow-runs'))).toHaveLength(1)
        expect((await readdir(join(fixture.root, '.quifox', 'workflow-runs'))).filter(file => file.endsWith('.mjs'))).toHaveLength(1)
        const view = await fixture.runtime.command({ type: 'snapshot', sessionId: session.id }) as SessionView
        expect(view.events.some(event => event.type === 'workflow')).toBe(true)
        await fixture.restart()
        const restored = await fixture.runtime.command({ type: 'snapshot', sessionId: session.id }) as SessionView
        expect(restored.workflow?.name).toBe('knowledge')
        expect(restored.messages).toEqual(view.messages)
        await expect(fixture.runtime.command({ type: 'workflows', action: 'read', name: '../escape' })).rejects.toThrow()
    } finally { await fixture.close() }
}, 15000)

it('repairs typed results in the same actor context before returning a validated value', async () => {
    const calls: string[] = []
    const value = await runWorkflow({ script: 'interface Intent { query: string }\nreturn await agent("Intent").ask<Intent>("Rewrite the question");', args: {},
        ask: async (_persona, input) => { calls.push(input.instructions); return calls.length === 1 ? { wrong: true } : { query: 'retrieval query' } } })
    expect(value).toEqual({ query: 'retrieval query' })
    expect(calls).toHaveLength(2)
    expect(calls[1]).toContain('failed validation')
})

it('restores a durable run and replays completed nodes without issuing their asks again', async () => {
    const root = await mkdtemp(join(tmpdir(), 'workflow-recovery-')), path = join(root, 'checkpoint.json'), identity = 'a'.repeat(64)
    const script = 'const a = agent("First"); const first = await a.ask("first"); return await agent("Second").ask("second:" + first);'
    const controller = new AbortController(), calls: string[] = []
    try {
        await expect(runWorkflow({ script, args: {}, runId: identity, journal: workflowJournal(path, identity, value => value), signal: controller.signal,
            ask: async (_persona, message, signal) => {
                calls.push(message.instructions)
                if (message.instructions === 'first') return 'cached evidence'
                controller.abort()
                return await new Promise((_resolve, reject) => { if (signal.aborted) reject(new Error('interrupted')); else signal.addEventListener('abort', () => reject(new Error('interrupted')), { once: true }) })
            } })).rejects.toThrow('停止')
        const resumed: string[] = []
        const value = await runWorkflow({ script, args: {}, runId: identity, journal: workflowJournal(path, identity, value => value),
            ask: async (_persona, message) => { resumed.push(message.instructions); return 'final answer' } })
        expect(value).toBe('final answer')
        expect(calls).toEqual(['first', 'second:cached evidence'])
        expect(resumed).toEqual(['second:cached evidence'])
        await expect(runWorkflow({ script: script + '\nlog("changed");', args: {}, runId: identity, journal: workflowJournal(path, identity, value => value), ask: async () => 'wrong' })).rejects.toThrow('script changed')
    } finally { await rm(root, { recursive: true, force: true }) }
}, 15000)

it('discovers the plugin-bound Skill and serves authenticated workflow API turns', async () => {
    const fixture = await synthetic(() => ({ text: 'API answer' }))
    try {
        const session = await fixture.runtime.command({ type: 'create' }) as SessionView
        expect(session.skills.skills.map(skill => skill.name)).toContain('typescript-workflows')
        const templates = await fixture.runtime.command({ type: 'workflows', action: 'templates' }) as { name: string; inspection: { ok: boolean } }[]
        expect(templates.map(template => template.inspection.ok)).toEqual([true, true])
        const script = 'return await agent("Answer").ask(String(args.question));'
        await fixture.runtime.command({ type: 'workflows', action: 'save', name: 'api', script })
        const api = await fixture.runtime.command({ type: 'workflows', action: 'deploy', name: 'api' }) as { url: string; token: string }
        expect(await fixture.runtime.command({ type: 'workflows', action: 'deploy', name: 'api' })).toEqual(api)
        const deployments = await fixture.runtime.command({ type: 'workflows', action: 'deployments' }) as { id: string; name: string; url: string }[]
        expect(deployments).toEqual([expect.objectContaining({ name: 'api', url: api.url })])
        expect(JSON.stringify(deployments)).not.toContain(api.token)
        expect((await fetch(api.url + '/runs')).status).toBe(401)
        const response = await fetch(api.url + '/runs', { method: 'POST', headers: { Authorization: 'Bearer ' + api.token, 'Content-Type': 'application/json' }, body: JSON.stringify({ question: 'question' }) })
        expect(response.status).toBe(202)
        const { sessionId } = await response.json() as { sessionId: string }
        await fixture.runtime.waitForIdle(sessionId)
        const result = await fetch(api.url + '/runs/' + sessionId, { headers: { Authorization: 'Bearer ' + api.token } }).then(response => response.json()) as { output: string; status: string }
        expect(result).toMatchObject({ output: 'API answer', status: 'idle' })
        const other = await fetch(api.url + '/runs/' + session.id, { headers: { Authorization: 'Bearer ' + api.token } })
        expect(other.status).toBe(404)
        await fixture.runtime.command({ type: 'workflows', action: 'undeploy', deploymentId: deployments[0]!.id })
        expect(await fixture.runtime.command({ type: 'workflows', action: 'deployments' })).toEqual([])
        await expect(fetch(api.url + '/runs')).rejects.toThrow()
    } finally { await fixture.close() }
}, 15000)

it('stops a live internal model and resumes the original Host conversation without rerunning the completed stage', async () => {
    let entered!: () => void, release!: () => void
    const waiting = new Promise<void>(resolve => { entered = resolve }), held = new Promise<void>(resolve => { release = resolve })
    const fixture = await synthetic(async (_request, index) => {
        if (index === 2) { entered(); await held }
        return { text: index === 1 ? 'persisted evidence' : 'resumed answer' }
    })
    try {
        const script = 'const evidence = await agent("Evidence").ask("retrieve"); return await agent("Answer").ask("answer:" + evidence);'
        const session = await fixture.runtime.command({ type: 'create', workflow: { name: 'recovery', script } }) as SessionView
        await fixture.runtime.command({ type: 'submit', sessionId: session.id, prompt: 'question' })
        await waiting
        await fixture.runtime.command({ type: 'stop', sessionId: session.id })
        await fixture.runtime.waitForIdle(session.id)
        const stopped = await fixture.runtime.command({ type: 'snapshot', sessionId: session.id }) as SessionView
        expect(stopped.status).toBe('stopped')
        expect(stopped.resumeAvailable).toBe(true)
        release(); await fixture.restart()
        await fixture.runtime.command({ type: 'resume', sessionId: session.id, mode: 'replan' }); await fixture.runtime.waitForIdle(session.id)
        const resumed = await fixture.runtime.command({ type: 'snapshot', sessionId: session.id }) as SessionView
        const logs = resumed.status === 'error' ? await readdir(join(fixture.root, 'logs')).then(files => Promise.all(files.map(file => readFile(join(fixture.root, 'logs', file), 'utf8')))) : []
        if (logs.length) throw new Error(logs.join('\n'))
        expect(resumed.status).toBe('idle')
        expect(resumed.messages.at(-1)?.message.content).toBe('resumed answer')
        expect(fixture.requests).toHaveLength(3)
        expect(fixture.requests[2]!.messages.at(-1)!.content).toBe('answer:persisted evidence')
    } finally { release(); await fixture.close() }
}, 15000)

it('reuses a committed actor answer when its engine result commit was lost', async () => {
    const fixture = await synthetic(() => ({ text: 'committed actor answer' }))
    try {
        const script = 'return await agent("Answer").ask(String(args.question));', inputId = 'stable-workflow-turn'
        const session = await fixture.runtime.command({ type: 'create', workflow: { name: 'gap', script } }) as SessionView
        await fixture.runtime.command({ type: 'submit', sessionId: session.id, prompt: 'question', messageId: inputId }); await fixture.runtime.waitForIdle(session.id)
        const path = join(fixture.root, 'workflow-runs', (await readdir(join(fixture.root, 'workflow-runs')))[0]!)
        const records = (await readFile(path, 'utf8')).trim().split('\n').map(line => JSON.parse(line) as { operation: string; args: Record<string, unknown>[] })
        const completed = records.findIndex(record => record.operation === 'putNode' && record.args[0]?.status === 'completed')
        expect(completed).toBeGreaterThan(0)
        // Keep the durable actor Session but cut the engine WAL at the pre-result crash boundary.
        await writeFile(path, records.slice(0, completed).map(record => JSON.stringify(record)).join('\n') + '\n')
        await fixture.restart()
        const entry = fixture.runtime['entries'].get(session.id)!
        await fixture.runtime['leases'].claim(fixture.runtime['journal'].path(session.id))
        entry.pendingInputId = inputId
        const output = await fixture.runtime['executeWorkflow'](entry, script, records[0]!.args[0]!.args as Record<string, unknown>)
        expect(output).toBe('committed actor answer')
        expect(fixture.requests).toHaveLength(1)
    } finally { await fixture.close() }
}, 15000)

it('blocks old workflow execution after disabling the plugin and preserves split UTF-8 API input', async () => {
    const fixture = await synthetic(() => ({ text: 'answer' }))
    try {
        const script = 'return await agent("Answer").ask(String(args.question));'
        await fixture.runtime.command({ type: 'workflows', action: 'save', name: 'unicode', script })
        const api = await fixture.runtime.command({ type: 'workflows', action: 'deploy', name: 'unicode' }) as { url: string; token: string }
        const body = Buffer.from(JSON.stringify({ question: '中文知识问题' })), boundary = Buffer.from('{"question":"').length + 1
        const id = await new Promise<string>((resolve, reject) => {
            const request = httpRequest(api.url + '/runs', { method: 'POST', headers: { Authorization: 'Bearer ' + api.token, 'Content-Type': 'application/json' } }, response => {
                let body = ''; response.on('data', chunk => { body += String(chunk) }); response.on('end', () => { try { resolve((JSON.parse(body) as { sessionId: string }).sessionId) } catch (cause) { reject(cause) } })
            })
            request.on('error', reject); request.write(body.subarray(0, boundary)); setTimeout(() => request.end(body.subarray(boundary)), 30)
        })
        await fixture.runtime.waitForIdle(id)
        expect(fixture.requests[0]!.messages.at(-1)!.content).toBe('中文知识问题')
        await fixture.runtime.command({ type: 'plugin-set-enabled', pluginId: 'workflows', scope: 'global', enabled: false })
        await expect(fixture.runtime.command({ type: 'submit', sessionId: id, prompt: 'must not execute' })).rejects.toThrow('停用')
        expect(fixture.requests).toHaveLength(1)
    } finally { await fixture.close() }
}, 15000)
