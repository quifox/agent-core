# Workflow plugins

[English](README.md) | [简体中文](README.zh-CN.md)

WorkflowModelPlugin supplies a model turn from a Host-injected workflow executor. WorkflowToolsPlugin exposes inspect, save and run tools. The package has no filesystem, compiler or network dependency; QuiFox's shared runtime owns those boundaries.

```ts
import { createAgent } from '@quifox/agent-core';
import { WorkflowModelPlugin } from '@quifox/agent-plugin-workflow';

const agent = createAgent({plugins: [new WorkflowModelPlugin({
    input: () => ({question: 'Find relevant knowledge'}),
    execute: async input => host.runWorkflow(input)
})]});
```

host is the application's injected executor. Compose your session and persistence plugins for conversation ownership. See the [QuiFox workflow guide](../../quifox/runtime/docs/guides/workflows.md) for runnable scripts, Skill discovery, GUI, API and recovery.
