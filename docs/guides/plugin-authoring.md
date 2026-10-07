# Plugin authoring guide

English | [简体中文](plugin-authoring.zh-CN.md)

This guide covers the shared development contract for plugins in the experimental Agent Core research project. Each plugin owns its usage documentation in its own package. The [Core specification](../../packages/agent-core/docs/specs/architecture.md) is authoritative for Hooks, Context, Outcome, and Tool behavior.

## Minimal plugin

```ts
import type { AgentHooks, AgentPlugin } from '@quifox/agent-core'

export class ExamplePlugin implements AgentPlugin<{ prompt: string }> {
    readonly id = 'example'
    readonly hooks: AgentHooks<{ prompt: string }> = {
        onRunStart: async (_ctx, input, outcome) => {
            // Outcome identifies this call. Context is reused for the Agent lifetime.
            void input
            void outcome
            return { action: 'continue' }
        }
    }
}
```

Core does not infer capabilities from plugin names and does not install dependencies. Callers create plugin objects and use array order to define Hook order.

## Contract checklist

Define these boundaries before implementation:

1. **Owner**: the state owned exclusively by this plugin and the state owned by Session, Tool, Model plugins, or Host. Protocol clients belong inside model plugins; Core only invokes Hooks.
2. **Lifetime**: whether state belongs to the plugin object, lifetime Context, or one Outcome. Context identity is not Run identity.
3. **Hook order**: required predecessors and successors, plus behavior when a collaborator is missing.
4. **Concurrency**: whether one object supports multiple Agents or calls, and whether it rejects, queues, or batches.
5. **Failure**: whether a condition returns `stop/result`, returns a business `ToolResult`, or throws into a failed Outcome.
6. **Side effects**: who decides started, completed, unknown result, retry safety, and recovery.
7. **External data**: network, storage, authentication, SSE, and UI must be injected by the Host rather than accessed through implicit globals.

## Context capabilities

A plugin may publish an explicitly documented capability on the lifetime Context:

```ts
import type { AgentContext, AgentPlugin } from '@quifox/agent-core'

interface ExampleContext {
    example?: { record(value: string): void }
}

const records: string[] = []
const plugin: AgentPlugin = {
    id: 'example',
    hooks: {
        onInitialize: async ctx => {
            const extension = ctx as AgentContext & ExampleContext
            extension.example = { record: value => { records.push(value) } }
        }
    }
}
```

The Host owns the records; the plugin publishes the recording capability. Document its name, mutability, initialization point, and missing-capability behavior. Do not infer capabilities from plugin IDs, class names, or undocumented fields, and do not duplicate authoritative state.

## Identity and composition

- A plugin object keeps shared mutable identity. Create a new object when isolation is required.
- Each Agent registers and initializes an object once, while runtime Hooks execute at every array position. Declare the repeated-position semantics: tracing may intentionally log at each position, while one-time admission can deduplicate by Outcome. Plugins that do not support repetition reject it themselves. Sharing the object with a new Agent runs that Agent's registration and initialization.
- A composition plugin may insert ordinary internal plugins during `onRegister`; the final array remains the only execution order.
- The Core Tool loop uses the shared Registry. Plugins can also read original Tool objects through `ctx.tools.get(name)` or `ctx.tools.values()` and compose their own method calls.

### Reading and directly reusing Tools

`get(name)` returns the original registered Tool, or undefined. `values()` returns an ordered array snapshot containing the same Tool references; changing that array does not change the Registry.

```ts
const tool = ctx.tools.get('save')
if (tool) {
    const result = await tool.execute(callerInput, ctx)
}
```

The caller chooses the method, arguments, and whether or how to use prepare. These read methods do not wrap handlers, validate arguments, or impose a call sequence. Direct calls do not automatically trigger beforeTool/afterTool, create Core Tool events, or establish a Run. Any such orchestration belongs to the calling plugin.

Registration still binds the original prepare/execute methods and copies policy. Replacing methods on the returned object affects direct calls to that object, while the existing Core registration keeps its original binding. Mutable object state read inside the bound methods remains shared.

## Recommended compositions and collaboration

