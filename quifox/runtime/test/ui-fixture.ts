import { createServer } from 'node:http'
import { once } from 'node:events'
import { mkdir } from 'node:fs/promises'
import { resolve, join } from 'node:path'
import { randomUUID } from 'node:crypto'
import { defaultConfig, saveConfig, writeAtomic } from '../src/config.js'

/** Manual native/PTY acceptance fixture; creates only explicitly selected isolated app roots. */
const directory = process.argv[2]
if (!directory) throw new Error('Pass an isolated acceptance artifact directory.')
const root = resolve(directory)
await mkdir(root, { recursive: true })
const server = createServer(async (request, response) => {
    let body = ''; for await (const chunk of request) body += chunk
    const input = JSON.parse(body) as { messages: { role: string; content: string }[] }
    const last = input.messages.at(-1)
    const prompt = last?.content ?? ''
    response.writeHead(200, { 'Content-Type': 'text/event-stream' })
    const write = (delta: unknown): void => { response.write(`data: ${JSON.stringify({ choices: [{ delta }] })}\n\n`) }
    const finish = (reason = 'stop'): void => { write({}); response.end(`data: ${JSON.stringify({ choices: [{ delta: {}, finish_reason: reason }] })}\n\ndata: [DONE]\n\n`) }
    if (last?.role !== 'tool' && prompt.includes('审批')) {
        write({ tool_calls: [{ index: 0, id: randomUUID(), type: 'function', function: { name: 'apply_patch', arguments: JSON.stringify({ path: 'acceptance.txt', oldText: '', newText: 'Approved through the actual quifox Host.' }) } }] }); finish('tool_calls')
    } else if (last?.role !== 'tool' && prompt.includes('子智能体')) {
        write({ tool_calls: [{ index: 0, id: randomUUID(), type: 'function', function: { name: 'subagent_start', arguments: '{}' } }] }); finish('tool_calls')
    } else {
        const text = last?.role === 'tool' ? '工具已返回真实回执。你可以在项目面板中查看修改和任务。' : prompt.includes('Markdown') ?
            '# 验收结果\n\n正文支持 **Markdown** 与列表：\n\n- 模型与思考可在输入区选择\n- 工具差异和子任务在项目面板查看\n\n```ts\nconst status = "verified"\n```\n\n[查看文件](acceptance.txt)' :
            `已接纳你的消息：${prompt}\n\n这是原生 Desktop / TUI 通过 Bun Host 请求本地 HTTP 模型夹具产生的输出。`
        const parts = [...text], slow = prompt.includes('慢速')
        let index = 0
        const timer = setInterval(() => {
            if (response.destroyed) { clearInterval(timer); return }
            write({ content: parts.slice(index, index + 3).join('') }); index += 3
            if (index >= parts.length) { clearInterval(timer); finish() }
        }, slow ? 250 : 20)
        response.on('close', () => { clearInterval(timer) })
    }
})
server.listen(0, '127.0.0.1'); await once(server, 'listening')
const baseUrl = `http://127.0.0.1:${(server.address() as { port: number }).port}`
for (const name of ['desktop', 'tui']) {
    const appRoot = join(root, name), workspace = join(appRoot, 'workspace')
    await mkdir(join(workspace, '.agents', 'skills', 'acceptance'), { recursive: true })
    await writeAtomic(join(workspace, '.agents', 'skills', 'acceptance', 'SKILL.md'), '---\nname: acceptance\ndescription: Verify the isolated quifox acceptance workspace.\n---\n\nRead acceptance.txt through the ordinary file tool.\n')
    const config = defaultConfig(workspace)
    config.model = { provider: 'synthetic', model: 'synthetic-ui', baseUrl, apiKey: 'synthetic-acceptance-key', contextWindow: 1_000_000, maxOutputTokens: 1024 }
    config.models = [{ ...config.model, id: 'review-model', model: 'synthetic-review', reasoningEffort: 'medium', reasoningEfforts: ['none', 'low', 'medium', 'high'] }]
    config.memory.generate = false
    await mkdir(join(appRoot, 'agents'), { recursive: true })
    await writeAtomic(join(appRoot, 'agents', 'reviewer.md'), '---\nname: reviewer\ndescription: Review the isolated acceptance project.\nmodel: review-model\npermissionMode: plan\neffort: high\n---\nUse read-only tools and retain the original requirements.\n')
    await saveConfig(appRoot, config)
}
process.stdout.write(`${JSON.stringify({ root, baseUrl })}\n`)
for (const signal of ['SIGINT', 'SIGTERM'] as const) process.on(signal, () => { server.closeAllConnections(); server.close(); process.exit(0) })
