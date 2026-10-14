import { expect, it } from 'vitest'
import { WorkflowApi } from '../src/workflow-api.js'
import type { RuntimeCommand } from '../src/protocol.js'

it('does not submit a run whose Session creation completes after API shutdown', async () => {
    let started!: () => void, release!: () => void, stopped!: () => void
    const creating = new Promise<void>(resolve => { started = resolve }), held = new Promise<void>(resolve => { release = resolve }), cancelled = new Promise<void>(resolve => { stopped = resolve })
    const commands: RuntimeCommand[] = []
    const api = new WorkflowApi(async command => {
        commands.push(command)
        if (command.type === 'create') { started(); await held; return { id: 'session' } }
        if (command.type === 'stop') stopped()
        return { accepted: true }
    }, { name: 'test', script: 'return "answer";' }, '/synthetic/project')
    try {
        const deployment = await api.start()
        const request = fetch(deployment.url + '/runs', { method: 'POST', headers: { Authorization: 'Bearer ' + deployment.token }, body: JSON.stringify({ question: 'question' }) }).catch(() => undefined)
        await creating; await api.close(); release(); await cancelled; await request
        expect(commands.map(command => command.type)).toEqual(['create', 'stop'])
    } finally { release(); await api.close() }
})
