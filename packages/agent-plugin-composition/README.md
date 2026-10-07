# @quifox/agent-plugin-composition

English | [简体中文](README.zh-CN.md)

Experimental next-Agent recomposition for the Agent Core research project. The [package specification](docs/specs/architecture.md) defines the contract.

PluginCompositionPlugin stages a complete ordered array of real plugin objects. At the current call's final cleanup, it creates a new Agent and invokes the Host's replaceAgent callback. Current CTX, Hooks, and Tools remain on the original Agent.

The Host holds a replaceable Agent reference and supplies replaceAgent. When combining with Code Mode, it also supplies that package's code executor. Composition itself needs no executor or caller-side apply/commit.

### Caller-owned runtime

The caller holds the reference: `runtime = { agent }` is sufficient. A closure or existing application class works too. The runtime holds the current Agent; execute evaluates source. These are separate Host responsibilities.

Call `runtime.agent.run(input)` or `runtime.agent.stream(input)` directly. Add a thin adapter only if the application needs a stable run/stream-facing object. This is local Host code:

```ts
import type { Agent } from '@quifox/agent-core'

function createHostApi<Input>(runtime: { agent: Agent<Input> }) {
    return {
        run(input: Input) { return runtime.agent.run(input) },
        stream(input: Input) { return runtime.agent.stream(input) },
    }
}
```

Every invocation reads runtime.agent again. Returning the original Agent or caching methods bound to it keeps callers on the old object. A run already started, or a stream generator already obtained from the old Agent, retains that execution; reference replacement does not move it to the new Agent.

### Host wiring

This is application Host code, not a library Runtime factory:

```ts
import { createAgent, type AgentPlugin } from '@quifox/agent-core'
import { PluginCompositionPlugin } from '@quifox/agent-plugin-composition'

function createCompositionHost<Input>(initialPlugins: AgentPlugin<Input>[]) {
    const composition = new PluginCompositionPlugin<Input>({
        replaceAgent: nextAgent => { runtime.agent = nextAgent },
    })
    const runtime = {
        agent: createAgent({ plugins: [...initialPlugins, composition] }),
    }
    return {
        runtime,
        setNextPlugins: (plugins: AgentPlugin<Input>[]) =>
            composition.setNextPlugins(plugins),
    }
}
```

Call the returned setNextPlugins capability from a Hook after this manager has reached onRunStart. Composition works without Code Mode. For model-supplied code, add [Code Mode](../agent-plugin-code-mode/README.md) and inject this callback through bindings; the [typechecked combined Host example](../agent-plugin-code-mode/test/host-example.ts) shows that wiring.

### Code supplied by the model

When Code Mode and the Host binding are installed, this JS can construct an ordinary plugin object. The code executor and environment binding follow that package's contract:

```js
const newPlugin = {
    id: 'generated-note',
    hooks: {
        onRunStart: async ctx => {
            ctx.generatedNote = 'This capability was added by code';
            return { action: 'continue' };
        },
    },
};

const next = [...ctx.plugins, newPlugin];
setNextPlugins(next);
return 'The next Agent will include generated-note';
```

Removal and reordering use normal JS arrays. For example:

```js
setNextPlugins(ctx.plugins.filter(plugin => plugin.id !== 'generated-note'));
```

Each submission is the complete ordered list. Repeated successful submissions use the last list; empty lists and self-removal are allowed. Plugin IDs are descriptive, not unique object identities. The manager removes only its own internal cleanup object from proposals; other registration wrappers, dependencies, factories, and object reuse remain their owners' contracts.

setNextPlugins stages for the latest call that reached the manager's onRunStart and has not entered final cleanup. It throws when no such call exists, so it is not an idle configuration setter. Submit from a Hook after that manager has been reached, or from execute_code. Submission does not make new Tools available in the current call.

Retain Code Mode and Composition in the complete array when those capabilities are needed later; omission removes them and nothing reinstalls them automatically. Copying ctx.plugins and adding an object is appropriate only when the involved owners allow reuse; handle other owners' registration helpers according to their contracts.

### Cleanup and reference semantics

The manager inserts one private cleanup object during onRegister and verifies that it owns the last onRunEnd during initialization and again before replacement. The replacement callback runs in that object's final onRunEnd handler, after all preceding cleanup. A failed execution or preceding cleanup discards the proposal.

This is the final business cleanup boundary, not a claim that the old run Promise has already resolved. The old Agent still completes its original execution and final events. New capabilities register and initialize on the new Agent's first call. A callback failure becomes a cleanup failure; callback-owned partial effects are not automatically rolled back.

All consumers read `runtime.agent` for each call. A cached `const oldAgent = runtime.agent` remains an old reference. The Host supplies its own reference container; Core exports no Runtime/Handle/withPlugins API. A new Agent has a new CTX. Reusing compatible Session objects can preserve their object-owned history; CTX-only fields do not move automatically.

A successful reference handoff only constructs the new Agent. Its onRegister/onInitialize run on first execution, so the old Outcome.ok does not prove the next composition is valid. Missing capabilities still fail when the new execution reaches the relevant phase. Host-held Teams member mappings, subscriptions, and resource bindings are updated or released according to their owners' contracts.

If the new Agent's first execution fails, the Host reference remains the newly assigned object. The Host chooses any later reconstruction or reference change; Composition does not restore an old Agent or roll back another owner's initialization effects.

Recomposition and Code Mode do not reject concurrent run() calls. Choose a separate admission plugin when the application needs execution coordination. The context-free setNextPlugins binding targets the latest active call reaching the manager; do not infer automatic scheduling of overlapping proposals.

Other plugins that also require the final cleanup position, including Steering, need an explicit compatible composition contract. This package does not reorder their objects or promise arbitrary combinations.

The [composition contract](docs/specs/architecture.md) and [real-Core tests](test/plugin.test.ts) cover ordering, failure, independent admission, early stream closure, repeated positions, addition/removal, self-removal, and Session reuse.
