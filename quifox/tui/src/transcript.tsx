import { memo } from 'react'
import { Box, Text } from 'ink'
import { MarkdownText } from '@assistant-ui/react-ink-markdown'
import { stripVTControlCharacters } from 'node:util'
import { toolSummary, type TranscriptMessage } from '@quifox/shared-runtime'
import { toolResultText } from './trace-text.js'

export const safeText = (value: string): string => stripVTControlCharacters(value).replace(/\p{Cc}/gu, value => ['\n', '\t'].includes(value) ? value : '')
export type Highlighter = (code: string, language?: string) => string
const theme = { heading: { color: 'cyan', bold: true }, strong: { bold: true }, inlineCode: { color: 'yellow' }, link: { color: 'cyan', underline: true },
    quote: { color: 'gray' }, listMarker: { color: 'cyan' }, tableHeader: { color: 'cyan', bold: true } } as const

export const TerminalMarkdown = memo(function TerminalMarkdown({ text, width, highlighter }: { text: string; width: number; highlighter?: Highlighter }) {
    const color = process.env.NO_COLOR === undefined
    return <MarkdownText text={safeText(text).slice(-12000)} width={Math.max(8, width)} color={color} theme={theme} codeWrap tableDense
        {...(color && highlighter ? { highlighter } : {})}/>
})

export const TerminalMessage = memo(function TerminalMessage({ entry, width, highlighter }: { entry: TranscriptMessage; width: number; highlighter?: Highlighter }) {
    const message = entry.message
    if (message.role === 'user') return <Box flexDirection="column" backgroundColor="white" paddingX={1} marginBottom={1}><Text color="black">{'› '}{safeText(message.content)}</Text></Box>
    if (message.role === 'tool') return <Box flexDirection="column" marginBottom={1}><Text dimColor>{'↳ '}{safeText(message.toolName)}</Text><Text>{safeText(toolResultText(message.content).slice(0, 12000))}</Text></Box>
    return <Box flexDirection="column" marginBottom={1}>
        {!!message.content && <TerminalMarkdown text={message.content} width={width} {...(highlighter ? { highlighter } : {})}/>}
        {message.role === 'assistant' && message.toolCalls?.map(call => <Text key={call.id} color="cyan">{'● '}{safeText(toolSummary(call))}</Text>)}
    </Box>
})
