import { expect, it } from 'vitest'
import { createAgent } from '@quifox/agent-core'
import { WorkflowModelPlugin } from '../src/index.js'

it('executes a workflow as the model capability and returns its actual output', async () => {
    const seen: unknown[] = []
    const plugin = new WorkflowModelPlugin({ execute: async input => { seen.push(input); return 'workflow answer' }, input: () => ({ question: 'retrieve knowledge', messages: [] }) })
    const outcome = await createAgent({ plugins: [plugin] }).run({ prompt: 'retrieve knowledge' })
    expect(outcome.ok).toBe(true)
    if (!outcome.ok) throw outcome.error
    expect(seen).toEqual([{ question: 'retrieve knowledge', messages: [] }])
    expect(outcome.value).toMatchObject({ text: 'workflow answer', toolCalls: [], finishReason: 'stop' })
})
