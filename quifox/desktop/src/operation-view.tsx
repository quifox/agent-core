import type { ToolCall, ToolResult } from '@quifox/agent-core'

const labels: Record<string, string> = { path: '文件', cwd: '工作目录', command: '命令', stdout: '输出', stderr: '错误输出', exitCode: '退出码',
    name: '名称', title: '标题', status: '状态', text: '回复', content: '内容', description: '说明', prompt: '任务', error: '原因', message: '说明',
    timeoutMs: '等待上限（毫秒）', background: '后台执行', cancelRequested: '已请求停止', result: '结果', results: '结果', tools: '工具', skills: '技能',
    model: '模型', reasoningEffort: '思考强度', mode: '上下文方式', target: '目标', entries: '条目', kind: '类型', truncated: '预览已截断' }
const hidden = /^(?:id|sessionId|taskId|callId|toolCallId|operationId|parentId|ownerId|runId|version|revision|apiKey|authorization|password|token|headers|env|displayTruncated)$/i
export const stateLabels: Record<string, string> = { idle: '待机', running: '运行中', stopping: '正在停止', stopped: '已停止', cancelled: '已打断',
    completed: '已完成', success: '已完成', failed: '失败', error: '失败', denied: '已拒绝', unknown: '结果未知', 'not-started': '未执行', committed: '已提交', queue: '排队', steer: '引导', empty: '独立上下文', fork: '继承上下文' }
function parsed(value: unknown): unknown {
    if (typeof value !== 'string' || !/^\s*(?:\[|\{)/.test(value)) return value
    try { return JSON.parse(value) } catch { return value }
}
function record(value: unknown): Record<string, unknown> | undefined {
    const source = parsed(value)
    return source && typeof source === 'object' && !Array.isArray(source) ? source as Record<string, unknown> : undefined
}

/** Business data is rendered as fields and lists; code and terminal output keep real newlines. */
export function ReadableValue({ value, depth = 0 }: { value: unknown; depth?: number }) {
    const source = parsed(value)
    if (source === undefined || source === null || source === '') return null
    if (typeof source === 'boolean') return <span>{source ? '是' : '否'}</span>
    if (typeof source !== 'object') return <div className="readable-text">{stateLabels[String(source)] ?? String(source)}</div>
    if (depth > 8) return <span>内容层级过深，请在本地日志查看。</span>
    if (Array.isArray(source)) return <ol className="readable-list">{source.slice(0, 100).map((item, index) => <li key={index}><ReadableValue value={item} depth={depth + 1}/></li>)}</ol>
    return <dl className="readable-fields">{Object.entries(source).filter(([key, item]) => !hidden.test(key) && item !== undefined && item !== null).slice(0, 100).map(([key, item]) => <div key={key}><dt>{labels[key] ?? key.replace(/([a-z])([A-Z])/g, '$1 $2').replace(/_/g, ' ')}</dt><dd><ReadableValue value={item} depth={depth + 1}/></dd></div>)}</dl>
}

export function OperationView({ call, result }: { call: Pick<ToolCall, 'name' | 'input'>; result?: ToolResult | undefined }) {
    const input = record(call.input) ?? {}, output = record(result?.data) ?? record(result?.content)
    if (call.name === 'run_command') return <section className="terminal-output" aria-label="命令与执行输出">
        <div className="terminal-directory">{typeof input.cwd === 'string' ? input.cwd : '工作目录'}</div>
        <pre className="terminal-command"><span aria-hidden="true">$ </span><code>{String(input.command ?? '')}</code></pre>
        {typeof output?.stdout === 'string' && !!output.stdout && <pre aria-label="标准输出">{output.stdout}</pre>}
        {typeof output?.stderr === 'string' && !!output.stderr && <pre className="terminal-error" aria-label="标准错误">{output.stderr}</pre>}
        {output?.exitCode !== undefined && <div className="terminal-exit">退出码 {String(output.exitCode ?? '未报告')}{output.cancelRequested ? ' · 已请求停止' : ''}</div>}
        {output && output.exitCode === undefined && <ReadableValue value={output}/>}
        {result && !output && <ReadableValue value={result.content}/>}
        {!result && <div className="operation-waiting">等待执行结果</div>}
    </section>
    return <section className="operation-view"><ReadableValue value={input}/>{result && <div className="operation-result"><ReadableValue value={output ?? result.content}/></div>}</section>
}
