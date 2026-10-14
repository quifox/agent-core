import { expect, it } from 'vitest'
import { render } from 'ink-testing-library'
import { stripVTControlCharacters } from 'node:util'
import { TerminalMessage } from '../src/transcript.js'

it('renders assistant Markdown with structure instead of role labels and markup', async () => {
    const app = render(<TerminalMessage width={40} entry={{ id: 'answer', origin: 'context', message: { role: 'assistant', content: '# 标题\n\n**重点**与 `code`\n\n- 列表项\n\n```js\nconst value = 1;\n```' } }}/>)
    try {
        await expect.poll(() => app.lastFrame()).toContain('列表项')
        const text = stripVTControlCharacters(app.lastFrame() ?? '')
        expect(text).toContain('标题'); expect(text).toContain('重点'); expect(text).toContain('const value = 1;')
        expect(text).not.toContain('assistant'); expect(text).not.toContain('**'); expect(text).not.toContain('```')
    } finally { app.unmount() }
})
