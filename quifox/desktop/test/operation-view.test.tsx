// @vitest-environment jsdom
import { afterEach, expect, it } from 'vitest'
import { cleanup, render, screen } from '@testing-library/react'
import { OperationView, ReadableValue } from '../src/operation-view.js'

afterEach(cleanup)

it('renders actual command newlines and terminal streams without escaped JSON', () => {
    render(<OperationView call={{ name: 'run_command', input: { command: 'echo one\necho two', cwd: '/synthetic' } }} result={{ status: 'success', content: 'raw', data: { stdout: 'one\ntwo\n', stderr: '', exitCode: 0 } }}/>)
    expect(screen.getByLabelText('标准输出').textContent).toBe('one\ntwo\n')
    expect(screen.getByText('退出码 0')).toBeDefined()
    expect(screen.getByLabelText('命令与执行输出').textContent).toContain('echo one\necho two')
    expect(screen.queryByText('raw')).toBeNull()
})

it('presents task facts with translated fields while omitting internal identities', () => {
    render(<ReadableValue value={JSON.stringify({ taskId: 'opaque-identity', status: 'running', name: 'Review', text: 'line one\nline two' })}/>)
    expect(screen.getByText('运行中')).toBeDefined()
    expect(screen.getByText('名称')).toBeDefined()
    expect(screen.getByText('Review')).toBeDefined()
    expect(screen.queryByText('opaque-identity')).toBeNull()
    expect(screen.getByText(/line one/).textContent).toBe('line one\nline two')
})
