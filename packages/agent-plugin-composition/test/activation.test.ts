import { expect, it, vi } from 'vitest'
import { createAgent, type AgentPlugin } from '@quifox/agent-core'
import { PluginActivationPlugin } from '../src/index.js'

it('excludes a disabled candidate before registration and initialization while retaining enabled object identity and order', async () => {
    const registered = vi.fn(), initialized = vi.fn()
    const disabled = { id: 'disabled', enabled: false, hooks: { onRegister: registered, onInitialize: initialized } }
    const stop: AgentPlugin = { id: 'stop', hooks: { onRunStart: async () => ({ action: 'stop', value: 'done' }) } }
    const activation = new PluginActivationPlugin()
    const selected = activation.select([activation, disabled, stop])
    expect(selected).toEqual([stop]); expect(selected[0]).toBe(stop)
    expect((await createAgent({ plugins: [activation, disabled, stop] }).run(undefined)).ok).toBe(true)
    expect(registered).not.toHaveBeenCalled(); expect(initialized).not.toHaveBeenCalled()
})
