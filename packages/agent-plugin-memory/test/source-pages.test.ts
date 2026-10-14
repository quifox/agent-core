import { expect, it } from 'vitest'
import { memoryToolText, sourceReadPage, MemoryInputError } from '../src/service.js'
import { utf8Bytes } from '../src/evidence.js'
import type { SourceRead } from '../src/contracts.js'

it('pages large physical lines without breaking JSON, Unicode or continuation coordinates', () => {
    const lines = ['first line', JSON.stringify({ content: '狐狸🦊\0'.repeat(20_000) }), 'last line']
    let line = 1, offset = 0, iterations = 0
    const rebuilt = ['', '', '']
    while (line <= lines.length) {
        const input: SourceRead = { ref: 'source', startLine: line, lines: lines.slice(line - 1), truncated: false }
        const page = sourceReadPage(input, offset), encoded = memoryToolText(page)
        expect(utf8Bytes(encoded)).toBeLessThanOrEqual(12_000)
        expect(JSON.parse(encoded)).toEqual(page)
        page.lines.forEach((fragment, index) => { rebuilt[line - 1 + index] += fragment })
        if (!page.truncated) break
        expect(page.nextLine).toBeDefined(); expect(page.nextOffset).toBeDefined()
        expect(page.nextLine! > line || page.nextOffset! > offset).toBe(true)
        line = page.nextLine!; offset = page.nextOffset!; iterations += 1
        expect(iterations).toBeLessThan(200)
    }
    expect(iterations).toBeGreaterThan(1); expect(rebuilt).toEqual(lines)
})

it('rejects invalid fragment positions and preserves parseable JSON previews for other oversized receipts', () => {
    expect(() => sourceReadPage({ ref: 'source', startLine: 1, lines: ['🦊'], truncated: false }, 1)).toThrow(MemoryInputError)
    expect(() => sourceReadPage({ ref: 'source', startLine: 1, lines: ['x'], truncated: false }, 2)).toThrow(MemoryInputError)
    const oversized = Array.from({ length: 200 }, () => ({ path: 'summary.md', content: '\0'.repeat(20_000), children: Array.from({ length: 20 }, () => ({ content: 'x'.repeat(20_000) })) }))
    const encoded = memoryToolText(oversized)
    expect(utf8Bytes(encoded)).toBeLessThanOrEqual(16_000); expect(JSON.parse(encoded)).toMatchObject({ truncated: true })
})
