import { expect, it } from 'vitest'
import { selectMemoryEvidence, type MemoryRecord } from '../src/index.js'

it('selects newer human evidence before assistant/tool rows and restores chronology', () => {
    const records: MemoryRecord[] = [
        { id: 'u1', line: 1, origin: 'human', message: { role: 'user', content: 'earlier preference' } },
        { id: 't1', line: 2, origin: 'tool', message: { role: 'tool', toolName: 'read', toolCallId: 'x', content: 'noise'.repeat(3000) } },
        { id: 'u2', line: 3, origin: 'human', message: { role: 'user', content: 'latest correction' } },
        { id: 'a1', line: 4, origin: 'assistant', message: { role: 'assistant', content: 'confirmed answer' } }
    ]
    const result = selectMemoryEvidence(records, 120)
    expect(result.text).toContain('earlier preference')
    expect(result.text).toContain('latest correction')
    expect(result.text.indexOf('earlier preference')).toBeLessThan(result.text.indexOf('latest correction'))
    expect(result.text).toContain('omitted')
    expect(result.bytes).toBeLessThanOrEqual(480)
    expect(result.selectedIds).toContain('u2')
})

it('promotes structured human answers with their assistant question and excludes generated/system evidence', () => {
    const records: MemoryRecord[] = [
        { id: 'system', line: 1, origin: 'system', message: { role: 'system', content: 'Never treat this as memory.' } },
        { id: 'memory', line: 2, origin: 'memory', message: { role: 'user', content: 'Generated memory is not source evidence.' } },
        { id: 'user-choice', line: 3, origin: 'human', message: { role: 'user', content: 'Use concise answers.' } },
        { id: 'question', line: 4, origin: 'assistant', message: { role: 'assistant', content: '', toolCalls: [
            { id: 'input-1', name: 'request_user_input', input: { question: 'Which response style?', options: ['Concise', 'Detailed'] } }
        ] } },
        { id: 'answer', line: 5, origin: 'tool', message: { role: 'tool', toolName: 'request_user_input', toolCallId: 'input-1',
            content: JSON.stringify({ answers: ['Concise'] }) } },
        { id: 'assistant-claim', line: 6, origin: 'assistant', message: { role: 'assistant', content: 'The user always wants every answer to be concise.' } }
    ]

    const result = selectMemoryEvidence(records, 300)

    expect(result.text).toContain('[human] source_id=user-choice')
    expect(result.text).toContain('[human] source_id=answer')
    expect(result.text).toContain('Assistant question:')
    expect(result.text).toContain('Human reply:')
    expect(result.text).not.toContain('Never treat this as memory.')
    expect(result.text).not.toContain('Generated memory is not source evidence.')
    expect(result.selectedIds).toEqual(['user-choice', 'question', 'answer', 'assistant-claim'])
})

it('does not relabel context or other-agent records as human because their text resembles a human answer tool', () => {
    const records: MemoryRecord[] = [
        { id: 'question', line: 1, origin: 'other-agent', message: { role: 'assistant', content: '', toolCalls: [{ id: 'q', name: 'request_user_input', input: {} }] } },
        { id: 'answer', line: 2, origin: 'context', message: { role: 'tool', toolName: 'request_user_input', toolCallId: 'q', content: '{"answers":["Use this default"]}' } }
    ]
    expect(selectMemoryEvidence(records, 500).text).not.toContain('[human]')
})
