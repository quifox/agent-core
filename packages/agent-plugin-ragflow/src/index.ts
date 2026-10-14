import { defineTool, toolSuccess, type AgentContext, type AgentHooks, type AgentPlugin } from '@quifox/agent-core'
import { z } from 'zod'

export interface KnowledgeChunk { content: string; document: string; documentId?: string; score?: number }
export interface RetrievalInput { question: string; documentIds?: string[] | undefined }
export const retrievalDocumentation = {
    id: 'ragflow', name: 'RAGFlow knowledge retrieval',
    description: 'Search the Host-configured datasets. Never invent evidence; cite document names. Empty results mean no matches, while a failed connection is an error.',
    tools: [{ name: 'knowledge_retrieve', input: '{question: string, documentIds?: string[]}', output: '{chunks: [{content, document, documentId?, score?}]}' }],
    example: 'agent("Research", {plugins: ["ragflow"]}).ask("Retrieve evidence for the user question using knowledge_retrieve; return relevant evidence and document citations.")'
}

/** The Host owns authentication and retrieval transport; Agents receive only evidence. */
export class RagFlowPlugin implements AgentPlugin {
    readonly id = 'ragflow'
    readonly hooks: AgentHooks
    constructor(retrieve: (input: RetrievalInput, ctx: AgentContext) => Promise<KnowledgeChunk[]>) {
        const tool = defineTool({ name: 'knowledge_retrieve', description: 'Retrieve evidence from the configured RAGFlow knowledge datasets. Use for any knowledge question, including follow-up questions and comparisons. question is a self-contained search query; optional documentIds narrow the search. Returns text with source document names, IDs and scores; no matches is distinct from a connection error. The plugin-bound typescript-workflows Skill explains how to add RAGFlow to workflow Agents.',
            inputSchema: z.object({ question: z.string().trim().min(1).max(8000), documentIds: z.array(z.string().min(1)).max(100).optional() }).strict(),
            policy: { sideEffect: 'none', approval: 'none', retrySafe: true }, execute: async (input, ctx) => {
                const chunks = await retrieve(input, ctx)
                return toolSuccess(chunks.length ? chunks.map((chunk, index) => `[${index + 1}] ${chunk.document}\n${chunk.content}`).join('\n\n') : '没有找到相关知识片段。', { chunks })
            } })
        this.hooks = { onInitialize: async ctx => { ctx.tools.register(tool) } }
    }
}
