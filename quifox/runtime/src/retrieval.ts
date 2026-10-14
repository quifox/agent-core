import { z } from 'zod'
import type { KnowledgeChunk, RetrievalInput } from '@quifox/agent-plugin-ragflow'
import type { RuntimeConfig } from './config.js'

const responseSchema = z.object({ code: z.number(), data: z.object({ chunks: z.array(z.object({
    content: z.string(), document_keyword: z.string().optional(), document_name: z.string().optional(),
    document_id: z.string().optional(), similarity: z.number().optional()
}).passthrough()) }).optional() }).passthrough()

/** Native RAGFlow retrieval API. Dataset boundaries come from private Host configuration. */
export async function retrieveKnowledge(connection: RuntimeConfig['ragflow'], input: RetrievalInput, signal?: AbortSignal): Promise<KnowledgeChunk[]> {
    if (!connection) throw new Error('请先在全局配置中设置 RAGFlow 连接与 datasetIds。')
    const response = await fetch(new URL('api/v1/retrieval', connection.baseUrl.replace(/\/?$/, '/')), {
        method: 'POST', redirect: 'error', signal: signal ? AbortSignal.any([signal, AbortSignal.timeout(30_000)]) : AbortSignal.timeout(30_000),
        headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${connection.apiKey}` },
        body: JSON.stringify({ question: input.question, dataset_ids: connection.datasetIds, ...(input.documentIds ? { document_ids: input.documentIds } : {}), page: 1, page_size: 8, top_k: 64 })
    })
    if (!response.ok) throw new Error(`知识检索服务返回 HTTP ${response.status}。`)
    if (!response.body) throw new Error('知识检索服务没有返回正文。')
    const reader = response.body.getReader(), chunks: Uint8Array[] = []
    let bytes = 0
    try {
        for (;;) {
            const chunk = await reader.read()
            if (chunk.done) break
            bytes += chunk.value.length
            if (bytes > 2_000_000) { await reader.cancel(); throw new Error('知识检索响应超过读取预算。') }
            chunks.push(chunk.value)
        }
    } finally { reader.releaseLock() }
    const text = Buffer.concat(chunks).toString('utf8')
    const value = responseSchema.parse(JSON.parse(text))
    if (value.code !== 0 || !value.data) throw new Error('知识检索服务未完成查询。')
    return value.data.chunks.map(chunk => ({ content: chunk.content, document: chunk.document_keyword ?? chunk.document_name ?? '未命名文档',
        ...(chunk.document_id ? { documentId: chunk.document_id } : {}), ...(chunk.similarity === undefined ? {} : { score: chunk.similarity }) }))
}