CTX and Hook working data remain open and mutable. Third-party plugins may choose their own collaboration contracts. Official recommended compositions should make these relationships explicit:

- **Capabilities**: declare what is consumed and published, and who owns the state. Use explicit object references or public Context extensions. Steering, for example, calls Conversation.appendUserMessages while Session owns message storage.
- **Identity pairing**: keep related references paired by the composition object. ChatConversationPlugin checks that its Model uses the same Session; register the composition rather than also registering its internal Session and Model.
- **Ordering**: identify where each Hook reads, transforms, and records data. The caller chooses the candidate array; a composition organizes the relationships it promises. Core does not sort by `after` metadata.
- **Lifetime**: distinguish object sharing, repeated positions, per-Outcome admission and release, initialization in a new Agent, and Host-owned resource cleanup.
- **Evidence**: link owner specifications and real-Core composition tests. State the supported cases instead of generalizing one plugin's tests to every combination.

Concrete usage and assembly order belong to each owner's package documentation and composition tests; start with the [package index](../../README.md#packages). A plugin can have different ordering needs across Hooks; assess the declared complete composition.

## Common pitfalls

| Assumption | Actual behavior and handling |
|---|---|
| Transforming a result updates every record | Session and publish sinks observe their own Hook position. Later changes do not rewrite saved strings. Put transforms before recorders when the transformed version is required. |
| Multiple model Hooks form middleware automatically | The last model wins; wrappers delegate explicitly. Events must be the last model with a real upstream generator. |
| A control Hook yield is an immediate notification | Ordinary control chains buffer events. stop/result short-circuits later handlers, while afterTool completes the receipt chain. Verify publish and stream timing separately. |
| One onRunEnd means all cleanup succeeded | Later cleanup can still fail. Publishing does not guarantee persistence. Host decisions use the Outcome returned after complete consumption; internal handoff follows its own cleanup contract. |
| Stable CTX identity identifies each Run | Context identifies the Agent; Outcome identifies a call. Cleanup can reach a plugin that did not admit the call, so it must release only its own Outcome. |
| Shareable objects all support concurrent use | Teams is designed for sharing; Session and Events have their own admission limits. Choose shared or independent instances according to each contract. |
| Reused objects skip initialization in a new Agent | CTX, the tool table, registration, and initialization are new. Private object state may survive; Context fields and external Agent references need explicit handling. |
| Final ctx.plugins can always be replayed | Registration can insert helper objects, such as Steering's tail. Owners normalize or reconstruct candidates; removing an object does not automatically release external resources. |
| Outcome.ok proves business completion | It means no unrecovered execution-chain exception. Tool error results, model terminal reasons, and team goals have owner-defined meanings. |
| Every change to a registered Tool takes effect, or none can | prepare/execute are bound during registration. Replacing methods does not update that binding, while mutable state read inside the bound methods can still change. |

For example, `Session saves A → later afterTool transforms to B` leaves A in the conversation while Core can deliver B. To record and observe B, choose `transform to B → Session saves → Events observes` at the corresponding Hook. A composition that needs both versions defines their purposes explicitly; Core does not choose its storage policy.

## Documentation and verification

Each official plugin package should contain:

```text
AGENTS.md                    scope routing, local invariants, exact checks
docs/specs/architecture.md   ownership, state, ordering, failure, composition
README / guide / example     human-facing usage when needed
test/                        real-Core composition tests
```

Update the specification before a behavioral change, then add a regression test that fails on the old implementation. Verify types, unit/composition tests, and the build. Report live network, database, WeApp runtime, and UI evidence separately.

For each supported composition, verify shared mutations, admission and cleanup ownership, exception propagation, and retry boundaries. Document unsupported combinations alongside the package's APIs.

The framework remains experimental before 1.0. Keep new public APIs minimal and state their migration boundary. Avoid speculative wrappers or compatibility facades.

## Package-owned usage

For setup and APIs, start with the [individual package documentation](../../README.md#packages). Code execution belongs to the [Code Mode guide](../../packages/agent-plugin-code-mode/README.md); next-Agent reference handoff and Host runtime usage belong to the [Composition guide](../../packages/agent-plugin-composition/README.md). A combination example links its collaborators rather than becoming their shared authority.
