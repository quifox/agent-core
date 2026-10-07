# @quifox/agent-core

English | [简体中文](README.zh-CN.md)

Protocol-neutral, Hook-driven ReAct kernel. Reuse the complete plugin set for later calls. stream yields observations; run fully consumes that same stream and returns its Outcome.

The public API is [index.ts](src/index.ts). [Repository boundaries](../../docs/specs/packages.md) distinguish the execution core from capability plugins.

## Execution boundaries

```text
onRegister: prepare the candidate plugin array
→ onInitialize: first initialization and Tool registration
→ onRunStart: this invocation's input
→ beforeStep
→ beforeModel(ctx)
→ model(ctx): yield events, return the turn result
→ afterModel(ctx, result): shared mutable result
→ beforeTool
→ default Tool entry: prepare(ctx, input) → execute(prepared, ctx)
→ afterTool
→ afterStep
→ another model turn or onRunEnd
```

Plugins supply model generation. Core does not build Provider requests or own message history. The last model Hook wins; wrappers delegate explicitly. Arrays define Hook order, while after metadata alone does not sort plugins.

One Agent retains one Context; each invocation has its own Outcome. Hook working objects remain shared and mutable. Control Hooks return continue/stop; beforeTool can supply a result to skip the Tool entry.

Tools own prepare/execute and their business results. Raw Tool references can also be read from the Registry and called by another owner; those calls do not automatically receive the default chain's Hooks or events.

Sessions, prompts, admission, interruption, recovery, and Host I/O belong to explicit plugins or the Host.

## Further reading

- [Lifecycle, Hooks, Outcome, and default loop](docs/specs/architecture.md)
- [Registration, initialization, reuse, and fork](docs/specs/sessions.md)
- [Tool preparation, Registry reads, and receipts](docs/specs/tool-runtime.md)
