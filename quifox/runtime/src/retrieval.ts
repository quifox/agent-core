import { retrievalDocumentation, type KnowledgeChunk, type RetrievalInput } from '@quifox/agent-plugin-knowledge'

export const mockRetrievalDocumentation = { ...retrievalDocumentation, name: 'Mock knowledge retrieval',
    description: 'QuiFox supplies local synthetic workflow, parallel research and conversation-history documents. Every source is marked Mock. This demo does not connect to a knowledge service or answer unrelated real-world questions. Cite sources and explicitly identify mock evidence; empty results mean no matches.',
    example: 'agent("Research", {plugins: ["knowledge"]}).ask("Use knowledge_retrieve to demonstrate parallel workflow retrieval. Identify synthetic evidence and cite Mock source names.")' }

const documents = [
    { documentId: 'mock-workflow', document: '[Mock] Workflow notes', keywords: ['workflow', '工作流'],
        content: 'Synthetic example: a workflow can rewrite a question, collect evidence and compose an answer. This is mock evidence for integration tests, not a real knowledge source.' },
    { documentId: 'mock-parallel', document: '[Mock] Parallel research', keywords: ['parallel', '并行'],
        content: 'Synthetic example: two research branches keep independent Agent context, then combine their returned evidence. This is mock evidence, not a measured retrieval result.' },
    { documentId: 'mock-history', document: '[Mock] Conversation history', keywords: ['history', 'context', 'conversation', '历史', '上下文', '多轮'],
        content: 'Synthetic example: a follow-up question can use outer user and assistant messages while internal research traces stay local to that turn. This is mock evidence.' }
] as const

/** A local, deterministic example of the injected retrieval boundary; no network or credentials. */
export async function mockRetrieveKnowledge(input: RetrievalInput, signal?: AbortSignal): Promise<KnowledgeChunk[]> {
    signal?.throwIfAborted()
    const question = input.question.normalize('NFKC').toLowerCase()
    return documents.filter(document => (!input.documentIds || input.documentIds.includes(document.documentId))
        && document.keywords.some(keyword => question.includes(keyword)))
        .map(({ content, document, documentId }) => ({ content, document, documentId }))
}
