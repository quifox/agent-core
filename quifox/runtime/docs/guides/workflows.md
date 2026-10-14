# TypeScript workflows

[English](workflows.md) | [简体中文](workflows.zh-CN.md)

Enable the Workflows plugin in QuiFox's plugin page. Its typescript-workflows Skill automatically appears in the existing skill catalog; the Agent can load it and read the enabled business plugin catalog, recovery guidance and templates. No separate documentation tool is needed.

Workflows are ordinary TypeScript scripts with agent().ask(), optional function JSDoc @phase labels, branches and Promise.all. QuiFox derives the graph from the same TypeScript source it executes, using its pinned [ZCode](https://github.com/zai-org/ZCode) engine fork. Scripts use Host globals, not imports. This version supports agent, args, phase, log and ordinary TypeScript; upstream world/artifact/hole APIs are not exposed.

In a conversation, a dynamic-workflow fenced code block becomes a graph card. Run opens a right-side test panel; Save stores the script in ~/.quifox/workflows. The top-level Workflows page lists saved scripts and templates, with the read-only graph on the left and the regular multi-turn conversation on the right. Import accepts a .ts file and validates it before saving. Expand a phase to see steps, branch/join/loop edges and actual runtime states.

For general knowledge retrieval, use the [authoring Skill](../../skills/typescript-workflows/SKILL.md). The parallel-retrieval template rewrites a follow-up question, retrieves direct and conflicting evidence in parallel, and synthesizes an answer with sources. It is not tied to a specific exam, year or dataset. Internal Agents start empty per workflow turn; reuse an actor variable for context inside that turn. args.messages supplies only outer user/assistant I/O.

RAGFlow uses its native [retrieval API](https://ragflow.io/docs/http_api_reference). Add a private global configuration section:

```json
{"ragflow":{"baseUrl":"https://knowledge.example.invalid/","apiKey":"YOUR_KEY","datasetIds":["YOUR_DATASET_ID"]}}
```

Enable the RAGFlow plugin. An Agent can call knowledge_retrieve directly or a script can create agent("Research", {plugins:["ragflow"], tools:["knowledge_retrieve"]}). Host-defined datasets cannot be widened by the model. Missing configuration, failed retrieval and zero results are distinct. Model profiles and permissions use the normal QuiFox settings.

The Host fsyncs workflow checkpoints in its private workflow-runs directory. Resume the original conversation after interruption: the script replays from its entry, completed nodes reuse results, and live actors reattach to their original Session. Read the [recovery contract](../../skills/typescript-workflows/recovery.md) before designing side effects. Deterministic control flow is required; arbitrary JavaScript heap state is not persisted. Unknown interrupted tool results are explicitly marked incomplete/unknown rather than automatically replayed. Exactly-once business writes require plugin-owned idempotency and reconciliation. Templates show read-only retry and parallel joins; they do not establish production readiness.

Deploy as local API from the workflow page. The Host returns a loopback URL and private Bearer token. POST /runs with {"question":"..."} returns a sessionId; GET /runs/:id returns status/output. Supply the same sessionId on another POST /runs for a follow-up. POST /runs/:id/stop cancels the workflow. Close only hides the dialog; Manage local API reopens the same service, and Stop API shuts it down. A deployment pins the saved script until stopped and redeployed. Tokens are not written into public snapshots; the service ends with the Host and does not expose a public server.

The separate LangChain plugin supplies the seven skills in the supplied v0.2 review collection through the same skill catalog. Install it from the plugin marketplace and enable Skills. Official LangGraph skill names and references retain their upstream identity; workflow-production-design and workflow-release-checklist are optional authoring references. This plugin does not install dependencies or execute scripts; LangChain/LangGraph applications use their own libraries and are not QuiFox workflow scripts. See the [source notice](../../skills/langchain/NOTICE) and [official collection](https://github.com/langchain-ai/langchain-skills).

QuiFox maintains the workflow support layer. A generated script's business decisions belong to its author; diagnostics do not automatically rewrite its branches or prompts.

Scripts run in a separate process with a restricted inherited environment. Node VM is not a security boundary: run trusted local scripts only. Production deployment, external write idempotency and platform fault recovery require application-specific validation.
