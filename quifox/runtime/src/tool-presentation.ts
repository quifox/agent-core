import type { ToolCall, ToolResult } from '@quifox/agent-core'

export class FileAccessError extends Error {
    constructor(readonly result: ToolResult) { super(result.content); this.name = 'FileAccessError' }
}

export interface FileChange { path: string; before: string | null; after: string | null; truncated?: boolean }
export interface ToolInspection {
    summary: string; risk: 'read-only' | 'write' | 'execute' | 'outside-workspace'; requiresApproval?: boolean
    authorizationIdentity?: string; change?: FileChange; target?: string
}

/** Human summaries do not expose implementation parameter names; raw calls remain available in details. */
export function toolSummary(call: Pick<ToolCall, 'name' | 'input'>): string {
    const input = call.input && typeof call.input === 'object' ? call.input as Record<string, unknown> : {}
    const path = typeof input.path === 'string' ? input.path : '文件'
    if (call.name === 'read_file') return `读取 ${path}`
    if (call.name === 'open_view') return `展示 ${String(input.target ?? '文件')}`
    if (call.name === 'list_files') return `查看 ${typeof input.path === 'string' ? input.path : '工作目录'}`
    if (call.name === 'write_file') return `写入 ${path}`
    if (call.name === 'apply_patch') return `修改 ${path}`
    if (call.name === 'run_command') return `在 ${typeof input.cwd === 'string' ? input.cwd : '工作目录'} 执行 ${String(input.command ?? '').slice(0, 160)}`
    if (call.name === 'subagent_start') return `创建 ${typeof input.agent === 'string' ? input.agent : '子 Agent'}${input.prompt ? '并启动任务' : input.mode === 'fork' ? '，复制父上下文并待机' : '，空历史待机'}`
    if (call.name === 'subagent_send') return '向子 Agent 发送后续任务'
    if (call.name === 'subagent_wait') return '等待子 Agent 回复'
    if (call.name === 'subagent_stop') return '停止子 Agent'
    if (call.name.startsWith('skill_')) return `${call.name === 'skill_load' ? '加载技能' : call.name === 'skill_read' ? '读取技能资源' : '查看技能目录'} ${String(input.skill ?? '')}`.trim()
    if (call.name.startsWith('task_')) return `${call.name === 'task_cancel' ? '取消' : call.name === 'task_wait' ? '等待' : '查看'}后台任务`
    return `调用 ${call.name.replace(/_/g, ' ')}`
}
