import { expect, it } from 'vitest'
import { chatModelOptions } from '../../../test/support/chat-model.mjs'
import { MemoryProcessor, emptyMemoryState, type MemoryStore, type ConversationArchive, type MemoryExtractionFormat } from '../src/index.js'

function harness(format?: MemoryExtractionFormat, extractionReply = '{"description":"Preference","summary":"A conditional preference."}') {
    let state = emptyMemoryState(); const bodies: Record<string, unknown>[] = []
    const source = { id: 'a', ownerId: 'u', shortId: 'a', title: 'A', createdAt: '2026-10-01T00:00:00Z', updatedAt: '2026-10-02T00:00:00Z',
        sourceRef: 'source-a', revision: 1, active: false, generateMemory: true }
    const store: MemoryStore = { async load() { return structuredClone(state) }, async compareAndSet(_owner, revision, next) {
        if (revision !== state.revision) { return false }; state = structuredClone(next); return true
    } }
    const archive: ConversationArchive = { async list() { return [source] }, async records() {
        return [{ id: 'm1', line: 1, origin: 'human', message: { role: 'user', content: 'An explicit conditional preference.' } }]
    }, async read() { throw new Error('unused') }, async search() { return [] }, async send() { throw new Error('unused') } }
    const model = chatModelOptions({ provider: 'test', modelId: 'test', async *stream(request) {
        if (!request.tools.length) {
            if (extractionReply === 'fail') { throw new Error('Unsupported extraction format.') }
            yield { type: 'text-delta', delta: extractionReply }
            yield { type: 'finish', reason: 'stop' }
        } else if (!request.messages.some(message => message.role === 'tool')) {
            yield { type: 'tool-call', call: { id: 'publish', name: 'memory_publish', input: {
                content: '## User Profile\n\n## User preferences\n\n## General Tips\n'
            } } }
            yield { type: 'finish', reason: 'tool-calls' }
        } else { yield { type: 'finish', reason: 'stop' } }
    } })
    const transport = model.transport!
    const processor = new MemoryProcessor({ store, archive, newId: () => 'job', now: () => Date.parse('2026-10-03T00:00:00Z'),
        ...(format === undefined ? {} : { extractionFormat: format }),
        model: { ...model, transport: { async stream(request) {
            bodies.push(JSON.parse(request.body!)); return transport.stream(request)
        } }, settings: { providerOptions: { custom_option: true, response_format: { type: 'inherited' } } } } })
    return { processor, bodies }
}

it('sends a strict extraction schema through Chat while leaving consolidation requests unconstrained', async () => {
    const { processor, bodies } = harness()
    expect(await processor.run('u')).toMatchObject({ extracted: 1, consolidated: true, errors: [] })
    expect(bodies[0]?.response_format).toMatchObject({ type: 'json_schema', json_schema: { strict: true, schema: {
        type: 'object', required: ['description', 'summary'], additionalProperties: false,
        properties: { description: { type: 'string' }, summary: { type: 'string' } }
    } } })
    expect(bodies.slice(1).every(body => body.response_format === undefined)).toBe(true)
    expect(bodies.every(body => body.custom_option === true)).toBe(true)
})

it.each(['json-object', 'text'] as const)('honors the explicit %s extraction capability', async format => {
    const { processor, bodies } = harness(format)
    expect(await processor.run('u')).toMatchObject({ extracted: 1, consolidated: true, errors: [] })
    expect(bodies[0]?.response_format).toEqual(format === 'json-object' ? { type: 'json_object' } : undefined)
    expect(bodies.slice(1).every(body => body.response_format === undefined)).toBe(true)
})

it.each(['json-schema', 'json-object', 'text'] as const)('keeps response validation in %s mode', async format => {
    const { processor } = harness(format, '{"description":"Preference","summary":"A conditional preference.","extra":"rejected"}')
    expect(await processor.run('u')).toMatchObject({ extracted: 0, errors: ['extraction_failed'] })
})

it('does not silently downgrade an unsupported schema request', async () => {
    const { processor, bodies } = harness(undefined, 'fail')
    expect(await processor.run('u')).toMatchObject({ extracted: 0, errors: ['extraction_failed'] })
    const extractions = bodies.filter(body => body.tool_choice === 'none')
    expect(extractions).toHaveLength(1)
    expect(extractions[0]?.response_format).toMatchObject({ type: 'json_schema' })
})
