import { defineTool, toolSuccess, type AgentContext, type AgentHooks, type AgentPlugin } from '@quifox/agent-core'
import { z } from 'zod'

export interface KnowledgeChunk { content: string; document: string; documentId?: string; score?: number }
export interface RetrievalInput { question: string; documentIds?: string[] | undefined }
export const retrievalDocumentation = {
    id: 'knowledge', name: 'Knowledge retrieval',
    description: 'Retrieve evidence through the Host-injected knowledge interface. Cite source document names, do not invent evidence, and preserve source limitations. Empty results mean no matches; callback failure is an error.',
    tools: [{ name: 'knowledge_retrieve', input: '{question: string, documentIds?: string[]}', output: '{chunks: [{content, document, documentId?, score?}]}' }],
    example: 'agent("Research", {plugins: ["knowledge"]}).ask("Use knowledge_retrieve to find relevant evidence and cite source document names.")'
}

/** Inject retrieval at the Host boundary without coupling the tool to a service. */
export class KnowledgePlugin implements AgentPlugin {
    readonly id = 'knowledge'
    readonly hooks: AgentHooks
    constructor(retrieve: (input: RetrievalInput, ctx: AgentContext) => Promise<KnowledgeChunk[]>, description = retrievalDocumentation.description) {
        const tool = defineTool({ name: 'knowledge_retrieve', description: description + ' question is a self-contained search query; optional documentIds narrow the search. Returns text with source names and optional document IDs/scores.',
            inputSchema: z.object({ question: z.string().trim().min(1).max(8000), documentIds: z.array(z.string().min(1)).max(100).optional() }).strict(),
            policy: { sideEffect: 'none', approval: 'none', retrySafe: true }, execute: async (input, ctx) => {
                const chunks = await retrieve(input, ctx)
                return toolSuccess(chunks.length ? chunks.map((chunk, index) => `[${index + 1}] ${chunk.document}\n${chunk.content}`).join('\n\n') : '没有找到相关知识片段。', { chunks })
            } })
        this.hooks = { onInitialize: async ctx => { ctx.tools.register(tool) } }
    }
}
