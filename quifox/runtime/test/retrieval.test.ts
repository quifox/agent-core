import { expect, it } from 'vitest'
import { createServer } from 'node:http'
import { once } from 'node:events'
import { retrieveKnowledge } from '../src/retrieval.js'
import { defaultConfig, publicConfig, workspaceConfig } from '../src/config.js'
import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { tmpdir } from 'node:os'

it('uses the native HTTP API and configured dataset boundary while returning evidence without credentials', async () => {
    let payload: unknown, authorization: string | undefined, path: string | undefined
    const server = createServer(async (request, response) => {
        const chunks: Buffer[] = []; for await (const chunk of request) chunks.push(chunk as Buffer)
        payload = JSON.parse(Buffer.concat(chunks).toString('utf8')); authorization = request.headers.authorization; path = request.url
        response.setHeader('Content-Type', 'application/json'); response.end(JSON.stringify({ code: 0, data: { chunks: [{ content: '中文证据', document_keyword: 'Guide', document_id: 'doc', similarity: .8 }] } }))
    })
    server.listen(0, '127.0.0.1'); await once(server, 'listening')
    try {
        const connection = { baseUrl: 'http://127.0.0.1:' + (server.address() as { port: number }).port, apiKey: 'synthetic-retrieval-key', datasetIds: ['authorized'] }
        const result = await retrieveKnowledge(connection, { question: '通用问题', documentIds: ['doc'] })
        expect(path).toBe('/api/v1/retrieval'); expect(authorization).toBe('Bearer synthetic-retrieval-key')
        expect(payload).toMatchObject({ question: '通用问题', dataset_ids: ['authorized'], document_ids: ['doc'] })
        expect(result).toEqual([{ content: '中文证据', document: 'Guide', documentId: 'doc', score: .8 }])
        const config = defaultConfig('/synthetic'); config.ragflow = connection
        expect(JSON.stringify(publicConfig(config))).not.toContain('synthetic-retrieval-key')
    } finally { server.closeAllConnections(); server.close() }
})
it('rejects oversized streaming responses before reading the complete body', async () => {
    const server = createServer((_request, response) => { response.writeHead(200); response.end('x'.repeat(2_100_000)) })
    server.listen(0, '127.0.0.1'); await once(server, 'listening')
    try {
        await expect(retrieveKnowledge({ baseUrl: 'http://127.0.0.1:' + (server.address() as { port: number }).port, apiKey: 'synthetic', datasetIds: ['dataset'] }, { question: 'question' })).rejects.toThrow('读取预算')
    } finally { server.closeAllConnections(); server.close() }
})
it('rejects project-controlled retrieval URLs and dataset scopes', async () => {
    const root = await mkdtemp(join(tmpdir(), 'quifox-rag-trust-'))
    try {
        await mkdir(join(root, '.quifox'))
        await writeFile(join(root, '.quifox', 'config.json'), JSON.stringify({ ragflow: { baseUrl: 'https://untrusted.invalid/', apiKey: 'synthetic', datasetIds: ['other'] } }))
        await expect(workspaceConfig(defaultConfig(root), root, join(root, 'profile'))).rejects.toThrow('项目配置无效')
    } finally { await rm(root, { recursive: true, force: true }) }
})
