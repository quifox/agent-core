# Knowledge retrieval plugin

[English](README.md) | [简体中文](README.zh-CN.md)

KnowledgePlugin registers knowledge_retrieve with a Host-injected retrieval function. Agents receive readable evidence and document references. The interface does not select a service, open a connection or manage credentials. QuiFox supplies an optional local Mock example with explicitly synthetic sources.

```ts
import { KnowledgePlugin } from '@quifox/agent-plugin-knowledge';
const retrieval = new KnowledgePlugin(async () => [
    { content: 'Synthetic example evidence.', document: '[Mock] Example', documentId: 'mock-example' }
]);
```

Use the plugin directly or, after installing the Mock example in QuiFox, add it to a workflow Agent with plugins: ["knowledge"]. See the [workflow guide](../../quifox/runtime/docs/guides/workflows.md). Empty results and callback failures remain distinct. Mock execution validates integration, not real retrieval quality.

The default tool description is backend-neutral. A Host can pass a second description argument to identify its own source limitations; QuiFox uses it to explicitly mark the local Mock.
