# RAGFlow plugin

[English](README.md) | [简体中文](README.zh-CN.md)

RagFlowPlugin registers knowledge_retrieve with a Host-injected retrieval function. Agents receive readable evidence and document references. Authentication, dataset boundaries and HTTP transport belong to the Host.

```ts
import { RagFlowPlugin } from '@quifox/agent-plugin-ragflow';
const retrieval = new RagFlowPlugin((input, context) => host.retrieve(input, context));
```

Use the plugin directly or add it to a QuiFox workflow Agent with plugins: ["ragflow"]. See the [workflow guide](../../quifox/runtime/docs/guides/workflows.md).
