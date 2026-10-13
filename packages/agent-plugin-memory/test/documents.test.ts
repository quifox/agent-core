import { expect, it } from 'vitest'
import { renderGlobalMemory, validateGlobalMemory, utf8Bytes, type ConversationMemory } from '../src/index.js'

it('renders exact relative navigation from metadata without model-authored pointers', () => {
    const source: ConversationMemory = { conversationId: 'a', path: 'conversations/2026-10-01T00-00-00Z-a.md', title: 'Study defaults',
        description: 'Read for the study duration and Sunday exception.', summary: 'Useful summary.', sourceRef: 'source-a',
        sourceUpdatedAt: '2026-10-02T00:00:00Z', sourceRevision: 1, generatedAt: '2026-10-02T01:00:00Z', usageCount: 0 }
    const draft = '## User Profile\n\n## User preferences\nDefault study duration: 25 minutes.\n\n## General Tips\n'
    const rendered = renderGlobalMemory(draft, [source])
    expect(rendered).toContain(`- ${source.path} — Study defaults: Read for the study duration and Sunday exception.`)
    expect(rendered.startsWith('v1\n')).toBe(true)
    expect(utf8Bytes(rendered)).toBeLessThan(10_000)
    expect(validateGlobalMemory(rendered, [source])).toBe(rendered)
    expect(() => validateGlobalMemory(rendered + '\n[bad](conversations/nested/absent.md)', [source])).toThrow()
    expect(() => validateGlobalMemory(rendered + `\n[bad](/private/${source.path})`, [source])).toThrow()
    expect(renderGlobalMemory(draft, [{ ...source, title: '检查 conversations/topic.md 的解析', description: '讨论 [文本](conversations/example.md)，不是记忆引用。' }])).toContain(source.path)
    expect(renderGlobalMemory(draft, [{ ...source, title: '说明 [memory:example] 引用格式' }])).toContain(source.path)
})
