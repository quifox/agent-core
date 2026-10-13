# @quifox/agent-plugin-memory

[English](README.md) | [简体中文](README.zh-CN.md)

An experimental, owner-scoped memory plugin for Chat-based Agents. It adapts the two-stage memory workflow from OpenAI Codex v2 to server-owned Chat conversations and Agent Core.

The durable memory projection has two document types:

- `memory.md` contains reusable user context and navigation links to conversation summaries.
- `conversations/<created-at>-<short-id>.md` contains one conversation's summary, description, and program-generated source metadata.

Conversation titles come from the host. One extraction call returns both `description` and `summary`; code writes the title, source revision, timestamps, and opaque JSONL `sourceRef`. The plugin does not create topic files, raw-memory files, or a second transcript store.

## Host integration

The host owns authentication, owner-scoped persistence, the Chat JSONL archive, and background scheduling. `MemoryStore` must implement atomic compare-and-set within one owner. `ConversationArchive` must resolve opaque source references only within the supplied owner. Neither storage nor scheduling is performed by Agent Core.

Create a service and processor once, then share one `MemoryPlugin` across Agents. Resolve each run's identity from the host's trusted conversation binding:

```ts
import { createAgent } from '@quifox/agent-core'
import { ChatModelPlugin } from '@quifox/agent-plugin-model'
import { ChatSessionPlugin, type ConversationContext } from '@quifox/agent-plugin-session'
import { ContextualChatConversationPlugin, RequestContextPlugin } from '@quifox/agent-plugin-request-context'
import { MemoryPlugin, MemoryProcessor, MemoryService, type MemoryBinding } from '@quifox/agent-plugin-memory'

const service = new MemoryService(memoryStore, archive, newId)
const processor = new MemoryProcessor({ store: memoryStore, archive, model: modelOptions, newId })
const bindings = new WeakMap<ContextualChatConversationPlugin, MemoryBinding>()
const memory = new MemoryPlugin({
  service,
  binding(ctx) {
    const binding = bindings.get((ctx as ConversationContext).conversation as ContextualChatConversationPlugin)
    if (!binding) throw new Error('No trusted memory binding for this conversation.')
    return binding
  },
  // Enqueue durably; do not wait for background summarization in the chat response.
  schedule: binding => enqueueMemoryPass(binding.ownerId, binding.conversationId)
})

const session = new ChatSessionPlugin({ id: conversationId, ownerId })
const context = new RequestContextPlugin(session)
const model = new ChatModelPlugin({ ...modelOptions, session: context.source })
const conversation = new ContextualChatConversationPlugin({ session, generation: model, context })
bindings.set(conversation, { ownerId, conversationId, context })
const agent = createAgent({ plugins: [conversation, memory] })
```

`enqueueMemoryPass` is host code that later calls `processor.run(ownerId, currentConversationId)`. The processor re-reads eligible Chat records, claims owner-scoped leases, extracts changed conversations from their original records, then consolidates selected summaries into `memory.md`. Failures preserve published documents and schedule retry. A stale source snapshot cannot publish.

Extraction defaults to Chat strict JSON schema through the existing model settings. For a route with different capabilities, set `MemoryProcessorOptions.extractionFormat` to `'json-object'` or `'text'` explicitly. All modes validate the response; unsupported formats fail without automatic downgrade. This constraint applies only to extraction, while consolidation uses ordinary tool calls.

## Memory behavior

The extraction pass ranks evidence by provenance: human input and structured human answers first, then assistant, other-agent, commentary, context, and tool output. It applies bounded input selection, restores chronology, and marks omitted or truncated evidence. System messages, injected memory, and generated reasoning are excluded as human evidence. Revisions are summarized again from original records rather than by appending a delta to an older summary.

Cross-conversation consolidation reads the prior `memory.md` and summary catalogue, follows exact summary paths, and can read or search selected original JSONL when it needs to verify a conflict. It publishes only after successful Agent completion and a source/fingerprint/lease check. `memory_list`, `memory_read`, and `memory_search` expose summaries progressively; `conversation_read` and `conversation_search` expose owner-scoped original evidence. Search is keyword based; hosts may add a retrieval ranker without changing source identity.

For truncated `conversation_read` pages, pass returned `nextLine`/`nextOffset` as `startLine`/`startOffset`. `lineFragment` marks a piece of a large redacted physical line; offsets count UTF-16 units without splitting surrogate pairs. JSON receipts remain parseable within the tool budget; oversized lists/search results return an explicit structural preview.

The selection limit bounds consolidation input, preserving recent unselected summaries for later reads and selection. Corrections hide the prior global document from active requests while retaining its published body for consolidation. Usage-feedback storage failures cannot fail a completed answer; hosts can observe them through `MemoryPluginOptions.onFeedbackError`.

An explicit `remember`, `correct`, or `forget` request becomes an append-only note. Corrections and unscoped forgets hide older summaries until regeneration applies those maintenance requests; publishing a new global document does not expose an uncorrected summary again. A targeted forget revokes that conversation. Original JSONL remains historical evidence, with later maintenance requests attached when tools read it. A pending remember preserves previously valid memory.

Maintenance retains its own program-generated timestamp. It changes matching retained facts without becoming original conversation history or adding facts from another topic. Summary and description follow the conversation user's language.

Large maintenance histories return a program-generated `memory-notes:<conversationId>` reference alongside the original evidence. Read it through the existing `memory_read` tool in bounded line ranges before treating historical claims as current preferences. This is a virtual view of retained notes, not another persistent memory file.

The host can supply `MemoryBinding.operationId(callId)`, resolving the persisted assistant batch to `tool:<conversation-id>:<batch-entry-id>:<tool-call-id>`. Notes and message dispatch use that identity for safe retries. The model supplies only a target conversation and message content; the backend generates and durably stores the message ID. Replaying one call returns its prior receipt; a new call may intentionally send the same text again. Without a durable operation resolver, these tools do not advertise retry safety.

`conversation_list` discovers all owned conversations, including empty or unsummarized ones, with title filtering and stable pagination. Pages are bounded before advancing their cursor. Original search filters the allowed scope before ranking, and includes title matches without inventing JSONL line numbers. The global writer supplies semantic Markdown; code adds the version marker and relative-path navigation from real summary metadata.

In `beforeModel`, the memory plugin sets a contribution on the separate request-context plugin. Its adapter first lets the unchanged Session save the original messages, then returns the temporary projection to the unchanged Model plugin. Memory never enters the Session history. Retry restores the original input and reads current memory again; it does not promise an identical temporary context across retries. Existing Core, Model, and Session implementations remain unchanged.

## Validation and limits

The plugin validates document structure, exact summary pointers, bounds, owner-scoped references, leases, retry state, and persisted-source revisions. Known missing/revoked references and semantic input errors return stable `MEMORY_UNAVAILABLE` or `MEMORY_INPUT_INVALID` tool results, allowing the model to correct the call and close its batch. Unexpected storage/I/O failures remain failed tool calls for host recovery. These checks establish data lineage and workflow correctness; they do not prove that a model-generated summary is semantically complete or that a remembered fact remains true. The host should expose an explicit memory review/forget path and verify model behavior with representative conversations.

The source-derived prompts and evidence-selection algorithm come from [`openai/codex`](https://github.com/openai/codex/tree/806d9732c974bc8a51b8317c1bd8985544fe627c), under Apache-2.0. See [LICENSE](LICENSE) and [NOTICE](NOTICE) for attribution and adaptation details.
